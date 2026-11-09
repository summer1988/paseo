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
  catalog: unknown;
  sessionItems: unknown = { items: [] };
  workspaceFrame: unknown = undefined;
  async ping() {
    if (!this.failPing) return;
    const { DshError } = await import("../server/remote.js");
    throw new DshError("transport", "The saved host is not accepting connections");
  }
  async call(endpoint: string, args: Record<string, unknown>) {
    this.calls.push({ endpoint, args });
    if (endpoint === "session/modelCatalog" && this.unauthorizedCatalog) {
      const { DshError } = await import("../server/remote.js");
      throw new DshError("remote", "Remote call failed with HTTP 401");
    }
    if (endpoint === "session/create" && this.failCreate) {
      const { DshError } = await import("../server/remote.js");
      throw new DshError("session/writer-held", "Another client is writing this session");
    }
    if (endpoint === "session/create") return { sessionId: "dsh-1" };
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
    if (endpoint === "session/state") return { running: false, pendingInput: [], queue: [] };
    if (endpoint === "session/fork") return { sessionId: "dsh-fork" };
    if (endpoint === "session/list") return this.sessionItems;
    return {};
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
  expect(script.calls.find((call) => call.endpoint === "session/create")?.args).toEqual({
    request: { cwd: "/repo" },
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
    const retried = await provider.getCatalogCacheKey!({ scope: "global" });
    expect(retried).not.toBe(connected);
    expect(await sessions.read()).toMatchObject({ installId: next.id });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a model without reasoning does not inherit another model's effort", async () => {
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
    request: { sessionId: "dsh-1", provider: "a6api", model: "gpt-6.1-sol" },
  });
  const config = events.find((event) => event.type === "session.config");
  const models = config && config.type === "session.config" ? config.config.models : [];
  expect(models.find((model) => model.id === unsupported)?.thinkingOptions).toEqual([]);
  expect(models.find((model) => model.id === supported)).toMatchObject({
    defaultThinkingOptionId: "high",
  });
  expect(config && config.type === "session.config" ? config.config.thinkingOption : "set").toBe(
    undefined,
  );
  await connection.close();
});

function modelId(): string {
  return JSON.stringify(["deepseek", "v4"]);
}
