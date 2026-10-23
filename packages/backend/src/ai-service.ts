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
} from "@unica/ai";
import { RpcError, type AiTestResult, type AppSettings } from "@unica/core/rpc";
import type { BackendCore as Backend } from "./core";
import { NetworkPolicyError } from "./net-policy";
import { readSettings, saveCapabilities, setKeyHint } from "./settings";

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
    if (error.kind === "cancelled") return new RpcError("CANCELLED", error.message, { aiErrorKind: error.kind });
    return new RpcError("UNAVAILABLE", error.message, { aiErrorKind: error.kind });
  }
  return new RpcError("UNAVAILABLE", error instanceof Error ? error.message : String(error), { aiErrorKind: "unavailable" });
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

  constructor(
    private readonly b: Backend,
    private readonly factory: AiFactory,
  ) {}

  providers() {
    const providers = PROVIDERS.filter((p) => p.id !== "fake" || this.b.options.demoAi);
    return { providers: [...providers], presets: Object.values(PRESETS) };
  }

  /** Resolves a target to a ready config, failing fast (before any SDK retry) when it can't run. */
  async config(target: Target): Promise<ProviderConfig> {
    const { provider, preset } = target;
    if (provider === "none") throw new AiError("Conecta una IA en Ajustes → IA para crear filtros con IA.", "not_configured");
    const local = isLocalProvider({ id: provider, baseURL: target.baseURL, preset });
    // a custom endpoint may be a name for a server on this Mac: the policy resolves it before connecting
    const declaredCloud = !local && !(provider === "compatible" && (preset ?? "custom") === "custom");
    if (declaredCloud && (await this.b.net.isLocalMode())) {
      throw new AiError(`${describeProvider(provider).label} está en pausa por el modo local. Desactívalo en Ajustes → General o elige un modelo de este Mac.`, "blocked");
    }
    const baseURL = resolveBaseURL({ id: provider, baseURL: target.baseURL, preset });
    if (provider !== "fake" && !baseURL) throw new AiError("Indica la URL del servidor en Ajustes → IA.", "not_configured");
    const apiKey = await this.b.getSecret(keySecretName(provider, preset));
    if (!apiKey && needsKey({ id: provider, preset })) {
      throw new AiError(`Guarda tu API key de ${provider === "compatible" ? PRESETS[preset ?? "custom"].label : describeProvider(provider).label} en Ajustes → IA.`, "not_configured");
    }
    const providerLocality = declaredCloud ? "cloud" : "local";
    if (baseURL) {
      try {
        await this.b.net.assert("ai", baseURL, { providerLocality });
      } catch (error) {
        if (error instanceof NetworkPolicyError) throw new AiError(error.message, "blocked");
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
      // the first local call may load the model into memory; cloud calls retry once
      timeoutMs: local ? 90_000 : 30_000,
      maxRetries: local ? 0 : 1,
    };
  }

  private currentTarget(settings: AppSettings): Target {
    const { ai } = settings;
    return { provider: ai.provider, model: ai.model, baseURL: ai.baseURL ?? undefined, preset: ai.preset ?? undefined };
  }

  /** The configured provider, ready to run tasks. Throws AiError when it can't. */
  async current(): Promise<AiTasks> {
    const settings = await readSettings(this.b.store);
    const target = this.currentTarget(settings);
    const config = { ...(await this.config(target)), capabilities: settings.ai.capabilities ?? undefined };
    const { fetch: _fetch, ...hashed } = config;
    const key = await sha256Hex(JSON.stringify(hashed));
    let ai = this.clients.get(key);
    if (!ai) {
      if (this.clients.size > 8) this.clients.clear();
      ai = this.factory(config, {
        onCapabilities: (capabilities) =>
          void saveCapabilities(this.b.store, target.provider, { model: target.model, baseURL: target.baseURL, preset: target.preset }, capabilities),
      });
      this.clients.set(key, ai);
    }
    return ai;
  }

  async generateFilter(prompt: string, clientId: string): Promise<GeneratedFilter> {
    this.generating.get(clientId)?.abort();
    const controller = new AbortController();
    this.generating.set(clientId, controller);
    try {
      const ai = await this.current();
      const store = this.b.store;
      return await ai.generateFilter(
        prompt,
        {
          now: this.b.now(),
          categories: (await store.categories.list()).map((c) => ({ id: c.id, name: c.name })),
          accounts: (await store.accounts.list()).map((a) => ({ id: a.id, email: a.email, displayName: a.displayName })),
        },
        AbortSignal.any([controller.signal, this.b.abort.signal]),
      );
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
      return { ok: true, latencyMs: result.latencyMs, capabilities: result.capabilities, warning: result.warning };
    } catch (error) {
      const e = error instanceof AiError ? error : new AiError(error instanceof Error ? error.message : String(error), "unavailable");
      return { ok: false, latencyMs: Math.round(performance.now() - started), error: { kind: e.kind, message: e.message } };
    }
  }

  async setKey(provider: AiProviderId, preset: CompatiblePreset | undefined, value: string): Promise<AppSettings> {
    const name = keySecretName(provider, preset);
    if (value) {
      await this.b.setSecret(name, value);
      // short keys would give too much away
      await setKeyHint(this.b.store, provider, preset, value.length >= 12 ? value.slice(-4) : null);
    } else {
      await this.b.store.secrets.delete(name);
      await setKeyHint(this.b.store, provider, preset, null);
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
