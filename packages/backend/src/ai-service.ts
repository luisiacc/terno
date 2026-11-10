import { captureError } from "@terno/core/diag";
import {
  AiError,
  createAi,
  describeProvider,
  discoverModels,
  isLocalProvider,
  keySecretName,
  needsKey,
  PRESETS,
  probe,
  PROVIDERS,
  resolveBaseURL,
  type AiOptions,
  type AiProviderId,
  type AiTasks,
  type CompatiblePreset,
  type CompletionRequest,
  type GeneratedFilter,
  type ModelInfo,
  type ModelTransport,
  type ProviderConfig,
  type StreamEvent,
} from "@terno/ai";
import { isDevAiProvider, messageOf, routeFor, textRef, type AiJob } from "@terno/core";
import { RpcError, type AiTestResult, type AppSettings } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import type { BackendCore as Backend } from "./core";
import { SecretUnreadableError } from "./keychain";
import { NetworkPolicyError } from "./net-policy";
import { AiLimiter, type LimiterTask } from "./ai-limiter";
import { activeDevAi, aiAllowed, bindKeyOrigin, capabilitiesFor, endpointOrigin, keyOrigins, readSettings, readStoredSettings, saveCapabilities, setKeyHint } from "./settings";

export type AiFactory = (config: ProviderConfig, options: AiOptions) => AiTasks;
export const defaultAiFactory: AiFactory = (config, options) => createAi(config, options);

interface Target {
  provider: AiProviderId;
  model: string;
  baseURL?: string;
  preset?: CompatiblePreset;
}

const MODELS_TTL_MS = 60_000;

/**
 * A key the user took back stops spending: whatever was built under it aborts what it has in flight and refuses what
 * comes next. A cache of clients can't do this, since a worker keeps the instance it already holds.
 */
function revocable(inner: ModelTransport, revoked: AbortSignal): ModelTransport {
  const guard = (req: CompletionRequest): CompletionRequest => {
    if (revoked.aborted) throw new AiError(L("errors.ai.cancelled"), "cancelled");
    return { ...req, signal: AbortSignal.any([req.signal, revoked]) };
  };
  const wrapped: ModelTransport = { ...inner, complete: async (req) => inner.complete(guard(req)) };
  if (inner.stream) {
    const stream = inner.stream.bind(inner);
    wrapped.stream = async function* (req: CompletionRequest): AsyncGenerator<StreamEvent> {
      yield* stream(guard(req));
    };
  }
  return wrapped;
}

/** AI failures cross the RPC boundary with their kind, so the UI can give specific help. */
export function toRpcError(error: unknown): RpcError {
  if (error instanceof RpcError) return error;
  if (error instanceof AiError) {
    if (error.kind === "cancelled") return new RpcError("CANCELLED", messageOf(error), { aiErrorKind: error.kind });
    return new RpcError("UNAVAILABLE", messageOf(error), { aiErrorKind: error.kind });
  }
  // not the provider's verdict: our bug (the RPC server captures the original, once)
  return new RpcError("UNAVAILABLE", error instanceof Error ? error.message : String(error), { aiErrorKind: "unavailable" }, { expected: false, cause: error });
}

/**
 * Builds AI clients from the saved profiles, the user's keys and the network
 * policy. Nothing here runs at boot: clients are created on first use and
 * cached per configuration.
 */
export class AiService {
  private readonly clients = new Map<string, AiTasks>();
  private readonly models = new Map<string, { at: number; models: ModelInfo[] }>();
  /** in-flight filters.generate per client: a newer request aborts the previous one */
  private readonly generating = new Map<string, AbortController>();
  /** in-flight foreground requests by id: only the connection that started one can stop it */
  private readonly requests = new Map<string, { clientId: string; controller: AbortController }>();
  /** by secret name: aborted when that key is replaced or removed, and what was built under it dies with it */
  private readonly keyLeases = new Map<string, AbortController>();
  /** plan 146: replaced when Dev mode's switch moves: what began before that is stopped, or starts over */
  private devAiEpoch = new AbortController();
  /** plan 168: replaced when a key comes or goes, which can move a job to the other provider: what's being built starts over */
  private routing = new AbortController();
  readonly limiter: AiLimiter;

  constructor(
    private readonly b: Backend,
    private readonly factory: AiFactory,
  ) {
    this.limiter = new AiLimiter({
      store: b.store,
      now: () => b.now(),
      monthlyLimitUsd: async () => (await readSettings(b.store)).ai.monthlyLimitUsd,
      beforeAhead: (task) => (task === "digest" ? b.today.holdingUp() : b.replies.holdingUp()),
    });
  }

  /** Starts a cancellable request for a connection; `release` when it settles. */
  begin(requestId: string, clientId: string): { signal: AbortSignal; release: () => void } {
    if (this.requests.has(requestId)) throw new RpcError("BAD_REQUEST", L("errors.ai.requestInUse"));
    const controller = new AbortController();
    const entry = { clientId, controller };
    this.requests.set(requestId, entry);
    return {
      signal: AbortSignal.any([controller.signal, this.b.abort.signal]),
      release: () => {
        if (this.requests.get(requestId) === entry) this.requests.delete(requestId);
      },
    };
  }

  cancel(requestId: string, clientId: string): void {
    const entry = this.requests.get(requestId);
    if (entry?.clientId === clientId) entry.controller.abort();
  }

  /** A window closed: nothing it asked for has anywhere to go. */
  disconnected(clientId: string): void {
    for (const entry of this.requests.values()) if (entry.clientId === clientId) entry.controller.abort();
  }

  /** The provider or a task's target changed: nothing more goes where the user just left (plan 85 decision 10). */
  configChanged(): void {
    for (const entry of this.requests.values()) entry.controller.abort();
    this.clients.clear();
  }

  /** Plan 168: a key decides where a job goes, so one coming, going or confirmed restarts what's being built. */
  private rerouted(): void {
    this.routing.abort();
    this.routing = new AbortController();
  }

  /** Plan 146: every key changed at once: also what filters run, and the transports workers already hold. */
  devAiChanged(): void {
    this.devAiEpoch.abort();
    this.devAiEpoch = new AbortController();
    this.configChanged();
    for (const controller of this.generating.values()) controller.abort();
    for (const lease of this.keyLeases.values()) lease.abort();
    this.keyLeases.clear();
    this.models.clear();
  }

  providers() {
    const providers = PROVIDERS.filter((p) => p.id !== "jev" && (p.id !== "fake" || this.b.options.demoAi));
    return { providers: [...providers], presets: Object.values(PRESETS) };
  }

  /** Resolves a target to a ready config, failing fast (before any SDK retry) when it can't run. */
  async config(asked: Target): Promise<ProviderConfig> {
    // not a read more, on anything but a local build
    const dev = this.b.options.devAi && isDevAiProvider(asked.provider) ? await activeDevAi(this.b.store) : null;
    // plan 146: the environment's keys go only to their provider's own endpoint
    const target: Target = dev ? { provider: asked.provider, model: asked.model } : asked;
    const { provider, preset } = target;
    if (provider === "none") throw new AiError(L("errors.ai.notConfigured"), "not_configured");
    const local = isLocalProvider({ id: provider, baseURL: target.baseURL, preset });
    // a custom endpoint may be a name for a server on this Mac; the locality rides along with the request (plan 97:
    // it no longer decides whether a cloud provider may run)
    const declaredCloud = !local && !(provider === "compatible" && (preset ?? "custom") === "custom");
    const baseURL = resolveBaseURL({ id: provider, baseURL: target.baseURL, preset });
    if (provider !== "fake" && !baseURL) throw new AiError(L("errors.ai.serverUrlMissing"), "not_configured");
    const secretName = keySecretName(provider, preset);
    let apiKey = dev
      ? (dev[provider as keyof typeof dev] ?? null)
      : await this.b.getSecret(secretName).catch((error: unknown) => {
          throw error instanceof SecretUnreadableError ? new AiError(messageOf(error), "not_configured") : error;
        });
    if (apiKey && !dev) {
      // a key goes only to the origin it was saved (or confirmed) for
      const origin = new URL(baseURL!).origin;
      const bound = (await keyOrigins(this.b.store))[secretName];
      if (!bound) await bindKeyOrigin(this.b.store, secretName, origin);
      else if (bound !== origin) {
        if (needsKey({ id: provider, preset })) {
          throw new AiError(L("errors.ai.keyBoundElsewhere", { bound, origin }), "not_configured");
        }
        apiKey = null;
      }
    }
    if (!apiKey && needsKey({ id: provider, preset })) {
      throw new AiError(L("errors.ai.keyMissing", { provider: provider === "compatible" ? PRESETS[preset ?? "custom"].label : describeProvider(provider).label }), "not_configured");
    }
    const providerLocality = declaredCloud ? "cloud" : "local";
    if (baseURL) {
      try {
        await this.b.net.assert("ai", baseURL, { providerLocality });
      } catch (error) {
        if (error instanceof NetworkPolicyError) throw new AiError(messageOf(error), "blocked");
        throw error;
      }
    }
    return {
      id: provider,
      model: target.model,
      baseURL,
      preset,
      apiKey,
      fetch: this.b.net.fetchFor("ai", { providerLocality }),
      // the web build: the SDKs run in this tab's worker, with the user's own key (still through the policy fetch)
      browserOrigin: this.b.host.capabilities.network === "browser" ? ((globalThis as { location?: { origin: string } }).location?.origin ?? "null") : undefined,
      // the first local call may load the model into memory; cloud calls retry once
      timeoutMs: local ? 90_000 : 30_000,
      maxRetries: local ? 0 : 1,
    };
  }

  private currentTarget(settings: AppSettings): Target {
    const { ai } = settings;
    return { provider: ai.provider, model: ai.model, baseURL: ai.baseURL ?? undefined, preset: ai.preset ?? undefined };
  }

  /**
   * What a job runs on: plan 168's `routeFor`, the one rule Settings and the gates read too, with the profile it runs
   * under (the configured provider as set up, another with its own saved endpoint). Never another provider without the
   * user having set it up: a key or the configured provider.
   */
  private async targetFor(job: AiJob, settings: AppSettings): Promise<Target> {
    const route = routeFor(job, settings.ai);
    // Claude or OpenAI chosen with no key yet: config says which key to save, not that nothing is set up
    if (!route) return this.currentTarget(settings);
    // a local server or a service with no model set: nothing to ask (Settings says so too: `aiCanRun`)
    if (!route.model.trim()) throw new AiError(L("errors.ai.modelMissing"), "not_configured");
    if (route.provider === settings.ai.provider) return { ...this.currentTarget(settings), model: route.model };
    const profile = settings.ai.profiles[route.provider];
    return { provider: route.provider, model: route.model, baseURL: profile?.baseURL, preset: profile?.preset };
  }

  /**
   * The one place that decides what runs a task. The AiTasks it returns are
   * immutable for their configuration: a change in Settings gives the next
   * caller others, and aborts what's in flight (configChanged).
   */
  async forTask(task: AiJob, o: { foreground?: boolean } = {}): Promise<AiTasks> {
    const epoch = this.devAiEpoch.signal;
    const routing = this.routing.signal;
    // plan 150: what's offered is what runs. Filters are Free and asked for by a click (plan 85)
    if (task !== "filter" && !(await aiAllowed(this.b.store))) {
      // a toggle while this read: a late no mustn't pause what the toggle just woke
      if (epoch.aborted) return this.forTask(task, o);
      throw new AiError(L("errors.ai.devSwitchOff"), "not_configured");
    }
    const settings = await readSettings(this.b.store);
    const target = await this.targetFor(task, settings);
    const lease = this.keyLease(keySecretName(target.provider, target.preset));
    // a key removed while this read it fails here: when that moved the job to the other key, it starts over there (Codex code review)
    const stored = await this.config(target).catch((error: unknown) => {
      if (routing.aborted || lease.signal.aborted || epoch.aborted) return null;
      throw error;
    });
    if (!stored) return this.forTask(task, o);
    const capabilities = (await capabilitiesFor(this.b.store, target)) ?? undefined;
    // the limiter counts every request, so the SDK's own retries (unseen by it) stay off for these tasks
    const config: ProviderConfig = { ...stored, capabilities, maxRetries: task === "filter" ? stored.maxRetries : 0 };
    const { fetch: _fetch, ...hashed } = config;
    const foreground = o.foreground ?? (task === "filter" || task === "writing");
    const key = await sha256Hex(JSON.stringify({ ...hashed, task, foreground }));
    // the key changed while this was reading it: what it holds may be the one taken back
    // or a key came or went meanwhile, and the job may belong to the other provider now
    if (lease.signal.aborted || epoch.aborted || routing.aborted) return this.forTask(task, o);
    let ai = this.clients.get(key);
    if (!ai) {
      if (this.clients.size > 16) this.clients.clear();
      const local = isLocalProvider({ id: target.provider, baseURL: target.baseURL, preset: target.preset });
      ai = this.factory(config, {
        wrapTransport: (transport) => revocable(this.limiter.wrap(transport, { task: (task === "askPlan" ? "ask" : task === "replyCheck" ? "reply" : task) as LimiterTask, ahead: task === "reply" || task === "replyCheck", model: target.model, local, foreground }), lease.signal),
        onCapabilities: (next) =>
          void saveCapabilities(this.b.store, target.provider, { model: target.model, baseURL: target.baseURL, preset: target.preset }, next),
      });
      this.clients.set(key, ai);
    }
    return ai;
  }

  private keyLease(secretName: string): AbortController {
    let lease = this.keyLeases.get(secretName);
    if (!lease) this.keyLeases.set(secretName, (lease = new AbortController()));
    return lease;
  }

  /** The configured provider, ready to run tasks. Throws AiError when it can't. */
  current(): Promise<AiTasks> {
    return this.forTask("filter");
  }

  async generateFilter(prompt: string, clientId: string): Promise<GeneratedFilter> {
    this.generating.get(clientId)?.abort();
    const controller = new AbortController();
    this.generating.set(clientId, controller);
    try {
      const ai = await this.current();
      const store = this.b.store;
      const signal = AbortSignal.any([controller.signal, this.b.abort.signal]);
      const generated = await ai.generateFilter(
        prompt,
        {
          now: this.b.now(),
          categories: (await store.categories.list()).map((c) => ({ id: c.id, name: c.name })),
          accounts: (await store.accounts.list()).map((a) => ({ id: a.id, email: a.email, displayName: a.displayName })),
        },
        signal,
      );
      const [currentCategories, currentAccounts] = await Promise.all([store.categories.list(), store.accounts.list()]);
      const categories = new Set(currentCategories.map((c) => c.id));
      const accounts = new Set(currentAccounts.map((a) => a.id));
      if (signal.aborted) throw new AiError(L("errors.ai.cancelled"), "cancelled");
      if (generated.rule.actions.some((a) => a.type === "addCategory" && !categories.has(a.categoryId))) {
        throw new AiError(L("errors.categoryGone"), "invalid_output");
      }
      if (generated.rule.conditions.some((c) => c.field === "account" && !accounts.has(c.value))) {
        throw new AiError(L("errors.accountGone"), "invalid_output");
      }
      return generated;
    } catch (error) {
      throw toRpcError(error);
    } finally {
      if (this.generating.get(clientId) === controller) this.generating.delete(clientId);
    }
  }

  async listModels(target: Omit<Target, "model">): Promise<{ models: ModelInfo[]; tookMs: number }> {
    const started = performance.now();
    const signal = AbortSignal.any([this.b.abort.signal, this.devAiEpoch.signal]);
    const settings = await readSettings(this.b.store);
    // the saved profile fills the gaps: its endpoint, and its model (so Ollama can report the context window)
    const profile = settings.ai.profiles[target.provider];
    const model = profile?.model ?? "";
    const samePreset = (target.preset ?? profile?.preset) === profile?.preset;
    const baseURL = target.baseURL ?? (samePreset ? profile?.baseURL : undefined);
    try {
      const config = await this.config({ ...target, baseURL, model });
      const cacheKey = [target.provider, target.preset ?? "", config.baseURL ?? "", model, config.apiKey ? await sha256Hex(config.apiKey) : ""].join("|");
      const hit = this.models.get(cacheKey);
      if (hit && Date.now() - hit.at < MODELS_TTL_MS) return { models: hit.models, tookMs: performance.now() - started };
      const local = isLocalProvider({ id: target.provider, baseURL: config.baseURL, preset: target.preset });
      const models = await discoverModels({ ...config, timeoutMs: local ? 3_000 : 8_000 }, signal);
      this.models.set(cacheKey, { at: Date.now(), models });
      return { models, tookMs: performance.now() - started };
    } catch (error) {
      throw toRpcError(error);
    }
  }

  async test(target: Target): Promise<AiTestResult> {
    const started = performance.now();
    const signal = AbortSignal.any([this.b.abort.signal, this.devAiEpoch.signal]);
    try {
      const config = await this.config(target);
      const result = await probe(config, signal);
      await saveCapabilities(this.b.store, target.provider, { model: target.model, baseURL: target.baseURL, preset: target.preset }, result.capabilities);
      return { ok: true, latencyMs: result.latencyMs, capabilities: result.capabilities, ...(result.warning ? { warning: result.warning.message, warningI18n: textRef(result.warning) } : {}) };
    } catch (error) {
      if (!(error instanceof AiError)) captureError(error, { code: "ai.unexpected", fields: { op: "test" } });
      const e = error instanceof AiError ? error : new AiError(error instanceof Error ? error.message : String(error), "unavailable");
      return { ok: false, latencyMs: Math.round(performance.now() - started), error: { kind: e.kind, message: e.message, ...(e.i18n ? { i18n: e.i18n } : {}) } };
    }
  }

  /** The provider's saved endpoint origin (the one its key is for). */
  private async profileOrigin(provider: AiProviderId, preset: CompatiblePreset | undefined): Promise<string | null> {
    const profile = (await readStoredSettings(this.b.store)).ai.profiles[provider];
    const own = provider !== "compatible" || (profile?.preset ?? "custom") === (preset ?? "custom") ? profile : { model: "", preset };
    return endpointOrigin(provider, own);
  }

  async confirmKey(provider: AiProviderId, preset: CompatiblePreset | undefined): Promise<AppSettings> {
    const name = keySecretName(provider, preset);
    if (await this.b.store.secrets.has(name)) await bindKeyOrigin(this.b.store, name, await this.profileOrigin(provider, preset));
    this.rerouted();
    this.clients.clear();
    this.models.clear();
    return readSettings(this.b.store);
  }

  async setKey(provider: AiProviderId, preset: CompatiblePreset | undefined, value: string): Promise<AppSettings> {
    // plan 146: it would change nothing now, and a saved key would be overwritten for later
    if (this.b.options.devAi && isDevAiProvider(provider) && (await activeDevAi(this.b.store))) throw new RpcError("BAD_REQUEST", L("errors.ai.devKeyFromEnv"));
    const name = keySecretName(provider, preset);
    if (value) {
      await this.b.setSecret(name, value);
      await bindKeyOrigin(this.b.store, name, await this.profileOrigin(provider, preset));
      // short keys would give too much away
      await setKeyHint(this.b.store, provider, preset, value.length >= 12 ? value.slice(-4) : null);
    } else {
      await this.b.store.secrets.delete(name);
      await setKeyHint(this.b.store, provider, preset, null);
      await bindKeyOrigin(this.b.store, name, null);
    }
    // written first, so nothing built from here on can read the old one; done before the caller lets workers resume
    this.keyLeases.get(name)?.abort();
    this.rerouted();
    this.keyLeases.delete(name);
    this.clients.clear();
    this.models.clear();
    return readSettings(this.b.store);
  }
}

/** Cache keys that must not hold a secret in clear (WebCrypto: Node and browsers alike). */
async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
