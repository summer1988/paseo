import { expect, test } from "vitest";
import {
  completeToolCall,
  mapAddedSession,
  mapWireEvent,
  modelId,
  parseModelId,
  reasoningForWrite,
  reduceAssistantFrame,
  rememberContextWindow,
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

  expect(
    mapWireEvent({
      type: "request/header",
      seq: 7,
      data: { header: { tools: [{ name: "bash" }] } },
    }).items,
  ).toEqual([]);
  expect(
    mapWireEvent({
      type: "user/message",
      seq: 8,
      data: {
        role: "user",
        source: { kind: "runtime-context" },
        content: [{ type: "text", text: "Current runtime context" }],
      },
    }).items,
  ).toEqual([]);
  expect(
    mapWireEvent({
      type: "user/message",
      seq: 8,
      data: {
        role: "user",
        source: { kind: "user", rpcId: "msg_1" },
        content: [{ type: "text", text: "你好" }],
      },
    }).items[0],
  ).toMatchObject({ type: "user_message", text: "你好", clientMessageId: "msg_1" });

  expect(
    mapWireEvent({ type: "request/context", seq: 10, data: { contextWindow: 1000000 } }).usage,
  ).toEqual({ contextWindowMaxTokens: 1000000 });
  const counted = mapWireEvent({
    type: "assistant/message",
    seq: 11,
    data: { message: { content: [{ type: "text", text: "ok" }] }, usage: { totalTokens: 46868 } },
  });
  expect(counted.usage?.contextWindowUsedTokens).toBe(46868);
  expect(rememberContextWindow(1000000, counted.usage ?? {}).usage.contextWindowMaxTokens).toBe(
    1000000,
  );

  const plugin = mapWireEvent({
    type: "tool/result",
    seq: 12,
    data: {
      message: {
        toolCallId: "call-plugin",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              plugin: "dsh-infinite-gen-4",
              pluginVersion: "0.4.0",
              displayName: "无限四代",
              targetArchitecture: "DeepSeek-V4",
              mode: "persona",
            }),
          },
        ],
      },
    },
  });
  expect(plugin.items[0]).toMatchObject({
    type: "tool_call",
    name: "无限四代",
    detail: {
      type: "plain_text",
      label: "dsh-infinite-gen-4 0.4.0",
      text: "dsh-infinite-gen-4 0.4.0\nDeepSeek-V4\npersona",
    },
  });

  const skill = mapWireEvent({
    type: "tool/call",
    seq: 13,
    data: {
      callId: "call-skill",
      name: "skill",
      arguments: JSON.stringify({ name: "ida-reverse" }),
    },
  });
  expect(skill.items[0]).toMatchObject({ name: "ida-reverse", detail: { type: "plain_text" } });
  const skillResult = mapWireEvent({
    type: "tool/result",
    seq: 14,
    data: {
      message: {
        toolCallId: "call-skill",
        content: [
          { type: "text", text: '<skill_content name="ida-reverse">\nsteps\n</skill_content>' },
        ],
      },
    },
  });
  expect(skillResult.items[0]).toMatchObject({
    name: "ida-reverse",
    detail: { type: "plain_text", label: "ida-reverse", text: "steps" },
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

test("streams assistant text and folds the finished message onto the same row", () => {
  const started = reduceAssistantFrame(undefined, { type: "start", attemptId: "a1" });
  const chunk = reduceAssistantFrame(started.state, {
    type: "chunk",
    chunk: { type: "text-delta", text: "你好" },
  });
  expect(chunk.items[0]).toMatchObject({ type: "assistant_message", id: "live:a1", text: "你好" });
  const blank = reduceAssistantFrame(chunk.state, {
    type: "chunk",
    chunk: { type: "reasoning-delta", text: "\u200b" },
  });
  expect(blank.items.some((item) => item.type === "reasoning")).toBe(false);
  const done = reduceAssistantFrame(blank.state, {
    type: "end",
    attemptId: "a1",
    outcome: { kind: "committed", seq: 19 },
  });
  expect(done.commit).toEqual({ seq: 19, attemptId: "a1" });
  expect(
    mapWireEvent({
      type: "assistant/message",
      seq: 19,
      data: { message: { content: [{ type: "reasoning", text: "\u200b" }] } },
    }).items,
  ).toEqual([]);
});

test("a finished tool keeps the call and a plugin profile keeps its name", () => {
  const running = mapWireEvent({
    type: "tool/call",
    seq: 1,
    data: { callId: "call-read", name: "read", arguments: JSON.stringify({ file_path: "a.ts" }) },
  }).items[0];
  const finished = mapWireEvent({
    type: "tool/result",
    seq: 2,
    data: { message: { toolCallId: "call-read", content: [{ type: "text", text: "export {}" }] } },
  }).items[0];
  expect(completeToolCall(running, finished)).toMatchObject({
    name: "read",
    detail: { type: "read", filePath: "a.ts", content: "export {}" },
  });
  const profile = mapWireEvent({
    type: "tool/result",
    seq: 3,
    data: {
      message: {
        toolCallId: "call-ig",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              plugin: "dsh-infinite-gen-5",
              version: "1.3.0",
              engine: "reverse",
            }),
          },
        ],
      },
    },
  }).items[0];
  expect(profile).toMatchObject({
    name: "dsh-infinite-gen-5",
    detail: { type: "plain_text", label: "dsh-infinite-gen-5 1.3.0" },
  });
});
