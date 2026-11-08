import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "vitest";
import {
  PROVIDER_CAPABILITIES,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import type { DiscoveredInstall } from "../server/discover.js";
import { HostPool, type HostControls } from "../server/host.js";
import { createDshProvider, type SettingsSource } from "../server/provider.js";
import { exchangeLogin } from "../server/remote.js";
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
  async call(endpoint: string, args: Record<string, unknown>) {
    this.calls.push({ endpoint, args });
    if (endpoint === "session/create" && this.failCreate) {
      const { DshError } = await import("../server/remote.js");
      throw new DshError("session/writer-held", "Another client is writing this session");
    }
    if (endpoint === "session/create") return { sessionId: "dsh-1" };
    if (endpoint === "session/modelCatalog") {
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
    if (endpoint === "session/state") return { running: false, pendingInput: [], queue: [] };
    if (endpoint === "session/fork") return { sessionId: "dsh-fork" };
    return {};
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
  expect(script.calls.some((call) => call.endpoint === "session/create")).toBe(true);
  const commands = events.find((event) => event.type === "session.commands");
  expect(
    commands && commands.type === "session.commands"
      ? commands.commands.map((command) => command.name)
      : [],
  ).toContain("review");
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
  await until(events, (event) => event.type === "session.ready");
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
    sessionId: "dsh-1",
    provider: "deepseek",
    model: "v4",
  });

  script.events[0]?.({
    type: "waterfall",
    event: "user-questions/request",
    eventId: "question-1",
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
    request: { id: "approval-1", toolName: "bash", reason: "run ls" },
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
  const opened = await until(
    events,
    (event) => event.type === "session.opened" && event.sessionId === "child",
  );
  expect(opened).toMatchObject({
    parentSessionId: "paseo-1",
    restoration: "parent",
    persistence: { data: { sessionId: "child" } },
  });
  await connection.close();
});

test("login exchange keeps the cookie and drops the token from errors", async () => {
  expect(redact("failed http://127.0.0.1:9/?token=secret")).toBe("failed [url]");
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.setHeader("set-cookie", "dsh-auth=cookie; HttpOnly");
    response.statusCode = url.searchParams.get("interactions") === "answer" ? 302 : 400;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const exchanged = await exchangeLogin(`http://127.0.0.1:${port}/?token=secret`);
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

function modelId(): string {
  return JSON.stringify(["deepseek", "v4"]);
}
