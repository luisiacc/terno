import OpenAI, { AzureOpenAI } from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type { ChatCompletionChunk, ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { L } from "@terno/i18n";
import { describeProvider, isLocalProvider, needsKey, PRESETS, resolveBaseURL } from "./providers";
import { mapNetworkError, mapSdkError, type ErrorInfo } from "./sdk-errors";
import { AiError, promptText, type CompletionRequest, type ModelInfo, type ModelTransport, type ProviderConfig, type StreamEvent, type Usage } from "./types";

/** GA version with structured outputs (json_schema) on chat completions. */
export const AZURE_API_VERSION = "2024-10-21";
function usageOf(u: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number } | null } | null | undefined): Usage | undefined {
  return u ? { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens, cacheReadTokens: u.prompt_tokens_details?.cached_tokens ?? 0 } : undefined;
}

/** OpenRouter attributes traffic to the calling app with these. */
const OPENROUTER_HEADERS = { "HTTP-Referer": "https://terno.app", "X-Title": "Terno" };

/**
 * One adapter for every OpenAI Chat Completions server: OpenAI, OpenRouter,
 * Groq, Together, Azure, Ollama, LM Studio and custom endpoints.
 */
export function openaiChatTransport(config: ProviderConfig): ModelTransport {
  const baseURL = resolveBaseURL(config);
  if (!baseURL) throw new AiError(L("errors.ai.serverUrlMissing"), "not_configured");
  const descriptor = describeProvider(config.id);
  const azure = config.id === "compatible" && config.preset === "azure";
  const info: ErrorInfo = {
    label: config.id === "compatible" ? PRESETS[config.preset ?? "custom"].label : descriptor.label,
    local: isLocalProvider(config),
    host: new URL(baseURL).host,
    provider: config.id,
    browserOrigin: config.browserOrigin,
  };
  // Local servers ignore auth but the SDK refuses to run without a key: send a placeholder, never a real secret.
  const apiKey = config.apiKey ?? (needsKey(config) ? null : "local");
  const origin = baseURL.replace(/\/v1\/?$/, "");

  let made: OpenAI | null = null;
  const load = (): OpenAI => {
    if (made) return made;
    if (!apiKey) throw new AiError(L("errors.ai.keyMissing", { provider: info.label }), "not_configured");
    // Every value explicit: the SDK otherwise falls back to OPENAI_BASE_URL / _API_KEY / _ORG_ID / _PROJECT_ID.
    // In the web build's worker the SDK must be told it may run there (the user's own key, on their device).
    const dangerouslyAllowBrowser = config.browserOrigin !== undefined;
    made = azure
      ? new AzureOpenAI({ apiKey, baseURL: `${baseURL.replace(/\/+$/, "")}/openai`, apiVersion: AZURE_API_VERSION, deployment: config.model, organization: null, project: null, webhookSecret: null, fetch: config.fetch, timeout: config.timeoutMs, maxRetries: config.maxRetries, dangerouslyAllowBrowser })
      : new OpenAI({ apiKey, adminAPIKey: null, baseURL, organization: null, project: null, webhookSecret: null, defaultHeaders: config.preset === "openrouter" ? OPENROUTER_HEADERS : undefined, fetch: config.fetch, timeout: config.timeoutMs, maxRetries: config.maxRetries, dangerouslyAllowBrowser });
    return made;
  };

  /** Native discovery endpoints (Ollama, LM Studio) go through the same policy fetch. */
  async function getJson<T>(path: string, signal: AbortSignal, init: RequestInit = {}): Promise<{ status: number; body: T | null }> {
    let res: Response;
    try {
      res = await config.fetch(`${origin}${path}`, { ...init, signal, headers: { "content-type": "application/json", ...init.headers } });
    } catch (error) {
      throw mapNetworkError(error, info);
    }
    if (res.status === 401 || res.status === 403) throw new AiError(L("errors.ai.keyRejected", { provider: info.label }), "auth");
    return { status: res.status, body: res.ok ? ((await res.json().catch(() => null)) as T | null) : null };
  }

  async function sdkModels(signal: AbortSignal): Promise<ModelInfo[]> {
    const client = load();
    try {
      const models: ModelInfo[] = [];
      for await (const m of client.models.list({ signal })) {
        // OpenRouter and some servers add a context length to the standard model object
        const extra = m as unknown as { name?: string; context_length?: number; max_context_length?: number };
        models.push({ id: m.id, label: extra.name, contextTokens: extra.context_length ?? extra.max_context_length });
      }
      return models;
    } catch (error) {
      throw mapSdkError(error, OpenAI, info);
    }
  }

  async function ollamaModels(signal: AbortSignal): Promise<ModelInfo[]> {
    type Tags = { models?: { name: string; size?: number }[] };
    const [tags, ps] = await Promise.all([
      getJson<Tags>("/api/tags", signal),
      getJson<Tags>("/api/ps", signal).catch(() => ({ status: 0, body: null })),
    ]);
    if (!tags.body?.models) throw new AiError(L("errors.ai.noModelList", { provider: info.label, status: tags.status }), "unavailable");
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

  const request = async (req: CompletionRequest): Promise<ChatCompletionCreateParamsNonStreaming> => {
      const tokenLimit = config.id === "openai" || azure ? { max_completion_tokens: req.maxTokens } : { max_tokens: req.maxTokens };
      return {
        model: config.model,
        messages: [{ role: "system", content: promptText(req.system) }, ...req.messages.map((m) => ({ role: m.role, content: promptText(m.content) }))],
        ...tokenLimit,
        ...(req.output === "json_schema" && req.schema
          ? { response_format: zodResponseFormat(req.schema.zod, req.schema.name) }
          : req.output === "json_object"
            ? { response_format: { type: "json_object" as const } }
            : {}),
      };
  };

  return {
    async complete(req) {
      const client = load();
      const body = await request(req);
      try {
        const completion = await client.chat.completions.create(body, { signal: req.signal });
        const choice = completion.choices[0];
        if (!choice) throw new AiError(L("errors.ai.emptyAnswer", { provider: info.label }), "invalid_output");
        if (choice.message.refusal) return { text: "", stop: "refusal" };
        return { text: choice.message.content ?? "", stop: choice.finish_reason === "length" ? "length" : "end", usage: usageOf(completion.usage) };
      } catch (error) {
        throw mapSdkError(error, OpenAI, info);
      }
    },

    async *stream(req): AsyncGenerator<StreamEvent> {
      const client = load();
      const body = await request(req);
      try {
        // only OpenAI promises this option; a local server might refuse an unknown one
        const options = config.id === "openai" ? { stream_options: { include_usage: true } } : {};
        const stream = (await client.chat.completions.create({ ...body, ...options, stream: true } as never, { signal: req.signal })) as unknown as AsyncIterable<ChatCompletionChunk>;
        let stop: "end" | "length" | "refusal" = "end";
        let usage: Usage | undefined;
        for await (const chunk of stream) {
          usage = usageOf(chunk.usage) ?? usage;
          const choice = chunk.choices[0];
          if (!choice) continue;
          if (choice.delta.refusal) stop = "refusal";
          if (choice.finish_reason === "length") stop = "length";
          if (choice.delta.content) yield { type: "delta", text: choice.delta.content };
        }
        yield { type: "done", stop, usage };
      } catch (error) {
        throw mapSdkError(error, OpenAI, info);
      }
    },

    listModels(signal) {
      if (descriptor.discovery === "ollama") return ollamaModels(signal);
      if (descriptor.discovery === "lmstudio") return lmstudioModels(signal);
      return sdkModels(signal);
    },
  };
}
