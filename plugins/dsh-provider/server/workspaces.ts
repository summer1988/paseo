import type { ProviderSessionSummary } from "@getpaseo/plugin/server/provider";
import type { DshCaller } from "./remote.js";

const PREVIEW_LIMIT = 160;

export interface ListedSession {
  sessionId: string;
  cwd: string;
  title?: string;
  description?: string;
  updatedAt?: string;
}

export interface ListedWorkspace {
  id: string;
  title: string;
  path: string;
  updatedAt: string;
  sessionCount: number;
}

export interface SessionListQuery {
  cwd?: string;
  query?: string;
  limit?: number;
}

/** Human sessions, excluding subagents, blanks, and archived ids. */
export function mapSessionItems(value: unknown, archived: ReadonlySet<string>): ListedSession[] {
  const items = isRecord(value) && Array.isArray(value.items) ? value.items : [];
  return items.flatMap((item) => {
    const mapped = mapSessionItem(item, archived);
    return mapped ? [mapped] : [];
  });
}

export function filterSessions(
  sessions: readonly ListedSession[],
  input: SessionListQuery,
): ListedSession[] {
  const cwd = input.cwd ? directory(input.cwd) : undefined;
  const query = input.query?.trim().toLowerCase();
  const matched = sessions.filter((session) => {
    if (cwd && directory(session.cwd) !== cwd) return false;
    if (!query) return true;
    return [session.title, session.description, session.cwd]
      .filter((part): part is string => Boolean(part))
      .join("\n")
      .toLowerCase()
      .includes(query);
  });
  const sorted = [...matched].sort((left, right) => time(right.updatedAt) - time(left.updatedAt));
  if (input.limit === undefined) return sorted;
  return sorted.slice(0, input.limit);
}

export function toProviderSessions(sessions: readonly ListedSession[]): ProviderSessionSummary[] {
  return sessions.map((session) => ({
    persistence: { version: 1, data: { sessionId: session.sessionId } },
    cwd: session.cwd,
    ...(session.title ? { title: session.title } : {}),
    ...(session.description ? { description: session.description } : {}),
    ...(session.updatedAt ? { updatedAt: session.updatedAt } : {}),
  }));
}

/** Workspaces that still have an importable user session. */
export function workspacesFromBaseline(
  frame: unknown,
  sessions: readonly ListedSession[],
): ListedWorkspace[] {
  const value = baselineValue(frame);
  if (!value || !Array.isArray(value.items)) return [];
  const rows = value.items.flatMap((item) => {
    if (!isRecord(item) || typeof item.workspaceId !== "string" || typeof item.path !== "string") {
      return [];
    }
    const path = directory(item.path);
    const sessionCount = sessions.filter((session) => directory(session.cwd) === path).length;
    if (sessionCount === 0) return [];
    return [
      {
        id: item.workspaceId,
        title: textAt(item.title) ?? path,
        path,
        updatedAt: textAt(item.updatedAt) ?? new Date(0).toISOString(),
        sessionCount,
      },
    ];
  });
  return rows.sort((left, right) => time(right.updatedAt) - time(left.updatedAt));
}

export function archivedSessionIds(frame: unknown): Set<string> {
  const value = baselineValue(frame);
  if (!value || !Array.isArray(value.archivedSessionIds)) return new Set();
  return new Set(value.archivedSessionIds.filter((id): id is string => typeof id === "string"));
}

/** Session rows stay available when the workspace stream does not answer. */
export async function readImportIndex(
  client: DshCaller,
): Promise<{ sessions: ListedSession[]; workspaces: ListedWorkspace[] }> {
  const listed = await client.call("session/list", { _request: {} });
  const frame = await client.first("workspace/follow", {}).catch(() => undefined);
  const sessions = mapSessionItems(listed, archivedSessionIds(frame));
  return { sessions, workspaces: workspacesFromBaseline(frame, sessions) };
}

export async function readWorkspaceList(client: DshCaller): Promise<ListedWorkspace[]> {
  const listed = await client.call("session/list", { _request: {} });
  const frame = await client.first("workspace/follow", {});
  const sessions = mapSessionItems(listed, archivedSessionIds(frame));
  return workspacesFromBaseline(frame, sessions);
}

function mapSessionItem(item: unknown, archived: ReadonlySet<string>): ListedSession | undefined {
  if (!isRecord(item) || typeof item.sessionId !== "string") return undefined;
  if (item.origin === "subagent" || item.blank === true) return undefined;
  if (archived.has(item.sessionId)) return undefined;
  if (typeof item.cwd !== "string" || item.cwd.length === 0) return undefined;
  const title = sessionTitle(item);
  const description = sessionPreview(item);
  const updatedAt = sessionTime(item.updatedAt);
  return {
    sessionId: item.sessionId,
    cwd: directory(item.cwd),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function sessionTitle(item: Record<string, unknown>): string | undefined {
  const direct = textAt(item.title);
  if (direct) return direct;
  return textAt(projectionValues(item)?.title);
}

function sessionPreview(item: Record<string, unknown>): string | undefined {
  const values = projectionValues(item);
  const timeline = values && isRecord(values.contextTimeline) ? values.contextTimeline : undefined;
  return preview(textAt(timeline?.lastUser));
}

function projectionValues(item: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!isRecord(item.projections) || !isRecord(item.projections.values)) return undefined;
  return item.projections.values;
}

function preview(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  if (cleaned.length <= PREVIEW_LIMIT) return cleaned;
  return `${cleaned.slice(0, PREVIEW_LIMIT - 3)}...`;
}

function sessionTime(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

function baselineValue(frame: unknown): Record<string, unknown> | undefined {
  if (!isRecord(frame)) return undefined;
  if (frame.type !== "baseline" && frame.type !== "replace") return undefined;
  return isRecord(frame.value) ? frame.value : undefined;
}

function directory(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function textAt(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function time(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
