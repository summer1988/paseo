import path from "node:path";
import { expect, test } from "vitest";
import { discoverInstalls, type DiscoverIO } from "../server/discover.js";

const HOST = path.join("node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "index.js");

function io(input: {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  which?: string | null;
  files?: Record<string, string>;
  dirs?: Record<string, string[]>;
}): DiscoverIO {
  const files = new Set(Object.keys(input.files ?? {}));
  for (const [directory, names] of Object.entries(input.dirs ?? {})) {
    for (const name of names) files.add(path.join(directory, name));
  }
  return {
    platform: input.platform ?? "darwin",
    arch: input.arch ?? "arm64",
    env: input.env ?? {},
    homedir: input.homedir ?? "/Users/me",
    async which() {
      return input.which === undefined ? "/usr/local/bin/dsh" : input.which;
    },
    async npmPrefix() {
      return null;
    },
    async version(command) {
      return command.endsWith(`${path.sep}dsh`) ? "0.2.2" : null;
    },
    async readText(file) {
      return input.files?.[file] ?? null;
    },
    async list(directory) {
      return input.dirs?.[directory] ?? null;
    },
    async exists(file) {
      return files.has(file) || input.dirs?.[file] !== undefined;
    },
  };
}

const plist = (name: string, executable: string, version: string) => `<?xml version="1.0"?>
<plist><dict>
<key>CFBundleName</key><string>${name}</string>
<key>CFBundleExecutable</key><string>${executable}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>`;

test("finds the official CLI, official desktop, and DSH NEXT", async () => {
  const official = "/Applications/DeepSeek Harness.app";
  const next = "/Applications/DSH NEXT.app";
  const officialEntry = path.join(official, "Contents", "Resources", "host", HOST);
  const nextEntry = path.join(next, "Contents", "Resources", "host", HOST);
  const location = path.join(
    "/Users/me",
    "Library",
    "Application Support",
    "DSH NEXT",
    "home",
    "desktop-next-location.json",
  );
  const installs = await discoverInstalls(
    io({
      which: "/usr/local/bin/dsh",
      dirs: {
        "/Applications": ["DeepSeek Harness.app", "DSH NEXT.app", "Other.app"],
      },
      files: {
        "/usr/local/bin/dsh": "",
        [path.join(official, "Contents", "Info.plist")]: plist(
          "DeepSeek Harness",
          "DeepSeek Harness",
          "0.2.2",
        ),
        [path.join(official, "Contents", "MacOS", "DeepSeek Harness")]: "",
        [officialEntry]: "",
        [path.join(next, "Contents", "Info.plist")]: plist("DSH NEXT", "DSH NEXT", "2.0.22"),
        [path.join(next, "Contents", "MacOS", "DSH NEXT")]: "",
        [nextEntry]: "",
        [location]: JSON.stringify({ path: "/Users/me/next-home" }),
      },
    }),
  );

  expect(installs.map((install) => install.kind).sort()).toEqual([
    "dsh-next",
    "official-cli",
    "official-desktop",
  ]);
  const desktop = installs.find((install) => install.kind === "official-desktop");
  expect(desktop?.attachAvailable).toBe(false);
  expect(desktop?.attachDisabledReason).toMatch(/Build a host/);
  expect(desktop?.launch?.command).toBe(
    path.join(official, "Contents", "MacOS", "DeepSeek Harness"),
  );
  expect(desktop?.launch?.command).not.toBe("/usr/local/bin/dsh");
  expect(desktop?.launch?.args.slice(0, 2)).toEqual(["--expose-internals", officialEntry]);
  expect(desktop?.launch?.env.ELECTRON_RUN_AS_NODE).toBe("1");
  expect(desktop?.profile).toBe("desktop");

  const cli = installs.find((install) => install.kind === "official-cli");
  expect(cli?.launch?.args).toEqual(["web", "--no-open", "--host", "127.0.0.1", "--port", "0"]);
  expect(cli?.attachAvailable).toBe(true);
  expect(cli?.profile).toBe("web");

  const community = installs.find((install) => install.kind === "dsh-next");
  expect(community?.attachAvailable).toBe(true);
  expect(community?.home).toBe("/Users/me/next-home");
  expect(community?.launch?.env.DSH_HOME).toBe("/Users/me/next-home");
});

test("builds DSH NEXT from the packaged asar host", async () => {
  const next = "/Applications/DSH NEXT.app";
  const resources = path.join(next, "Contents", "Resources");
  const archive = path.join(resources, "app.asar");
  const primary = path.join(resources, "runtime", "arm64", "primary-runtime");
  const home = "/Users/me/next-home";
  const installs = await discoverInstalls(
    io({
      which: null,
      arch: "arm64",
      dirs: { "/Applications": ["DSH NEXT.app"] },
      files: {
        [path.join(next, "Contents", "Info.plist")]: plist("DSH NEXT", "DSH NEXT", "2.0.22"),
        [path.join(next, "Contents", "MacOS", "DSH NEXT")]: "",
        [archive]: "",
        [primary]: "",
        [path.join(home, "desktop-next.json")]: JSON.stringify({ active: "coding" }),
        [path.join(
          "/Users/me",
          "Library",
          "Application Support",
          "DSH NEXT",
          "home",
          "desktop-next-location.json",
        )]: JSON.stringify({ path: home }),
      },
    }),
  );
  expect(installs).toHaveLength(1);
  expect(installs[0]).toMatchObject({
    kind: "dsh-next",
    canBuild: true,
    attachAvailable: true,
    home,
  });
  const projectDir = path.join(home, "profiles", "coding");
  expect(installs[0]?.launch).toMatchObject({
    command: path.join(next, "Contents", "MacOS", "DSH NEXT"),
    args: [
      "--expose-internals",
      "--max-http-header-size=65536",
      path.join(archive, "lib", "host.js"),
      archive,
      projectDir,
      primary,
    ],
    cwd: projectDir,
    ipc: true,
    env: { ELECTRON_RUN_AS_NODE: "1", DSH_HOME: home },
  });
});

test("lists a desktop install that cannot build when its host entry is missing", async () => {
  const official = "/Applications/DeepSeek Harness.app";
  const installs = await discoverInstalls(
    io({
      which: null,
      dirs: { "/Applications": ["DeepSeek Harness.app"] },
      files: {
        [path.join(official, "Contents", "Info.plist")]: plist(
          "DeepSeek Harness",
          "DeepSeek Harness",
          "0.2.2",
        ),
        [path.join(official, "Contents", "MacOS", "DeepSeek Harness")]: "",
      },
    }),
  );
  expect(installs).toHaveLength(1);
  expect(installs[0]).toMatchObject({ canBuild: false, attachAvailable: false });
  expect(installs[0]?.launch).toBeUndefined();
});

test("reads a Linux DSH NEXT desktop entry", async () => {
  const exec = "/opt/dsh-next/dsh-desktop-next";
  const entry = path.join("/opt/dsh-next/resources/host", HOST);
  const installs = await discoverInstalls(
    io({
      platform: "linux",
      which: null,
      env: { DSH_DESKTOP_NEXT_HOME: "/srv/next" },
      dirs: {
        "/usr/share/applications": ["dsh-desktop-next.desktop"],
        "/opt/dsh-next/resources": [],
      },
      files: {
        "/usr/share/applications/dsh-desktop-next.desktop":
          "[Desktop Entry]\nName=DSH NEXT\nExec=/opt/dsh-next/dsh-desktop-next %u\nIcon=dsh-desktop-next\n",
        [exec]: "",
        [entry]: "",
      },
    }),
  );
  expect(installs[0]).toMatchObject({
    kind: "dsh-next",
    canBuild: true,
    attachAvailable: true,
    home: "/srv/next",
  });
  expect(installs[0]?.launch?.command).toBe(exec);
});
