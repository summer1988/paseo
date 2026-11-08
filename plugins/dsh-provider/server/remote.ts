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
  listen(onItem: (value: unknown) => void): () => void;
  follow(sessionId: string, onItem: (value: unknown) => void): () => void;
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
  const connect = new URL("/connect", url.origin);
  connect.searchParams.set("token", url.searchParams.get("token") ?? "");
  connect.searchParams.set("interactions", "answer");
  let response: Response;
  try {
    response = await fetchImpl(connect, { redirect: "manual" });
  } catch (error) {
    throw new DshError("login", error instanceof Error ? error.message : "Login exchange failed");
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
      const response = await fetchImpl(new URL(`/api/${endpoint}`, options.origin), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: options.cookie,
        },
        body: JSON.stringify({ args }),
      });
      const body: unknown = await response.json().catch(() => undefined);
      return unwrap(body, response.status);
    },
    listen(onItem) {
      return open("$events", {}, onItem);
    },
    follow(sessionId, onItem) {
      return open(
        "session/follow",
        {
          address: { kind: "session", sessionId },
          activate: true,
          assistantStream: true,
        },
        onItem,
      );
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

function loadWebSocket(): new (
  url: string | URL,
  options?: { headers?: Record<string, string> },
) => SocketLike {
  const load = (process as { getBuiltinModule?: (name: string) => unknown }).getBuiltinModule;
  const builtin = load?.("node:undici");
  if (!isRecord(builtin) || typeof builtin.WebSocket !== "function") {
    throw new DshError("socket", "WebSocket is unavailable");
  }
  return builtin.WebSocket as new (
    url: string | URL,
    options?: { headers?: Record<string, string> },
  ) => SocketLike;
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

function unwrap(body: unknown, status: number): unknown {
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
