import type { DshRoster } from "../shared/contract.js";

/** Latest recognized children and team tasks, keyed by either session id. */
export class SessionRoster {
  private readonly byId = new Map<string, DshRoster>();
  private readonly listeners = new Set<(roster: DshRoster) => void>();

  publish(roster: DshRoster): void {
    this.byId.set(roster.sessionId, roster);
    this.byId.set(roster.providerSessionId, roster);
    for (const listener of this.listeners) listener(roster);
  }

  read(sessionId: string): DshRoster | null {
    return this.byId.get(sessionId) ?? null;
  }

  subscribe(listener: (roster: DshRoster) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
