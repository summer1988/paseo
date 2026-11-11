import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

const fileSchema = z.object({
  version: z.literal(1),
  installId: z.string().min(1),
  origin: z.string().min(1),
  cookie: z.string().min(1),
});

export interface SavedSession {
  installId: string;
  origin: string;
  cookie: string;
}

export interface SessionStore {
  read(): Promise<SavedSession | undefined>;
  write(session: SavedSession): Promise<void>;
  clear(): Promise<void>;
  /** Removes the file only when it still contains this login. */
  clearMatching(session: SavedSession): Promise<void>;
}

/** Daemon-only login. The settings RPC never receives this file. */
export class SessionFile implements SessionStore {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.chain.then(operation, operation);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async read(): Promise<SavedSession | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(raw);
    } catch {
      return undefined;
    }
    const parsed = fileSchema.safeParse(parsedBody);
    if (!parsed.success || !loopbackOrigin(parsed.data.origin)) return undefined;
    return {
      installId: parsed.data.installId,
      origin: parsed.data.origin,
      cookie: parsed.data.cookie,
    };
  }

  async write(session: SavedSession): Promise<void> {
    if (!loopbackOrigin(session.origin)) {
      throw new Error("The saved login host must be loopback");
    }
    await this.enqueue(async () => {
      const raw = JSON.stringify({ version: 1, ...session });
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, raw, { mode: 0o600 });
        await rename(temporary, this.file);
      } finally {
        await rm(temporary, { force: true });
      }
    });
  }

  async clear(): Promise<void> {
    await this.enqueue(async () => {
      await rm(this.file, { force: true });
    });
  }

  async clearMatching(session: SavedSession): Promise<void> {
    await this.enqueue(async () => {
      const current = await this.read();
      if (
        !current ||
        current.installId !== session.installId ||
        current.origin !== session.origin ||
        current.cookie !== session.cookie
      ) {
        return;
      }
      await rm(this.file, { force: true });
    });
  }
}

export function defaultSessionFile(): SessionFile {
  return new SessionFile(
    path.join(resolvePaseoHome(), "plugin-settings", "dsh-provider", "session.json"),
  );
}

function resolvePaseoHome(): string {
  const raw = process.env.PASEO_HOME ?? "~/.paseo";
  if (raw.startsWith("~/")) return path.resolve(path.join(homedir(), raw.slice(2)));
  if (raw === "~") return homedir();
  return path.resolve(raw);
}

function loopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK.has(url.hostname);
  } catch {
    return false;
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
