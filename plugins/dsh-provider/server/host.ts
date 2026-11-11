import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import type { ChildProcess } from "node:child_process";
import type { DiscoveredInstall } from "./discover.js";
import { redact } from "./redact.js";
import { createRemoteClient, DshError, exchangeLogin, type DshCaller } from "./remote.js";

const READY = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/\S*token=[^\s]+/i;

export interface LiveHost {
  client: DshCaller;
  owned: boolean;
  close(): Promise<void>;
}

export interface HostControls {
  spawn(install: DiscoveredInstall): ChildProcess;
  exchange(loginUrl: string): Promise<{ origin: string; cookie: string }>;
  connect(session: { origin: string; cookie: string }): DshCaller;
}

export function defaultHostControls(): HostControls {
  return {
    spawn(install) {
      const launch = install.launch;
      if (!launch) throw new DshError("launch", "This install has no host entry");
      return spawnProcess(launch.command, launch.args, {
        cwd: launch.cwd,
        env: { ...process.env, ...launch.env },
        stdio: launch.ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    },
    exchange: (loginUrl) => exchangeLogin(loginUrl),
    connect: (session) => createRemoteClient(session),
  };
}

export class HostPool {
  private owned: { id: string; host: LiveHost; child: ChildProcess } | undefined;
  private readonly attached = new Map<string, LiveHost>();
  private readonly epochs = new WeakMap<LiveHost, number>();
  private readonly deadOrigins = new Set<string>();
  private generation = 0;
  private transportEpoch = 0;
  private transportNotedFor = -1;

  constructor(private readonly controls: HostControls = defaultHostControls()) {}

  hasAttachment(installId: string): boolean {
    return this.attached.has(installId);
  }

  async build(install: DiscoveredInstall): Promise<LiveHost> {
    if (!install.launch || !install.canBuild) {
      throw new DshError("launch", `${install.label} does not expose a host entry Paseo can start`);
    }
    if (this.owned?.id === install.id) return this.owned.host;
    await this.closeOwned();
    const child = this.controls.spawn(install);
    try {
      const loginUrl = await waitForReady(child, install.launch.ipc);
      const session = await this.controls.exchange(loginUrl);
      const client = this.controls.connect(session);
      const host: LiveHost = {
        client,
        owned: true,
        close: async () => {
          await client.close();
          await stopChild(child, install.launch?.ipc === true);
        },
      };
      this.owned = { id: install.id, host, child };
      return host;
    } catch (error) {
      await stopChild(child, install.launch.ipc);
      throw error;
    }
  }

  async attach(
    install: DiscoveredInstall,
    loginUrl: string,
  ): Promise<{ origin: string; cookie: string }> {
    if (!install.attachAvailable) {
      throw new DshError(
        "attach",
        install.attachDisabledReason ?? "This client cannot be used directly",
      );
    }
    const existing = this.attached.get(install.id);
    if (existing) {
      await existing.close();
      this.attached.delete(install.id);
    }
    const session = await this.controls.exchange(loginUrl);
    this.clearDead(install.id);
    this.remember(install.id, session);
    return session;
  }

  restore(install: DiscoveredInstall, session: { origin: string; cookie: string }): void {
    if (!install.attachAvailable) {
      throw new DshError(
        "attach",
        install.attachDisabledReason ?? "This client cannot be used directly",
      );
    }
    if (this.attached.has(install.id)) return;
    if (this.deadOrigins.has(deadOriginKey(install.id, session.origin))) return;
    this.remember(install.id, session);
  }

  /** Zero when this install has no live login. Changes after each new login. */
  sessionGeneration(installId: string): number {
    return this.attached.has(installId) ? this.generation : 0;
  }

  /** The login generation stamped onto the current attachments. */
  loginEpoch(): number {
    return this.generation;
  }

  /** The generation this host was attached in, if Paseo attached it. */
  epochOf(host: LiveHost): number | undefined {
    return this.epochs.get(host);
  }

  /** Bumps once for the current login. A repeated failure keeps the catalog key stable. */
  transportGeneration(): number {
    return this.transportEpoch;
  }

  noteTransportFailure(): void {
    if (this.transportNotedFor === this.generation) return;
    this.transportNotedFor = this.generation;
    this.transportEpoch += 1;
  }

  /** Ignores a saved login whose host already failed for this install. */
  markDead(installId: string, origin: string): void {
    this.deadOrigins.add(deadOriginKey(installId, origin));
  }

  attachment(installId: string): LiveHost | undefined {
    return this.attached.get(installId);
  }

  /** The host Paseo already started or attached for this install. Does not launch one. */
  live(installId: string): LiveHost | undefined {
    if (this.owned?.id === installId) return this.owned.host;
    return this.attached.get(installId);
  }

  async dropAttached(): Promise<void> {
    const hosts = [...this.attached.values()];
    if (hosts.length === 0) return;
    this.attached.clear();
    this.generation += 1;
    await Promise.all(hosts.map((host) => host.close()));
  }

  /** Drops the attachments only when they are still the login that failed. */
  async dropIfCurrent(epoch: number): Promise<void> {
    if (this.generation !== epoch) return;
    await this.dropAttached();
  }

  private clearDead(installId: string): void {
    const prefix = `${installId}\0`;
    for (const key of this.deadOrigins) {
      if (key.startsWith(prefix)) this.deadOrigins.delete(key);
    }
  }

  private remember(installId: string, session: { origin: string; cookie: string }): void {
    const client = this.controls.connect(session);
    const host: LiveHost = {
      client,
      owned: false,
      close: async () => {
        await client.close();
      },
    };
    this.generation += 1;
    this.epochs.set(host, this.generation);
    this.attached.set(installId, host);
  }

  async closeOwned(): Promise<void> {
    const owned = this.owned;
    this.owned = undefined;
    await owned?.host.close();
  }

  async closeAll(): Promise<void> {
    const attached = [...this.attached.values()];
    this.attached.clear();
    await this.closeOwned();
    await Promise.all(attached.map((host) => host.close()));
  }
}

function waitForReady(child: ChildProcess, ipc: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const finish = (url: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(url);
    };
    const fail = (error: DshError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(
      () => fail(new DshError("startup", "The host did not become ready")),
      20_000,
    );
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer = `${buffer}${chunk}`.slice(-65_536);
      const match = READY.exec(buffer);
      if (match) finish(match[0]);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", () => {
      // Diagnostics stay off the log: stderr can repeat the login URL.
    });
    if (ipc) {
      child.on("message", (message: unknown) => {
        if (!message || typeof message !== "object" || !("type" in message)) return;
        if (message.type === "ready" && "url" in message && typeof message.url === "string")
          finish(message.url);
        if (message.type === "fatal") {
          const text =
            "message" in message && typeof message.message === "string"
              ? message.message
              : "Host failed to start";
          fail(new DshError("startup", redact(text)));
        }
      });
    }
    child.once("exit", (code) =>
      fail(new DshError("startup", `The host exited before it was ready (${String(code)})`)),
    );
    child.once("error", (error) => fail(new DshError("startup", error.message)));
  });
}

function deadOriginKey(installId: string, origin: string): string {
  return `${installId}\0${origin}`;
}

async function stopChild(child: ChildProcess, ipc: boolean): Promise<void> {
  if (ipc && child.connected) child.send({ type: "shutdown" });
  await terminateProcess(child, "SIGTERM");
}
