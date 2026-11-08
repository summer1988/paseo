import { expect, test } from "vitest";
import {
  mapAddedSession,
  mapWireEvent,
  modelId,
  parseModelId,
  reasoningForWrite,
} from "../server/events.js";

test("writes an omitted reasoning effort for the provider default", () => {
  expect(reasoningForWrite("provider-default")).toBeUndefined();
  expect(reasoningForWrite("high")).toBe("high");
  expect(parseModelId(modelId("deepseek", "v4"))).toEqual({ provider: "deepseek", model: "v4" });
});

test("maps durable session events and keeps unknown ones", () => {
  const assistant = mapWireEvent({
    type: "assistant/message",
    seq: 3,
    data: {
      message: {
        content: [
          { type: "text", text: "done" },
          { type: "reasoning", text: "think" },
        ],
      },
      usage: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 4 },
    },
  });
  expect(assistant.items.map((item) => item.type)).toEqual(["assistant_message", "reasoning"]);
  expect(assistant.usage).toMatchObject({ inputTokens: 2, cachedInputTokens: 4 });

  const tool = mapWireEvent({
    type: "tool/call",
    seq: 4,
    data: { callId: "call-1", name: "bash", arguments: JSON.stringify({ command: "ls" }) },
  });
  expect(tool.items[0]).toMatchObject({
    type: "tool_call",
    callId: "call-1",
    status: "running",
    detail: { type: "shell", command: "ls" },
  });

  expect(mapWireEvent({ type: "plan/mode", seq: 5, data: { active: true } }).mode).toBe("plan");
  expect(
    mapWireEvent({
      type: "todo/write",
      seq: 6,
      data: { todos: [{ content: "Fix", status: "pending" }] },
    }).items[0],
  ).toMatchObject({
    type: "todo",
  });

  const unknown = mapWireEvent({ type: "future/widget", seq: 9, data: { kept: true } });
  expect(unknown.items[0]).toMatchObject({
    type: "plugin",
    pluginId: "dsh-provider",
    kind: "dsh-event",
    version: 1,
    data: { type: "future/widget", seq: 9, data: { kept: true } },
  });
});

test("recognizes a subagent list row", () => {
  expect(
    mapAddedSession({
      origin: "subagent",
      sessionId: "child",
      parentSessionId: "parent",
      cwd: "/repo",
    }),
  ).toEqual({
    sessionId: "child",
    parentSessionId: "parent",
    title: undefined,
    cwd: "/repo",
  });
  expect(mapAddedSession({ origin: "user", sessionId: "root" })).toBeUndefined();
});
