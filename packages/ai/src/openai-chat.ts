import type OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { describeProvider, isLocalProvider, needsKey, PRESETS, resolveBaseURL } from "./providers";
import { mapNetworkError, mapSdkError, type ErrorInfo } from "./sdk-errors";
import { AiError, type ModelInfo, type ModelTransport, type ProviderConfig } from "./types";

type Sdk = typeof import("openai");

/** GA version with structured outputs (json_schema) on chat completions. */
export const AZURE_API_VERSION = "2024-10-21";
/** OpenRouter attributes traffic to the calling app with these. */
const OPENROUTER_HEADERS = { "HTTP-Referer": "https://terno.app", "X-Title": "Terno" };

/**
 * One adapter for every OpenAI Chat Completions server: OpenAI, OpenRouter,
 * Groq, Together, Azure, Ollama, LM Studio and custom endpoints.
 */
export function openaiChatTransport(config: ProviderConfig): ModelTransport {
  const baseURL = resolveBaseURL(config);
  if (!baseURL) throw new AiError("Indica la URL del servidor en Ajustes → IA.", "not_configured");
  const descriptor = describeProvider(config.id);
  const azure = config.id === "compatible" && config.preset === "azure";
  const info: ErrorInfo = {
    label: config.id === "compatible" ? PRESETS[config.preset ?? "custom"].label : descriptor.label,
    local: isLocalProvider(config),
    host: new URL(baseURL).host,
  };
  // Local servers ignore auth but the SDK refuses to run without a key: send a placeholder, never a real secret.
  const apiKey = config.apiKey ?? (needsKey(config) ? null : "local");
  const origin = baseURL.replace(/\/v1\/?$/, "");

  let loaded: Promise<{ sdk: Sdk; client: OpenAI }> | null = null;
  const load = () =>
    (loaded ??= import("openai").then((sdk) => {
      if (!apiKey) throw new AiError(`Guarda tu API key de ${info.label} en Ajustes → IA.`, "not_configured");
      const { default: OpenAI, AzureOpenAI } = sdk;
      // Every value explicit: the SDK otherwise falls back to OPENAI_BASE_URL / _API_KEY / _ORG_ID / _PROJECT_ID.
      const client = azure
        ? new AzureOpenAI({ apiKey, baseURL: `${baseURL.replace(/\/+$/, "")}/openai`, apiVersion: AZURE_API_VERSION, deployment: config.model, organization: null, project: null, webhookSecret: null, fetch: config.fetch, timeout: config.timeoutMs, maxRetries: config.maxRetries })
        : new OpenAI({ apiKey, adminAPIKey: null, baseURL, organization: null, project: null, webhookSecret: null, defaultHeaders: config.preset === "openrouter" ? OPENROUTER_HEADERS : undefined, fetch: config.fetch, timeout: config.timeoutMs, maxRetries: config.maxRetries });
      return { sdk, client };
    }));

  /** Native discovery endpoints (Ollama, LM Studio) go through the same policy fetch. */
  async function getJson<T>(path: string, signal: AbortSignal, init: RequestInit = {}): Promise<{ status: number; body: T | null }> {
    let res: Response;
    try {
      res = await config.fetch(`${origin}${path}`, { ...init, signal, headers: { "content-type": "application/json", ...init.headers } });
    } catch (error) {
      throw mapNetworkError(error, info);
    }
    if (res.status === 401 || res.status === 403) throw new AiError(`${info.label} rechazó la API key.`, "auth");
    return { status: res.status, body: res.ok ? ((await res.json().catch(() => null)) as T | null) : null };
  }

  async function sdkModels(signal: AbortSignal): Promise<ModelInfo[]> {
    const { sdk, client } = await load();
    try {
      const models: ModelInfo[] = [];
      for await (const m of client.models.list({ signal })) {
        // OpenRouter and some servers add a context length to the standard model object
        const extra = m as unknown as { name?: string; context_length?: number; max_context_length?: number };
        models.push({ id: m.id, label: extra.name, contextTokens: extra.context_length ?? extra.max_context_length });
      }
      return models;
    } catch (error) {
      throw mapSdkError(error, sdk.default, info);
    }
  }

  async function ollamaModels(signal: AbortSignal): Promise<ModelInfo[]> {
    type Tags = { models?: { name: string; size?: number }[] };
    const [tags, ps] = await Promise.all([
      getJson<Tags>("/api/tags", signal),
      getJson<Tags>("/api/ps", signal).catch(() => ({ status: 0, body: null })),
    ]);
    if (!tags.body?.models) throw new AiError(`${info.label} respondió sin lista de modelos (${tags.status}).`, "unavailable");
    const loadedNames = new Set(ps.body?.models?.map((m) => m.name) ?? []);
    const models: ModelInfo[] = tags.body.models.map((m) => ({ id: m.name, sizeBytes: m.size, loaded: loadedNames.has(m.name) }));
    const selected = models.find((m) => m.id === config.model || m.id === `${config.model}:latest`);
    if (selected) {
      const show = await getJson<{ model_info?: Record<string, unknown> }>("/api/show", signal, { method: "POST", body: JSON.stringify({ model: selected.id }) }).catch(() => null);
      const entry = Object.entries(show?.body?.model_info ?? {}).find(([k, v]) => k.endsWith(".context_length") && typeof v === "number");
      if (entry) selected.contextTokens = entry[1] as number;
    }
    return models;
  }

  async function lmstudioModels(signal: AbortSignal): Promise<ModelInfo[]> {
    type V0 = { data?: { id: string; type?: string; state?: string; max_context_length?: number }[] };
    const v0 = await getJson<V0>("/api/v0/models", signal);
    // older LM Studio builds only speak the OpenAI API
    if (v0.status === 404 || !v0.body?.data) return sdkModels(signal);
    return v0.body.data
      .filter((m) => m.type !== "embeddings")
      .map((m) => ({ id: m.id, contextTokens: m.max_context_length, loaded: m.state === "loaded" }));
  }

  return {
    async complete(req) {
      const { sdk, client } = await load();
      const { zodResponseFormat } = await import("openai/helpers/zod");
      const tokenLimit = config.id === "openai" || azure ? { max_completion_tokens: req.maxTokens } : { max_tokens: req.maxTokens };
      const body: ChatCompletionCreateParamsNonStreaming = {
        model: config.model,
        messages: [{ role: "system", content: req.system }, ...req.messages],
        ...tokenLimit,
        ...(req.output === "json_schema" && req.schema
          ? { response_format: zodResponseFormat(req.schema.zod, req.schema.name) }
          : req.output === "json_object"
            ? { response_format: { type: "json_object" as const } }
            : {}),
      };
      try {
        const completion = await client.chat.completions.create(body, { signal: req.signal });
        const choice = completion.choices[0];
        if (!choice) throw new AiError(`${info.label} devolvió una respuesta vacía.`, "invalid_output");
        if (choice.message.refusal) return { text: "", stop: "refusal" };
        return { text: choice.message.content ?? "", stop: choice.finish_reason === "length" ? "length" : "end" };
      } catch (error) {
        throw mapSdkError(error, sdk.default, info);
      }
    },

    listModels(signal) {
      if (descriptor.discovery === "ollama") return ollamaModels(signal);
      if (descriptor.discovery === "lmstudio") return lmstudioModels(signal);
      return sdkModels(signal);
    },
  };
}
