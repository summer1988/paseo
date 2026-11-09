import { expect, test } from "vitest";
import { filterSessions, mapSessionItems, workspacesFromBaseline } from "../server/workspaces.js";

const listed = {
  items: [
    {
      sessionId: "keep",
      cwd: "/repo/",
      updatedAt: 1_700_000_000_000,
      projections: {
        values: {
          title: "Hello",
          contextTimeline: { lastUser: "  ping\nthere  " },
        },
      },
    },
    { sessionId: "child", origin: "subagent", cwd: "/repo", updatedAt: 1_800_000_000_000 },
    { sessionId: "empty", blank: true, cwd: "/repo" },
    { sessionId: "old", cwd: "/repo", updatedAt: 1_600_000_000_000, title: "Older" },
    { sessionId: "archived", cwd: "/repo", title: "Hidden" },
    {
      sessionId: "other",
      cwd: "/other",
      title: "Elsewhere",
      updatedAt: "2026-05-01T00:00:00.000Z",
    },
  ],
};

const frame = {
  type: "baseline",
  value: {
    items: [
      {
        workspaceId: "repo",
        path: "/repo",
        title: "Repo",
        sessionIds: ["keep", "child", "archived"],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-02-01T00:00:00.000Z",
      },
      {
        workspaceId: "empty",
        path: "/unused",
        title: "Unused",
        sessionIds: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      },
    ],
    archivedSessionIds: ["archived"],
    pinnedSessionIds: [],
  },
};

test("session import keeps human rows and workspace titles", () => {
  const sessions = mapSessionItems(listed, new Set(["archived"]));
  expect(sessions.map((session) => session.sessionId)).toEqual(["keep", "old", "other"]);
  expect(sessions[0]).toMatchObject({
    cwd: "/repo",
    title: "Hello",
    description: "ping there",
    updatedAt: new Date(1_700_000_000_000).toISOString(),
  });
  expect(filterSessions(sessions, { cwd: "/repo", query: "hello", limit: 1 })).toEqual([
    expect.objectContaining({ sessionId: "keep" }),
  ]);
  expect(workspacesFromBaseline(frame, sessions)).toEqual([
    {
      id: "repo",
      title: "Repo",
      path: "/repo",
      updatedAt: "2026-02-01T00:00:00.000Z",
      sessionCount: 2,
    },
  ]);
});
