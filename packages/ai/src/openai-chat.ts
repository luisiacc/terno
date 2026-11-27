import OpenAI, { AzureOpenAI } from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type { ChatCompletionChunk, ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { OPENAI_DEFAULT_MODEL, OPENAI_DRAFT_MODEL } from "@terno/core";
import { L } from "@terno/i18n";
import { describeProvider, isLocalProvider, needsKey, PRESETS, resolveBaseURL } from "./providers";
import { mapNetworkError, mapSdkError, type ErrorInfo } from "./sdk-errors";
import { AiError, blockTexts, marksCache, promptText, type CompletionRequest, type ModelInfo, type ModelTransport, type PromptBlock, type PromptText, type ProviderConfig, type StreamEvent, type Usage } from "./types";

/** GA version with structured outputs (json_schema) on chat completions. */
export const AZURE_API_VERSION = "2024-10-21";
/**
 * As Anthropic reports it. OpenAI bills each prompt token at one rate: uncached, a cache read or a cache write; so
 * `prompt_tokens` holds the cached and written ones, and they're taken out of input to be counted once, at their own price.
 */
export function usageOf(u: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number | null; cache_write_tokens?: number | null } | null } | null | undefined): Usage | undefined {
  if (!u) return undefined;
  const read = Math.min(u.prompt_tokens_details?.cached_tokens ?? 0, u.prompt_tokens);
  const written = Math.min(u.prompt_tokens_details?.cache_write_tokens ?? 0, u.prompt_tokens - read);
  return { inputTokens: u.prompt_tokens - read - written, outputTokens: u.completion_tokens, cacheReadTokens: read, cacheWriteTokens: written };
}

/**
 * OpenAI's models whose pages document `reasoning_effort` on Chat Completions with low among its values: the two Terno
 * routes to (plan 168), and Terra, tried for summaries (plan 202). A model that doesn't take it rejects the request, so
 * nothing else gets it.
 */
const REASONING_MODELS: ReadonlySet<string> = new Set([OPENAI_DEFAULT_MODEL, OPENAI_DRAFT_MODEL, "gpt-6.1-terra"]);
export const takesReasoningEffort = (model: string) => REASONING_MODELS.has(model);

/**
 * Plan 291: OpenAI's models that take `prompt_cache_options` (GPT-5.6 and later): the ones Terno routes to, and Terra.
 * Left to its default (implicit) mode such a model writes every whole prompt to its cache at 1.25× input, mail and all,
 * and reads back only the system prompt; so each request goes in explicit mode, where only a marked block's end is
 * written ("no explicit breakpoints: no prompt caching"). Others never get the field.
 */
const EXPLICIT_CACHE_MODELS: ReadonlySet<string> = new Set([OPENAI_DEFAULT_MODEL, OPENAI_DRAFT_MODEL, "gpt-6.1-terra"]);
export const takesExplicitCache = (model: string) => EXPLICIT_CACHE_MODELS.has(model);

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

  const effort = config.id === "openai" && takesReasoningEffort(config.model);
  // OpenAI's own endpoint only: a relay saved on an OpenAI profile may refuse fields it doesn't know
  const explicitCache = config.id === "openai" && takesExplicitCache(config.model) && new URL(baseURL).host === new URL(descriptor.defaultBaseURL ?? baseURL).host;
  /** A marked prompt as text parts, a breakpoint where a prefix ends; anything else as the plain text it always was. */
  const parts = (c: readonly PromptBlock[], texts: readonly string[]) => c.map((b, i) => ({ type: "text" as const, text: texts[i]!, ...(b.cache ? { prompt_cache_breakpoint: { mode: "explicit" as const } } : {}) }));
  /**
   * One message, or (plan 291) several of the same role, each marked block ending one. Measured on Luna: with a JSON
   * schema, a breakpoint inside a message is written on every call and never read (2,312 tokens written three times
   * running), one at a message's end is read (2,297); without a schema both are. So structured requests end a message
   * at each breakpoint: the same text in the same role, one message boundary more.
   */
  const message = <R extends "system" | "user" | "assistant">(role: R, c: PromptText, structured: boolean): { role: R; content: string | ReturnType<typeof parts> }[] => {
    if (!explicitCache || typeof c === "string" || !marksCache(c)) return [{ role, content: promptText(c) }];
    const texts = blockTexts(c);
    if (!structured) return [{ role, content: parts(c, texts) }];
    const out: { role: R; content: ReturnType<typeof parts> }[] = [];
    let start = 0;
    c.forEach((b, i) => {
      if (b.cache || i === c.length - 1) {
        out.push({ role, content: parts(c.slice(start, i + 1), texts.slice(start, i + 1)) });
        start = i + 1;
      }
    });
    return out;
  };
  const request = async (req: CompletionRequest): Promise<ChatCompletionCreateParamsNonStreaming> => {
      const tokenLimit = config.id === "openai" || azure ? { max_completion_tokens: req.maxTokens } : { max_tokens: req.maxTokens };
      const structured = req.output === "json_schema" && !!req.schema;
      return {
        model: config.model,
        messages: [...message("system", req.system, structured), ...req.messages.flatMap((m) => message(m.role, m.content, structured))] as ChatCompletionCreateParamsNonStreaming["messages"],
        ...(explicitCache ? { prompt_cache_options: { mode: "explicit" as const } } : {}),
        ...tokenLimit,
        ...(effort && req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
        // plan 279: only where reasoning_effort goes, OpenAI's own models that document both
        ...(effort && req.verbosity ? { verbosity: req.verbosity } : {}),
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
        const usage = usageOf(completion.usage);
        // a refusal is billed too: its usage is what the book settles, not the worst case
        if (choice.message.refusal) return { text: "", stop: "refusal", ...(usage ? { usage } : {}) };
        return { text: choice.message.content ?? "", stop: choice.finish_reason === "length" ? "length" : "end", usage };
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
