import {
  negotiateProviderCapabilities,
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
  liveItemId,
  mapAddedSession,
  mapWireEvent,
  modelId,
  reduceAssistantFrame,
  rememberContextWindow,
  type LiveAttempt,
  parseModelId,
  PROVIDER_DEFAULT_THINKING,
  reasoningForWrite,
  type WireEvent,
} from "./events.js";
import { DshError, type DshCaller } from "./remote.js";
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
  const forgetLogin = async () => {
    await options.pool.dropAttached();
    await options.sessions?.clear();
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
      return readStatus(options.settings, options.pool, discover);
    },
    async connect(request) {
      if (!request.versions.includes(1))
        throw new DshError("protocol", "Provider protocol version 1 is required");
      await restoreSaved();
      const choice = await chosenInstall(options.settings, discover);
      const host =
        choice.mode === "build"
          ? await options.pool.build(choice.install)
          : requireAttachment(options.pool, choice.install);
      return openConnection(
        host,
        negotiateProviderCapabilities(request.capabilities, CAPABILITIES),
        () => {
          if (host.owned) void options.pool.closeOwned();
        },
        forgetLogin,
        () => options.pool.noteTransportFailure(),
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

async function readStatus(
  settings: SettingsSource,
  pool: HostPool,
  discover: () => Promise<DiscoveredInstall[]>,
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
    try {
      await host?.client.ping();
    } catch (error) {
      pool.noteTransportFailure();
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
  host: LiveHost,
  capabilities: readonly string[],
  onClose: () => void,
  onUnauthorized: () => Promise<void>,
  onTransport: () => void,
): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, DshSession>();
  let closed = false;
  let clientId: string | undefined;
  const stopEvents = host.client.listen((value) => {
    if (!isRecord(value)) return;
    if (value.type === "ready" && typeof value.clientId === "string") clientId = value.clientId;
    if (value.type === "emit" && value.event === "api-session/added" && Array.isArray(value.args)) {
      const child = mapAddedSession(value.args[0]);
      if (child) {
        const parent = [...sessions.values()].find(
          (session) => session.dshId === child.parentSessionId,
        );
        parent?.openChild(child);
      }
    }
    if (value.type === "waterfall") {
      for (const session of sessions.values()) {
        if (session.offerWaterfall(value, clientId)) break;
      }
    }
  });
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
          void dispatch(input).catch(async (error: unknown) => {
            if (isUnauthorized(error)) await onUnauthorized();
            if (isTransport(error)) onTransport();
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

  async function dispatch(input: ProviderInput): Promise<void> {
    if (input.type === "catalog") {
      emit({
        type: "catalog",
        requestId: input.requestId,
        catalog: await readCatalog(host.client),
      });
      return;
    }
    if (input.type === "sessions") {
      emit({
        type: "sessions",
        requestId: input.requestId,
        sessions: await readSessions(host.client, {
          cwd: input.cwd,
          query: input.query,
          limit: input.limit,
        }),
      });
      return;
    }
    if (input.type === "session.open") {
      const session = new DshSession(
        input.sessionId,
        input.config,
        host,
        capabilities,
        emit,
        (child) => {
          sessions.set(child.providerSessionId, child);
        },
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
      const sessionId = persistedSessionId(input.persistence.data);
      await host.client.call(
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
  private activeTurn: string | undefined;
  private contextWindowMax: number | undefined;
  private liveAttempt: LiveAttempt | undefined;
  private readonly liveCommits = new Map<number, string>();
  private readonly openTools = new Map<string, ProviderTimelineItem>();
  private disposed = false;

  constructor(
    readonly providerSessionId: string,
    private readonly config: ProviderSessionConfig,
    private readonly host: LiveHost,
    private readonly capabilities: readonly string[],
    private readonly emit: (event: ProviderEvent) => void,
    private readonly registerChild: (session: DshSession) => void,
  ) {}

  async open(requestId: string, persistence: unknown): Promise<void> {
    const existing =
      isRecord(persistence) && typeof persistence.sessionId === "string"
        ? persistence.sessionId
        : undefined;
    this.resolvedId = existing ?? (await this.create());
    if (this.config.model) await this.select(this.config.model, this.config.thinkingOption);
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
    this.follow();
    this.emit({
      type: "session.commands",
      sessionId: this.providerSessionId,
      commands: await this.commands(),
    });
    this.emit({
      type: "session.config",
      sessionId: this.providerSessionId,
      config: await this.configState(),
    });
    this.emit({ type: "session.ready", requestId, sessionId: this.providerSessionId });
  }

  openChild(child: {
    sessionId: string;
    parentSessionId: string;
    title?: string;
    cwd?: string;
  }): void {
    if (child.parentSessionId !== this.resolvedId) return;
    const session = new DshSession(
      child.sessionId,
      { ...this.config, cwd: child.cwd ?? this.config.cwd, title: child.title },
      this.host,
      this.capabilities,
      this.emit,
      this.registerChild,
    );
    session.resolvedId = child.sessionId;
    this.registerChild(session);
    this.emit({
      type: "session.opened",
      sessionId: child.sessionId,
      parentSessionId: this.providerSessionId,
      capabilities: this.capabilities,
      restoration: "parent",
      cwd: child.cwd ?? this.config.cwd,
      persistence: { version: 1, data: { sessionId: child.sessionId } },
      ...(child.title ? { title: child.title } : {}),
    });
    session.follow();
    this.emit({ type: "session.ready", sessionId: child.sessionId });
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
    this.emit({
      type: "session.config",
      sessionId: this.providerSessionId,
      config: await this.configState(),
    });
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

  offerWaterfall(frame: Record<string, unknown>, clientId: string | undefined): boolean {
    if (
      typeof frame.event !== "string" ||
      typeof frame.eventId !== "string" ||
      !isRecord(frame.request)
    )
      return false;
    const permission = permissionFrom(frame.event, frame.eventId, frame.request);
    if (!permission) return false;
    this.pending.set(permission.request.id, {
      eventId: frame.eventId,
      event: frame.event,
      questions: permission.questions,
    });
    if (clientId) this.pending.get(permission.request.id)!.eventId = frame.eventId;
    this.emit({
      type: "session.permission",
      sessionId: this.providerSessionId,
      request: permission.request,
    });
    return true;
  }

  async answer(
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
      sessionId: this.providerSessionId,
      permissionId,
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.stopFollow?.();
  }

  private async create(): Promise<string> {
    const created = await this.host.client.call(
      "session/create",
      withRequest({ cwd: this.config.cwd }),
    );
    if (!isRecord(created) || typeof created.sessionId !== "string") {
      throw new DshError("session", "The host did not return a session id");
    }
    return created.sessionId;
  }

  private follow(): void {
    this.stopFollow = this.host.client.follow(this.resolvedId, (value) => {
      if (this.disposed || !isRecord(value)) return;
      if (value.type === "snapshot" && Array.isArray(value.records)) {
        for (const record of value.records) this.apply(record);
        return;
      }
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
    });
  }

  private apply(record: unknown): void {
    if (!isRecord(record) || record.type !== "event" || !isRecord(record.event)) return;
    const event = record.event;
    if (typeof event.type !== "string" || typeof event.seq !== "number") return;
    const wire: WireEvent = { type: event.type, seq: event.seq, data: event.data };
    const mapped = mapWireEvent(wire);
    for (const item of this.present(event.seq, mapped.items)) {
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
    if (mapped.mode) {
      const mode = mapped.mode;
      void this.configState().then((config) => {
        this.emit({
          type: "session.config",
          sessionId: this.providerSessionId,
          config: { ...config, mode },
        });
        return undefined;
      });
    }
    if (mapped.turn && this.activeTurn) {
      this.emit({
        type: "session.turn",
        sessionId: this.providerSessionId,
        turnId: this.activeTurn,
        state: mapped.turn.state,
        ...(mapped.turn.error ? { error: { message: mapped.turn.error } } : {}),
      });
      if (mapped.turn.state !== "started") this.activeTurn = undefined;
    }
  }

  private onAssistantFrame(frame: unknown): void {
    const reduced = reduceAssistantFrame(this.liveAttempt, frame);
    this.liveAttempt = reduced.state;
    if (reduced.commit) this.liveCommits.set(reduced.commit.seq, reduced.commit.attemptId);
    for (const item of reduced.items) {
      this.emit({ type: "timeline.item", sessionId: this.providerSessionId, item });
    }
  }

  private present(seq: number, items: ProviderTimelineItem[]): ProviderTimelineItem[] {
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
    await this.host.client.call(
      "session/selectModel",
      withRequest({
        sessionId: this.resolvedId,
        provider: parsed.provider,
        model: parsed.model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
      }),
    );
    this.selection = parsed;
    this.appliedThinking = reasoningEffort;
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
    const catalog = await readCatalog(this.host.client);
    const currentId = this.selection
      ? modelId(this.selection.provider, this.selection.model)
      : catalog.defaultModel;
    const current = catalog.models.find((model) => model.id === currentId);
    const thinkingOptions = current?.thinkingOptions ?? [];
    const thinkingOption =
      this.appliedThinking && thinkingOptions.some((option) => option.id === this.appliedThinking)
        ? this.appliedThinking
        : undefined;
    return {
      model: currentId,
      mode: this.config.mode ?? catalog.defaultMode,
      ...(thinkingOption ? { thinkingOption } : {}),
      models: catalog.models,
      modes: catalog.modes,
      thinkingOptions,
      settings: [],
    };
  }
}

async function readCatalog(client: DshCaller): Promise<ProviderCatalog> {
  const value = await client.call("session/modelCatalog", {});
  const groups = isRecord(value) && Array.isArray(value.groups) ? value.groups : [];
  const models = groups.flatMap((group) => {
    if (!isRecord(group) || typeof group.id !== "string" || !Array.isArray(group.models)) return [];
    const groupName = typeof group.name === "string" ? group.name : group.id;
    return group.models.flatMap((model) => {
      if (!isRecord(model) || typeof model.id !== "string") return [];
      const thinking = thinkingForModel(model);
      const detail = typeof model.description === "string" ? model.description : undefined;
      return [
        {
          id: modelId(String(group.id), String(model.id)),
          // The id is the provider/model pair the host requires. The picker shows
          // that id whenever description is missing, so the visible name stays the model name.
          label: typeof model.name === "string" ? model.name : model.id,
          description: detail ?? groupName,
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
  return {
    models,
    modes: [
      { id: "default", label: "Default" },
      { id: "plan", label: "Plan" },
    ],
    ...(fallback ? { defaultModel: fallback } : {}),
    defaultMode: "default",
  };
}

/** A model with no `reasoning` advertises no efforts. Another model's list must not fill in. */
function thinkingForModel(model: Record<string, unknown>): {
  thinkingOptions: { id: string; label: string }[];
  defaultThinkingOptionId?: string;
} {
  const reasoning = isRecord(model.reasoning) ? model.reasoning : undefined;
  const efforts = reasoning && Array.isArray(reasoning.efforts) ? reasoning.efforts : [];
  const thinkingOptions = efforts.flatMap((effort) => {
    if (!isRecord(effort) || typeof effort.id !== "string") return [];
    return [{ id: effort.id, label: typeof effort.name === "string" ? effort.name : effort.id }];
  });
  if (thinkingOptions.length === 0) return { thinkingOptions };
  const defaultEffort =
    typeof reasoning?.defaultEffort === "string" ? reasoning.defaultEffort : undefined;
  if (defaultEffort && thinkingOptions.some((option) => option.id === defaultEffort)) {
    return { thinkingOptions, defaultThinkingOptionId: defaultEffort };
  }
  if (!thinkingOptions.some((option) => option.id === "")) {
    thinkingOptions.unshift({ id: PROVIDER_DEFAULT_THINKING, label: "Provider default" });
  }
  return { thinkingOptions, defaultThinkingOptionId: thinkingOptions[0]?.id };
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
  if (event === "approval/request" && typeof request.id === "string") {
    return {
      request: {
        id: request.id,
        name: typeof request.toolName === "string" ? request.toolName : "tool",
        kind: "tool",
        description: typeof request.reason === "string" ? request.reason : undefined,
        actions: [
          { id: "reject", label: "Deny", behavior: "deny", variant: "danger" },
          { id: "allow", label: "Allow once", behavior: "allow", variant: "primary" },
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
