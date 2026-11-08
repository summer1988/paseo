import { execCommand } from "@getpaseo/plugin/server";
import { constants as fsConstants } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DshInstall } from "../shared/contract.js";

export interface InstallLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  ipc: boolean;
}

export interface DiscoveredInstall extends DshInstall {
  launch?: InstallLaunch;
}

export interface DiscoverIO {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homedir: string;
  which(command: string): Promise<string | null>;
  npmPrefix(): Promise<string | null>;
  readText(file: string): Promise<string | null>;
  list(directory: string): Promise<string[] | null>;
  exists(file: string): Promise<boolean>;
  version(command: string): Promise<string | null>;
}

const OFFICIAL_DESKTOP_ATTACH =
  "Official DeepSeek Harness does not publish a login link. Build a host from this install instead.";
const HOST_ENTRY = path.join("node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "index.js");

export async function discoverInstalls(io: DiscoverIO): Promise<DiscoveredInstall[]> {
  const [cli, apps] = await Promise.all([discoverCli(io), discoverApps(io)]);
  const seen = new Set<string>();
  const installs: DiscoveredInstall[] = [];
  for (const install of [...cli, ...apps]) {
    if (seen.has(install.id)) continue;
    seen.add(install.id);
    installs.push(install);
  }
  return installs.sort((left, right) => left.label.localeCompare(right.label));
}

export function createNodeDiscoverIO(env: NodeJS.ProcessEnv = process.env): DiscoverIO {
  return {
    platform: process.platform,
    env,
    homedir: os.homedir(),
    async which(command) {
      const locator = process.platform === "win32" ? "where.exe" : "which";
      try {
        const { stdout } = await execCommand(locator, [command], { timeout: 3000 });
        return (
          stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find(Boolean) ?? null
        );
      } catch {
        return null;
      }
    },
    async npmPrefix() {
      try {
        const { stdout } = await execCommand("npm", ["prefix", "-g"], { timeout: 3000, env });
        const prefix = stdout.trim();
        return prefix || null;
      } catch {
        return null;
      }
    },
    async readText(file) {
      try {
        return await readFile(file, "utf8");
      } catch {
        return null;
      }
    },
    async list(directory) {
      try {
        return await readdir(directory);
      } catch {
        return null;
      }
    },
    async exists(file) {
      try {
        await access(file, fsConstants.F_OK);
        return true;
      } catch {
        return false;
      }
    },
    async version(command) {
      try {
        const { stdout } = await execCommand(command, ["--version"], { timeout: 3000, env });
        return /\b\d+\.\d+\.\d+[^\s]*/.exec(stdout)?.[0] ?? (stdout.trim().slice(0, 80) || null);
      } catch {
        return null;
      }
    },
  };
}

async function discoverCli(io: DiscoverIO): Promise<DiscoveredInstall[]> {
  const found = new Set<string>();
  const onPath = await io.which("dsh");
  if (onPath) found.add(onPath);
  const prefix = await io.npmPrefix();
  if (prefix) {
    const binary =
      io.platform === "win32"
        ? path.win32.join(prefix, "dsh.cmd")
        : path.join(prefix, "bin", "dsh");
    if (await io.exists(binary)) found.add(binary);
  }
  const home = officialHome(io);
  const installs: DiscoveredInstall[] = [];
  for (const location of found) {
    installs.push({
      id: `official-cli:${location}`,
      kind: "official-cli",
      label: "DeepSeek Harness CLI",
      version: await io.version(location),
      location,
      canBuild: true,
      attachAvailable: true,
      profile: "web",
      home,
      launch: {
        command: location,
        args: ["web", "--no-open", "--host", "127.0.0.1", "--port", "0"],
        env: { DSH_HOME: home },
        cwd: io.homedir,
        ipc: false,
      },
    });
  }
  return installs;
}

async function discoverApps(io: DiscoverIO): Promise<DiscoveredInstall[]> {
  if (io.platform === "darwin") return discoverMacApps(io);
  if (io.platform === "linux") return discoverDesktopEntries(io);
  if (io.platform === "win32") return discoverWindowsApps(io);
  return [];
}

async function discoverMacApps(io: DiscoverIO): Promise<DiscoveredInstall[]> {
  const installs: DiscoveredInstall[] = [];
  for (const root of [path.join("/Applications"), path.join(io.homedir, "Applications")]) {
    for (const name of (await io.list(root)) ?? []) {
      if (!name.endsWith(".app")) continue;
      const kind = appKind(name.replace(/\.app$/, ""));
      if (!kind) continue;
      const install = await desktopApp(io, kind, path.join(root, name));
      if (install) installs.push(install);
    }
  }
  return installs;
}

async function discoverDesktopEntries(io: DiscoverIO): Promise<DiscoveredInstall[]> {
  const installs: DiscoveredInstall[] = [];
  const dirs = [
    "/usr/share/applications",
    path.join(io.homedir, ".local", "share", "applications"),
  ];
  for (const directory of dirs) {
    for (const name of (await io.list(directory)) ?? []) {
      if (!name.endsWith(".desktop")) continue;
      const text = await io.readText(path.join(directory, name));
      const parsed = text ? parseDesktopEntry(text) : undefined;
      if (!parsed) continue;
      const install = await desktopTree(io, parsed.kind, parsed.exec, parsed.name);
      if (install) installs.push(install);
    }
  }
  return installs;
}

async function discoverWindowsApps(io: DiscoverIO): Promise<DiscoveredInstall[]> {
  const installs: DiscoveredInstall[] = [];
  const roots = [io.env.PROGRAMFILES, windowsPrograms(io)].filter((root): root is string =>
    Boolean(root),
  );
  for (const root of roots) {
    for (const name of (await io.list(root)) ?? []) {
      const kind = appKind(name);
      if (!kind) continue;
      const install = await desktopTree(io, kind, path.win32.join(root, name), name);
      if (install) installs.push(install);
    }
  }
  return installs;
}

function windowsPrograms(io: DiscoverIO): string | undefined {
  return io.env.LOCALAPPDATA ? path.win32.join(io.env.LOCALAPPDATA, "Programs") : undefined;
}

async function desktopApp(
  io: DiscoverIO,
  kind: DiscoveredInstall["kind"],
  bundle: string,
): Promise<DiscoveredInstall | undefined> {
  const plist = await io.readText(path.join(bundle, "Contents", "Info.plist"));
  const executable = plistValue(plist, "CFBundleExecutable") ?? path.basename(bundle, ".app");
  const version = plistValue(plist, "CFBundleShortVersionString");
  const label = plistValue(plist, "CFBundleName") ?? path.basename(bundle, ".app");
  const binary = path.join(bundle, "Contents", "MacOS", executable);
  const resources = path.join(bundle, "Contents", "Resources");
  return finishDesktop(io, kind, bundle, label, version, binary, resources);
}

async function desktopTree(
  io: DiscoverIO,
  kind: DiscoveredInstall["kind"],
  location: string,
  label: string,
): Promise<DiscoveredInstall | undefined> {
  const resources = await firstExisting(io, [
    path.join(location, "resources"),
    path.join(location, "Resources"),
    path.join(path.dirname(location), "resources"),
    path.join(path.dirname(location), "Resources"),
  ]);
  return finishDesktop(io, kind, location, label, null, location, resources ?? location);
}

async function finishDesktop(
  io: DiscoverIO,
  kind: DiscoveredInstall["kind"],
  location: string,
  label: string,
  version: string | null,
  binary: string,
  resources: string,
): Promise<DiscoveredInstall | undefined> {
  const runtimeDir = await firstExisting(
    io,
    [
      path.join(resources, "host"),
      path.join(resources, "dsh"),
      path.join(resources, "app", "dsh"),
    ].map((dir) => path.join(dir, HOST_ENTRY)),
  );
  const home = kind === "dsh-next" ? await nextHome(io) : officialHome(io);
  const entry = runtimeDir;
  const launch = entry
    ? desktopLaunch(runtimeDirFromEntry(entry), entry, binary, home, resources)
    : undefined;
  const official = kind === "official-desktop";
  return {
    id: `${kind}:${location}`,
    kind,
    label,
    version,
    location,
    canBuild: Boolean(launch) && (await io.exists(binary)),
    attachAvailable: !official,
    ...(official ? { attachDisabledReason: OFFICIAL_DESKTOP_ATTACH } : {}),
    profile: "desktop",
    home,
    ...(launch && (await io.exists(binary)) ? { launch } : {}),
  };
}

function runtimeDirFromEntry(entry: string): string {
  let directory = entry;
  for (let depth = 0; depth < 5; depth += 1) directory = path.dirname(directory);
  return directory;
}

function desktopLaunch(
  runtimeDir: string,
  entry: string,
  binary: string,
  home: string,
  resources: string,
): InstallLaunch {
  const projectDir = path.join(home, "profiles", "desktop");
  const primaryRuntime = path.join(resources, "runtime", "primary-runtime");
  return {
    command: binary,
    args: ["--expose-internals", entry, runtimeDir, projectDir, primaryRuntime],
    env: { ELECTRON_RUN_AS_NODE: "1", DSH_HOME: home },
    cwd: projectDir,
    ipc: true,
  };
}

async function nextHome(io: DiscoverIO): Promise<string> {
  const bases = [
    io.platform === "darwin"
      ? path.join(io.homedir, "Library", "Application Support", "DSH NEXT", "home")
      : undefined,
    io.platform === "win32" && io.env.APPDATA
      ? path.win32.join(io.env.APPDATA, "DSH NEXT", "home")
      : undefined,
    path.join(io.env.XDG_CONFIG_HOME || path.join(io.homedir, ".config"), "DSH NEXT", "home"),
    path.join(io.homedir, ".desktop-next", "home"),
  ].filter((base): base is string => Boolean(base));
  for (const base of bases) {
    const text = await io.readText(path.join(base, "desktop-next-location.json"));
    const chosen = text ? locationPath(text) : undefined;
    if (chosen) return chosen;
  }
  const fromEnv = io.env.DSH_DESKTOP_NEXT_HOME;
  if (fromEnv && path.isAbsolute(fromEnv)) return fromEnv;
  return path.join(io.homedir, ".dsh");
}

function officialHome(io: DiscoverIO): string {
  const configured = io.env.DSH_HOME;
  if (configured && path.isAbsolute(configured)) return configured;
  return path.join(io.homedir, ".dsh");
}

function locationPath(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed === "string") return path.isAbsolute(parsed) ? parsed : undefined;
  if (!isRecord(parsed)) return undefined;
  for (const key of ["path", "directory", "home", "location", "dataDirectory"]) {
    const value = parsed[key];
    if (typeof value === "string" && path.isAbsolute(value)) return value;
  }
  return undefined;
}

function appKind(name: string): DiscoveredInstall["kind"] | undefined {
  const normalized = name.trim().toLowerCase();
  if (normalized === "deepseek harness") return "official-desktop";
  if (normalized === "dsh next" || normalized === "dsh-next") return "dsh-next";
  return undefined;
}

function parseDesktopEntry(
  text: string,
): { kind: DiscoveredInstall["kind"]; name: string; exec: string } | undefined {
  const name = desktopField(text, "Name");
  const exec = desktopField(text, "Exec")
    ?.replace(/%[a-zA-Z]/g, "")
    .trim();
  const icon = desktopField(text, "Icon");
  const kind = appKind(name ?? "") ?? (icon === "dsh-desktop-next" ? "dsh-next" : undefined);
  if (!kind || !name || !exec) return undefined;
  return { kind, name, exec: stripQuotes(exec) };
}

function desktopField(text: string, key: string): string | undefined {
  const match = new RegExp(`^${key}=(.*)$`, "m").exec(text);
  return match?.[1]?.trim();
}

function stripQuotes(value: string): string {
  return value.replace(/^"|"$/g, "");
}

function plistValue(plist: string | null, key: string): string | null {
  if (!plist) return null;
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist);
  return match?.[1] ?? null;
}

async function firstExisting(io: DiscoverIO, files: string[]): Promise<string | undefined> {
  for (const file of files) {
    if (await io.exists(file)) return file;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function publicInstall(install: DiscoveredInstall): DshInstall {
  const { launch: _launch, ...rest } = install;
  return rest;
}
