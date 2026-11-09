import type { PluginServerContext } from "@getpaseo/plugin/server";
import { attachInstall, listInstalls, listWorkspaces } from "./shared/contract.js";
import { dshSettings } from "./shared/settings.js";
import { createNodeDiscoverIO, discoverInstalls, publicInstall } from "./server/discover.js";
import { HostPool } from "./server/host.js";
import { createDshProvider, listConnectedWorkspaces } from "./server/provider.js";
import { DshError } from "./server/remote.js";
import { defaultSessionFile } from "./server/session-file.js";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(dshSettings);
  const pool = new HostPool();
  const sessions = defaultSessionFile();
  const discover = () => discoverInstalls(createNodeDiscoverIO());
  server.handle(listInstalls, async () => ({
    installs: (await discover()).map(publicInstall),
  }));
  server.handle(attachInstall, async ({ installId, loginUrl }) => {
    const install = (await discover()).find((candidate) => candidate.id === installId);
    if (!install) throw new DshError("choice", "That install is no longer available");
    const session = await pool.attach(install, loginUrl);
    await sessions.write({ installId, origin: session.origin, cookie: session.cookie });
    return { ready: true as const };
  });
  server.handle(listWorkspaces, async () => ({
    workspaces: await listConnectedWorkspaces({ settings, pool, sessions, discover }),
  }));
  server.registerProvider(createDshProvider({ settings, pool, sessions, discover }));
  return () => pool.closeAll();
}
