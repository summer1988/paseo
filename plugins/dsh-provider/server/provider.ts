import {
  negotiateProviderCapabilities,
  PROVIDER_CHILD_SUBTITLE_NOTICE,
  requireProviderCapabilities,
  type ProviderCatalog,
  type ProviderCatalogOptions,
  type ProviderCommand,
  type ProviderConfigChanges,
  type ProviderConnection,
  type ProviderError,
  type ProviderEvent,
  type ProviderInput,
  type ProviderPermissionRequest,
  type ProviderPermissionResponse,
  type ProviderPrompt,
  type ProviderRegistration,
  type ProviderSessionConfig,
  type ProviderStatus,
  type ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import type { DshRoster } from "../shared/contract.js";
import type { DshSettings } from "../shared/settings.js";
import {
  createNodeDiscoverIO,
  discoverInstalls,
  type DiscoveredInstall,
  type DiscoverIO,
} from "./discover.js";
import { HostPool, type LiveHost } from "./host.js";
import {
  completeToolCall,
  attemptIdForAssistantSettlement,
  catalogEntries,
  childDuration,
  childLabelFromSnapshot,
  formatChildSubtitle,
  readChildProjection,
  type ChildTiming,
  liveItemId,
  mapAddedSession,
  mapWireEvent,
  modelId,
  type TeamTaskFact,
  reduceAssistantFrame,
  rememberContextWindow,
  type LiveAttempt,
  parseModelId,
  PROVIDER_DEFAULT_THINKING,
  reasoningForWrite,
  type WireEvent,
} from "./events.js";
import {
  contextControl,
  contextMutation,
  readModelSurface,
  selectionFromProjection,
  selectionFromWire,
  windowFor,
  type ModelSurface,
} from "./model-surface.js";
import { DshError, type DshCaller } from "./remote.js";
import { SessionRoster } from "./roster.js";
import type { SessionStore } from "./session-file.js";
import {
  filterSessions,
  readImportIndex,
  readWorkspaceList,
  toProviderSessions,
  type ListedWorkspace,
} from "./workspaces.js";

const CAPABILITIES = [
  "prompt.message",
  "prompt.command",
  "prompt.image",
  "prompt.steer",
  "session.can_stop_runtime",
  "session.archive",
  "session.configure",
  "session.list",
  "session.persistence",
  "session.subsession",
  "session.unarchive",
  "permission",
  "timeline.plugin",
] as const;

const INSTALL_HELP =
  "Install DeepSeek Harness (https://github.com/deepseek-ai/deepseek-harness) or DSH NEXT, then choose it in DeepSeek Harness settings.";

export interface SettingsSource {
  read(): Promise<
    | { status: "ready"; values: DshSettings }
    | { status: "invalid"; error: string }
    | { status: "loading" }
  >;
}

export function createDshProvider(options: {
  settings: SettingsSource;
  pool: HostPool;
  sessions?: SessionStore;
  discover?: (io?: DiscoverIO) => Promise<DiscoveredInstall[]>;
  roster?: SessionRoster;
}): ProviderRegistration {
  const discover = options.discover ?? (() => discoverInstalls(createNodeDiscoverIO()));
  let restoring: Promise<void> | undefined;
  const restoreSaved = () => {
    restoring ??= restoreAttachment(
      options.settings,
      options.pool,
      options.sessions,
      discover,
    ).finally(() => {
      restoring = undefined;
    });
    return restoring;
  };
  let retiring: Promise<void> | undefined;
  const retire = (epoch: number) => {
    if (options.pool.loginEpoch() !== epoch) return Promise.resolve();
    if (retiring) return retiring;
    options.pool.noteTransportFailure();
    retiring = forgetSavedLogin(options.pool, options.sessions, epoch).finally(() => {
      retiring = undefined;
    });
    return retiring;
  };
  return {
    id: "dsh",
    label: "DeepSeek Harness",
    icon: "icon.svg",
    async getCatalogCacheKey(_options: ProviderCatalogOptions) {
      await restoreSaved();
      const choice = await readChoice(options.settings);
      return JSON.stringify({
        installId: choice.installId,
        mode: choice.mode,
        generation: choice.installId ? options.pool.sessionGeneration(choice.installId) : 0,
        transport: options.pool.transportGeneration(),
      });
    },
    async status() {
      await restoreSaved();
      return readStatus(options.settings, options.pool, discover, retire);
    },
    async connect(request) {
      if (!request.versions.includes(1))
        throw new DshError("protocol", "Provider protocol version 1 is required");
      await restoreSaved();
      const choice = await chosenInstall(options.settings, discover);
      const built = choice.mode === "build" ? await options.pool.build(choice.install) : undefined;
      if (!built) requireAttachment(options.pool, choice.install);
      const resolveHost = (): LiveHost => built ?? requireAttachment(options.pool, choice.install);
      return openConnection(
        resolveHost,
        negotiateProviderCapabilities(request.capabilities, CAPABILITIES),
        () => {
          if (built?.owned) void options.pool.closeOwned();
        },
        (host) => options.pool.epochOf(host),
        retire,
        options.roster,
      );
    },
  };
}

async function restoreAttachment(
  settings: SettingsSource,
  pool: HostPool,
  sessions: SessionStore | undefined,
  discover: () => Promise<DiscoveredInstall[]>,
): Promise<void> {
  if (!sessions) return;
  const state = await settings.read();
  if (state.status !== "ready" || !("values" in state)) return;
  if (state.values.mode !== "attach" || !state.values.installId) {
    if (state.values.mode === "build") await sessions.clear();
    return;
  }
  if (pool.hasAttachment(state.values.installId)) return;
  const saved = await sessions.read();
  if (!saved || saved.installId !== state.values.installId) return;
  const install = (await discover()).find((candidate) => candidate.id === saved.installId);
  if (!install?.attachAvailable) return;
  pool.restore(install, { origin: saved.origin, cookie: saved.cookie });
}

/** Drops the login that failed. A newer attach changes the epoch and keeps its cookie. */
async function forgetSavedLogin(
  pool: HostPool,
  sessions: SessionStore | undefined,
  epoch: number,
): Promise<void> {
  const saved = await sessions?.read();
  if (pool.loginEpoch() !== epoch) return;
  if (saved) pool.markDead(saved.installId, saved.origin);
  if (pool.loginEpoch() !== epoch) return;
  if (saved) await sessions?.clearMatching(saved);
  else await sessions?.clear();
  await pool.dropIfCurrent(epoch);
}

async function readStatus(
  settings: SettingsSource,
  pool: HostPool,
  discover: () => Promise<DiscoveredInstall[]>,
  retire: (epoch: number) => Promise<void>,
): Promise<ProviderStatus> {
  const installs = await discover();
  if (installs.length === 0) return { available: false, diagnostic: INSTALL_HELP };
  const choice = await readChoice(settings);
  if (!choice.installId || !choice.mode) {
    return {
      available: false,
      diagnostic: `Choose an installed client in DeepSeek Harness settings. Found: ${installs.map((install) => install.label).join(", ")}.`,
    };
  }
  const install = installs.find((candidate) => candidate.id === choice.installId);
  if (!install)
    return {
      available: false,
      diagnostic: "The selected DeepSeek Harness install is no longer available.",
    };
  if (choice.mode === "attach") {
    if (!install.attachAvailable) {
      return {
        available: false,
        diagnostic: install.attachDisabledReason ?? "This client cannot be used directly.",
      };
    }
    if (!pool.hasAttachment(install.id)) {
      return {
        available: false,
        diagnostic: "Paste this client's loopback login link in DeepSeek Harness settings.",
      };
    }
    const host = pool.attachment(install.id);
    const epoch = host ? pool.epochOf(host) : undefined;
    try {
      await host?.client.ping();
    } catch (error) {
      if (epoch !== undefined) await retire(epoch);
      const detail =
        error instanceof DshError ? error.message : "The saved login cannot reach the host.";
      return {
        available: false,
        diagnostic: `${detail} Paste the browser address again.`,
      };
    }
    return { available: true, diagnostic: `Using ${install.label} directly.` };
  }
  if (!install.canBuild) {
    return {
      available: false,
      diagnostic: `${install.label} is installed, but its host entry is not readable.`,
    };
  }
  return {
    available: true,
    diagnostic: install.version ? `Using ${install.label} ${install.version}` : undefined,
  };
}

async function chosenInstall(
  settings: SettingsSource,
  discover: () => Promise<DiscoveredInstall[]>,
): Promise<{ install: DiscoveredInstall; mode: "build" | "attach" }> {
  const choice = await readChoice(settings);
  const installs = await discover();
  const install = installs.find((candidate) => candidate.id === choice.installId);
  if (!install || !choice.mode)
    throw new DshError("choice", "Choose an installed DeepSeek Harness client in settings.");
  return { install, mode: choice.mode };
}

async function readChoice(settings: SettingsSource): Promise<DshSettings> {
  const state = await settings.read();
  if (state.status === "invalid") throw new DshError("settings", state.error);
  if (state.status !== "ready" || !("values" in state)) return { installId: null, mode: null };
  return state.values;
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof DshError && error.code === "remote" && error.message.includes("HTTP 401");
}

function isTransport(error: unknown): boolean {
  return error instanceof DshError && error.code === "transport";
}

function requireAttachment(pool: HostPool, install: DiscoveredInstall): LiveHost {
  if (!install.attachAvailable) {
    throw new DshError(
      "attach",
      install.attachDisabledReason ?? "This client cannot be used directly",
    );
  }
  const host = pool.attachment(install.id);
  if (!host)
    throw new DshError(
      "attach",
      "Paste this client's loopback login link in DeepSeek Harness settings.",
    );
  return host;
}

function openConnection(
  resolveHost: () => LiveHost,
  capabilities: readonly string[],
  onClose: () => void,
  epochOf: (host: LiveHost) => number | undefined,
  retire: (epoch: number) => Promise<void>,
  roster?: SessionRoster,
): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, DshSession>();
  let closed = false;
  let clientId: string | undefined;
  let bound = resolveHost();
  let stopEvents = subscribe(bound);
  const emit = (event: ProviderEvent) => {
    if (!closed) for (const listener of listeners) listener(event);
  };
  return {
    version: 1,
    capabilities,
    async send(input) {
      if (closed) throw new DshError("closed", "DeepSeek Harness connection is closed");
      requireProviderCapabilities(capabilities, input);
      queueMicrotask(() => {
        if (!closed)
          void dispatch(input).catch((error: unknown) => {
            fail(input, error);
          });
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      closed = true;
      stopEvents();
      await Promise.all([...sessions.values()].map((session) => session.dispose()));
      sessions.clear();
      onClose();
    },
  };

  function subscribe(host: LiveHost): () => void {
    return host.client.listen((value) => {
      if (!isRecord(value)) return;
      if (value.type === "ready" && typeof value.clientId === "string") clientId = value.clientId;
      if (
        value.type === "emit" &&
        value.event === "api-session/added" &&
        Array.isArray(value.args)
      ) {
        const child = mapAddedSession(value.args[0]);
        if (child) {
          const parent = [...sessions.values()].find(
            (session) => session.dshId === child.parentSessionId,
          );
          parent?.openChild(child);
        }
      }
      if (value.type === "waterfall") {
        const agentId = typeof value.agentId === "string" ? value.agentId : undefined;
        const owner = agentId
          ? [...sessions.values()].find((session) => session.dshId === agentId)
          : undefined;
        if (owner?.offerWaterfall(value, clientId)) return;
        if (value.event === "approval/request" || value.event === "user-questions/request") {
          declineWaterfall(host, clientId, value);
        }
      }
    });
  }

  function currentHost(): LiveHost {
    const next = resolveHost();
    if (next === bound) return next;
    stopEvents();
    clientId = undefined;
    bound = next;
    stopEvents = subscribe(next);
    return next;
  }

  async function dispatch(input: ProviderInput): Promise<void> {
    let host: LiveHost | undefined;
    try {
      await route();
    } catch (error) {
      const epoch = host ? epochOf(host) : undefined;
      if (epoch !== undefined && (isUnauthorized(error) || isTransport(error))) await retire(epoch);
      throw error;
    }

    function selectHost(): LiveHost {
      const next = currentHost();
      host = next;
      return next;
    }

    async function route(): Promise<void> {
      if (input.type === "catalog") {
        const active = selectHost();
        emit({
          type: "catalog",
          requestId: input.requestId,
          catalog: await readCatalog(active.client, await loadSurface(active.client)),
        });
        return;
      }
      if (input.type === "sessions") {
        const active = selectHost();
        emit({
          type: "sessions",
          requestId: input.requestId,
          sessions: await readSessions(active.client, {
            cwd: input.cwd,
            query: input.query,
            limit: input.limit,
          }),
        });
        return;
      }
      if (input.type === "session.open") {
        const active = selectHost();
        const session = new DshSession(
          input.sessionId,
          input.config,
          active,
          capabilities,
          emit,
          (child) => {
            if (sessions.has(child.providerSessionId)) {
              sessions.get(child.providerSessionId)?.noteLabel(child.pendingLabel());
              return false;
            }
            sessions.set(child.providerSessionId, child);
            return true;
          },
          (sessionId) => sessions.get(sessionId),
          roster,
        );
        sessions.set(input.sessionId, session);
        try {
          await session.open(input.requestId, input.persistence?.data);
        } catch (error) {
          sessions.delete(input.sessionId);
          await session.dispose();
          throw error;
        }
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      }
      if (input.type === "session.archive" || input.type === "session.unarchive") {
        const active = selectHost();
        const sessionId = persistedSessionId(input.persistence.data);
        await active.client.call(
          input.type === "session.archive"
            ? "workspace/archiveSession"
            : "workspace/unarchiveSession",
          withRequest({
            sessionId,
            ...(input.type === "session.archive" ? { stopActivity: false } : {}),
          }),
        );
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      }
      if (!("sessionId" in input))
        throw new DshError("unsupported", "DeepSeek Harness does not support that request");
      const session = sessions.get(input.sessionId);
      if (!session) throw new DshError("unknownSession", "DeepSeek Harness session is not open");
      host = session.host;
      switch (input.type) {
        case "session.prompt":
          await session.prompt(input.prompt);
          return;
        case "session.configure":
          await session.configure(input.changes);
          break;
        case "session.permission":
          await session.answer(input.permissionId, input.response, clientId);
          return;
        case "session.interrupt":
          await session.interrupt();
          break;
        case "session.can_stop_runtime":
          emit({
            type: "session.can_stop_runtime",
            requestId: input.requestId,
            sessionId: input.sessionId,
            canStop: await session.canStop(sessions.size),
          });
          return;
        case "session.close":
          await session.dispose();
          sessions.delete(input.sessionId);
          emit({ type: "session.closed", sessionId: input.sessionId });
          break;
        case "session.revert":
          throw new DshError(
            "unsupported",
            "DeepSeek Harness revert does not match conversation, files, or both",
          );
        default: {
          const kind = input satisfies never;
          throw new DshError(
            "unsupported",
            `DeepSeek Harness does not support ${JSON.stringify(kind)}`,
          );
        }
      }
      if ("requestId" in input) emit({ type: "request.completed", requestId: input.requestId });
    }
  }

  function fail(input: ProviderInput, failure: unknown): void {
    const error = providerError(failure);
    if (input.type === "session.prompt") {
      emit({
        type: "session.prompt_result",
        sessionId: input.sessionId,
        clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error },
      });
      return;
    }
    if ("requestId" in input) emit({ type: "request.failed", requestId: input.requestId, error });
    else if ("sessionId" in input)
      emit({ type: "session.runtime_failed", sessionId: input.sessionId, error });
  }
}

function retargetLiveItem(attemptId: string, item: ProviderTimelineItem): ProviderTimelineItem {
  if (item.type === "assistant_message") return { ...item, id: liveItemId(attemptId, "assistant") };
  if (item.type === "reasoning") return { ...item, id: liveItemId(attemptId, "reasoning") };
  return item;
}

function declineWaterfall(
  host: LiveHost,
  clientId: string | undefined,
  frame: Record<string, unknown>,
): void {
  if (!clientId || typeof frame.eventId !== "string") return;
  void host.client
    .call("$events/result", {
      clientId,
      eventId: frame.eventId,
      outcome: { kind: "next" },
    })
    .catch(() => undefined);
}

function rosterPhase(mode: string | undefined): DshRoster["children"][number]["phase"] {
  if (mode === "provisioning" || mode === "failed") return mode;
  if (mode === "external") return "unknown";
  return "active";
}

class DshSession {
  private resolvedId = "";
  get dshId(): string {
    return this.resolvedId;
  }
  private stopFollow: (() => void) | undefined;
  private readonly pending = new Map<
    string,
    { eventId: string; event: string; questions?: QuestionItem[] }
  >();
  private selection: { provider: string; model: string } | undefined;
  private appliedThinking: string | undefined;
  /** The host rejected the effort, so the catalog default must not be reported as selected. */
  private thinkingUnapplied = false;
  private activeTurn: string | undefined;
  private contextWindowMax: number | undefined;
  private permissionPreset: string | undefined;
  private replayingSnapshot = false;
  private liveAttempt: LiveAttempt | undefined;
  private readonly liveCommits = new Map<number, string>();
  private readonly openTools = new Map<string, ProviderTimelineItem>();
  private disposed = false;
  private introduced = false;
  private followed = false;
  private settled = false;
  private holding = false;
  private turnEpoch = 0;
  private readonly queued: unknown[] = [];
  private detail: string | undefined;
  private audience: "root" | "child" = "root";
  private parentProviderSessionId: string | undefined;
  private childMode: string | undefined;
  private sessionTitle: string | undefined;
  private tokenTotal: number | undefined;
  private timing: ChildTiming | undefined;
  private projectedCompleted: boolean | undefined;
  private observedTurn = false;
  private observedCompleted: boolean | undefined;
  private lastPublished: "running" | "completed" | "failed" | undefined;
  private personalTodos: Extract<ProviderTimelineItem, { type: "todo" }>["items"] = [];
  private readonly teamTasks = new Map<string, TeamTaskFact>();
  private readonly knownChildren = new Map<string, DshRoster["children"][number]>();

  constructor(
    readonly providerSessionId: string,
    private config: ProviderSessionConfig,
    readonly host: LiveHost,
    private readonly capabilities: readonly string[],
    private readonly emit: (event: ProviderEvent) => void,
    private readonly registerChild: (session: DshSession) => boolean,
    private readonly lookupChild?: (sessionId: string) => DshSession | undefined,
    private readonly roster?: SessionRoster,
  ) {}

  noteLabel(title: string | undefined): void {
    if (!title || this.introduced) return;
    this.config = { ...this.config, title };
  }

  noteDetail(description: string | undefined): void {
    if (!description || this.introduced) return;
    this.detail = description;
  }

  pendingLabel(): string | undefined {
    return this.config.title;
  }

  noteMode(mode: string | undefined): void {
    if (mode) this.childMode = mode;
  }

  async open(requestId: string, persistence: unknown): Promise<void> {
    const existing =
      isRecord(persistence) && typeof persistence.sessionId === "string"
        ? persistence.sessionId
        : undefined;
    this.resolvedId = existing ?? (await this.create());
    if (this.config.model) await this.select(this.config.model, this.config.thinkingOption);
    else await this.adoptProjectedSelection();
    this.introduced = true;
    this.emit({
      type: "session.opened",
      requestId,
      sessionId: this.providerSessionId,
      capabilities: this.capabilities,
      restoration: "core",
      cwd: this.config.cwd,
      persistence: { version: 1, data: { sessionId: this.resolvedId } },
      ...(this.config.title ? { title: this.config.title } : {}),
    });
    // Create uses history "skip". This stream activates the host and carries the reply.
    this.ensureFollow();
    this.emit({
      type: "session.commands",
      sessionId: this.providerSessionId,
      commands: await this.commands(),
    });
    await this.emitConfig();
    this.emit({ type: "session.ready", requestId, sessionId: this.providerSessionId });
  }

  openChild(child: {
    sessionId: string;
    parentSessionId?: string;
    title?: string;
    description?: string;
    cwd?: string;
    mode?: string;
    kind?: "subagent" | "teammate";
  }): void {
    if (child.sessionId === this.resolvedId) return;
    if (child.parentSessionId && child.parentSessionId !== this.resolvedId) return;
    this.rememberChild(child);
    const existing = this.lookupChild?.(child.sessionId);
    if (existing) {
      existing.noteLabel(child.title);
      existing.noteDetail(child.description);
      existing.noteMode(child.mode);
      this.advance(existing, child.mode);
      return;
    }
    const session = new DshSession(
      child.sessionId,
      { ...this.config, cwd: child.cwd ?? this.config.cwd, title: child.title },
      this.host,
      this.capabilities,
      this.emit,
      this.registerChild,
      this.lookupChild,
      this.roster,
    );
    session.resolvedId = child.sessionId;
    session.audience = "child";
    session.parentProviderSessionId = this.providerSessionId;
    session.noteDetail(child.description);
    session.noteMode(child.mode);
    if (!this.registerChild(session)) return;
    this.advance(session, child.mode);
  }

  async prompt(prompt: ProviderPrompt): Promise<void> {
    if (prompt.input.type === "command" && prompt.input.name === "fork") {
      const created = await this.host.client.call(
        "session/fork",
        withRequest({ sessionId: this.resolvedId }),
      );
      const sessionId =
        isRecord(created) && typeof created.sessionId === "string" ? created.sessionId : "";
      this.emit({
        type: "session.notice",
        sessionId: this.providerSessionId,
        notice: {
          id: `fork:${sessionId}`,
          severity: "info",
          title: "Forked session",
          description: sessionId,
        },
      });
      this.emit({
        type: "session.prompt_result",
        sessionId: this.providerSessionId,
        clientMessageId: prompt.clientMessageId,
        result: { type: "completed" },
      });
      return;
    }
    const content = promptContent(prompt);
    if (
      content.some((part) => isRecord(part) && part.type === "image") &&
      !this.capabilities.includes("prompt.image")
    ) {
      throw new DshError("image", "This session cannot send images");
    }
    await this.host.client.call(
      "session/prompt",
      withRequest({
        requestId: prompt.clientMessageId,
        sessionId: this.resolvedId,
        mode: prompt.delivery === "steer" ? "steer" : "queue",
        content,
      }),
    );
    const turnId =
      prompt.delivery === "steer"
        ? (this.activeTurn ?? prompt.clientMessageId)
        : prompt.clientMessageId;
    if (prompt.delivery !== "steer") {
      this.activeTurn = turnId;
      this.emit({
        type: "session.turn",
        sessionId: this.providerSessionId,
        turnId,
        state: "started",
      });
    }
    this.emit({
      type: "session.prompt_result",
      sessionId: this.providerSessionId,
      clientMessageId: prompt.clientMessageId,
      result: prompt.delivery === "steer" ? { type: "steer", turnId } : { type: "turn", turnId },
    });
  }

  async configure(changes: ProviderConfigChanges): Promise<void> {
    if (changes.model) await this.select(changes.model, changes.thinkingOption ?? undefined);
    else if (changes.thinkingOption && this.selection) {
      await this.select(
        modelId(this.selection.provider, this.selection.model),
        changes.thinkingOption,
      );
    }
    if (changes.mode) {
      await this.host.client.call(
        "session/prompt",
        withRequest({
          requestId: `mode-${changes.mode}`,
          sessionId: this.resolvedId,
          mode: "queue",
          content: [{ type: "text", text: changes.mode === "plan" ? "/plan" : "/plan off" }],
        }),
      );
    }
    if (changes.providerOptions && "contextWindow" in changes.providerOptions) {
      await this.applyContextWindow(changes.providerOptions.contextWindow);
    }
    if (changes.providerOptions && "permission" in changes.providerOptions) {
      await this.applyPermission(changes.providerOptions.permission);
    }
    await this.emitConfig();
  }

  async interrupt(): Promise<void> {
    await this.host.client.call("session/cancel", withRequest({ sessionId: this.resolvedId }));
  }

  async canStop(openSessions: number): Promise<boolean> {
    if (!this.host.owned || openSessions > 1) return false;
    const state = await this.host.client.call(
      "session/state",
      withRequest({ sessionId: this.resolvedId }),
    );
    if (!isRecord(state)) return false;
    const pending = Array.isArray(state.pendingInput) ? state.pendingInput.length : 0;
    const queued = Array.isArray(state.queue) ? state.queue.length : 0;
    return state.running !== true && pending === 0 && queued === 0 && this.pending.size === 0;
  }

  offerWaterfall(frame: Record<string, unknown>, _clientId: string | undefined): boolean {
    if (
      typeof frame.event !== "string" ||
      typeof frame.eventId !== "string" ||
      !isRecord(frame.request)
    )
      return false;
    const permission = this.presentPermission(
      permissionFrom(frame.event, frame.eventId, frame.request),
    );
    if (!permission) return false;
    this.pending.set(permission.request.id, {
      eventId: frame.eventId,
      event: frame.event,
      questions: permission.questions,
    });
    this.emit({
      type: "session.permission",
      sessionId: this.chatSessionId(),
      request: permission.request,
    });
    return true;
  }

  async answer(
    permissionId: string,
    response: ProviderPermissionResponse,
    clientId: string | undefined,
  ): Promise<void> {
    const owner = this.ownerOf(permissionId);
    if (!owner) throw new DshError("permission", "That question is no longer waiting");
    await owner.settlePermission(permissionId, response, clientId);
  }

  private ownerOf(permissionId: string): DshSession | undefined {
    if (this.pending.has(permissionId)) return this;
    for (const childId of this.knownChildren.keys()) {
      const found = this.lookupChild?.(childId)?.ownerOf(permissionId);
      if (found) return found;
    }
    return undefined;
  }

  private async settlePermission(
    permissionId: string,
    response: ProviderPermissionResponse,
    clientId: string | undefined,
  ): Promise<void> {
    const pending = this.pending.get(permissionId);
    if (!pending) throw new DshError("permission", "That question is no longer waiting");
    if (!clientId) throw new DshError("permission", "The host event stream is not ready");
    const outcome = outcomeFor(pending, response);
    await this.host.client.call("$events/result", { clientId, eventId: pending.eventId, outcome });
    this.pending.delete(permissionId);
    this.emit({
      type: "session.permission_resolved",
      sessionId: this.chatSessionId(),
      permissionId,
    });
  }

  /** The card belongs on the chat the user is looking at. A child still owns the host answer. */
  private chatSessionId(): string {
    return this.parentProviderSessionId ?? this.providerSessionId;
  }

  private presentPermission(
    permission: { request: ProviderPermissionRequest; questions?: QuestionItem[] } | undefined,
  ): { request: ProviderPermissionRequest; questions?: QuestionItem[] } | undefined {
    if (!permission || !this.parentProviderSessionId) return permission;
    const name = this.config.title?.trim();
    if (!name) return permission;
    const reason = permission.request.title ?? permission.request.description;
    return {
      ...permission,
      request: {
        ...permission.request,
        title: name,
        ...(reason && reason !== name ? { description: reason } : {}),
      },
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.stopFollow?.();
  }

  private async create(): Promise<string> {
    const workspaceId = await this.workspaceFor(this.config.cwd);
    const created = await this.host.client.call(
      "session/create",
      withRequest(workspaceId ? { workspaceId } : { cwd: this.config.cwd }),
    );
    if (!isRecord(created) || typeof created.sessionId !== "string") {
      throw new DshError("session", "The host did not return a session id");
    }
    await this.useWorkspaceWrite(created.sessionId);
    return created.sessionId;
  }

  /** Register the Paseo folder so the new session is filed under it. */
  private async workspaceFor(cwd: string): Promise<string | undefined> {
    if (!cwd) return undefined;
    const created = await this.host.client
      .call("workspace/create", withRequest({ path: cwd }))
      .catch(() => undefined);
    if (!isRecord(created) || !isRecord(created.workspace)) return undefined;
    return typeof created.workspace.workspaceId === "string"
      ? created.workspace.workspaceId
      : undefined;
  }

  /** Pin a session Paseo just created to in-workspace edits. A missing command still leaves it open. */
  private async useWorkspaceWrite(sessionId: string): Promise<void> {
    await this.applyPermission("workspace-write", sessionId);
  }

  /** Switch the session preset without starting a model turn. */
  private async applyPermission(value: unknown, sessionId = this.resolvedId): Promise<void> {
    if (value !== "workspace-write" && value !== "danger-full-access") return;
    if (!sessionId || value === this.permissionPreset) return;
    const applied = await this.host.client
      .call("commands/execute", {
        agentId: sessionId,
        line: `/permission ${value}`,
        submittedAttachments: [],
      })
      .then(() => true)
      .catch(() => false);
    if (applied) this.permissionPreset = value;
  }

  private advance(session: DshSession, mode: string | undefined): void {
    if (mode === "provisioning") {
      session.introduce();
      return;
    }
    if (mode === "failed") {
      session.presentFailed();
      return;
    }
    if (mode === "external") {
      session.presentExternal();
      return;
    }
    // A catalog row already has its name. Show it before the child's log page arrives.
    if (session.pendingLabel()) session.introduce();
    session.ensureFollow();
  }

  private rememberChild(child: {
    sessionId: string;
    title?: string;
    description?: string;
    mode?: string;
    kind?: "subagent" | "teammate";
  }): void {
    const previous = this.knownChildren.get(child.sessionId);
    this.knownChildren.set(child.sessionId, {
      sessionId: child.sessionId,
      ...((child.title ?? previous?.title) ? { title: child.title ?? previous?.title } : {}),
      ...((child.description ?? previous?.description)
        ? { description: child.description ?? previous?.description }
        : {}),
      phase: rosterPhase(child.mode),
      kind: child.kind === "teammate" ? "teammate" : "subagent",
    });
    this.publishRoster();
  }

  private noteTeamTask(task: TeamTaskFact): void {
    this.teamTasks.set(task.id, task);
    this.emitTasks();
    this.publishRoster();
  }

  private emitTasks(): void {
    const team = [...this.teamTasks.values()].flatMap((task) => {
      if (task.status === "deleted") return [];
      return [
        {
          text: task.subject,
          completed: task.status === "completed",
          id: task.id,
          status: task.status,
        },
      ];
    });
    this.emit({
      type: "timeline.item",
      sessionId: this.providerSessionId,
      item: { type: "todo", id: "todos", items: [...this.personalTodos, ...team] },
    });
  }

  private publishRoster(): void {
    if (!this.roster || !this.resolvedId) return;
    const tasks = [...this.teamTasks.values()].flatMap((task) => {
      if (task.status === "deleted") return [];
      return [
        {
          id: task.id,
          subject: task.subject,
          description: task.description,
          status: task.status,
          ...(task.ownerId ? { ownerId: task.ownerId } : {}),
        },
      ];
    });
    this.roster.publish({
      sessionId: this.resolvedId,
      providerSessionId: this.providerSessionId,
      children: [...this.knownChildren.values()],
      tasks,
    });
  }

  private ensureFollow(): void {
    if (this.followed || this.disposed) return;
    this.followed = true;
    this.follow();
  }

  private follow(): void {
    this.stopFollow = this.host.client.follow(this.resolvedId, (value) => {
      if (this.disposed || !isRecord(value)) return;
      if (this.holding) {
        this.queued.push(value);
        return;
      }
      this.consume(value);
    });
  }

  private consume(value: Record<string, unknown>): void {
    if (value.type === "snapshot") {
      this.beginSnapshot(value);
      return;
    }
    if (!this.introduced) this.introduce();
    if (value.type === "assistant-stream") {
      this.onAssistantFrame(value.frame);
      return;
    }
    if (value.type === "event") this.apply(value);
    if (value.type === "error" && value.error instanceof Error) {
      this.emit({
        type: "session.runtime_failed",
        sessionId: this.providerSessionId,
        error: providerError(value.error),
      });
    }
  }

  /** The catalog projection is the full child list. The event page is only the recent tail. */
  private beginSnapshot(value: Record<string, unknown>): void {
    const records = Array.isArray(value.records) ? value.records : [];
    if (this.audience === "child") this.absorbFacts(value.projections);
    if (!this.introduced) {
      if (!this.pendingLabel()) this.noteLabel(childLabelFromSnapshot(records));
      if (this.audience === "child" && !this.pendingLabel()) this.noteLabel(this.providerSessionId);
      this.introduce();
    }
    this.openCatalog(value.projections);
    if (this.audience === "child" && value.hasMore === true) {
      this.holding = true;
      void this.finishSnapshot(records);
      return;
    }
    this.replay(records);
    void this.reconcileRunning();
  }

  private async finishSnapshot(records: unknown[]): Promise<void> {
    const older = await this.olderRecords(records).catch(() => []);
    if (this.disposed) return;
    this.replay([...older, ...records]);
    this.holding = false;
    const queued = this.queued.splice(0);
    for (const value of queued) {
      if (isRecord(value)) this.consume(value);
    }
    void this.reconcileRunning();
  }

  private replay(records: unknown[]): void {
    this.replayingSnapshot = true;
    for (const record of records) this.apply(record);
    this.replayingSnapshot = false;
    if (this.introduced) void this.emitConfig();
  }

  private openCatalog(projections: unknown): void {
    for (const entry of catalogEntries(projections)) {
      this.openChild({ sessionId: entry.id, title: entry.label, mode: entry.mode });
    }
  }

  /** Pages the child's own log. The follow snapshot is the last page, so older rows would be missing. */
  private async olderRecords(records: unknown[]): Promise<unknown[]> {
    const pages: unknown[][] = [];
    let before = firstEventSeq(records);
    for (let page = 0; page < 40 && before !== undefined; page += 1) {
      const older = await this.host.client.call(
        "session/events",
        withRequest({
          address: { kind: "session", sessionId: this.resolvedId },
          beforeSeq: before,
          maxMessages: 200,
        }),
      );
      if (!isRecord(older) || !Array.isArray(older.records) || older.records.length === 0) break;
      pages.push(older.records);
      if (older.hasMore !== true) break;
      const next = firstEventSeq(older.records);
      if (next === undefined || next >= before) break;
      before = next;
    }
    return pages.toReversed().flat();
  }

  /**
   * Catalog mode is not a lifecycle. The host's `running` flag and whether the last turn
   * completed decide the row. A `turn/end` error is not a failed child.
   */
  private async reconcileRunning(): Promise<void> {
    if (this.audience !== "child" || !this.resolvedId || this.disposed) return;
    if (this.childMode === "failed" || this.childMode === "external") return;
    const epoch = this.turnEpoch;
    const state = await this.host.client
      .call("session/state", withRequest({ sessionId: this.resolvedId }))
      .catch(() => undefined);
    if (this.disposed || this.turnEpoch !== epoch) return;
    if (this.childMode === "failed" || this.childMode === "external") return;
    if (!isRecord(state) || typeof state.running !== "boolean") return;
    this.applyHostRunning(state.running);
  }

  private absorbFacts(projections: unknown): void {
    const facts = readChildProjection(projections);
    if (facts.label) this.noteLabel(facts.label);
    if (facts.mode) this.childMode = facts.mode;
    if (facts.sessionTitle) this.sessionTitle = facts.sessionTitle;
    if (facts.tokenTotal !== undefined) this.tokenTotal = facts.tokenTotal;
    if (facts.timing) this.timing = facts.timing;
    if (facts.lastTurnCompleted !== undefined) this.projectedCompleted = facts.lastTurnCompleted;
  }

  private applyHostRunning(running: boolean): void {
    if (running) this.markRunning();
    else this.markInactive();
    this.emitSubtitle(running);
  }

  private markRunning(): void {
    if (this.activeTurn && !this.settled) return;
    this.settled = false;
    this.noteTurn(0, { state: "started" });
  }

  private markInactive(): void {
    if (!this.activeTurn && this.settled && this.lastPublished === "completed") return;
    this.activeTurn = undefined;
    this.settled = false;
    this.settle("completed");
  }

  private turnCompleted(): boolean {
    if (this.observedTurn) return this.observedCompleted === true;
    return this.projectedCompleted === true;
  }

  private apply(record: unknown): void {
    if (!isRecord(record) || record.type !== "event" || !isRecord(record.event)) return;
    const event = record.event;
    if (typeof event.type !== "string" || typeof event.seq !== "number") return;
    const wire: WireEvent = { type: event.type, seq: event.seq, data: event.data };
    if (wire.type === "model/selection") this.adoptWireSelection(wire.data);
    const mapped = mapWireEvent(wire, this.audience);
    if (mapped.child) this.openChild(mapped.child);
    if (mapped.teamTask) this.noteTeamTask(mapped.teamTask);
    const settlement = attemptIdForAssistantSettlement(this.liveAttempt, {
      type: event.type,
      surfaceOp: event.surfaceOp,
      data: event.data,
    });
    const items = mapped.items.filter((item) => {
      if (item.type !== "todo") return true;
      this.personalTodos = item.items;
      return false;
    });
    if (!mapped.teamTask && items.length !== mapped.items.length) this.emitTasks();
    for (const item of this.present(event.seq, items, settlement)) {
      this.rememberTool(item);
      this.emit({ type: "timeline.item", sessionId: this.providerSessionId, item });
    }
    if (mapped.usage) {
      const remembered = rememberContextWindow(this.contextWindowMax, mapped.usage);
      this.contextWindowMax = remembered.remembered;
      this.emit({
        type: "session.usage",
        sessionId: this.providerSessionId,
        usage: remembered.usage,
      });
    }
    if (mapped.permission && mapped.permission !== this.permissionPreset) {
      this.permissionPreset = mapped.permission;
      if (this.introduced && !this.replayingSnapshot) void this.emitConfig();
    }
    if (mapped.mode) void this.emitConfig(mapped.mode);
    if (mapped.turn) this.takeTurn(event.seq, mapped.turn);
  }

  /** Child status follows the host. Replayed turn endings stay in the log and do not set the row. */
  private takeTurn(
    seq: number,
    turn: { state: "started" | "completed" | "failed" | "canceled"; error?: string },
  ): void {
    if (this.audience !== "child") {
      this.noteTurn(seq, turn);
      return;
    }
    this.observedTurn = true;
    if (turn.state === "started") this.observedCompleted = undefined;
    else this.observedCompleted = turn.state === "completed";
    if (this.replayingSnapshot) return;
    if (turn.state === "started") {
      this.noteTurn(seq, turn);
      this.emitSubtitle(true);
      return;
    }
    this.turnEpoch += 1;
    void this.reconcileRunning();
  }

  /** A child has no Paseo prompt, so its own turn/start has to open the row's status. */
  private noteTurn(
    seq: number,
    turn: { state: "started" | "completed" | "failed" | "canceled"; error?: string },
  ): void {
    this.turnEpoch += 1;
    if (turn.state === "started") {
      if (this.activeTurn) return;
      this.activeTurn = `turn:${seq}`;
    } else if (!this.activeTurn) this.activeTurn = `turn:${seq}`;
    const turnId = this.activeTurn;
    if (!turnId) return;
    this.emit({
      type: "session.turn",
      sessionId: this.providerSessionId,
      turnId,
      state: turn.state,
      ...(turn.error ? { error: { message: turn.error } } : {}),
    });
    this.rememberTurn(turn.state);
    if (turn.state !== "started") {
      this.activeTurn = undefined;
      this.settled = true;
    }
  }

  private introduce(): void {
    if (this.introduced) return;
    this.introduced = true;
    this.emit({
      type: "session.opened",
      sessionId: this.providerSessionId,
      ...(this.parentProviderSessionId ? { parentSessionId: this.parentProviderSessionId } : {}),
      capabilities: this.capabilities,
      restoration: "parent",
      cwd: this.config.cwd,
      persistence: { version: 1, data: { sessionId: this.resolvedId } },
      ...(this.config.title ? { title: this.config.title } : {}),
      ...(this.detail ? { description: this.detail } : {}),
    });
    this.emit({ type: "session.ready", sessionId: this.providerSessionId });
  }

  private presentFailed(): void {
    this.childMode = "failed";
    this.introduce();
    if (this.lastPublished === "failed") return;
    this.settled = false;
    this.settle("failed");
  }

  private presentExternal(): void {
    this.childMode = "external";
    this.introduce();
    this.settle("completed");
    this.emitSubtitle(false);
  }

  private settle(state: "completed" | "failed" | "canceled"): void {
    if (this.settled) return;
    this.settled = true;
    this.rememberTurn(state);
    this.emit({
      type: "session.turn",
      sessionId: this.providerSessionId,
      turnId: `turn:${this.resolvedId}`,
      state,
    });
  }

  private rememberTurn(state: "started" | "completed" | "failed" | "canceled"): void {
    if (state === "started") this.lastPublished = "running";
    else if (state === "failed") this.lastPublished = "failed";
    else this.lastPublished = "completed";
  }

  private emitSubtitle(running: boolean): void {
    if (this.audience !== "child" || !this.introduced) return;
    const external = this.childMode === "external";
    const subtitle = formatChildSubtitle({
      sessionTitle: this.sessionTitle,
      mode: this.childMode,
      external,
      running,
      lastTurnCompleted: this.turnCompleted(),
      tokenTotal: this.tokenTotal,
      durationMs: childDuration({ timing: this.timing, running, now: Date.now() }),
    });
    if (!subtitle) return;
    this.emit({
      type: "session.notice",
      sessionId: this.providerSessionId,
      notice: {
        id: PROVIDER_CHILD_SUBTITLE_NOTICE,
        severity: "info",
        title: "子会话",
        description: subtitle,
      },
    });
  }

  private onAssistantFrame(frame: unknown): void {
    const reduced = reduceAssistantFrame(this.liveAttempt, frame);
    this.liveAttempt = reduced.state;
    if (reduced.commit) this.liveCommits.set(reduced.commit.seq, reduced.commit.attemptId);
    for (const item of reduced.items) {
      this.emit({ type: "timeline.item", sessionId: this.providerSessionId, item });
    }
  }

  private present(
    seq: number,
    items: ProviderTimelineItem[],
    settlementAttemptId?: string,
  ): ProviderTimelineItem[] {
    if (settlementAttemptId) this.liveCommits.set(seq, settlementAttemptId);
    const attemptId = this.liveCommits.get(seq);
    return items.flatMap((item) => {
      const retargeted = attemptId ? retargetLiveItem(attemptId, item) : item;
      if (retargeted.type !== "tool_call" || retargeted.status === "running") return [retargeted];
      return [completeToolCall(this.openTools.get(retargeted.callId), retargeted)];
    });
  }

  private rememberTool(item: ProviderTimelineItem): void {
    if (item.type === "tool_call" && item.status === "running")
      this.openTools.set(item.callId, item);
  }

  private async select(model: string, thinking: string | null | undefined): Promise<void> {
    const parsed = parseModelId(model);
    if (!parsed) throw new DshError("model", "The selected model is not a provider and model pair");
    const catalog = await readCatalog(this.host.client);
    const reasoningEffort = listedEffort(catalog.models, parsed, thinking);
    const applied = await this.writeSelection(parsed, reasoningEffort);
    this.selection = parsed;
    this.appliedThinking = applied;
    this.thinkingUnapplied = reasoningEffort !== undefined && applied === undefined;
  }

  /** A borrowed effort the host rejects must not stop the session from opening. */
  private async writeSelection(
    parsed: { provider: string; model: string },
    reasoningEffort: string | undefined,
  ): Promise<string | undefined> {
    try {
      await this.callSelect(parsed, reasoningEffort);
      return reasoningEffort;
    } catch (error) {
      if (!reasoningEffort || !rejectsReasoningEffort(error)) throw error;
      await this.callSelect(parsed);
      return undefined;
    }
  }

  private callSelect(
    parsed: { provider: string; model: string },
    reasoningEffort?: string,
  ): Promise<unknown> {
    return this.host.client.call(
      "session/selectModel",
      withRequest({
        sessionId: this.resolvedId,
        provider: parsed.provider,
        model: parsed.model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
      }),
    );
  }

  private async adoptProjectedSelection(): Promise<void> {
    const projected = await this.host.client
      .call("session/projections", withRequest({ sessionId: this.resolvedId }))
      .then(selectionFromProjection)
      .catch(() => undefined);
    if (!projected) return;
    this.selection = { provider: projected.provider, model: projected.model };
    this.appliedThinking = projected.reasoningEffort;
  }

  private adoptWireSelection(data: unknown): void {
    const picked = selectionFromWire(data);
    if (!picked) return;
    this.selection = { provider: picked.provider, model: picked.model };
    this.appliedThinking = picked.reasoningEffort;
    void this.emitConfig();
  }

  private async applyContextWindow(value: unknown): Promise<void> {
    if (!this.selection) {
      throw new DshError("context", "Select a model before setting its context window");
    }
    if (value === null) return;
    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
      throw new DshError("context", "The context window must be a positive token count");
    }
    const tokens = Number(value);
    if (!Number.isSafeInteger(tokens)) {
      throw new DshError("context", "The context window must be a positive token count");
    }
    const surface = await loadSurface(this.host.client);
    const mutation = contextMutation(
      surface,
      this.selection.provider,
      this.selection.model,
      tokens,
    );
    if (!mutation) throw new DshError("context", "This model has no context window setting");
    await this.host.client.call("settings/mutate", {
      ns: mutation.ns,
      ops: mutation.ops,
      ...(mutation.expectedRevision === undefined
        ? {}
        : { expectedRevision: mutation.expectedRevision }),
    });
    this.contextWindowMax = tokens;
  }

  private async emitConfig(mode?: string): Promise<void> {
    const config = await this.configState();
    const next = mode ? { ...config, mode } : config;
    this.emit({
      type: "session.config",
      sessionId: this.providerSessionId,
      config: next,
    });
    const reported = next.providerOptions?.contextWindow;
    const configured = typeof reported === "string" ? Number(reported) : undefined;
    const tokens =
      this.contextWindowMax ?? (Number.isSafeInteger(configured) ? configured : undefined);
    if (tokens === undefined) return;
    const remembered = rememberContextWindow(this.contextWindowMax, {
      contextWindowMaxTokens: tokens,
    });
    this.contextWindowMax = remembered.remembered;
    this.emit({
      type: "session.usage",
      sessionId: this.providerSessionId,
      usage: remembered.usage,
    });
  }

  private async commands(): Promise<ProviderCommand[]> {
    const listed = await this.host.client
      .call("skills/list", withRequest({ sessionId: this.resolvedId }))
      .catch(() => undefined);
    const skills = isRecord(listed) && Array.isArray(listed.skills) ? listed.skills : [];
    return [
      { name: "plan", description: "Enter plan mode", argumentHint: "[off]" },
      { name: "compact", description: "Compact the conversation" },
      { name: "fork", description: "Fork this session" },
      ...skills.flatMap((skill) => {
        if (
          !isRecord(skill) ||
          typeof skill.name !== "string" ||
          typeof skill.description !== "string"
        )
          return [];
        return [{ name: skill.name, description: skill.description }];
      }),
    ];
  }

  private async configState() {
    const surface = await loadSurface(this.host.client);
    const catalog = await readCatalog(this.host.client, surface);
    const currentId = this.selection
      ? modelId(this.selection.provider, this.selection.model)
      : catalog.defaultModel;
    const current = catalog.models.find((model) => model.id === currentId);
    const thinkingOptions = withSessionEffort(current?.thinkingOptions ?? [], this.appliedThinking);
    const thinkingOption = this.thinkingUnapplied
      ? undefined
      : selectedThinking(thinkingOptions, this.appliedThinking);
    const parsed = currentId ? parseModelId(currentId) : undefined;
    const windowControl = parsed
      ? contextControl(surface, parsed.provider, parsed.model, this.contextWindowMax)
      : undefined;
    const access = permissionControl(this.permissionPreset);
    return {
      model: currentId,
      mode: this.config.mode ?? catalog.defaultMode,
      ...(thinkingOption ? { thinkingOption } : {}),
      models: catalog.models,
      modes: catalog.modes,
      thinkingOptions,
      controls: [...access.controls, ...(windowControl?.controls ?? [])],
      providerOptions: { ...access.providerOptions, ...windowControl?.providerOptions },
    };
  }
}

async function loadSurface(client: DshCaller): Promise<ModelSurface> {
  const [providers, described] = await Promise.all([
    client.call("llm/listConfigurableProviders", {}).catch(() => undefined),
    client.call("settings/describe", {}).catch(() => undefined),
  ]);
  return readModelSurface(providers, described);
}

async function readCatalog(client: DshCaller, surface?: ModelSurface): Promise<ProviderCatalog> {
  const value = await client.call("session/modelCatalog", {});
  const groups = isRecord(value) && Array.isArray(value.groups) ? value.groups : [];
  const models = groups.flatMap((group) => {
    if (!isRecord(group) || typeof group.id !== "string" || !Array.isArray(group.models)) return [];
    const groupId = group.id;
    const groupName = typeof group.name === "string" ? group.name : groupId;
    return group.models.flatMap((model) => {
      if (!isRecord(model) || typeof model.id !== "string") return [];
      const thinking = thinkingForModel(model);
      const detail =
        typeof model.description === "string" && model.description.trim()
          ? model.description
          : undefined;
      const id = modelId(groupId, model.id);
      const tokens = surface ? windowFor(surface, groupId, model.id) : undefined;
      const aliases = [model.id, `${groupId}/${model.id}`].filter((alias) => alias !== id);
      return [
        {
          id,
          aliases,
          // The picker prints `description ?? id`. The id is the host pair, so the
          // row keeps a human name and a real subtitle.
          label: typeof model.name === "string" && model.name ? model.name : model.id,
          description: detail ?? groupName,
          ...(tokens ? { contextWindowMaxTokens: tokens } : {}),
          thinkingOptions: thinking.thinkingOptions,
          ...(thinking.defaultThinkingOptionId
            ? { defaultThinkingOptionId: thinking.defaultThinkingOptionId }
            : {}),
        },
      ];
    });
  });
  const fallback =
    isRecord(value) &&
    isRecord(value.default) &&
    typeof value.default.provider === "string" &&
    typeof value.default.model === "string"
      ? modelId(value.default.provider, value.default.model)
      : models[0]?.id;
  if (fallback) {
    const chosen = models.find((model) => model.id === fallback);
    if (chosen) Object.assign(chosen, { isDefault: true });
  }
  shareDeclaredThinking(models);
  return {
    models,
    modes: [
      { id: "default", label: "智能体" },
      { id: "plan", label: "计划" },
    ],
    ...(fallback ? { defaultModel: fallback } : {}),
    defaultMode: "default",
  };
}

const PERMISSION_CHOICES = [
  { value: "workspace-write", label: "工作区写入" },
  { value: "danger-full-access", label: "完全写入" },
] as const;

function permissionChoices(preset: string | undefined): { value: string; label: string }[] {
  const choices: { value: string; label: string }[] = PERMISSION_CHOICES.map((choice) => ({
    value: choice.value,
    label: choice.label,
  }));
  if (preset && !choices.some((choice) => choice.value === preset)) {
    choices.push({ value: preset, label: preset });
  }
  return choices;
}

function permissionControl(preset: string | undefined): {
  controls: [
    {
      type: "select";
      key: "permission";
      label: string;
      icon: string;
      defaultValue: string;
      choices: { value: string; label: string }[];
    },
  ];
  providerOptions: { permission: string };
} {
  const value = preset ?? "workspace-write";
  const choices = permissionChoices(preset);
  return {
    controls: [
      {
        type: "select",
        key: "permission",
        label: "访问权限",
        icon: "shield-check",
        defaultValue: value,
        choices,
      },
    ],
    providerOptions: { permission: value },
  };
}

/** A model with no `reasoning` advertises no efforts of its own. */
function thinkingForModel(model: Record<string, unknown>): {
  thinkingOptions: { id: string; label: string; description?: string; isDefault?: boolean }[];
  defaultThinkingOptionId?: string;
} {
  const reasoning = isRecord(model.reasoning) ? model.reasoning : undefined;
  const efforts = reasoning && Array.isArray(reasoning.efforts) ? reasoning.efforts : [];
  const thinkingOptions: {
    id: string;
    label: string;
    description?: string;
    isDefault?: boolean;
  }[] = efforts.flatMap((effort) => {
    if (!isRecord(effort) || typeof effort.id !== "string") return [];
    const description = typeof effort.description === "string" ? effort.description : undefined;
    return [
      {
        id: effort.id,
        label: typeof effort.name === "string" ? effort.name : effort.id,
        ...(description ? { description } : {}),
      },
    ];
  });
  if (thinkingOptions.length === 0) return { thinkingOptions };
  const defaultEffort =
    typeof reasoning?.defaultEffort === "string" ? reasoning.defaultEffort : undefined;
  const chosen = defaultEffort
    ? thinkingOptions.find((option) => option.id === defaultEffort)
    : undefined;
  if (chosen) {
    Object.assign(chosen, { isDefault: true });
    return { thinkingOptions, defaultThinkingOptionId: chosen.id };
  }
  if (!thinkingOptions.some((option) => option.id === "")) {
    thinkingOptions.unshift({
      id: PROVIDER_DEFAULT_THINKING,
      label: "Provider default",
      isDefault: true,
    });
  }
  return { thinkingOptions, defaultThinkingOptionId: thinkingOptions[0]?.id };
}

/** Models that publish no efforts still offer the efforts another catalog model declared. */
function shareDeclaredThinking(
  models: {
    thinkingOptions: { id: string; label: string; description?: string; isDefault?: boolean }[];
    defaultThinkingOptionId?: string;
  }[],
): void {
  const source = models.find((model) => model.thinkingOptions.length > 0);
  if (!source) return;
  for (const model of models) {
    if (model.thinkingOptions.length > 0) continue;
    model.thinkingOptions = source.thinkingOptions.map((option) => ({ ...option }));
    if (source.defaultThinkingOptionId) {
      model.defaultThinkingOptionId = source.defaultThinkingOptionId;
    }
  }
}

function rejectsReasoningEffort(error: unknown): boolean {
  return (
    error instanceof DshError &&
    error.code === "session/model-unavailable" &&
    error.message.includes("does not support reasoning effort")
  );
}

function selectedThinking(
  options: readonly { id: string; isDefault?: boolean }[],
  applied: string | undefined,
): string | undefined {
  if (applied && options.some((option) => option.id === applied)) return applied;
  return options.find((option) => option.isDefault)?.id;
}

function withSessionEffort(
  options: { id: string; label: string; description?: string; isDefault?: boolean }[],
  effort: string | undefined,
): { id: string; label: string; description?: string; isDefault?: boolean }[] {
  if (!effort || options.some((option) => option.id === effort)) return options;
  return [...options, { id: effort, label: effort }];
}

function listedEffort(
  models: readonly { id: string; thinkingOptions?: readonly { id: string }[] }[],
  parsed: { provider: string; model: string },
  thinking: string | null | undefined,
): string | undefined {
  const effort = reasoningForWrite(thinking);
  if (!effort) return undefined;
  const model = models.find((item) => item.id === modelId(parsed.provider, parsed.model));
  if (!model?.thinkingOptions?.some((option) => option.id === effort)) return undefined;
  return effort;
}

export async function listConnectedWorkspaces(options: {
  settings: SettingsSource;
  pool: HostPool;
  sessions?: SessionStore;
  discover?: (io?: DiscoverIO) => Promise<DiscoveredInstall[]>;
}): Promise<ListedWorkspace[]> {
  const discover = options.discover ?? (() => discoverInstalls(createNodeDiscoverIO()));
  await restoreAttachment(options.settings, options.pool, options.sessions, discover);
  const choice = await readChoice(options.settings);
  if (!choice.installId || !choice.mode) return [];
  const host = options.pool.live(choice.installId);
  if (!host) return [];
  return readWorkspaceList(host.client);
}

async function readSessions(
  client: DshCaller,
  input: { cwd?: string; query?: string; limit?: number },
) {
  const index = await readImportIndex(client);
  return toProviderSessions(filterSessions(index.sessions, input));
}

interface QuestionItem {
  id: string;
  header: string;
  prompt: string;
  detail?: string;
  options?: { label: string }[];
  multiSelect?: boolean;
  intent?: { kind?: string; approve?: string };
}

function permissionFrom(
  event: string,
  _eventId: string,
  request: Record<string, unknown>,
): { request: ProviderPermissionRequest; questions?: QuestionItem[] } | undefined {
  if (event === "approval/request") {
    const toolName = typeof request.toolName === "string" ? request.toolName : "";
    if (!toolName) return undefined;
    const reason = approvalReason(request);
    return {
      request: {
        id: _eventId,
        name: toolName,
        kind: "tool",
        title: reason ?? `工具 ${toolName} 请求越权执行`,
        actions: [
          { id: "reject", label: "拒绝", behavior: "deny", variant: "danger" },
          { id: "allow", label: "允许一次", behavior: "allow", variant: "primary" },
        ],
      },
    };
  }
  if (event !== "user-questions/request" || !Array.isArray(request.questions)) return undefined;
  const questions = request.questions.flatMap((entry) => {
    const question = asQuestion(entry);
    return question ? [question] : [];
  });
  if (questions.length === 0) return undefined;
  const plan = questions.length === 1 ? questions[0]?.intent : undefined;
  if (plan?.kind === "plan-review") {
    const question = questions[0]!;
    return {
      request: {
        id: question.id,
        name: "exit_plan_mode",
        kind: "plan",
        title: question.header,
        description: question.detail ?? question.prompt,
        actions: [
          { id: "keep-planning", label: "Keep planning", behavior: "deny" },
          {
            id: "approve",
            label: plan.approve ?? "Approve",
            behavior: "allow",
            variant: "primary",
          },
        ],
      },
      questions,
    };
  }
  return {
    request: {
      id: questions[0]!.id,
      name: "ask_user_question",
      kind: "question",
      input: {
        questions: questions.map((question) => ({
          id: question.id,
          header: question.header,
          question: question.prompt,
          options: (question.options ?? []).map((option) => ({ label: option.label })),
          multiSelect: question.multiSelect === true,
          allowOther: true,
        })),
      },
    },
    questions,
  };
}

function approvalReason(request: Record<string, unknown>): string | undefined {
  if (typeof request.displayReason === "string" && request.displayReason.trim()) {
    return request.displayReason;
  }
  if (typeof request.reason === "string" && request.reason.trim()) return request.reason;
  return undefined;
}

function firstEventSeq(records: unknown[]): number | undefined {
  for (const record of records) {
    if (!isRecord(record) || !isRecord(record.event)) continue;
    if (typeof record.event.seq === "number") return record.event.seq;
  }
  return undefined;
}

function outcomeFor(
  pending: { event: string; questions?: QuestionItem[] },
  response: ProviderPermissionResponse,
): Record<string, unknown> {
  if (pending.event === "approval/request") {
    return { kind: "result", value: response.behavior === "allow" ? "allowed-once" : "rejected" };
  }
  if (response.behavior === "deny") {
    return {
      kind: "rejected",
      error: { name: "Error", message: response.message ?? "ASK_CANCELLED", code: "ASK_CANCELLED" },
    };
  }
  const questions = pending.questions ?? [];
  const plan = questions[0]?.intent?.kind === "plan-review" ? questions[0] : undefined;
  if (plan?.intent?.approve && response.selectedActionId === "approve") {
    return {
      kind: "result",
      value: { answers: [{ id: plan.id, selected: [plan.intent.approve] }] },
    };
  }
  const answers =
    isRecord(response.updatedInput) && isRecord(response.updatedInput.answers)
      ? response.updatedInput.answers
      : {};
  return {
    kind: "result",
    value: {
      answers: questions.map((question) => answerItem(question, answers[question.header])),
    },
  };
}

function answerItem(
  question: QuestionItem,
  raw: unknown,
): { id: string; selected: string[]; custom?: string } {
  const text = typeof raw === "string" ? raw : "";
  const labels = new Set((question.options ?? []).map((option) => option.label));
  const parts = text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (question.multiSelect) {
    const selected = parts.filter((part) => labels.has(part));
    const custom = parts.filter((part) => !labels.has(part)).join(", ");
    return { id: question.id, selected, ...(custom ? { custom } : {}) };
  }
  if (labels.has(text)) return { id: question.id, selected: [text] };
  return { id: question.id, selected: [], ...(text ? { custom: text } : {}) };
}

function promptContent(prompt: ProviderPrompt): Record<string, unknown>[] {
  if (prompt.input.type === "command") {
    const args = prompt.input.arguments.trim();
    return [
      { type: "text", text: args ? `/${prompt.input.name} ${args}` : `/${prompt.input.name}` },
    ];
  }
  const content: Record<string, unknown>[] = [];
  for (const part of prompt.input.content) {
    if (part.type === "text") content.push({ type: "text", text: part.text });
    else if (part.type === "image")
      content.push({ type: "image", mediaType: part.mimeType, data: part.data });
    else if (part.type === "uploaded_file")
      content.push({ type: "text", text: `File: ${part.path}` });
    else if ("text" in part && typeof part.text === "string")
      content.push({ type: "text", text: part.text });
    else if ("title" in part && typeof part.title === "string")
      content.push({ type: "text", text: part.title });
  }
  return content;
}

/** Typert names the single session argument `request`; `cwd` lives inside it. */
function withRequest(request: Record<string, unknown>): Record<string, unknown> {
  return { request };
}

function persistedSessionId(data: unknown): string {
  if (!isRecord(data) || typeof data.sessionId !== "string")
    throw new DshError("session", "Missing DeepSeek Harness session id");
  return data.sessionId;
}

function providerError(failure: unknown): ProviderError {
  if (failure instanceof DshError) {
    return {
      code: failure.code,
      message: failure.message.includes(failure.code)
        ? failure.message
        : `${failure.code}: ${failure.message}`,
    };
  }
  return { message: failure instanceof Error ? failure.message : "DeepSeek Harness failed" };
}

function asQuestion(value: unknown): QuestionItem | undefined {
  if (!isRecord(value) || typeof value.id !== "string") return undefined;
  const prompt = typeof value.question === "string" ? value.question : undefined;
  const header = typeof value.header === "string" ? value.header : prompt;
  if (!header || !prompt) return undefined;
  const intent = isRecord(value.intent) ? value.intent : undefined;
  return {
    id: value.id,
    header,
    prompt,
    ...(typeof value.detail === "string" ? { detail: value.detail } : {}),
    ...(Array.isArray(value.options)
      ? {
          options: value.options.flatMap((option) =>
            isRecord(option) && typeof option.label === "string" ? [{ label: option.label }] : [],
          ),
        }
      : {}),
    ...(value.multiSelect === true ? { multiSelect: true } : {}),
    ...(intent
      ? {
          intent: {
            ...(typeof intent.kind === "string" ? { kind: intent.kind } : {}),
            ...(typeof intent.approve === "string" ? { approve: intent.approve } : {}),
          },
        }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
