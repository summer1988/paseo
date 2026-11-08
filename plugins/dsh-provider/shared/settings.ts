import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const dshSettings = defineSettings({
  id: "client",
  scope: "host",
  version: 1,
  schema: z.object({
    installId: z.string().min(1).nullable().default(null),
    mode: z.enum(["build", "attach"]).nullable().default(null),
  }),
});

export type DshSettings = z.output<typeof dshSettings.schema>;
