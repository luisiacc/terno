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
  type GeneratedFilter,
  type ModelInfo,
  type ProviderConfig,
} from "@terno/ai";
import { JEV_DEFAULT_MODEL, messageOf, SUMMARY_DEFAULT_MODEL, textRef, WRITING_CLAUDE_MODEL, type AiTaskName } from "@terno/core";
import { RpcError, type AiTestResult, type AppSettings } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import type { BackendCore as Backend } from "./core";
import { SecretUnreadableError } from "./keychain";
import { NetworkPolicyError } from "./net-policy";
import { AiLimiter, type LimiterTask } from "./ai-limiter";
import { bindKeyOrigin, capabilitiesFor, endpointOrigin, keyOrigins, readSettings, saveCapabilities, setKeyHint } from "./settings";

export type AiFactory = (config: ProviderConfig, options: AiOptions) => AiTasks;
export const defaultAiFactory: AiFactory = (config, options) => createAi(config, options);

interface Target {
  provider: AiProviderId;
  model: string;
  baseURL?: string;
  preset?: CompatiblePreset;
}

const MODELS_TTL_MS = 60_000;

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
  readonly limiter: AiLimiter;

  constructor(
    private readonly b: Backend,
    private readonly factory: AiFactory,
  ) {
    this.limiter = new AiLimiter({
      store: b.store,
      now: () => b.now(),
      monthlyLimitUsd: async () => (await readSettings(b.store)).ai.monthlyLimitUsd,
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

  providers() {
    const providers = PROVIDERS.filter((p) => p.id !== "jev" && (p.id !== "fake" || this.b.options.demoAi));
    return { providers: [...providers], presets: Object.values(PRESETS) };
  }

  /** Resolves a target to a ready config, failing fast (before any SDK retry) when it can't run. */
  async config(target: Target): Promise<ProviderConfig> {
    const { provider, preset } = target;
    if (provider === "none") throw new AiError(L("errors.ai.notConfigured"), "not_configured");
    const local = isLocalProvider({ id: provider, baseURL: target.baseURL, preset });
    // a custom endpoint may be a name for a server on this Mac; the locality rides along with the request (plan 97:
    // it no longer decides whether a cloud provider may run)
    const declaredCloud = !local && !(provider === "compatible" && (preset ?? "custom") === "custom");
    const baseURL = resolveBaseURL({ id: provider, baseURL: target.baseURL, preset });
    if (provider !== "fake" && !baseURL) throw new AiError(L("errors.ai.serverUrlMissing"), "not_configured");
    const secretName = keySecretName(provider, preset);
    let apiKey = await this.b.getSecret(secretName).catch((error: unknown) => {
      throw error instanceof SecretUnreadableError ? new AiError(messageOf(error), "not_configured") : error;
    });
    if (apiKey) {
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

  /** What a task runs on: the user's choice, else its default. Never another provider without the user having set it up. */
  private async targetFor(task: AiTaskName | "filter" | "voice", settings: AppSettings): Promise<Target> {
    const name = task === "voice" ? "writing" : task;
    const chosen = name === "filter" ? undefined : settings.ai.tasks[name];
    const configured = this.currentTarget(settings);
    const profiled = (provider: AiProviderId, model: string): Target => {
      const profile = settings.ai.profiles[provider];
      return { provider, model, baseURL: profile?.baseURL, preset: profile?.preset };
    };
    if (chosen) return profiled(chosen.provider, chosen.model);
    if (name === "writing" && configured.provider === "anthropic") return { ...configured, model: WRITING_CLAUDE_MODEL };
    if (name === "categorize" && settings.ai.keys.jev?.hasKey) return profiled("jev", JEV_DEFAULT_MODEL);
    if (name === "summary") {
      if (settings.ai.keys.openai?.hasKey) return profiled("openai", SUMMARY_DEFAULT_MODEL);
      // a local model costs nothing and stays here; a paid one is the user's call, since this runs on every new mail
      if (!isLocalProvider({ id: configured.provider, baseURL: configured.baseURL, preset: configured.preset }) && configured.provider !== "none") {
        throw new AiError(L("errors.ai.summaryProvider"), "not_configured");
      }
    }
    return configured;
  }

  /**
   * The one place that decides what runs a task. The AiTasks it returns are
   * immutable for their configuration: a change in Settings gives the next
   * caller others, and aborts what's in flight (configChanged).
   */
  async forTask(task: AiTaskName | "filter" | "voice", o: { foreground?: boolean } = {}): Promise<AiTasks> {
    const settings = await readSettings(this.b.store);
    const target = await this.targetFor(task, settings);
    const stored = await this.config(target);
    const capabilities = (await capabilitiesFor(this.b.store, target)) ?? undefined;
    // the limiter counts every request, so the SDK's own retries (unseen by it) stay off for these tasks
    const config: ProviderConfig = { ...stored, capabilities, maxRetries: task === "filter" ? stored.maxRetries : 0 };
    const { fetch: _fetch, ...hashed } = config;
    const foreground = o.foreground ?? (task === "filter" || task === "writing");
    const key = await sha256Hex(JSON.stringify({ ...hashed, task, foreground }));
    let ai = this.clients.get(key);
    if (!ai) {
      if (this.clients.size > 16) this.clients.clear();
      const local = isLocalProvider({ id: target.provider, baseURL: target.baseURL, preset: target.preset });
      ai = this.factory(config, {
        wrapTransport: (transport) => this.limiter.wrap(transport, { task: task as LimiterTask, model: target.model, local, foreground }),
        onCapabilities: (next) =>
          void saveCapabilities(this.b.store, target.provider, { model: target.model, baseURL: target.baseURL, preset: target.preset }, next),
      });
      this.clients.set(key, ai);
    }
    return ai;
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
      const models = await discoverModels({ ...config, timeoutMs: local ? 3_000 : 8_000 }, this.b.abort.signal);
      this.models.set(cacheKey, { at: Date.now(), models });
      return { models, tookMs: performance.now() - started };
    } catch (error) {
      throw toRpcError(error);
    }
  }

  async test(target: Target): Promise<AiTestResult> {
    const started = performance.now();
    try {
      const config = await this.config(target);
      const result = await probe(config, this.b.abort.signal);
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
    const profile = (await readSettings(this.b.store)).ai.profiles[provider];
    const own = provider !== "compatible" || (profile?.preset ?? "custom") === (preset ?? "custom") ? profile : { model: "", preset };
    return endpointOrigin(provider, own);
  }

  async confirmKey(provider: AiProviderId, preset: CompatiblePreset | undefined): Promise<AppSettings> {
    const name = keySecretName(provider, preset);
    if (await this.b.store.secrets.has(name)) await bindKeyOrigin(this.b.store, name, await this.profileOrigin(provider, preset));
    this.clients.clear();
    this.models.clear();
    return readSettings(this.b.store);
  }

  async setKey(provider: AiProviderId, preset: CompatiblePreset | undefined, value: string): Promise<AppSettings> {
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
