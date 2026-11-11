import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  PROVIDER_CAPABILITIES,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import type { DiscoveredInstall } from "../server/discover.js";
import { HostPool, type HostControls } from "../server/host.js";
import {
  createDshProvider,
  listConnectedWorkspaces,
  type SettingsSource,
} from "../server/provider.js";
import { SessionFile } from "../server/session-file.js";
import { SessionRoster } from "../server/roster.js";
import { assertLoopbackLogin, createRemoteClient, exchangeLogin } from "../server/remote.js";
import { redact } from "../server/redact.js";

const desktop: DiscoveredInstall = {
  id: "official-desktop:/Applications/DeepSeek Harness.app",
  kind: "official-desktop",
  label: "DeepSeek Harness",
  version: "0.2.2",
  location: "/Applications/DeepSeek Harness.app",
  canBuild: true,
  attachAvailable: false,
  attachDisabledReason:
    "Official DeepSeek Harness does not publish a login link. Build a host from this install instead.",
  profile: "desktop",
  home: "/Users/me/.dsh",
  launch: {
    command: "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness",
    args: ["--expose-internals", "/Applications/DeepSeek Harness.app/host-entry.js"],
    env: { ELECTRON_RUN_AS_NODE: "1", DSH_HOME: "/Users/me/.dsh" },
    cwd: "/Users/me/.dsh/profiles/desktop",
    ipc: false,
  },
};

const next: DiscoveredInstall = {
  ...desktop,
  id: "dsh-next:/Applications/DSH NEXT.app",
  kind: "dsh-next",
  label: "DSH NEXT",
  attachAvailable: true,
  attachDisabledReason: undefined,
  launch: {
    ...desktop.launch!,
    command: "/Applications/DSH NEXT.app/Contents/MacOS/DSH NEXT",
  },
};

class Script {
  readonly calls: { endpoint: string; args: Record<string, unknown> }[] = [];
  readonly follows: Array<(value: unknown) => void> = [];
  readonly events: Array<(value: unknown) => void> = [];
  failCreate = false;
  unauthorizedCatalog = false;
  failPing = false;
  holdCatalog: Promise<void> | undefined;
  rejectUnsupportedEffort = false;
  childRunning = false;
  historyPages: { records: unknown[]; hasMore: boolean }[] = [];
  catalog: unknown;
  projections: unknown = {};
  providers: unknown = [];
  described: unknown = { namespaces: [] };
  sessionItems: unknown = { items: [] };
  workspaceFrame: unknown = undefined;
  async ping() {
    if (!this.failPing) return;
    const { DshError } = await import("../server/remote.js");
    throw new DshError("transport", "The saved host is not accepting connections");
  }
  async call(endpoint: string, args: Record<string, unknown>) {
    this.calls.push({ endpoint, args });
    if (endpoint === "session/modelCatalog" && this.holdCatalog) await this.holdCatalog;
    if (endpoint === "session/modelCatalog" && this.unauthorizedCatalog) {
      const { DshError } = await import("../server/remote.js");
      throw new DshError("remote", "Remote call failed with HTTP 401");
    }
    if (endpoint === "session/create" && this.failCreate) {
      const { DshError } = await import("../server/remote.js");
      throw new DshError("session/writer-held", "Another client is writing this session");
    }
    if (endpoint === "session/create") return { sessionId: "dsh-1" };
    if (endpoint === "workspace/create") return createdWorkspace(args.request);
    if (endpoint === "session/modelCatalog") {
      if (this.catalog) return this.catalog;
      return {
        default: { provider: "deepseek", model: "v4" },
        groups: [
          {
            id: "deepseek",
            name: "DeepSeek",
            models: [
              {
                id: "v4",
                name: "V4",
                reasoning: { efforts: [{ id: "high", name: "High" }] },
              },
            ],
          },
        ],
      };
    }
    if (endpoint === "skills/list")
      return { skills: [{ name: "review", description: "Review the diff" }] };
    if (endpoint === "session/state" || endpoint === "session/events") {
      return scriptedSession(this, endpoint);
    }
    if (endpoint === "session/fork") return { sessionId: "dsh-fork" };
    if (endpoint === "session/list") return this.sessionItems;
    if (endpoint === "session/projections") return this.projections;
    if (endpoint === "llm/listConfigurableProviders") return this.providers;
    if (endpoint === "settings/describe") return this.described;
    if (endpoint === "settings/mutate") return {};
    return answerSelect(endpoint, args, this.rejectUnsupportedEffort);
  }
  async first(endpoint: string, args: Record<string, unknown>) {
    this.calls.push({ endpoint, args });
    if (this.workspaceFrame === undefined) {
      const { DshError } = await import("../server/remote.js");
      throw new DshError("stream", "The host did not send a workspace list");
    }
    return this.workspaceFrame;
  }
  listen(onItem: (value: unknown) => void) {
    this.events.push(onItem);
    onItem({ type: "ready", clientId: "client-1", host: { home: "/Users/me/.dsh" } });
    return () => undefined;
  }
  follow(_sessionId: string, onItem: (value: unknown) => void) {
    this.follows.push(onItem);
    return () => undefined;
  }
  async close() {}
}

function scriptedSession(
  script: Script,
  endpoint: string,
):
  | { running: boolean; pendingInput: never[]; queue: never[] }
  | { records: unknown[]; hasMore: boolean } {
  if (endpoint === "session/state") {
    return { running: script.childRunning, pendingInput: [], queue: [] };
  }
  return script.historyPages.shift() ?? { records: [], hasMore: false };
}

async function answerSelect(
  endpoint: string,
  args: Record<string, unknown>,
  rejectEffort: boolean,
): Promise<Record<string, unknown>> {
  const request = args.request;
  const effort =
    request && typeof request === "object" && "reasoningEffort" in request
      ? request.reasoningEffort
      : undefined;
  if (endpoint !== "session/selectModel" || !rejectEffort || !effort) return {};
  const { DshError } = await import("../server/remote.js");
  throw new DshError(
    "session/model-unavailable",
    'provider "a6api" model "gpt-6.1-sol" does not support reasoning effort "high"',
  );
}

function createdWorkspace(request: unknown): {
  workspace: { workspaceId: string; path: string };
  created: true;
} {
  const folder =
    request && typeof request === "object" && "path" in request && typeof request.path === "string"
      ? request.path
      : "/repo";
  return {
    workspace: { workspaceId: "ws-1", path: folder },
    created: true,
  };
}

function child(): ChildProcess {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const process = new EventEmitter() as ChildProcess;
  process.stdout = Object.assign(stdout, { setEncoding: () => {} }) as ChildProcess["stdout"];
  process.stderr = Object.assign(stderr, { setEncoding: () => {} }) as ChildProcess["stderr"];
  process.kill = () => true;
  setTimeout(() => stdout.emit("data", "ready http://127.0.0.1:4010/?token=secret\n"), 0);
  return process;
}

function settings(values: {
  installId: string | null;
  mode: "build" | "attach" | null;
}): SettingsSource {
  return {
    async read() {
      return { status: "ready", values };
    },
  };
}

async function open(
  provider: ProviderRegistration,
  script: Script,
): Promise<{
  connection: ProviderConnection;
  events: ProviderEvent[];
}> {
  const connection = await provider.connect({
    versions: [1],
    capabilities: PROVIDER_CAPABILITIES,
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  void script;
  return { connection, events };
}

async function until(
  events: ProviderEvent[],
  predicate: (event: ProviderEvent) => boolean,
): Promise<ProviderEvent> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const found = events.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Missing event. Saw ${events.map((event) => event.type).join(",")}`);
}

function harness(
  installs: DiscoveredInstall[],
  selected: DiscoveredInstall,
  mode: "build" | "attach",
  roster?: SessionRoster,
) {
  const script = new Script();
  const spawned: DiscoveredInstall[] = [];
  const controls: HostControls = {
    spawn(install) {
      spawned.push(install);
      return child();
    },
    async exchange() {
      return { origin: "http://127.0.0.1:4010", cookie: "dsh-auth=cookie" };
    },
    connect() {
      return script;
    },
  };
  const pool = new HostPool(controls);
  const provider = createDshProvider({
    settings: settings({ installId: selected.id, mode }),
    pool,
    discover: async () => installs,
    roster,
  });
  return { script, spawned, pool, provider };
}

test("build uses the selected install's host entry and not another dsh", async () => {
  const { script, spawned, provider } = harness([desktop, next], desktop, "build");
  const { connection, events } = await open(provider, script);
  await connection.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "paseo-1",
    history: "replay",
    config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true },
  });
  await until(events, (event) => event.type === "session.ready");
  expect(spawned.map((install) => install.launch?.command)).toEqual([desktop.launch?.command]);
  expect(script.calls.find((call) => call.endpoint === "workspace/create")?.args).toEqual({
    request: { path: "/repo" },
  });
  expect(script.calls.find((call) => call.endpoint === "session/create")?.args).toEqual({
    request: { workspaceId: "ws-1" },
  });
  expect(script.calls.find((call) => call.endpoint === "commands/execute")?.args).toEqual({
    agentId: "dsh-1",
    line: "/permission workspace-write",
    submittedAttachments: [],
  });
  const commands = events.find((event) => event.type === "session.commands");
  expect(
    commands && commands.type === "session.commands"
      ? commands.commands.map((command) => command.name)
      : [],
  ).toContain("review");
  await connection.close();
});

test("lists human sessions and the workspaces that contain them", async () => {
  const { script, pool, provider } = harness([next], next, "attach");
  await pool.attach(next, "http://127.0.0.1:4010/?token=secret");
  script.sessionItems = {
    items: [
      {
        sessionId: "s1",
        cwd: "/repo",
        updatedAt: 1_700_000_000_000,
        projections: { values: { title: "Hello", contextTimeline: { lastUser: "ping" } } },
      },
      { sessionId: "child", origin: "subagent", cwd: "/repo" },
    ],
  };
  script.workspaceFrame = {
    type: "baseline",
    value: {
      items: [
        {
          workspaceId: "w1",
          path: "/repo",
          title: "Repo",
          sessionIds: ["s1", "child"],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
      ],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    },
  };
  const { connection, events } = await open(provider, script);
  await connection.send({ type: "sessions", requestId: "list-1", limit: 10 });
  const listed = await until(events, (event) => event.type === "sessions");
  expect(script.calls.find((call) => call.endpoint === "session/list")?.args).toEqual({
    _request: {},
  });
  expect(listed).toMatchObject({
    requestId: "list-1",
    sessions: [
      {
        cwd: "/repo",
        title: "Hello",
        description: "ping",
        persistence: { version: 1, data: { sessionId: "s1" } },
      },
    ],
  });
  await expect(
    listConnectedWorkspaces({
      settings: settings({ installId: next.id, mode: "attach" }),
      pool,
      discover: async () => [next],
    }),
  ).resolves.toEqual([
    {
      id: "w1",
      title: "Repo",
      path: "/repo",
      updatedAt: "2026-01-02T00:00:00.000Z",
      sessionCount: 1,
    },
  ]);
  await connection.close();
});

test("direct use does not spawn or record a process", async () => {
  const { script, spawned, pool, provider } = harness([next], next, "attach");
  await pool.attach(next, "http://127.0.0.1:4010/?token=secret");
  const { connection, events } = await open(provider, script);
  await connection.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "paseo-1",
    history: "skip",
    config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true },
  });
  const ready = await until(events, (event) => event.type === "session.ready");
  expect(ready).toMatchObject({ requestId: "open-1" });
  expect(script.follows).toHaveLength(1);
  expect(spawned).toEqual([]);
  const stop = events.find((event) => event.type === "session.can_stop_runtime");
  await connection.send({
    type: "session.can_stop_runtime",
    requestId: "stop-1",
    sessionId: "paseo-1",
  });
  const answer = await until(events, (event) => event.type === "session.can_stop_runtime");
  expect(stop ?? answer).toMatchObject({ canStop: false });
  await connection.close();
});

test("an attached host accepts a message while Paseo tools stay uninjected", async () => {
  const { script, pool, provider } = harness([next], next, "attach");
  await pool.attach(next, "http://127.0.0.1:4010/?token=secret");
  const { connection, events } = await open(provider, script);
  await connection.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "paseo-1",
    history: "skip",
    config: {
      cwd: "/repo",
      env: {},
      mcpServers: {
        paseo: { type: "http", url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=paseo-1" },
      },
      settings: {},
      persist: true,
    },
  });
  await until(events, (event) => event.type === "session.ready");
  await connection.send({
    type: "session.prompt",
    sessionId: "paseo-1",
    prompt: {
      clientMessageId: "msg-1",
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "hello" }] },
    },
  });
  await until(
    events,
    (event) => event.type === "session.prompt_result" && event.clientMessageId === "msg-1",
  );
  expect(script.calls.find((call) => call.endpoint === "session/prompt")?.args).toEqual({
    request: {
      requestId: "msg-1",
      sessionId: "dsh-1",
      mode: "queue",
      content: [{ type: "text", text: "hello" }],
    },
  });
  expect(events.some((event) => event.type === "request.failed")).toBe(false);
  await connection.close();
});

test("a held writer stays visible and does not open an empty session", async () => {
  const { script, provider } = harness([desktop], desktop, "build");
  script.failCreate = true;
  const { connection, events } = await open(provider, script);
  await connection.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "paseo-1",
    history: "skip",
    config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true },
  });
  const failed = await until(events, (event) => event.type === "request.failed");
  expect(failed).toMatchObject({ error: { code: "session/writer-held" } });
  expect(events.some((event) => event.type === "session.opened")).toBe(false);
  await connection.close();
});

test("model default effort is omitted, questions can be cancelled, and unknown events remain", async () => {
  const { script, provider } = harness([desktop], desktop, "build");
  const { connection, events } = await open(provider, script);
  await connection.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "paseo-1",
    history: "replay",
    config: {
      cwd: "/repo",
      env: {},
      mcpServers: {},
      settings: {},
      persist: true,
      model: modelId(),
    },
  });
  await until(events, (event) => event.type === "session.ready");
  const config = events.find((event) => event.type === "session.config");
  expect(
    config && config.type === "session.config" ? config.config.models[0] : undefined,
  ).toMatchObject({
    id: modelId(),
    label: "V4",
    description: "DeepSeek",
  });
  await connection.send({
    type: "session.configure",
    requestId: "config-1",
    sessionId: "paseo-1",
    changes: { model: modelId(), thinkingOption: "provider-default" },
  });
  await until(
    events,
    (event) => event.type === "request.completed" && event.requestId === "config-1",
  );
  expect(script.calls.find((call) => call.endpoint === "session/selectModel")?.args).toEqual({
    request: {
      sessionId: "dsh-1",
      provider: "deepseek",
      model: "v4",
    },
  });

  script.events[0]?.({
    type: "waterfall",
    event: "user-questions/request",
    eventId: "question-1",
    agentId: "dsh-1",
    request: {
      questions: [{ id: "q1", question: "Pick one", header: "Pick", options: [{ label: "A" }] }],
    },
  });
  await until(events, (event) => event.type === "session.permission");
  await connection.send({
    type: "session.permission",
    sessionId: "paseo-1",
    permissionId: "q1",
    response: { behavior: "deny", message: "Dismissed by user" },
  });
  await until(events, (event) => event.type === "session.permission_resolved");
  expect(script.calls.find((call) => call.endpoint === "$events/result")?.args).toMatchObject({
    clientId: "client-1",
    eventId: "question-1",
    outcome: { kind: "rejected", error: { code: "ASK_CANCELLED" } },
  });

  script.follows[0]?.({
    type: "event",
    event: { type: "future/widget", seq: 4, data: { kept: true } },
  });
  const item = await until(events, (event) => event.type === "timeline.item");
  expect(item).toMatchObject({ item: { type: "plugin", kind: "dsh-event" } });
  await connection.close();
});

test("approval and plan review answer the host waterfall", async () => {
  const { script, provider } = harness([desktop], desktop, "build");
  const { connection, events } = await open(provider, script);
  await connection.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "paseo-1",
    history: "skip",
    config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true },
  });
  await until(events, (event) => event.type === "session.ready");
  script.events[0]?.({
    type: "waterfall",
    event: "approval/request",
    eventId: "approval-1",
    agentId: "dsh-1",
    request: { toolName: "bash", reason: "run ls" },
  });
  const permission = await until(events, (event) => event.type === "session.permission");
  expect(permission).toMatchObject({ request: { kind: "tool", id: "approval-1" } });
  await connection.send({
    type: "session.permission",
    sessionId: "paseo-1",
    permissionId: "approval-1",
    response: { behavior: "allow", selectedActionId: "allow" },
  });
  await until(events, (event) => event.type === "session.permission_resolved");
  expect(script.calls.find((call) => call.endpoint === "$events/result")?.args).toMatchObject({
    outcome: { kind: "result", value: "allowed-once" },
  });
  await connection.close();
});

test("team tasks and teammates are visible to Paseo and the roster", async () => {
  const roster = new SessionRoster();
  const { script, provider } = harness([desktop], desktop, "build", roster);
  const { connection, events } = await open(provider, script);
  await connection.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "paseo-1",
    history: "skip",
    config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true },
  });
  await until(events, (event) => event.type === "session.ready");
  const lead = script.follows[0];
  const task = (status: string, id: string) => ({
    type: "event" as const,
    event: {
      type: "team/task",
      seq: 1,
      data: {
        version: 1,
        teamId: "dsh-1",
        task: {
          id,
          revision: 1,
          subject: id === "task-1" ? "写文档" : "已删",
          description: "",
          status,
          blockedBy: [],
          writeScopes: [],
        },
      },
    },
  });
  lead?.({ ...task("pending", "task-1"), event: { ...task("pending", "task-1").event, seq: 1 } });
  lead?.(task("in_progress", "task-1"));
  lead?.(task("pending", "task-2"));
  lead?.(task("deleted", "task-2"));
  expect(script.follows).toHaveLength(1);
  lead?.({
    type: "event",
    event: {
      type: "team/member",
      seq: 5,
      data: {
        version: 1,
        teamId: "dsh-1",
        member: {
          id: "mate-provisioning",
          name: "writer",
          description: "写",
          provider: "dsh",
          context: "fresh",
          phase: "provisioning",
        },
      },
    },
  });
  expect(script.follows).toHaveLength(1);
  const provisioning = await until(
    events,
    (event) => event.type === "session.opened" && event.sessionId === "mate-provisioning",
  );
  expect(provisioning).toMatchObject({
    title: "writer",
    description: "写",
    parentSessionId: "paseo-1",
  });
  lead?.({
    type: "event",
    event: {
      type: "team/member",
      seq: 6,
      data: {
        version: 1,
        teamId: "dsh-1",
        member: {
          id: "mate",
          name: "reviewer",
          description: "看 diff",
          provider: "dsh",
          context: "fresh",
          phase: "active",
        },
      },
    },
  });
  expect(script.follows).toHaveLength(2);
  script.follows[1]?.({ type: "snapshot", records: [] });
  const opened = await until(
    events,
    (event) => event.type === "session.opened" && event.sessionId === "mate",
  );
  expect(opened).toMatchObject({
    title: "reviewer",
    description: "看 diff",
    parentSessionId: "paseo-1",
  });
  lead?.({
    type: "event",
    event: { type: "team/message/queued", seq: 7, data: { version: 1, teamId: "dsh-1" } },
  });
  const todos = events.filter(
    (event) => event.type === "timeline.item" && event.item.type === "todo",
  );
  const latest = todos.at(-1);
  expect(latest).toMatchObject({
    sessionId: "paseo-1",
    item: {
      items: [{ id: "task-1", text: "写文档", status: "in_progress", completed: false }],
    },
  });
  expect(
    events.some((event) => event.type === "timeline.item" && event.item.type === "plugin"),
  ).toBe(false);
  expect(roster.read("dsh-1")).toMatchObject({
    providerSessionId: "paseo-1",
    tasks: [{ id: "task-1", status: "in_progress" }],
    children: [
      { sessionId: "mate-provisioning", kind: "teammate", phase: "provisioning" },
      { sessionId: "mate", kind: "teammate", phase: "active" },
    ],
  });
  expect(roster.read("paseo-1")?.tasks).toHaveLength(1);
  await connection.close();
});

test("a subagent row opens under its parent", async () => {
  const { script, provider } = harness([desktop], desktop, "build");
  const { connection, events } = await open(provider, script);
  await connection.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "paseo-1",
    history: "skip",
    config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true },
  });
  await until(events, (event) => event.type === "session.ready");
  script.events[0]?.({
    type: "emit",
    event: "api-session/added",
    args: [{ origin: "subagent", sessionId: "child", parentSessionId: "dsh-1", cwd: "/repo" }],
  });
  script.follows.at(-1)?.({
    type: "snapshot",
    records: [
      {
        type: "event",
        event: {
          type: "subagent/descriptor",
          seq: 1,
          data: { label: "调研", mode: "continuable" },
        },
      },
      {
        type: "event",
        event: {
          type: "user/message",
          seq: 2,
          data: {
            source: { kind: "agent-message" },
            content: [{ type: "text", text: "去做" }],
          },
        },
      },
      { type: "event", event: { type: "turn/start", seq: 3, data: {} } },
      {
        type: "event",
        event: { type: "turn/end", seq: 4, data: { reason: { kind: "completed" } } },
      },
    ],
  });
  const opened = await until(
    events,
    (event) => event.type === "session.opened" && event.sessionId === "child",
  );
  expect(opened).toMatchObject({
    parentSessionId: "paseo-1",
    restoration: "parent",
    title: "调研",
    persistence: { data: { sessionId: "child" } },
  });
  expect(opened).not.toHaveProperty("description");
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "timeline.item",
      sessionId: "child",
      item: expect.objectContaining({ text: "去做" }),
    }),
  );
  await until(
    events,
    (event) =>
      event.type === "session.turn" && event.sessionId === "child" && event.state === "completed",
  );
  await connection.close();
});

test("the catalog projection opens every child the log page left out", async () => {
  const { script, provider } = harness([desktop], desktop, "build");
  const { connection, events } = await open(provider, script);
  await connection.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "paseo-1",
    history: "skip",
    config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true },
  });
  await until(events, (event) => event.type === "session.ready");
  script.follows[0]?.({
    type: "snapshot",
    projections: {
      values: {
        subagentCatalog: [
          { id: "child-a", label: "甲", mode: "continuable" },
          { id: "child-b", label: "乙", mode: "one-shot" },
        ],
      },
    },
    records: [],
  });
  const opened = events.filter(
    (event) => event.type === "session.opened" && event.parentSessionId === "paseo-1",
  );
  expect(opened.map((event) => (event.type === "session.opened" ? event.sessionId : ""))).toEqual([
    "child-a",
    "child-b",
  ]);
  expect(opened).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sessionId: "child-a", title: "甲" }),
      expect.objectContaining({ sessionId: "child-b", title: "乙" }),
    ]),
  );
  await connection.close();
});

test("a child that is still running is not left failed by an older turn", async () => {
  const { script, provider } = harness([desktop], desktop, "build");
  const { connection, events } = await open(provider, script);
  await connection.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "paseo-1",
    history: "skip",
    config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true },
  });
  await until(events, (event) => event.type === "session.ready");
  script.events[0]?.({
    type: "emit",
    event: "api-session/added",
    args: [{ origin: "subagent", sessionId: "child", parentSessionId: "dsh-1", cwd: "/repo" }],
  });
  script.childRunning = true;
  script.follows.at(-1)?.({
    type: "snapshot",
    records: [
      {
        type: "event",
        event: { type: "subagent/descriptor", seq: 1, data: { label: "调研" } },
      },
      {
        type: "event",
        event: {
          type: "turn/end",
          seq: 2,
          data: { reason: { kind: "error", error: { message: "stale" } } },
        },
      },
    ],
  });
  await until(
    events,
    (event) =>
      event.type === "session.turn" && event.sessionId === "child" && event.state === "started",
  );
  expect(events.some((event) => event.type === "session.turn" && event.state === "failed")).toBe(
    false,
  );
  await connection.close();
});

test("an idle child is not failed when its last turn ended in error", async () => {
  const { script, provider } = harness([desktop], desktop, "build");
  const { connection, events } = await open(provider, script);
  await connection.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "paseo-1",
    history: "skip",
    config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true },
  });
  await until(events, (event) => event.type === "session.ready");
  script.events[0]?.({
    type: "emit",
    event: "api-session/added",
    args: [{ origin: "subagent", sessionId: "child", parentSessionId: "dsh-1", cwd: "/repo" }],
  });
  script.follows.at(-1)?.({
    type: "snapshot",
    projections: {
      values: {
        subagent: { label: "调研", mode: "continuable" },
        subagentTiming: { settledMs: 0, lastTurnCompleted: false },
      },
    },
    records: [
      {
        type: "event",
        event: {
          type: "turn/end",
          seq: 2,
          data: { reason: { kind: "error", error: { message: "stale" } } },
        },
      },
    ],
  });
  const notice = await until(
    events,
    (event) => event.type === "session.notice" && event.sessionId === "child",
  );
  expect(notice).toMatchObject({
    notice: { description: "可继续 · 未在运行" },
  });
  expect(events.some((event) => event.type === "session.turn" && event.state === "failed")).toBe(
    false,
  );
  expect(events).toContainEqual(
    expect.objectContaining({ type: "session.turn", sessionId: "child", state: "completed" }),
  );
  await connection.close();
});

test("a child name comes from the identity projection when the descriptor is off the page", async () => {
  const { script, provider } = harness([desktop], desktop, "build");
  const { connection, events } = await open(provider, script);
  await connection.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "paseo-1",
    history: "skip",
    config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true },
  });
  await until(events, (event) => event.type === "session.ready");
  script.events[0]?.({
    type: "emit",
    event: "api-session/added",
    args: [{ origin: "subagent", sessionId: "child", parentSessionId: "dsh-1", cwd: "/repo" }],
  });
  script.follows.at(-1)?.({
    type: "snapshot",
    projections: {
      values: {
        subagent: { label: "调研", mode: "one-shot" },
        title: "查资料",
        subagentTiming: { settledMs: 3000, lastTurnCompleted: true },
        tokenUsage: {
          uncachedInputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
    },
    records: [],
  });
  const opened = await until(
    events,
    (event) => event.type === "session.opened" && event.sessionId === "child",
  );
  expect(opened).toMatchObject({ title: "调研" });
  expect(opened).not.toHaveProperty("description");
  const notice = await until(
    events,
    (event) => event.type === "session.notice" && event.sessionId === "child",
  );
  expect(notice).toMatchObject({
    notice: { description: "查资料 · 一次性 · 已完成 · 1.5k · 3秒" },
  });
  await connection.close();
});

test("a one-shot child with no label is named by its session id", async () => {
  const { script, provider } = harness([desktop], desktop, "build");
  const { connection, events } = await open(provider, script);
  await connection.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "paseo-1",
    history: "skip",
    config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true },
  });
  await until(events, (event) => event.type === "session.ready");
  script.follows[0]?.({
    type: "snapshot",
    projections: { values: { subagentCatalog: [{ id: "plain", mode: "one-shot" }] } },
    records: [],
  });
  script.follows.at(-1)?.({ type: "snapshot", records: [] });
  const opened = await until(
    events,
    (event) => event.type === "session.opened" && event.sessionId === "plain",
  );
  expect(opened).toMatchObject({ title: "plain" });
  const notice = await until(
    events,
    (event) => event.type === "session.notice" && event.sessionId === "plain",
  );
  expect(notice).toMatchObject({ notice: { description: "一次性 · 未在运行" } });
  await connection.close();
});

test("an external child is completed without a log or an activity", async () => {
  const { script, provider } = harness([desktop], desktop, "build");
  const { connection, events } = await open(provider, script);
  await connection.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "paseo-1",
    history: "skip",
    config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true },
  });
  await until(events, (event) => event.type === "session.ready");
  const follows = script.follows.length;
  script.follows[0]?.({
    type: "snapshot",
    projections: {
      values: { subagentCatalog: [{ id: "ext", label: "外面", mode: "external" }] },
    },
    records: [],
  });
  const opened = await until(
    events,
    (event) => event.type === "session.opened" && event.sessionId === "ext",
  );
  expect(opened).toMatchObject({ title: "外面" });
  expect(script.follows).toHaveLength(follows);
  expect(events).toContainEqual(
    expect.objectContaining({ type: "session.turn", sessionId: "ext", state: "completed" }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "session.notice",
      sessionId: "ext",
      notice: expect.objectContaining({ description: "外部" }),
    }),
  );
  await connection.close();
});

test("a failed teammate stays failed", async () => {
  const { script, provider } = harness([desktop], desktop, "build");
  const { connection, events } = await open(provider, script);
  await connection.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "paseo-1",
    history: "skip",
    config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true },
  });
  await until(events, (event) => event.type === "session.ready");
  script.follows[0]?.({
    type: "event",
    event: {
      type: "team/member",
      seq: 1,
      data: {
        version: 1,
        teamId: "dsh-1",
        member: {
          id: "mate-failed",
          name: "writer",
          description: "写",
          phase: "failed",
        },
      },
    },
  });
  await until(
    events,
    (event) =>
      event.type === "session.turn" &&
      event.sessionId === "mate-failed" &&
      event.state === "failed",
  );
  expect(script.follows).toHaveLength(1);
  expect(
    events.some(
      (event) =>
        event.type === "session.turn" &&
        event.sessionId === "mate-failed" &&
        event.state === "completed",
    ),
  ).toBe(false);
  await connection.close();
});

test("a child log page keeps the older rows ahead of the tail", async () => {
  const { script, provider } = harness([desktop], desktop, "build");
  const { connection, events } = await open(provider, script);
  await connection.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "paseo-1",
    history: "skip",
    config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true },
  });
  await until(events, (event) => event.type === "session.ready");
  script.events[0]?.({
    type: "emit",
    event: "api-session/added",
    args: [
      {
        origin: "subagent",
        sessionId: "child",
        parentSessionId: "dsh-1",
        cwd: "/repo",
        projections: { values: { subagent: { label: "调研" } } },
      },
    ],
  });
  script.historyPages = [
    {
      hasMore: false,
      records: [
        {
          type: "event",
          event: {
            type: "user/message",
            seq: 1,
            data: {
              source: { kind: "agent-message" },
              content: [{ type: "text", text: "先做这个" }],
            },
          },
        },
      ],
    },
  ];
  script.follows.at(-1)?.({
    type: "snapshot",
    hasMore: true,
    records: [
      {
        type: "event",
        event: {
          type: "assistant/message",
          seq: 8,
          data: { message: { content: [{ type: "text", text: "后半段" }] } },
        },
      },
    ],
  });
  await until(
    events,
    (event) => event.type === "timeline.item" && event.item.type === "user_message",
  );
  const texts = events.flatMap((event) =>
    event.type === "timeline.item" && event.sessionId === "child" && "text" in event.item
      ? [event.item.text]
      : [],
  );
  expect(texts).toEqual(["先做这个", "后半段"]);
  await connection.close();
});

test("a child approval is answered by that child and titled with its name", async () => {
  const { script, provider } = harness([desktop], desktop, "build");
  const { connection, events } = await open(provider, script);
  await connection.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "paseo-1",
    history: "skip",
    config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true },
  });
  await until(events, (event) => event.type === "session.ready");
  script.events[0]?.({
    type: "emit",
    event: "api-session/added",
    args: [
      {
        origin: "subagent",
        sessionId: "child",
        parentSessionId: "dsh-1",
        cwd: "/repo",
        projections: { values: { subagent: { label: "调研" } } },
      },
    ],
  });
  script.follows.at(-1)?.({
    type: "snapshot",
    records: [
      {
        type: "event",
        event: { type: "subagent/descriptor", seq: 1, data: { label: "调研" } },
      },
    ],
  });
  await until(events, (event) => event.type === "session.opened" && event.sessionId === "child");
  script.events[0]?.({
    type: "waterfall",
    event: "approval/request",
    eventId: "approval-child",
    agentId: "child",
    request: { toolName: "bash", reason: "run ls" },
  });
  const permission = await until(events, (event) => event.type === "session.permission");
  expect(permission).toMatchObject({
    sessionId: "paseo-1",
    request: { id: "approval-child", title: "调研", description: "run ls", name: "bash" },
  });
  await connection.send({
    type: "session.permission",
    sessionId: "paseo-1",
    permissionId: "approval-child",
    response: { behavior: "allow", selectedActionId: "allow" },
  });
  await until(events, (event) => event.type === "session.permission_resolved");
  expect(script.calls.find((call) => call.endpoint === "$events/result")?.args).toMatchObject({
    clientId: "client-1",
    eventId: "approval-child",
    outcome: { kind: "result", value: "allowed-once" },
  });
  await connection.close();
});

test("an approval for a session that is not open is declined", async () => {
  const { script, provider } = harness([desktop], desktop, "build");
  const { connection, events } = await open(provider, script);
  await connection.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "paseo-1",
    history: "skip",
    config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true },
  });
  await until(events, (event) => event.type === "session.ready");
  script.events[0]?.({
    type: "waterfall",
    event: "approval/request",
    eventId: "approval-missing",
    agentId: "other",
    request: { toolName: "bash", reason: "run ls" },
  });
  const deadline = Date.now() + 2000;
  while (!script.calls.some((call) => call.endpoint === "$events/result")) {
    if (Date.now() > deadline) throw new Error("Missing waterfall decline");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(script.calls.find((call) => call.endpoint === "$events/result")?.args).toEqual({
    clientId: "client-1",
    eventId: "approval-missing",
    outcome: { kind: "next" },
  });
  expect(events.some((event) => event.type === "session.permission")).toBe(false);
  await connection.close();
});

test("a remote call retries a refused connection and hides the address", async () => {
  let attempts = 0;
  const client = createRemoteClient({
    origin: "http://127.0.0.1:9",
    cookie: "dsh-auth=cookie",
    socket: { send() {}, close() {}, addEventListener() {} },
    fetchImpl: async () => {
      attempts += 1;
      const cause = new Error("connect ECONNREFUSED http://127.0.0.1:9/?token=secret");
      Object.assign(cause, { code: "ECONNREFUSED" });
      throw new TypeError("fetch failed", { cause });
    },
  });
  const failure = client.call("session/modelCatalog", {}).then(
    () => {
      throw new Error("expected the call to fail");
    },
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  const message = await failure;
  expect(attempts).toBe(2);
  expect(message).toContain("not accepting connections");
  expect(message).not.toContain("secret");
  expect(message).not.toContain("http");
  await client.close();
});

test("a remote call uses the second attempt when the first connection fails", async () => {
  let attempts = 0;
  const client = createRemoteClient({
    origin: "http://127.0.0.1:9",
    cookie: "dsh-auth=cookie",
    socket: { send() {}, close() {}, addEventListener() {} },
    fetchImpl: async (_input, init) => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("fetch failed");
      const message = JSON.parse(String(init?.body)) as { rpcId?: unknown };
      return new Response(
        JSON.stringify({
          type: "server-response",
          rpcId: message.rpcId,
          result: { ok: true, value: { groups: [] } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  await expect(client.call("session/modelCatalog", {})).resolves.toEqual({ groups: [] });
  expect(attempts).toBe(2);
  await client.close();
});

test("a remote call sends the client-request envelope", async () => {
  let seen: unknown;
  const client = createRemoteClient({
    origin: "http://127.0.0.1:9",
    cookie: "dsh-auth=cookie",
    socket: { send() {}, close() {}, addEventListener() {} },
    fetchImpl: async (_input, init) => {
      seen = JSON.parse(String(init?.body));
      const message = seen as { rpcId?: unknown };
      return new Response(
        JSON.stringify({
          type: "server-response",
          rpcId: message.rpcId,
          result: { ok: true, value: { groups: [] } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  await expect(client.call("session/modelCatalog", {})).resolves.toEqual({ groups: [] });
  expect(seen).toMatchObject({
    type: "client-request",
    method: "session/modelCatalog",
    payload: { args: {} },
  });
  const rpcId = (seen as { rpcId?: unknown }).rpcId;
  expect(typeof rpcId).toBe("string");
  expect(rpcId).not.toBe("");
  await client.close();
});

test("the mux socket uses the process WebSocket", async () => {
  const client = createRemoteClient({ origin: "http://127.0.0.1:9", cookie: "dsh-auth=cookie" });
  await client.close();
});

test("a browser address token is read and omitted from login errors", async () => {
  const loginUrl = "http://127.0.0.1:55461/?token=browser-token";
  expect(assertLoopbackLogin(loginUrl).searchParams.get("token")).toBe("browser-token");
  const failure = exchangeLogin(loginUrl, async () => {
    throw new Error(`connect failed ${loginUrl}`);
  }).then(
    () => {
      throw new Error("expected login to fail");
    },
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  const message = await failure;
  expect(message).toContain("[url]");
  expect(message).not.toContain("browser-token");
});

test("login exchange keeps the cookie and drops the token from errors", async () => {
  expect(redact("failed http://127.0.0.1:9/?token=secret")).toBe("failed [url]");
  let seen = "";
  const server = createServer((request, response) => {
    seen = request.url ?? "";
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/" && url.searchParams.get("token")) {
      response.statusCode = 303;
      response.setHeader("location", "./");
      response.setHeader("set-cookie", "dsh-auth=cookie; HttpOnly; Path=/");
      response.end();
      return;
    }
    response.statusCode = 401;
    response.end("unauthorized");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const exchanged = await exchangeLogin(`http://127.0.0.1:${port}/?token=secret`);
    expect(seen.startsWith("/?token=")).toBe(true);
    expect(seen).not.toContain("/connect");
    expect(exchanged.cookie).toBe("dsh-auth=cookie");
    expect(JSON.stringify(exchanged)).not.toContain("secret");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});

test("a saved login reconnects without the address and shares one catalog", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dsh-session-"));
  try {
    const script = new Script();
    let exchanges = 0;
    const controls: HostControls = {
      spawn() {
        throw new Error("build");
      },
      async exchange() {
        exchanges += 1;
        return { origin: "http://127.0.0.1:4010", cookie: "dsh-auth=cookie" };
      },
      connect() {
        return script;
      },
    };
    const sessions = new SessionFile(path.join(directory, "session.json"));
    await sessions.write({
      installId: next.id,
      origin: "http://127.0.0.1:4010",
      cookie: "dsh-auth=cookie",
    });
    expect((await stat(path.join(directory, "session.json"))).mode & 0o077).toBe(0);
    expect(await readFile(path.join(directory, "session.json"), "utf8")).not.toContain("token=");
    const provider = createDshProvider({
      settings: settings({ installId: next.id, mode: "attach" }),
      pool: new HostPool(controls),
      sessions,
      discover: async () => [next],
    });
    const globalKey = await provider.getCatalogCacheKey!({ scope: "global" });
    const workspaceKey = await provider.getCatalogCacheKey!({
      scope: "workspace",
      cwd: "/repo",
    });
    expect(workspaceKey).toBe(globalKey);
    expect(exchanges).toBe(0);
    await expect(provider.status!({})).resolves.toMatchObject({ available: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a rejected saved login is forgotten and the catalog key changes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dsh-session-"));
  try {
    const script = new Script();
    script.unauthorizedCatalog = true;
    const controls: HostControls = {
      spawn() {
        throw new Error("build");
      },
      async exchange() {
        return { origin: "http://127.0.0.1:4010", cookie: "dsh-auth=cookie" };
      },
      connect() {
        return script;
      },
    };
    const pool = new HostPool(controls);
    const sessions = new SessionFile(path.join(directory, "session.json"));
    await sessions.write({
      installId: next.id,
      origin: "http://127.0.0.1:4010",
      cookie: "dsh-auth=cookie",
    });
    const provider = createDshProvider({
      settings: settings({ installId: next.id, mode: "attach" }),
      pool,
      sessions,
      discover: async () => [next],
    });
    const connected = await provider.getCatalogCacheKey!({ scope: "global" });
    const connection = await provider.connect({
      versions: [1],
      capabilities: PROVIDER_CAPABILITIES,
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await connection.send({ type: "catalog", requestId: "cat-1" });
    await until(events, (event) => event.type === "request.failed");
    expect(await sessions.read()).toBeUndefined();
    expect(pool.hasAttachment(next.id)).toBe(false);
    const cleared = await provider.getCatalogCacheKey!({ scope: "workspace", cwd: "/repo" });
    expect(cleared).not.toBe(connected);
    await connection.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unreachable saved host is not available and the catalog key changes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dsh-session-"));
  try {
    const script = new Script();
    script.failPing = true;
    const controls: HostControls = {
      spawn() {
        throw new Error("build");
      },
      async exchange() {
        return { origin: "http://127.0.0.1:4010", cookie: "dsh-auth=cookie" };
      },
      connect() {
        return script;
      },
    };
    const pool = new HostPool(controls);
    const sessions = new SessionFile(path.join(directory, "session.json"));
    await sessions.write({
      installId: next.id,
      origin: "http://127.0.0.1:4010",
      cookie: "dsh-auth=cookie",
    });
    const provider = createDshProvider({
      settings: settings({ installId: next.id, mode: "attach" }),
      pool,
      sessions,
      discover: async () => [next],
    });
    const connected = await provider.getCatalogCacheKey!({ scope: "global" });
    const status = await provider.status!({});
    expect(status.available).toBe(false);
    expect(status.diagnostic).toContain("not accepting connections");
    expect(status.diagnostic).toContain("Paste the browser address again.");
    expect(status.diagnostic).not.toContain("http");
    expect(pool.hasAttachment(next.id)).toBe(false);
    expect(await sessions.read()).toBeUndefined();
    const retried = await provider.getCatalogCacheKey!({ scope: "global" });
    expect(retried).not.toBe(connected);
    const again = await provider.status!({});
    expect(again.available).toBe(false);
    expect(again.diagnostic).toContain("Paste this client's loopback login link");
    const settled = await provider.getCatalogCacheKey!({ scope: "global" });
    expect(settled).toBe(retried);
    await sessions.write({
      installId: next.id,
      origin: "http://127.0.0.1:4010",
      cookie: "dsh-auth=cookie",
    });
    const blocked = await provider.getCatalogCacheKey!({ scope: "global" });
    expect(blocked).toBe(settled);
    expect(pool.hasAttachment(next.id)).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an open connection follows a newly attached host", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dsh-session-"));
  try {
    const first = new Script();
    const second = new Script();
    const scripts = [first, second];
    let index = 0;
    const controls: HostControls = {
      spawn() {
        throw new Error("build");
      },
      async exchange(loginUrl) {
        return { origin: new URL(loginUrl).origin, cookie: "dsh-auth=cookie" };
      },
      connect() {
        const script = scripts[index] ?? second;
        index += 1;
        return script;
      },
    };
    const pool = new HostPool(controls);
    const sessions = new SessionFile(path.join(directory, "session.json"));
    await sessions.write({
      installId: next.id,
      origin: "http://127.0.0.1:4010",
      cookie: "dsh-auth=cookie",
    });
    const provider = createDshProvider({
      settings: settings({ installId: next.id, mode: "attach" }),
      pool,
      sessions,
      discover: async () => [next],
    });
    const connection = await provider.connect({
      versions: [1],
      capabilities: PROVIDER_CAPABILITIES,
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await pool.attach(next, "http://127.0.0.1:4011/?token=secret");
    await connection.send({ type: "catalog", requestId: "cat-next" });
    await until(events, (event) => event.type === "catalog");
    expect(second.calls.some((call) => call.endpoint === "session/modelCatalog")).toBe(true);
    expect(first.calls.some((call) => call.endpoint === "session/modelCatalog")).toBe(false);
    expect(second.events).toHaveLength(1);
    await connection.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a stale unauthorized catalog does not forget a newer login", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dsh-session-"));
  try {
    const first = new Script();
    const second = new Script();
    let release: () => void = () => {};
    first.holdCatalog = new Promise<void>((resolve) => {
      release = resolve;
    });
    first.unauthorizedCatalog = true;
    const scripts = [first, second];
    let index = 0;
    const controls: HostControls = {
      spawn() {
        throw new Error("build");
      },
      async exchange(loginUrl) {
        return { origin: new URL(loginUrl).origin, cookie: "dsh-auth=cookie" };
      },
      connect() {
        const script = scripts[index] ?? second;
        index += 1;
        return script;
      },
    };
    const pool = new HostPool(controls);
    const sessions = new SessionFile(path.join(directory, "session.json"));
    await sessions.write({
      installId: next.id,
      origin: "http://127.0.0.1:4010",
      cookie: "dsh-auth=old",
    });
    const provider = createDshProvider({
      settings: settings({ installId: next.id, mode: "attach" }),
      pool,
      sessions,
      discover: async () => [next],
    });
    const connection = await provider.connect({
      versions: [1],
      capabilities: PROVIDER_CAPABILITIES,
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    void connection.send({ type: "catalog", requestId: "cat-old" });
    const deadline = Date.now() + 2000;
    while (first.calls.length === 0) {
      if (Date.now() > deadline) throw new Error("catalog did not start");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await pool.attach(next, "http://127.0.0.1:4011/?token=secret");
    await sessions.write({
      installId: next.id,
      origin: "http://127.0.0.1:4011",
      cookie: "dsh-auth=new",
    });
    release();
    await until(events, (event) => event.type === "request.failed");
    expect(await sessions.read()).toMatchObject({ cookie: "dsh-auth=new" });
    expect(pool.hasAttachment(next.id)).toBe(true);
    await connection.send({ type: "catalog", requestId: "cat-new" });
    await until(events, (event) => event.type === "catalog");
    expect(second.calls.some((call) => call.endpoint === "session/modelCatalog")).toBe(true);
    expect(first.calls.filter((call) => call.endpoint === "session/modelCatalog")).toHaveLength(1);
    await connection.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a model without reasoning offers the efforts another catalog model declared", async () => {
  const { script, provider } = harness([desktop], desktop, "build");
  script.catalog = {
    default: { provider: "deepseek-official", model: "deepseek-flash" },
    groups: [
      {
        id: "deepseek-official",
        name: "DeepSeek",
        models: [
          {
            id: "deepseek-flash",
            name: "DeepSeek-V4.1-Flash",
            reasoning: {
              efforts: [
                { id: "off", name: "Off" },
                { id: "high", name: "High" },
              ],
              defaultEffort: "high",
            },
          },
        ],
      },
      {
        id: "a6api",
        name: "A6API",
        models: [{ id: "gpt-6.1-sol", name: "gpt-6.1-sol", reasoning: null }],
      },
    ],
  };
  const unsupported = JSON.stringify(["a6api", "gpt-6.1-sol"]);
  const supported = JSON.stringify(["deepseek-official", "deepseek-flash"]);
  const { connection, events } = await open(provider, script);
  await connection.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "paseo-1",
    history: "replay",
    config: {
      cwd: "/repo",
      env: {},
      mcpServers: {},
      settings: {},
      persist: true,
      model: unsupported,
      thinkingOption: "high",
    },
  });
  await until(events, (event) => event.type === "session.ready");
  expect(script.calls.find((call) => call.endpoint === "session/selectModel")?.args).toEqual({
    request: {
      sessionId: "dsh-1",
      provider: "a6api",
      model: "gpt-6.1-sol",
      reasoningEffort: "high",
    },
  });
  const config = events.find((event) => event.type === "session.config");
  const models = config && config.type === "session.config" ? config.config.models : [];
  expect(models.find((model) => model.id === unsupported)?.thinkingOptions).toEqual([
    { id: "off", label: "Off" },
    { id: "high", label: "High", isDefault: true },
  ]);
  expect(models.find((model) => model.id === supported)).toMatchObject({
    defaultThinkingOptionId: "high",
  });
  expect(
    config && config.type === "session.config" ? config.config.thinkingOption : undefined,
  ).toBe("high");
  await connection.close();
});

test("a rejected reasoning effort still opens the session", async () => {
  const { script, provider } = harness([desktop], desktop, "build");
  script.rejectUnsupportedEffort = true;
  script.catalog = {
    default: { provider: "deepseek-official", model: "deepseek-flash" },
    groups: [
      {
        id: "deepseek-official",
        name: "DeepSeek",
        models: [
          {
            id: "deepseek-flash",
            name: "DeepSeek-V4.1-Flash",
            reasoning: { efforts: [{ id: "high", name: "High" }], defaultEffort: "high" },
          },
        ],
      },
      {
        id: "a6api",
        name: "A6API",
        models: [{ id: "gpt-6.1-sol", name: "gpt-6.1-sol", reasoning: null }],
      },
    ],
  };
  const unsupported = JSON.stringify(["a6api", "gpt-6.1-sol"]);
  const { connection, events } = await open(provider, script);
  await connection.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "paseo-1",
    history: "replay",
    config: {
      cwd: "/repo",
      env: {},
      mcpServers: {},
      settings: {},
      persist: true,
      model: unsupported,
      thinkingOption: "high",
    },
  });
  await until(events, (event) => event.type === "session.ready");
  const selects = script.calls.filter((call) => call.endpoint === "session/selectModel");
  expect(selects.map((call) => call.args)).toEqual([
    {
      request: {
        sessionId: "dsh-1",
        provider: "a6api",
        model: "gpt-6.1-sol",
        reasoningEffort: "high",
      },
    },
    { request: { sessionId: "dsh-1", provider: "a6api", model: "gpt-6.1-sol" } },
  ]);
  expect(events.some((event) => event.type === "request.failed")).toBe(false);
  const config = events.find((event) => event.type === "session.config");
  expect(
    config && config.type === "session.config" ? config.config.thinkingOption : undefined,
  ).toBe(undefined);
  await connection.close();
});

test("a resumed session shows the host thinking effort and the model name", async () => {
  const { script, provider } = harness([desktop], desktop, "build");
  script.catalog = {
    default: { provider: "deepseek", model: "v4" },
    groups: [
      {
        id: "deepseek",
        name: "DeepSeek",
        models: [
          {
            id: "v4",
            name: "V4",
            description: "Fast",
            reasoning: {
              efforts: [
                { id: "high", name: "High", description: "Deeper" },
                { id: "max", name: "Max" },
              ],
              defaultEffort: "high",
            },
          },
        ],
      },
    ],
  };
  script.projections = {
    kind: "sequenced",
    asOfSeq: 4,
    values: {
      modelSelection: {
        lastUsed: { provider: "deepseek", model: "v4" },
        next: { provider: "deepseek", model: "v4", reasoningEffort: "high" },
      },
    },
  };
  const { connection, events } = await open(provider, script);
  await connection.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "paseo-1",
    history: "replay",
    config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true },
  });
  await until(events, (event) => event.type === "session.ready");
  expect(script.calls.some((call) => call.endpoint === "session/selectModel")).toBe(false);
  const config = events.find((event) => event.type === "session.config");
  expect(config && config.type === "session.config" ? config.config : {}).toMatchObject({
    model: modelId(),
    thinkingOption: "high",
    models: [
      expect.objectContaining({
        id: modelId(),
        label: "V4",
        description: "Fast",
        aliases: ["v4", "deepseek/v4"],
        isDefault: true,
        thinkingOptions: [
          { id: "high", label: "High", description: "Deeper", isDefault: true },
          { id: "max", label: "Max" },
        ],
      }),
    ],
  });
  const model = config && config.type === "session.config" ? config.config.models[0] : undefined;
  expect(model?.description).not.toBe(model?.id);
  script.follows[0]?.({
    type: "event",
    event: {
      type: "model/selection",
      seq: 5,
      data: { provider: "deepseek", model: "v4", reasoningEffort: "max" },
    },
  });
  const updated = await until(
    events,
    (event) => event.type === "session.config" && event.config.thinkingOption === "max",
  );
  expect(updated.type === "session.config" ? updated.config.thinkingOption : undefined).toBe("max");
  await connection.close();
});

test("context window uses the host profile and the composer select", async () => {
  const { script, provider } = harness([desktop], desktop, "build");
  script.providers = [
    {
      provider: "deepseek",
      displayName: "DeepSeek",
      settingsNs: "llm-deepseek",
      settingsPath: [],
    },
  ];
  script.described = {
    namespaces: [
      {
        ns: "llm-deepseek",
        revision: 3,
        value: {
          defaultContextWindow: 1_000_000,
          models: [
            { id: "v4", name: "V4", contextWindow: 1_000_000 },
            { id: "other", name: "Other", contextWindow: 256_000 },
          ],
        },
        base: {
          defaultContextWindow: 1_000_000,
          models: [
            { id: "v4", name: "V4" },
            { id: "other", name: "Other", contextWindow: 256_000 },
          ],
        },
      },
    ],
  };
  const { connection, events } = await open(provider, script);
  await connection.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "paseo-1",
    history: "replay",
    config: {
      cwd: "/repo",
      env: {},
      mcpServers: {},
      settings: {},
      persist: true,
      model: modelId(),
    },
  });
  await until(events, (event) => event.type === "session.ready");
  const config = events.find((event) => event.type === "session.config");
  expect(config && config.type === "session.config" ? config.config.controls : []).toEqual([
    {
      type: "select",
      key: "permission",
      label: "访问权限",
      icon: "shield-check",
      defaultValue: "workspace-write",
      choices: [
        { value: "workspace-write", label: "工作区写入" },
        { value: "danger-full-access", label: "完全写入" },
      ],
    },
    {
      type: "select",
      key: "contextWindow",
      label: "Context window",
      defaultValue: "1000000",
      choices: [
        { value: "256000", label: "256K" },
        { value: "1000000", label: "1M" },
      ],
    },
  ]);
  expect(config && config.type === "session.config" ? config.config.models[0] : {}).toMatchObject({
    contextWindowMaxTokens: 1_000_000,
  });
  const usage = events.find((event) => event.type === "session.usage");
  expect(usage && usage.type === "session.usage" ? usage.usage.contextWindowMaxTokens : 0).toBe(
    1_000_000,
  );
  await connection.send({
    type: "session.configure",
    requestId: "config-1",
    sessionId: "paseo-1",
    changes: { providerOptions: { contextWindow: "256000" } },
  });
  await until(
    events,
    (event) => event.type === "request.completed" && event.requestId === "config-1",
  );
  expect(script.calls.find((call) => call.endpoint === "settings/mutate")?.args).toEqual({
    ns: "llm-deepseek",
    expectedRevision: 3,
    ops: [
      {
        op: "set",
        path: ["models"],
        value: [
          { id: "v4", name: "V4", contextWindow: 256_000 },
          { id: "other", name: "Other", contextWindow: 256_000 },
        ],
      },
    ],
  });
  await connection.close();
});

test("the composer switches access without starting a turn", async () => {
  const { script, provider } = harness([desktop], desktop, "build");
  const { connection, events } = await open(provider, script);
  await connection.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "paseo-1",
    history: "replay",
    config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true },
  });
  await until(events, (event) => event.type === "session.ready");
  script.follows[0]?.({
    type: "snapshot",
    records: [
      {
        type: "event",
        event: { type: "permission/preset", seq: 2, data: { preset: "read-only" } },
      },
    ],
  });
  const preset = await until(
    events,
    (event) =>
      event.type === "session.config" && event.config.providerOptions?.permission === "read-only",
  );
  expect(preset.type === "session.config" ? preset.config.controls?.[0] : undefined).toMatchObject({
    key: "permission",
    defaultValue: "read-only",
    choices: [
      { value: "workspace-write", label: "工作区写入" },
      { value: "danger-full-access", label: "完全写入" },
      { value: "read-only", label: "read-only" },
    ],
  });
  expect(preset.type === "session.config" ? preset.config.modes : []).toEqual([
    { id: "default", label: "智能体" },
    { id: "plan", label: "计划" },
  ]);
  const prompts = script.calls.filter((call) => call.endpoint === "session/prompt").length;
  await connection.send({
    type: "session.configure",
    requestId: "perm-1",
    sessionId: "paseo-1",
    changes: { providerOptions: { permission: "danger-full-access" } },
  });
  await until(
    events,
    (event) => event.type === "request.completed" && event.requestId === "perm-1",
  );
  expect(script.calls.findLast((call) => call.endpoint === "commands/execute")?.args).toEqual({
    agentId: "dsh-1",
    line: "/permission danger-full-access",
    submittedAttachments: [],
  });
  expect(script.calls.filter((call) => call.endpoint === "session/prompt")).toHaveLength(prompts);
  await connection.close();
});

function modelId(): string {
  return JSON.stringify(["deepseek", "v4"]);
}
