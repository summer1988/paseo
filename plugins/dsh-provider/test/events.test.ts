import { expect, test } from "vitest";
import {
  completeToolCall,
  childDuration,
  formatChildSubtitle,
  mapAddedSession,
  mapWireEvent,
  modelId,
  parseModelId,
  readChildProjection,
  reasoningForWrite,
  attemptIdForAssistantSettlement,
  reduceAssistantFrame,
  rememberContextWindow,
} from "../server/events.js";

function detailOf(name: string, args: Record<string, unknown>) {
  const event = mapWireEvent({
    type: "tool/call",
    seq: 1,
    data: { callId: "call-1", name, arguments: JSON.stringify(args) },
  });
  const item = event.items[0];
  return item?.type === "tool_call" ? item.detail : undefined;
}

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
  expect(detailOf("grep", { pattern: "foo", path: "src" })).toEqual({
    type: "search",
    query: "foo",
    toolName: "grep",
    filePaths: ["src"],
  });
  expect(detailOf("glob", { pattern: "**/*.ts" })).toEqual({
    type: "search",
    query: "**/*.ts",
    toolName: "glob",
  });
  expect(detailOf("web_search", { queries: ["paseo", "dsh"] })).toEqual({
    type: "search",
    query: "paseo\ndsh",
    toolName: "web_search",
  });
  expect(detailOf("web_fetch", { url: "https://example.com" })).toEqual({
    type: "fetch",
    url: "https://example.com",
  });
  expect(
    detailOf("apply_patch", { input: "*** Update File: src/a.ts\n@@\n-old\n+new\n" }),
  ).toMatchObject({ type: "edit", filePath: "src/a.ts" });
  expect(detailOf("str_replace_editor", { command: "view", path: "src/a.ts" })).toEqual({
    type: "read",
    filePath: "src/a.ts",
  });

  expect(mapWireEvent({ type: "plan/mode", seq: 5, data: { active: true } }).mode).toBe("plan");
  expect(
    mapWireEvent({ type: "permission/preset", seq: 9, data: { preset: "workspace-write" } }),
  ).toEqual({ items: [], permission: "workspace-write" });
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
    mode: undefined,
  });
  expect(mapAddedSession({ origin: "user", sessionId: "root" })).toBeUndefined();
  expect(
    mapAddedSession({
      origin: "subagent",
      sessionId: "child",
      parentSessionId: "parent",
      projections: { values: { subagent: { label: "调研", mode: "continuable" } } },
    }),
  ).toMatchObject({ title: "调研" });
  expect(
    mapWireEvent({
      type: "subagent/catalog",
      seq: 3,
      data: { childId: "child", label: "调研", mode: "continuable" },
    }).child,
  ).toMatchObject({ sessionId: "child", title: "调研", mode: "continuable" });
  const task = {
    type: "user/message",
    seq: 4,
    data: {
      source: { kind: "agent-message" },
      content: [{ type: "text", text: "去做" }],
    },
  };
  expect(mapWireEvent(task).items).toEqual([]);
  expect(mapWireEvent(task, "child").items[0]).toMatchObject({ text: "去做" });
});

test("reads the child snapshot projections DSH uses for a row", () => {
  const facts = readChildProjection({
    values: {
      subagent: { label: "调研", mode: "one-shot", seq: 4 },
      title: "查资料",
      subagentTiming: { settledMs: 3000, lastTurnCompleted: true },
      tokenUsage: {
        uncachedInputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
  });
  expect(facts).toMatchObject({
    label: "调研",
    mode: "one-shot",
    sessionTitle: "查资料",
    lastTurnCompleted: true,
    tokenTotal: 1500,
    timing: { settledMs: 3000 },
  });
  expect(
    formatChildSubtitle({
      sessionTitle: facts.sessionTitle,
      mode: facts.mode,
      external: false,
      running: false,
      lastTurnCompleted: true,
      tokenTotal: facts.tokenTotal,
      durationMs: childDuration({ timing: facts.timing, running: false, now: 0 }),
    }),
  ).toBe("查资料 · 一次性 · 已完成 · 1.5k · 3秒");
  expect(
    formatChildSubtitle({
      mode: "continuable",
      external: false,
      running: true,
      lastTurnCompleted: false,
    }),
  ).toBe("可继续 · 正在运行");
  expect(
    formatChildSubtitle({
      mode: "external",
      external: true,
      running: false,
      lastTurnCompleted: false,
    }),
  ).toBe("外部");
  expect(
    formatChildSubtitle({
      mode: "one-shot",
      external: false,
      running: false,
      lastTurnCompleted: false,
    }),
  ).toBe("一次性 · 未在运行");
});

test("recognizes a team task and teammate without showing mailbox records", () => {
  const task = {
    id: "task-1",
    revision: 2,
    subject: "写文档",
    description: "细节",
    status: "in_progress",
    blockedBy: [],
    writeScopes: [],
  };
  expect(
    mapWireEvent({
      type: "team/task",
      seq: 1,
      data: { version: 1, teamId: "lead", task },
    }).teamTask,
  ).toMatchObject({ id: "task-1", subject: "写文档", status: "in_progress" });
  expect(
    mapWireEvent({
      type: "team/member",
      seq: 2,
      data: {
        version: 1,
        teamId: "lead",
        member: {
          id: "mate",
          name: "reviewer",
          description: "看 diff",
          provider: "dsh",
          context: "fresh",
          phase: "active",
        },
      },
    }).child,
  ).toMatchObject({
    sessionId: "mate",
    title: "reviewer",
    description: "看 diff",
    mode: "active",
    kind: "teammate",
  });
  expect(
    mapWireEvent({ type: "team/message/queued", seq: 3, data: { version: 1, teamId: "lead" } })
      .items,
  ).toEqual([]);
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
  const open = reduceAssistantFrame(undefined, {
    type: "start",
    attemptId: "a1",
    turn: 8,
    step: 33,
  });
  expect(
    attemptIdForAssistantSettlement(open.state, {
      type: "assistant/message",
      surfaceOp: "append",
      data: { turn: 8, step: 33 },
    }),
  ).toBe("a1");
  expect(
    attemptIdForAssistantSettlement(open.state, {
      type: "assistant/message",
      surfaceOp: "append",
      data: { turn: 8, step: 34 },
    }),
  ).toBeUndefined();
  expect(
    attemptIdForAssistantSettlement(open.state, { type: "tool/call", data: {} }),
  ).toBeUndefined();
  expect(
    attemptIdForAssistantSettlement(open.state, {
      type: "assistant/message",
      surfaceOp: "replace",
      data: { turn: 8, step: 33 },
    }),
  ).toBeUndefined();
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
