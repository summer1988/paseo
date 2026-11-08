import type { PluginClientContext } from "@getpaseo/plugin/client";
import { z } from "zod";
import { DshEvent } from "./client/event.js";
import { DshSettingsScreen } from "./client/settings.js";

const eventData = z.object({ type: z.string(), data: z.unknown() }).passthrough();

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({
    id: "client",
    title: "DeepSeek Harness",
    icon: "Bot",
    Component: DshSettingsScreen,
  });
  client.addTimelineRenderer({
    kind: "dsh-event",
    version: 1,
    schema: eventData,
    Component: DshEvent,
  });
  client.addTimelineRenderer({
    kind: "dsh-goal",
    version: 1,
    schema: eventData,
    Component: DshEvent,
  });
  return () => {};
}
