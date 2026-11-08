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

export function mapWireEvent(event: WireEvent): MappedEvent {
  const id = `event:${event.seq}`;
  switch (event.type) {
    case "user/message":
      return { items: messageItem(id, "user_message", textFromMessage(event.data)) };
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
  if (text.text) items.push(timelineMessage(id, "assistant_message", text.text));
  if (text.reasoning) {
    items.push({ type: "reasoning", id: `${id}:reasoning`, text: text.reasoning });
  }
  const usage = isRecord(data) ? usageFrom(data.usage) : undefined;
  return { items, ...(usage ? { usage } : {}) };
}

function messageItem(
  id: string,
  type: "user_message" | "assistant_message",
  text: { text: string; reasoning: string },
): ProviderTimelineItem[] {
  const items: ProviderTimelineItem[] = [];
  if (text.text) items.push(timelineMessage(id, type, text.text));
  if (text.reasoning)
    items.push({ type: "reasoning", id: `${id}:reasoning`, text: text.reasoning });
  if (items.length === 0) items.push(pluginItem(id, "dsh-event", { type, data: text }));
  return items;
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
  return {
    type: "tool_call",
    id: `tool:${callId}`,
    callId,
    name,
    status: "running",
    error: null,
    detail: toolDetail(name, args),
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
  const name = typeof record.name === "string" ? record.name : "tool";
  if (failed) {
    return {
      type: "tool_call",
      id: `tool:${callId}`,
      callId,
      name,
      status: "failed",
      error: errorText,
      detail: { type: "unknown", input: null, output: text },
    };
  }
  return {
    type: "tool_call",
    id: `tool:${callId}`,
    callId,
    name,
    status: "completed",
    error: null,
    detail: { type: "unknown", input: null, output: text },
  };
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
