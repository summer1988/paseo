import { redact } from "./redact.js";

export class DshError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(redact(message));
    this.name = "DshError";
  }
}

export interface DshCaller {
  call(endpoint: string, args: Record<string, unknown>): Promise<unknown>;
  /** Resolves when the saved host accepts a connection. */
  ping(): Promise<void>;
  listen(onItem: (value: unknown) => void): () => void;
  follow(sessionId: string, onItem: (value: unknown) => void): () => void;
  /** Resolves with the first stream item, then cancels. */
  first(endpoint: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export function assertLoopbackLogin(loginUrl: string): URL {
  let url: URL;
  try {
    url = new URL(loginUrl);
  } catch {
    throw new DshError("login", "The login link is not a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DshError("login", "The login link must use http or https");
  }
  if (!LOOPBACK.has(url.hostname)) {
    throw new DshError("login", "The login link must use a loopback host");
  }
  if (!url.searchParams.get("token")) {
    throw new DshError("login", "The login link is missing a token");
  }
  return url;
}

export async function exchangeLogin(
  loginUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ origin: string; cookie: string }> {
  const url = assertLoopbackLogin(loginUrl);
  // GET /?token= mints the browser-session cookie (303). /connect mints an operator
  // cookie whose peer is deleted when its mux socket closes, so the next /api call is 401.
  const index = new URL("/", url.origin);
  index.searchParams.set("token", url.searchParams.get("token") ?? "");
  let response: Response;
  try {
    response = await fetchImpl(index, { redirect: "manual" });
  } catch (error) {
    if (!isTransportError(error)) {
      throw new DshError("login", error instanceof Error ? error.message : "Login exchange failed");
    }
    try {
      response = await fetchAgain(fetchImpl, index, { redirect: "manual" });
    } catch (retryError) {
      throw new DshError("login", describeTransport(retryError));
    }
  }
  if (response.status !== 303) {
    throw new DshError("login", "The host rejected the login link");
  }
  const cookie = cookieHeader(response);
  if (!cookie) throw new DshError("login", "The host did not return an authentication cookie");
  return { origin: url.origin, cookie };
}

export function createRemoteClient(options: {
  origin: string;
  cookie: string;
  fetchImpl?: typeof fetch;
  socket?: SocketLike;
}): DshCaller {
  const fetchImpl = options.fetchImpl ?? fetch;
  const socket = options.socket ?? openMux(options.origin, options.cookie);
  const streams = new Map<string, (value: unknown) => void>();
  let nextId = 0;
  const failAll = (error: DshError) => {
    for (const listener of streams.values()) listener({ type: "error", error });
    streams.clear();
  };
  socket.addEventListener("message", (event) => {
    const text = typeof event.data === "string" ? event.data : "";
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (!isRecord(message) || typeof message.streamId !== "string") return;
    const listener = streams.get(message.streamId);
    if (!listener) return;
    if (message.type === "item") listener(message.value);
    if (message.type === "end") {
      streams.delete(message.streamId);
      listener({ type: "end" });
    }
    if (message.type === "error") {
      streams.delete(message.streamId);
      const failure = isRecord(message.error) ? message.error : {};
      listener({
        type: "error",
        error: new DshError(
          typeof failure.code === "string" ? failure.code : "stream",
          typeof failure.message === "string" ? failure.message : "Remote stream failed",
        ),
      });
    }
  });
  socket.addEventListener("close", () => {
    failAll(new DshError("closed", "The host connection closed"));
  });

  function open(
    endpoint: string,
    args: Record<string, unknown>,
    onItem: (value: unknown) => void,
  ): () => void {
    const streamId = `dsh-${nextId}`;
    nextId += 1;
    streams.set(streamId, onItem);
    socket.send(JSON.stringify({ type: "open", streamId, endpoint, payload: { args } }));
    return () => {
      streams.delete(streamId);
      socket.send(JSON.stringify({ type: "cancel", streamId }));
    };
  }

  return {
    async call(endpoint, args) {
      const rpcId = globalThis.crypto.randomUUID();
      const response = await request(fetchImpl, new URL(`/api/${endpoint}`, options.origin), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: options.cookie,
        },
        body: JSON.stringify({
          type: "client-request",
          rpcId,
          method: endpoint,
          payload: { args },
        }),
      });
      const body: unknown = await response.json().catch(() => undefined);
      return unwrap(body, response.status, rpcId);
    },
    async ping() {
      // Any HTTP response means the process is accepting connections. A thrown
      // fetch is the host being down, which is what the catalog error was hiding.
      await request(fetchImpl, new URL("/", options.origin), {
        method: "GET",
        headers: { cookie: options.cookie },
        redirect: "manual",
      });
    },
    listen(onItem) {
      return open("$events", {}, onItem);
    },
    follow(sessionId, onItem) {
      return open(
        "session/follow",
        {
          request: {
            address: { kind: "session", sessionId },
            activate: true,
            assistantStream: true,
          },
        },
        onItem,
      );
    },
    first(endpoint, args) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          finish(new DshError("stream", "The host did not send a workspace list"));
        }, 15_000);
        const stop = open(endpoint, args, (value) => {
          if (isRecord(value) && value.type === "error" && value.error instanceof Error) {
            finish(value.error);
            return;
          }
          if (isRecord(value) && value.type === "end") {
            finish(new DshError("stream", "The host closed the workspace list"));
            return;
          }
          finish(undefined, value);
        });
        function finish(error?: Error, value?: unknown) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          stop();
          if (error) reject(error);
          else resolve(value);
        }
      });
    },
    async close() {
      socket.close();
    },
  };
}

function openMux(origin: string, cookie: string): SocketLike {
  const socket = new (loadWebSocket())(new URL("/api/remote.mux", origin), { headers: { cookie } });
  return socket;
}

type WebSocketConstructor = new (
  url: string | URL,
  options?: { headers?: Record<string, string> },
) => SocketLike;

function loadWebSocket(): WebSocketConstructor {
  // node:undici is not exposed by getBuiltinModule on Node 24/26 or Electron.
  // The process global is undici's WebSocket and accepts the cookie header.
  const globalSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof globalSocket === "function") return globalSocket as WebSocketConstructor;
  const load = (process as { getBuiltinModule?: (name: string) => unknown }).getBuiltinModule;
  const builtin = load?.("node:undici");
  if (!isRecord(builtin) || typeof builtin.WebSocket !== "function") {
    throw new DshError("socket", "WebSocket is unavailable");
  }
  return builtin.WebSocket as WebSocketConstructor;
}

type FetchInit = Parameters<typeof fetch>[1];

async function request(fetchImpl: typeof fetch, input: URL, init: FetchInit): Promise<Response> {
  try {
    return await fetchImpl(input, init);
  } catch (error) {
    if (!isTransportError(error)) throw error;
    try {
      return await fetchAgain(fetchImpl, input, init);
    } catch (retryError) {
      throw new DshError("transport", describeTransport(retryError));
    }
  }
}

async function fetchAgain(fetchImpl: typeof fetch, input: URL, init: FetchInit): Promise<Response> {
  if (fetchImpl !== fetch) return fetchImpl(input, init);
  const isolated = openIsolatedFetch();
  if (!isolated) return fetchImpl(input, init);
  try {
    return await isolated.fetch(input, init);
  } finally {
    await isolated.close();
  }
}

function openIsolatedFetch():
  | { fetch: (input: URL, init?: FetchInit) => Promise<Response>; close: () => Promise<void> }
  | undefined {
  const load = (process as { getBuiltinModule?: (name: string) => unknown }).getBuiltinModule;
  const builtin = load?.("node:undici");
  if (
    !isRecord(builtin) ||
    typeof builtin.Agent !== "function" ||
    typeof builtin.fetch !== "function"
  ) {
    return undefined;
  }
  try {
    const agent = new (builtin.Agent as new (options: {
      connections: number;
      pipelining: number;
    }) => { close: () => Promise<void> })({ connections: 1, pipelining: 0 });
    const undiciFetch = builtin.fetch as (
      input: URL,
      init?: FetchInit & { dispatcher?: unknown },
    ) => Promise<Response>;
    return {
      fetch: (input, init) => undiciFetch(input, { ...init, dispatcher: agent }),
      close: () => agent.close(),
    };
  } catch {
    return undefined;
  }
}

function isTransportError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && error.message === "fetch failed");
}

/** A stable sentence. Cause messages repeat the address, so they stay off the diagnostic. */
function describeTransport(error: unknown): string {
  const code = nestedCode(error);
  if (
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "EHOSTUNREACH" ||
    code === "ECONNABORTED"
  ) {
    return "The saved host is not accepting connections";
  }
  if (
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "UND_ERR_SOCKET" ||
    code === "UND_ERR_CLOSED"
  ) {
    return "The host connection was interrupted";
  }
  if (
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT" ||
    code === "ABORT_ERR"
  ) {
    return "The host did not respond in time";
  }
  return "The host could not be reached";
}

function nestedCode(error: unknown, depth = 0): string | undefined {
  if (depth > 3 || !isRecord(error)) return undefined;
  if (typeof error.code === "string") return error.code;
  return nestedCode(error.cause, depth + 1);
}

function cookieHeader(response: Response): string | undefined {
  const getter = response.headers as Headers & { getSetCookie?: () => string[] };
  const listed = typeof getter.getSetCookie === "function" ? getter.getSetCookie() : [];
  const raw =
    listed.length > 0
      ? listed
      : [response.headers.get("set-cookie")].filter((value): value is string => Boolean(value));
  const pairs = raw
    .map((value) => value.split(";")[0]?.trim())
    .filter((value): value is string => Boolean(value));
  return pairs.length > 0 ? pairs.join("; ") : undefined;
}

function unwrap(body: unknown, status: number, rpcId: string): unknown {
  if (isRecord(body) && body.type === "server-response" && body.rpcId !== rpcId) {
    throw new DshError("remote", "The host response did not match the request");
  }
  const result = isRecord(body) && isRecord(body.result) ? body.result : body;
  if (isRecord(result) && result.ok === false && isRecord(result.error)) {
    throw new DshError(
      typeof result.error.code === "string" ? result.error.code : "remote",
      typeof result.error.message === "string" ? result.error.message : "Remote call failed",
    );
  }
  if (isRecord(result) && result.ok === true && "value" in result) return result.value;
  if (status >= 400) throw new DshError("remote", `Remote call failed with HTTP ${status}`);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
