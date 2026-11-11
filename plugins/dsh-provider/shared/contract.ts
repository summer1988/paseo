import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

export const installKindSchema = z.enum(["official-cli", "official-desktop", "dsh-next"]);

export const installSchema = z.object({
  id: z.string().min(1),
  kind: installKindSchema,
  label: z.string().min(1),
  version: z.string().nullable(),
  location: z.string().min(1),
  canBuild: z.boolean(),
  attachAvailable: z.boolean(),
  attachDisabledReason: z.string().optional(),
  profile: z.enum(["web", "desktop"]),
  home: z.string().min(1),
});

export type DshInstall = z.infer<typeof installSchema>;

export const listInstalls = defineRpc({
  name: "dsh.installs.list",
  input: z.object({}),
  output: z.object({ installs: z.array(installSchema) }),
});

export const attachInstall = defineRpc({
  name: "dsh.installs.attach",
  input: z.object({
    installId: z.string().min(1),
    loginUrl: z.string().min(1),
  }),
  output: z.object({ ready: z.literal(true) }),
});

export const workspaceSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  path: z.string().min(1),
  updatedAt: z.string().min(1),
  sessionCount: z.number().int().nonnegative(),
});

export const listWorkspaces = defineRpc({
  name: "dsh.workspaces.list",
  input: z.object({}),
  output: z.object({ workspaces: z.array(workspaceSchema) }),
});

export const rosterChildSchema = z.object({
  sessionId: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  phase: z.enum(["provisioning", "active", "failed", "unknown"]),
  kind: z.enum(["subagent", "teammate"]),
});

export const rosterTaskSchema = z.object({
  id: z.string().min(1),
  subject: z.string(),
  description: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
  ownerId: z.string().optional(),
});

/** Children and the shared task board for one DeepSeek session. */
export const rosterSchema = z.object({
  sessionId: z.string().min(1),
  providerSessionId: z.string().min(1),
  children: z.array(rosterChildSchema),
  tasks: z.array(rosterTaskSchema),
});

export type DshRoster = z.infer<typeof rosterSchema>;

export const readRoster = defineRpc({
  name: "dsh.session.roster",
  input: z.object({ sessionId: z.string().min(1) }),
  output: z.object({ roster: rosterSchema.nullable() }),
});

export const watchRoster = defineSubscription({
  name: "dsh.session.roster.watch",
  input: z.object({ sessionId: z.string().min(1) }),
  event: rosterSchema,
});
