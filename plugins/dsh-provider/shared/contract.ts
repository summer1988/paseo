import { defineRpc } from "@getpaseo/plugin";
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
