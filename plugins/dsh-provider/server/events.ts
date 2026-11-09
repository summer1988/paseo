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
  turn?: { state: "started" | "completed" | "failed" | "canceled"; error?: string };
  child?: { sessionId: string; parentSessionId: string; title?: string; cwd?: string };
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
    return { state: { attemptId: frame.attemptId, text: "", reasoning: "" }, items: [] };
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
  "permission/preset",
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
]);

export function mapWireEvent(event: WireEvent): MappedEvent {
  if (hiddenEventTypes.has(event.type)) return { items: [] };
  const id = `event:${event.seq}`;
  switch (event.type) {
    case "user/message":
      if (!humanMessage(event.data)) return { items: [] };
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
    case "compaction/start":
    case "compaction/end":
      return { items: [compactionItem(event.type, event.data)] };
    case "turn/start":
      return { items: [], turn: { state: "started" } };
    case "turn/end":
      return { items: [], turn: turnEnd(event.data) };
    case "goal/change":
      return { items: [pluginItem(id, "dsh-goal", event)] };
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
    title: typeof summary.title === "string" ? summary.title : undefined,
    cwd: typeof summary.cwd === "string" ? summary.cwd : undefined,
  };
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

function humanMessage(data: unknown): boolean {
  if (!isRecord(data)) return false;
  const source = data.source;
  if (!isRecord(source) || typeof source.kind !== "string") return true;
  return source.kind === "user";
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
  const command = stringField(parsed, "command") ?? args;
  if (name === "bash" || name === "shell" || name === "pwsh" || name === "powershell") {
    return { type: "shell", command };
  }
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
  return { type: "unknown", input: parsed, output: null };
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
  return "";
}

function withOutput(detail: ToolDetail, output: string): ToolDetail {
  if (!output) return detail;
  if (detail.type === "shell") return { ...detail, output };
  if (detail.type === "read") return { ...detail, content: output };
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
