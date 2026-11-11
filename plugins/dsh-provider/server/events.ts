import type { ProviderTimelineItem, ProviderUsage } from "@getpaseo/plugin/server/provider";

type ToolDetail = Extract<ProviderTimelineItem, { type: "tool_call" }>["detail"];
type Json = Extract<ToolDetail, { type: "unknown" }>["input"];

export interface WireEvent {
  type: string;
  seq: number;
  time?: number;
  data: unknown;
}

export interface MappedEvent {
  items: ProviderTimelineItem[];
  usage?: ProviderUsage;
  mode?: string;
  permission?: string;
  turn?: { state: "started" | "completed" | "failed" | "canceled"; error?: string };
  child?: {
    sessionId: string;
    parentSessionId?: string;
    title?: string;
    description?: string;
    cwd?: string;
    mode?: string;
    kind?: "subagent" | "teammate";
  };
  teamTask?: TeamTaskFact;
}

export interface TeamTaskFact {
  id: string;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
  ownerId?: string;
}

const PROVIDER_DEFAULT_THINKING = "provider-default";

export function modelId(provider: string, model: string): string {
  return JSON.stringify([provider, model]);
}

export function parseModelId(id: string): { provider: string; model: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(id);
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    ) {
      return { provider: parsed[0], model: parsed[1] };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Empty effort is a stable selector id. dsh stores that choice by omitting the field. */
export function reasoningForWrite(thinkingOption: string | null | undefined): string | undefined {
  if (!thinkingOption || thinkingOption === PROVIDER_DEFAULT_THINKING) return undefined;
  return thinkingOption;
}

export { PROVIDER_DEFAULT_THINKING };

export interface LiveAttempt {
  attemptId: string;
  text: string;
  reasoning: string;
  turn?: number;
  step?: number;
}

export interface LiveFrameResult {
  state: LiveAttempt | undefined;
  items: ProviderTimelineItem[];
  /** Durable assistant event that replaces this live attempt. */
  commit?: { seq: number; attemptId: string };
}

/** Live assistant frames become the same timeline rows a finished message will update. */
export function reduceAssistantFrame(
  state: LiveAttempt | undefined,
  frame: unknown,
): LiveFrameResult {
  if (!isRecord(frame) || typeof frame.type !== "string") return { state, items: [] };
  if (frame.type === "start" && typeof frame.attemptId === "string") {
    return {
      state: {
        attemptId: frame.attemptId,
        text: "",
        reasoning: "",
        ...(typeof frame.turn === "number" ? { turn: frame.turn } : {}),
        ...(typeof frame.step === "number" ? { step: frame.step } : {}),
      },
      items: [],
    };
  }
  if (frame.type === "end") {
    const outcome = isRecord(frame.outcome) ? frame.outcome : undefined;
    const attemptId = typeof frame.attemptId === "string" ? frame.attemptId : state?.attemptId;
    if (outcome?.kind === "committed" && typeof outcome.seq === "number" && attemptId) {
      return { state: undefined, items: [], commit: { seq: outcome.seq, attemptId } };
    }
    return { state: undefined, items: [] };
  }
  if (frame.type !== "chunk" || !state || !isRecord(frame.chunk)) return { state, items: [] };
  const next = applyChunk(state, frame.chunk);
  return { state: next.state, items: next.items };
}

export function liveItemId(attemptId: string, kind: "assistant" | "reasoning"): string {
  return kind === "assistant" ? `live:${attemptId}` : `live:${attemptId}:reasoning`;
}

/**
 * The durable assistant/message is committed before its stream end frame.
 * Fold it onto the open attempt so the live row and the settled row stay one message.
 */
export function attemptIdForAssistantSettlement(
  attempt: LiveAttempt | undefined,
  event: { type: string; surfaceOp?: unknown; data: unknown },
): string | undefined {
  if (!attempt || event.type !== "assistant/message") return undefined;
  if (event.surfaceOp !== undefined && event.surfaceOp !== "append") return undefined;
  if (!isRecord(event.data)) return attempt.attemptId;
  if (
    typeof event.data.turn === "number" &&
    attempt.turn !== undefined &&
    event.data.turn !== attempt.turn
  ) {
    return undefined;
  }
  if (
    typeof event.data.step === "number" &&
    attempt.step !== undefined &&
    event.data.step !== attempt.step
  ) {
    return undefined;
  }
  return attempt.attemptId;
}

/** A finished tool row keeps the name and shape of the call that started it. */
export function completeToolCall(
  running: ProviderTimelineItem | undefined,
  finished: ProviderTimelineItem,
): ProviderTimelineItem {
  if (finished.type !== "tool_call" || running?.type !== "tool_call") return finished;
  const name = finished.name === "tool" ? running.name : finished.name;
  if (finished.detail.type === "plain_text") return { ...finished, name };
  return { ...finished, name, detail: withOutput(running.detail, outputOf(finished.detail)) };
}

/** usage_updated replaces the whole usage object, so a later token count must keep the window. */
export function rememberContextWindow(
  remembered: number | undefined,
  usage: ProviderUsage,
): { remembered: number | undefined; usage: ProviderUsage } {
  const next =
    typeof usage.contextWindowMaxTokens === "number" ? usage.contextWindowMaxTokens : remembered;
  if (next === undefined) return { remembered, usage };
  return { remembered: next, usage: { ...usage, contextWindowMaxTokens: next } };
}

const hiddenEventTypes = new Set([
  "sandbox/mode",
  "approval/policy",
  "model/selection",
  "agent/inbox/spliced",
  "step/start",
  "step/end",
  "system/message",
  "request/header",
  "session/title",
  "session/title-llm-request",
  "job/registered",
  "job/settled",
  "workspace/changes",
  "assistant/attempt",
  "llm/retry",
  "llm/retry-started",
  "session/end-seed",
  "approval/asked",
  "approval/decided",
  "subagent/descriptor",
  "system/message",
  "session",
  "team/message/queued",
  "team/message/delivered",
]);

const childUserSources = new Set(["user", "agent-message"]);

export function mapWireEvent(event: WireEvent, audience: "root" | "child" = "root"): MappedEvent {
  if (hiddenEventTypes.has(event.type)) return { items: [] };
  return mapTimelineEvent(event, audience) ?? mapSessionSignal(event);
}

function mapTimelineEvent(event: WireEvent, audience: "root" | "child"): MappedEvent | undefined {
  const id = `event:${event.seq}`;
  switch (event.type) {
    case "user/message":
      if (!humanMessage(event.data, audience)) return { items: [] };
      return { items: userMessageItems(id, event.data) };
    case "request/context":
      return contextWindow(event.data);
    case "assistant/message":
      return assistantMessage(id, event.data);
    case "tool/call":
      return { items: [toolCallItem(event.data, id)] };
    case "tool/result":
      return { items: [toolResultItem(event.data, id)] };
    case "todo/write":
      return { items: [todoItem(event.data)] };
    case "plan/mode":
      return planMode(event.data);
    case "permission/preset":
      return permissionPreset(event.data);
    default:
      return undefined;
  }
}

function mapSessionSignal(event: WireEvent): MappedEvent {
  const id = `event:${event.seq}`;
  switch (event.type) {
    case "compaction/start":
    case "compaction/end":
      return { items: [compactionItem(event.type, event.data)] };
    case "turn/start":
      return { items: [], turn: { state: "started" } };
    case "turn/end":
      return { items: [], turn: turnEnd(event.data) };
    case "goal/change":
      return { items: [pluginItem(id, "dsh-goal", event)] };
    case "subagent/catalog":
      return catalogChild(event.data);
    case "team/task":
      return teamTask(event.data);
    case "team/member":
      return teamMember(event.data);
    default:
      return childFromSummary(event) ?? { items: [pluginItem(id, "dsh-event", event)] };
  }
}

export function mapAddedSession(summary: unknown): MappedEvent["child"] | undefined {
  if (!isRecord(summary) || summary.origin !== "subagent") return undefined;
  if (typeof summary.sessionId !== "string" || typeof summary.parentSessionId !== "string") {
    return undefined;
  }
  return {
    sessionId: summary.sessionId,
    parentSessionId: summary.parentSessionId,
    title: summaryLabel(summary),
    cwd: typeof summary.cwd === "string" ? summary.cwd : undefined,
    mode: typeof summary.mode === "string" ? summary.mode : undefined,
  };
}

/** Direct children from the parent's catalog projection. The follow page omits older catalog events. */
export function catalogEntries(
  projections: unknown,
): { id: string; label?: string; mode?: string }[] {
  if (!isRecord(projections) || !isRecord(projections.values)) return [];
  const catalog = projections.values.subagentCatalog;
  if (!Array.isArray(catalog)) return [];
  return catalog.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id) return [];
    return [
      {
        id: entry.id,
        ...(typeof entry.label === "string" && entry.label.trim() ? { label: entry.label } : {}),
        ...(typeof entry.mode === "string" ? { mode: entry.mode } : {}),
      },
    ];
  });
}

export function childLabelFromSnapshot(records: unknown): string | undefined {
  if (!Array.isArray(records)) return undefined;
  for (const record of records) {
    if (!isRecord(record) || !isRecord(record.event)) continue;
    const event = record.event;
    if (event.type !== "subagent/descriptor" || !isRecord(event.data)) continue;
    if (typeof event.data.label === "string" && event.data.label.trim()) return event.data.label;
  }
  return undefined;
}

export interface ChildActiveSpan {
  since: number;
  through: number;
}

export interface ChildTiming {
  settledMs: number;
  active?: ChildActiveSpan;
  lastTurnCompleted?: boolean;
}

export interface ChildProjection {
  label?: string;
  mode?: string;
  sessionTitle?: string;
  lastTurnCompleted?: boolean;
  tokenTotal?: number;
  timing?: ChildTiming;
}

export interface ChildSubtitleFacts {
  sessionTitle?: string;
  mode?: string;
  external: boolean;
  running: boolean;
  lastTurnCompleted: boolean;
  tokenTotal?: number;
  durationMs?: number;
}

/** Identity, timing, title, and token total from one child follow snapshot. */
export function readChildProjection(projections: unknown): ChildProjection {
  const values = projectionValues(projections);
  const subagent = isRecord(values.subagent) ? values.subagent : undefined;
  const timing = readTiming(values.subagentTiming);
  const tokenTotal = readTokenTotal(values.tokenUsage);
  const facts: ChildProjection = {};
  const label = readTrimmed(subagent?.label);
  const mode = readTrimmed(subagent?.mode);
  const sessionTitle = readTrimmed(values.title);
  if (label) facts.label = label;
  if (mode) facts.mode = mode;
  if (sessionTitle) facts.sessionTitle = sessionTitle;
  if (timing) {
    facts.timing = timing;
    if (timing.lastTurnCompleted !== undefined) facts.lastTurnCompleted = timing.lastTurnCompleted;
  }
  if (tokenTotal !== undefined) facts.tokenTotal = tokenTotal;
  return facts;
}

/** Duration DSH shows: settled time, plus the open span through now only while running. */
export function childDuration(input: {
  timing: ChildTiming | undefined;
  running: boolean;
  now: number;
}): number | undefined {
  const timing = input.timing;
  if (!timing) return undefined;
  if (!timing.active) return timing.settledMs;
  const end = input.running ? input.now : timing.active.through;
  return timing.settledMs + Math.max(0, end - timing.active.since);
}

/** One track line: session title, mode, activity, token total, duration. */
export function formatChildSubtitle(facts: ChildSubtitleFacts): string | undefined {
  const parts = [
    facts.sessionTitle,
    modeText(facts.mode),
    activityText(facts),
    facts.tokenTotal === undefined ? undefined : compactTokenTotal(facts.tokenTotal),
    facts.durationMs === undefined ? undefined : formatDuration(facts.durationMs),
  ].filter((part): part is string => part !== undefined);
  if (parts.length === 0) return undefined;
  return parts.join(" · ");
}

function projectionValues(projections: unknown): Record<string, unknown> {
  if (!isRecord(projections) || !isRecord(projections.values)) return {};
  return projections.values;
}

function readTiming(value: unknown): ChildTiming | undefined {
  if (
    !isRecord(value) ||
    typeof value.settledMs !== "number" ||
    !Number.isFinite(value.settledMs)
  ) {
    return undefined;
  }
  const timing: ChildTiming = { settledMs: value.settledMs };
  if (
    isRecord(value.active) &&
    typeof value.active.since === "number" &&
    typeof value.active.through === "number"
  ) {
    timing.active = { since: value.active.since, through: value.active.through };
  }
  if (typeof value.lastTurnCompleted === "boolean") {
    timing.lastTurnCompleted = value.lastTurnCompleted;
  }
  return timing;
}

function readTokenTotal(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const keys = ["uncachedInputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"];
  let total = 0;
  let seen = false;
  for (const key of keys) {
    const part = value[key];
    if (typeof part !== "number" || !Number.isFinite(part)) continue;
    total += part;
    seen = true;
  }
  return seen ? total : undefined;
}

function readTrimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function modeText(mode: string | undefined): string | undefined {
  if (mode === "one-shot") return "一次性";
  if (mode === "continuable") return "可继续";
  if (mode === "external") return "外部";
  if (mode === "unknown") return "未知";
  return undefined;
}

function activityText(facts: ChildSubtitleFacts): string | undefined {
  if (facts.external) return undefined;
  if (facts.running) return "正在运行";
  if (facts.lastTurnCompleted) return "已完成";
  return "未在运行";
}

function compactTokenTotal(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${Math.round(tokens / 100) / 10}k`;
  return `${Math.round(tokens / 100_000) / 10}M`;
}

function formatDuration(ms: number): string | undefined {
  if (ms < 1000) return undefined;
  const totalSeconds = Math.floor(ms / 1000);
  const totalMinutes = Math.floor(totalSeconds / 60);
  const totalHours = Math.floor(totalMinutes / 60);
  const seconds = totalSeconds % 60;
  const minutes = totalMinutes % 60;
  if (totalHours > 0) return `${totalHours}小时${String(minutes).padStart(2, "0")}分`;
  if (totalMinutes > 0) return `${totalMinutes}分${String(seconds).padStart(2, "0")}秒`;
  return `${seconds}秒`;
}

function teamTask(data: unknown): MappedEvent {
  const task = readTeamTask(data);
  return task ? { items: [], teamTask: task } : { items: [] };
}

function readTeamTask(data: unknown): TeamTaskFact | undefined {
  if (!isRecord(data) || !isRecord(data.task)) return undefined;
  const task = data.task;
  const status = task.status;
  if (typeof task.id !== "string" || typeof task.subject !== "string") return undefined;
  if (
    status !== "pending" &&
    status !== "in_progress" &&
    status !== "completed" &&
    status !== "deleted"
  ) {
    return undefined;
  }
  return {
    id: task.id,
    subject: task.subject,
    description: typeof task.description === "string" ? task.description : "",
    status,
    ...(typeof task.ownerId === "string" ? { ownerId: task.ownerId } : {}),
  };
}

function teamMember(data: unknown): MappedEvent {
  if (!isRecord(data) || !isRecord(data.member)) return { items: [] };
  const member = data.member;
  if (typeof member.id !== "string" || typeof member.name !== "string" || !member.name.trim()) {
    return { items: [] };
  }
  const phase =
    member.phase === "provisioning" || member.phase === "failed" || member.phase === "active"
      ? member.phase
      : "active";
  return {
    items: [],
    child: {
      sessionId: member.id,
      title: member.name,
      ...(typeof member.description === "string" ? { description: member.description } : {}),
      mode: phase,
      kind: "teammate",
    },
  };
}

function catalogChild(data: unknown): MappedEvent {
  if (!isRecord(data) || typeof data.childId !== "string") return { items: [] };
  const label = typeof data.label === "string" ? data.label : undefined;
  return {
    items: [],
    child: {
      sessionId: data.childId,
      title: label,
      mode: typeof data.mode === "string" ? data.mode : undefined,
    },
  };
}

function summaryLabel(summary: Record<string, unknown>): string | undefined {
  if (typeof summary.title === "string" && summary.title.trim()) return summary.title;
  if (typeof summary.label === "string" && summary.label.trim()) return summary.label;
  const projections = isRecord(summary.projections) ? summary.projections.values : undefined;
  const subagent = isRecord(projections) ? projections.subagent : undefined;
  if (isRecord(subagent) && typeof subagent.label === "string" && subagent.label.trim()) {
    return subagent.label;
  }
  return undefined;
}

function childFromSummary(event: WireEvent): MappedEvent | undefined {
  if (event.type !== "api-session/added") return undefined;
  const child = mapAddedSession(event.data);
  return child ? { items: [], child } : undefined;
}

function assistantMessage(id: string, data: unknown): MappedEvent {
  const message = isRecord(data) ? data.message : data;
  const text = textFromMessage(message);
  const items: ProviderTimelineItem[] = [];
  const messageText = meaningful(text.text);
  const reasoningText = meaningful(text.reasoning);
  if (messageText) items.push(timelineMessage(id, "assistant_message", messageText));
  if (reasoningText) {
    items.push({ type: "reasoning", id: `${id}:reasoning`, text: reasoningText });
  }
  const usage = isRecord(data) ? usageFrom(data.usage) : undefined;
  return { items, ...(usage ? { usage } : {}) };
}

function humanMessage(data: unknown, audience: "root" | "child"): boolean {
  if (!isRecord(data)) return false;
  const source = data.source;
  if (!isRecord(source) || typeof source.kind !== "string") return true;
  if (source.kind === "user") return true;
  return audience === "child" && childUserSources.has(source.kind);
}

function userMessageItems(id: string, data: unknown): ProviderTimelineItem[] {
  const text = textFromMessage(data);
  const items: ProviderTimelineItem[] = [];
  const messageText = meaningful(text.text);
  const reasoningText = meaningful(text.reasoning);
  if (messageText) {
    const clientMessageId = rpcId(data);
    items.push({
      type: "user_message",
      id,
      text: messageText,
      ...(clientMessageId ? { clientMessageId } : {}),
    });
  }
  if (reasoningText) {
    items.push({ type: "reasoning", id: `${id}:reasoning`, text: reasoningText });
  }
  return items;
}

function rpcId(data: unknown): string | undefined {
  if (!isRecord(data) || !isRecord(data.source)) return undefined;
  return typeof data.source.rpcId === "string" ? data.source.rpcId : undefined;
}

function contextWindow(data: unknown): MappedEvent {
  if (!isRecord(data) || typeof data.contextWindow !== "number") return { items: [] };
  if (!Number.isFinite(data.contextWindow) || data.contextWindow <= 0) return { items: [] };
  return { items: [], usage: { contextWindowMaxTokens: data.contextWindow } };
}

function timelineMessage(
  id: string,
  type: "user_message" | "assistant_message",
  text: string,
): ProviderTimelineItem {
  return { type, id, text };
}

function toolCallItem(data: unknown, fallbackId: string): ProviderTimelineItem {
  const record = isRecord(data) ? data : {};
  const callId = typeof record.callId === "string" ? record.callId : fallbackId;
  const name = typeof record.name === "string" ? record.name : "tool";
  const args = typeof record.arguments === "string" ? record.arguments : "";
  const skillName = name === "skill" ? stringField(parseJson(args), "name") : undefined;
  return {
    type: "tool_call",
    id: `tool:${callId}`,
    callId,
    name: skillName ?? name,
    status: "running",
    error: null,
    detail: skillName ? { type: "plain_text", label: skillName } : toolDetail(name, args),
  };
}

function toolResultItem(data: unknown, fallbackId: string): ProviderTimelineItem {
  const record = isRecord(data) ? data : {};
  const message = isRecord(record.message) ? record.message : {};
  const callId = firstString(message.toolCallId, record.callId) ?? fallbackId;
  const failed = message.isError === true || isRecord(record.error);
  const text = textFromMessage(message).text;
  const errorText = isRecord(record.error)
    ? (firstString(record.error.reason, record.error.message) ?? "Tool failed")
    : text || "Tool failed";
  const named = typeof record.name === "string" ? record.name : "tool";
  const presented = presentedResult(text);
  const name = presented?.name ?? named;
  const detail = presented?.detail ?? { type: "unknown" as const, input: null, output: text };
  if (failed) {
    return {
      type: "tool_call",
      id: `tool:${callId}`,
      callId,
      name,
      status: "failed",
      error: errorText,
      detail,
    };
  }
  return {
    type: "tool_call",
    id: `tool:${callId}`,
    callId,
    name,
    status: "completed",
    error: null,
    detail,
  };
}

function applyChunk(
  state: LiveAttempt,
  chunk: Record<string, unknown>,
): { state: LiveAttempt; items: ProviderTimelineItem[] } {
  const next = { ...state };
  if (
    (chunk.type === "text-delta" || chunk.type === "reasoning-delta") &&
    typeof chunk.text === "string"
  ) {
    if (chunk.type === "text-delta") next.text += chunk.text;
    else next.reasoning += chunk.text;
  }
  if (chunk.type === "block-end" && isRecord(chunk.block)) {
    if (chunk.block.type === "text" && typeof chunk.block.text === "string")
      next.text = chunk.block.text;
    if (chunk.block.type === "reasoning" && typeof chunk.block.text === "string") {
      next.reasoning = chunk.block.text;
    }
  }
  const items: ProviderTimelineItem[] = [];
  const text = meaningful(next.text);
  const reasoning = meaningful(next.reasoning);
  if (text)
    items.push({ type: "assistant_message", id: liveItemId(state.attemptId, "assistant"), text });
  if (reasoning) {
    items.push({
      type: "reasoning",
      id: liveItemId(state.attemptId, "reasoning"),
      text: reasoning,
    });
  }
  return { state: next, items };
}

function presentedResult(text: string): { name: string; detail: ToolDetail } | undefined {
  const profile = pluginProfile(text);
  if (profile) return profile;
  return skillBody(text);
}

function pluginProfile(text: string): { name: string; detail: ToolDetail } | undefined {
  const parsed = parseJson(text);
  if (!isRecord(parsed)) return undefined;
  const plugin = stringField(parsed, "plugin");
  const displayName =
    stringField(parsed, "displayName") ?? stringField(parsed, "pluginDisplayName") ?? plugin;
  if (!displayName) return undefined;
  const version =
    stringField(parsed, "pluginVersion") ??
    stringField(parsed, "kernelVersion") ??
    stringField(parsed, "version");
  const identity = plugin && version ? `${plugin} ${version}` : plugin;
  const lines = [
    identity,
    stringField(parsed, "engine"),
    stringField(parsed, "targetArchitecture"),
    stringField(parsed, "mode"),
  ].filter((line): line is string => typeof line === "string" && line.length > 0);
  return {
    name: displayName,
    detail: { type: "plain_text", label: lines[0] ?? displayName, text: lines.join("\n") },
  };
}

function skillBody(text: string): { name: string; detail: ToolDetail } | undefined {
  const matched = /^<skill_content name="([^"]+)">/.exec(text);
  if (!matched?.[1]) return undefined;
  const name = matched[1];
  const body = text.replace(/^<skill_content[^>]*>\n?/, "").replace(/\n?<\/skill_content>\s*$/, "");
  return { name, detail: { type: "plain_text", label: name, text: body } };
}

function toolDetail(name: string, args: string): ToolDetail {
  const parsed = parseJson(args);
  return (
    shellDetail(name, parsed, args) ??
    fileDetail(name, parsed) ??
    searchDetail(name, parsed) ?? { type: "unknown", input: parsed, output: null }
  );
}

function shellDetail(name: string, parsed: Json, args: string): ToolDetail | undefined {
  if (name !== "bash" && name !== "shell" && name !== "pwsh" && name !== "powershell") {
    return undefined;
  }
  return { type: "shell", command: stringField(parsed, "command") ?? args };
}

function fileDetail(name: string, parsed: Json): ToolDetail | undefined {
  const filePath = stringField(parsed, "file_path") ?? stringField(parsed, "path") ?? "";
  if (name === "read" || name === "read_file") return { type: "read", filePath };
  if (name === "write" || name === "write_file") {
    return { type: "write", filePath, content: stringField(parsed, "content") };
  }
  if (name === "edit" || name === "str_replace" || name === "search_replace") {
    return {
      type: "edit",
      filePath,
      oldString: stringField(parsed, "old_string"),
      newString: stringField(parsed, "new_string"),
    };
  }
  if (name === "apply_patch") return patchDetail(parsed);
  if (name === "str_replace_editor") return editorDetail(parsed);
  return undefined;
}

function patchDetail(parsed: Json): ToolDetail {
  const patch = stringField(parsed, "input");
  return { type: "edit", filePath: patchPath(patch), ...(patch ? { unifiedDiff: patch } : {}) };
}

function patchPath(patch: string | undefined): string {
  const matched = patch ? /\*\*\* (?:Add|Update|Delete) File: ([^\n]+)/.exec(patch) : undefined;
  return matched?.[1]?.trim() ?? "";
}

function editorDetail(parsed: Json): ToolDetail | undefined {
  const filePath = stringField(parsed, "path") ?? "";
  const command = stringField(parsed, "command");
  if (command === "view") return { type: "read", filePath };
  if (command === "create") {
    return { type: "write", filePath, content: stringField(parsed, "file_text") };
  }
  if (command === "str_replace" || command === "insert") {
    return {
      type: "edit",
      filePath,
      oldString: stringField(parsed, "old_str"),
      newString: stringField(parsed, "new_str"),
    };
  }
  return undefined;
}

function searchDetail(name: string, parsed: Json): ToolDetail | undefined {
  if (name === "grep" || name === "glob") {
    const path = stringField(parsed, "path");
    return {
      type: "search",
      query: stringField(parsed, "pattern") ?? "",
      toolName: name,
      ...(path ? { filePaths: [path] } : {}),
    };
  }
  if (name === "web_search") {
    return {
      type: "search",
      query: stringList(parsed, "queries").join("\n"),
      toolName: "web_search",
    };
  }
  if (name === "web_fetch") return { type: "fetch", url: stringField(parsed, "url") ?? "" };
  return undefined;
}

function stringList(value: Json, key: string): string[] {
  if (!isRecord(value) || !Array.isArray(value[key])) return [];
  return value[key].filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
}

function todoItem(data: unknown): ProviderTimelineItem {
  const todos = isRecord(data) && Array.isArray(data.todos) ? data.todos : [];
  return {
    type: "todo",
    id: "todos",
    items: todos.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.content !== "string") return [];
      const status =
        entry.status === "in_progress" || entry.status === "completed" ? entry.status : "pending";
      return [{ text: entry.content, completed: status === "completed", status }];
    }),
  };
}

function planMode(data: unknown): MappedEvent {
  if (!isRecord(data) || typeof data.active !== "boolean") {
    return { items: [pluginItem("plan-mode", "dsh-event", data)] };
  }
  return { items: [], mode: data.active ? "plan" : "default" };
}

function permissionPreset(data: unknown): MappedEvent {
  if (!isRecord(data) || typeof data.preset !== "string" || !data.preset) return { items: [] };
  return { items: [], permission: data.preset };
}

function compactionItem(type: string, data: unknown): ProviderTimelineItem {
  const id =
    isRecord(data) && typeof data.compactionId === "string" ? data.compactionId : "compaction";
  return {
    type: "compaction",
    id: `compaction:${id}`,
    status: type === "compaction/end" ? "completed" : "loading",
    trigger: isRecord(data) && data.sourceCommandId !== undefined ? "manual" : "auto",
  };
}

function turnEnd(data: unknown): NonNullable<MappedEvent["turn"]> {
  const reason = isRecord(data) ? data.reason : undefined;
  const kind = isRecord(reason) && typeof reason.kind === "string" ? reason.kind : "completed";
  if (kind === "aborted" || kind === "interrupted") return { state: "canceled" };
  if (kind === "error" || kind === "blocked") {
    const error = isRecord(reason) && isRecord(reason.error) ? reason.error.message : undefined;
    return { state: "failed", error: typeof error === "string" ? error : "Turn failed" };
  }
  return { state: "completed" };
}

function pluginItem(id: string, kind: string, data: unknown): ProviderTimelineItem {
  return {
    type: "plugin",
    id,
    pluginId: "dsh-provider",
    kind,
    version: 1,
    data: toJson(data),
  };
}

function meaningful(text: string): string | undefined {
  const cleaned = text.replace(/\u200b/g, "");
  if (!cleaned.trim()) return undefined;
  return cleaned;
}

function outputOf(detail: ToolDetail): string {
  if (detail.type === "unknown" && typeof detail.output === "string") return detail.output;
  if (detail.type === "plain_text" && typeof detail.text === "string") return detail.text;
  if (detail.type === "shell" && typeof detail.output === "string") return detail.output;
  if (detail.type === "read" && typeof detail.content === "string") return detail.content;
  if (detail.type === "search" && typeof detail.content === "string") return detail.content;
  if (detail.type === "fetch" && typeof detail.result === "string") return detail.result;
  return "";
}

function withOutput(detail: ToolDetail, output: string): ToolDetail {
  if (!output) return detail;
  if (detail.type === "shell") return { ...detail, output };
  if (detail.type === "read") return { ...detail, content: output };
  if (detail.type === "search") return { ...detail, content: output };
  if (detail.type === "fetch") return { ...detail, result: output };
  if (detail.type === "unknown") return { ...detail, output };
  return detail;
}

function usageFrom(value: unknown): ProviderUsage | undefined {
  if (!isRecord(value)) return undefined;
  const usage: ProviderUsage = {};
  if (typeof value.inputTokens === "number") usage.inputTokens = value.inputTokens;
  if (typeof value.outputTokens === "number") usage.outputTokens = value.outputTokens;
  if (typeof value.cacheReadTokens === "number") usage.cachedInputTokens = value.cacheReadTokens;
  if (typeof value.totalTokens === "number") {
    usage.contextWindowUsedTokens = value.totalTokens;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function textFromMessage(value: unknown): { text: string; reasoning: string } {
  const content = isRecord(value) ? value.content : undefined;
  if (!Array.isArray(content)) return { text: "", reasoning: "" };
  const text: string[] = [];
  const reasoning: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || typeof block.text !== "string") continue;
    if (block.type === "reasoning" || block.type === "thinking") reasoning.push(block.text);
    else if (block.type === "text" || block.type === "input_text") text.push(block.text);
  }
  return { text: text.join(""), reasoning: reasoning.join("") };
}

function parseJson(value: string): Json {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return toJson(parsed);
  } catch {
    return value;
  }
}

function stringField(value: Json, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value[key] === "string" ? value[key] : undefined;
}

function toJson(value: unknown): Json {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => toJson(entry));
  if (isRecord(value)) {
    const result: { [key: string]: Json } = {};
    for (const [key, entry] of Object.entries(value)) result[key] = toJson(entry);
    return result;
  }
  return String(value);
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
