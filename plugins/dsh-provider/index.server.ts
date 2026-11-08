import type { PluginServerContext } from "@getpaseo/plugin/server";
import { attachInstall, listInstalls } from "./shared/contract.js";
import { dshSettings } from "./shared/settings.js";
import { createNodeDiscoverIO, discoverInstalls, publicInstall } from "./server/discover.js";
import { HostPool } from "./server/host.js";
import { createDshProvider } from "./server/provider.js";
import { DshError } from "./server/remote.js";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(dshSettings);
  const pool = new HostPool();
  const discover = () => discoverInstalls(createNodeDiscoverIO());
  server.handle(listInstalls, async () => ({
    installs: (await discover()).map(publicInstall),
  }));
  server.handle(attachInstall, async ({ installId, loginUrl }) => {
    const install = (await discover()).find((candidate) => candidate.id === installId);
    if (!install) throw new DshError("choice", "That install is no longer available");
    await pool.attach(install, loginUrl);
    return { ready: true as const };
  });
  server.registerProvider(createDshProvider({ settings, pool, discover }));
  return () => pool.closeAll();
}
