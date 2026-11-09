import type { DshInstall } from "./contract.js";

const NONE =
  "No installed client can accept a browser address. Install DeepSeek Harness or DSH NEXT, then search again.";
const MANY = "More than one client can take this address. Choose the matching client below.";

export function chooseAttachInstall(
  installs: readonly DshInstall[],
  selectedId: string | null,
): { install: DshInstall } | { error: string } {
  const attachable = installs.filter((install) => install.attachAvailable);
  const selected = attachable.find((install) => install.id === selectedId);
  if (selected) return { install: selected };
  const only = attachable[0];
  if (attachable.length === 1 && only) return { install: only };
  if (attachable.length > 1) return { error: MANY };
  const blocked = installs.find((install) => install.attachDisabledReason);
  return { error: blocked?.attachDisabledReason ?? NONE };
}
