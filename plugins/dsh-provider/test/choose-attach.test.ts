import { expect, test } from "vitest";
import { chooseAttachInstall } from "../shared/choose-attach.js";
import type { DshInstall } from "../shared/contract.js";

function install(id: string, attachAvailable: boolean, reason?: string): DshInstall {
  return {
    id,
    kind: attachAvailable ? "dsh-next" : "official-desktop",
    label: id,
    version: null,
    location: id,
    canBuild: true,
    attachAvailable,
    ...(reason ? { attachDisabledReason: reason } : {}),
    profile: "desktop",
    home: "/home",
  };
}

test("uses the selected attachable client, otherwise the only one", () => {
  const next = install("next", true);
  const cli = install("cli", true);
  const desktop = install("desktop", false, "Official desktop has no login link");
  expect(chooseAttachInstall([desktop, next], null)).toEqual({ install: next });
  expect(chooseAttachInstall([next, cli], "cli")).toEqual({ install: cli });
  expect(chooseAttachInstall([desktop], null)).toEqual({
    error: "Official desktop has no login link",
  });
  const several = chooseAttachInstall([next, cli], null);
  const none = chooseAttachInstall([], null);
  expect("error" in several ? several.error : "").toMatch(/matching client/);
  expect("error" in none ? none.error : "").toMatch(/No installed client/);
});
