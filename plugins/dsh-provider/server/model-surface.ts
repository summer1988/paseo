/**
 * Model identity and context-window edits for a DeepSeek Harness host.
 *
 * The catalog does not carry a context window. The host stores it on the
 * provider settings profile (`llm/listConfigurableProviders` + `settings/describe`),
 * and the session's current model is `session/projections` `modelSelection.next`.
 */

export interface HostSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface SettingsMutation {
  ns: string;
  ops: { op: "set"; path: string[]; value: unknown }[];
  expectedRevision?: number;
}

interface ProviderRoute {
  provider: string;
  ns: string;
  settingsPath: string[];
  revision?: number;
  value?: Record<string, unknown>;
  user?: Record<string, unknown>;
  base?: Record<string, unknown>;
}

export interface ModelSurface {
  routes: readonly ProviderRoute[];
}

const MILLION = 1_000_000;
const THOUSAND = 1_000;

export function formatCapacity(value: number): string {
  if (value % MILLION === 0) return `${value / MILLION}M`;
  if (value % THOUSAND === 0) return `${value / THOUSAND}K`;
  return String(value);
}

export function selectionFromProjection(value: unknown): HostSelection | undefined {
  if (!isRecord(value) || !isRecord(value.values)) return undefined;
  const modelSelection = value.values.modelSelection;
  if (!isRecord(modelSelection)) return undefined;
  return hostSelection(modelSelection.next) ?? hostSelection(modelSelection.lastUsed);
}

export function selectionFromWire(data: unknown): HostSelection | undefined {
  return hostSelection(data);
}

export function readModelSurface(providers: unknown, described: unknown): ModelSurface {
  const namespaces =
    isRecord(described) && Array.isArray(described.namespaces) ? described.namespaces : [];
  const rows = Array.isArray(providers) ? providers : [];
  const routes: ProviderRoute[] = [];
  for (const row of rows) {
    if (!isRecord(row) || typeof row.provider !== "string" || typeof row.settingsNs !== "string") {
      continue;
    }
    const settingsPath = stringPath(row.settingsPath);
    if (!settingsPath) continue;
    const namespace = namespaces.find((entry) => isRecord(entry) && entry.ns === row.settingsNs);
    if (!isRecord(namespace)) continue;
    routes.push({
      provider: row.provider,
      ns: row.settingsNs,
      settingsPath,
      ...(typeof namespace.revision === "number" ? { revision: namespace.revision } : {}),
      value: atPath(namespace.value, settingsPath),
      user: atPath(namespace.user, settingsPath),
      base: atPath(namespace.base, settingsPath),
    });
  }
  return { routes };
}

export function windowFor(
  surface: ModelSurface,
  provider: string,
  model: string,
): number | undefined {
  const route = surface.routes.find((entry) => entry.provider === provider);
  if (!route) return undefined;
  return (
    profileWindow(route.value, model) ??
    profileWindow(route.user, model) ??
    profileWindow(route.base, model)
  );
}

export function contextControl(
  surface: ModelSurface,
  provider: string,
  model: string,
  liveWindow?: number,
):
  | {
      controls: [
        {
          type: "select";
          key: "contextWindow";
          label: string;
          defaultValue: string;
          choices: { value: string; label: string }[];
        },
      ];
      providerOptions: { contextWindow: string };
    }
  | undefined {
  const route = surface.routes.find((entry) => entry.provider === provider);
  if (!route) return undefined;
  const current = windowFor(surface, provider, model) ?? positive(liveWindow);
  const windows = uniqueWindows([
    ...windowsIn(route.value),
    ...windowsIn(route.user),
    ...windowsIn(route.base),
    current,
  ]);
  if (windows.length === 0 || current === undefined) return undefined;
  const value = String(current);
  return {
    controls: [
      {
        type: "select",
        key: "contextWindow",
        label: "Context window",
        defaultValue: value,
        choices: windows.map((window) => ({
          value: String(window),
          label: formatCapacity(window),
        })),
      },
    ],
    providerOptions: { contextWindow: value },
  };
}

/**
 * Write the selected model's window the way the host editor does: set the
 * profile's `models` array. Copy the base catalog when the user section has
 * not customized one. Never replace that catalog with a one-model list.
 */
export function contextMutation(
  surface: ModelSurface,
  provider: string,
  model: string,
  tokens: number,
): SettingsMutation | undefined {
  if (!positive(tokens)) return undefined;
  const route = surface.routes.find((entry) => entry.provider === provider);
  if (!route) return undefined;
  const source = modelsOf(route.user) ?? modelsOf(route.base) ?? modelsOf(route.value);
  if (source?.some((entry) => entry.id === model)) {
    return mutation(
      route,
      [...route.settingsPath, "models"],
      modelsWithWindow(source, model, tokens),
    );
  }
  if (!route.value && !route.user && !route.base) return undefined;
  return mutation(route, [...route.settingsPath, "defaultContextWindow"], tokens);
}

function modelsWithWindow(
  models: readonly Record<string, unknown>[],
  model: string,
  tokens: number,
): Record<string, unknown>[] {
  const next = [];
  for (const entry of models) {
    next.push(entry.id === model ? Object.assign({}, entry, { contextWindow: tokens }) : entry);
  }
  return next;
}

function mutation(route: ProviderRoute, path: string[], value: unknown): SettingsMutation {
  return {
    ns: route.ns,
    ops: [{ op: "set", path, value }],
    ...(route.revision === undefined ? {} : { expectedRevision: route.revision }),
  };
}

function hostSelection(value: unknown): HostSelection | undefined {
  if (!isRecord(value) || typeof value.provider !== "string" || typeof value.model !== "string") {
    return undefined;
  }
  if (!value.provider || !value.model) return undefined;
  const reasoningEffort =
    typeof value.reasoningEffort === "string" ? value.reasoningEffort : undefined;
  return {
    provider: value.provider,
    model: value.model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

function profileWindow(
  profile: Record<string, unknown> | undefined,
  model: string,
): number | undefined {
  const listed = modelsOf(profile)?.find((entry) => entry.id === model);
  return positive(listed?.contextWindow) ?? positive(profile?.defaultContextWindow);
}

function windowsIn(profile: Record<string, unknown> | undefined): number[] {
  if (!profile) return [];
  const windows = [positive(profile.defaultContextWindow)];
  for (const model of modelsOf(profile) ?? []) windows.push(positive(model.contextWindow));
  return windows.flatMap((window) => (window === undefined ? [] : [window]));
}

function modelsOf(
  profile: Record<string, unknown> | undefined,
): Record<string, unknown>[] | undefined {
  if (!profile || !Object.hasOwn(profile, "models") || !Array.isArray(profile.models))
    return undefined;
  return profile.models.filter(isRecord);
}

function uniqueWindows(windows: (number | undefined)[]): number[] {
  return [...new Set(windows.flatMap((window) => (window === undefined ? [] : [window])))].sort(
    (left, right) => left - right,
  );
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

function stringPath(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return undefined;
  return value;
}

function atPath(root: unknown, path: readonly string[]): Record<string, unknown> | undefined {
  let current = root;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return isRecord(current) ? current : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
