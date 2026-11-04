import type Anthropic from "@anthropic-ai/sdk";
import { L } from "@terno/i18n";
import { resolveBaseURL } from "./providers";
import { mapSdkError } from "./sdk-errors";
import { AiError, type CompletionRequest, type ModelInfo, type ModelTransport, type PromptText, type ProviderConfig, type StreamEvent, type Usage } from "./types";

type Sdk = typeof import("@anthropic-ai/sdk");

/** cache_control on the blocks that end a cacheable prefix */
function blocks(content: PromptText) {
  if (typeof content === "string") return content;
  return content.map((b) => ({ type: "text" as const, text: b.text, ...(b.cache ? { cache_control: { type: "ephemeral" as const } } : {}) }));
}

function usageOf(u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): Usage {
  return { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheWriteTokens: u.cache_creation_input_tokens ?? 0 };
}

const stopOf = (reason: string | null | undefined) => (reason === "refusal" ? "refusal" : reason === "max_tokens" ? "length" : "end");

/** Anthropic Messages API. The SDK is imported on first use so backend boot never pays for it. */
export function anthropicTransport(config: ProviderConfig): ModelTransport {
  const baseURL = resolveBaseURL(config)!;
  const info = { label: "Anthropic", local: false, host: new URL(baseURL).host, provider: config.id, browserOrigin: config.browserOrigin };
  let loaded: Promise<{ sdk: Sdk; client: Anthropic }> | null = null;
  const load = () =>
    (loaded ??= import("@anthropic-ai/sdk").then((sdk) => {
      if (!config.apiKey) throw new AiError(L("errors.ai.keyMissing", { provider: "Anthropic" }), "not_configured");
      // Every option explicit: ambient ANTHROPIC_* env vars must never redirect or re-key requests.
      // In the web build's worker: the opt-in sends anthropic-dangerous-direct-browser-access, without which the API refuses CORS.
      const { default: Anthropic } = sdk;
      const client = new Anthropic({ apiKey: config.apiKey, authToken: null, baseURL, maxRetries: config.maxRetries, timeout: config.timeoutMs, fetch: config.fetch, dangerouslyAllowBrowser: config.browserOrigin !== undefined });
      return { sdk, client };
    }));

  // Haiku declines have no server-side fallback, and Haiku 4.5 rejects effort outright
  const haiku = /haiku/.test(config.model);
  const takesEffort = !/haiku-4/.test(config.model);
  const params = async (req: CompletionRequest) => {
    const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
    const format = req.output === "json_schema" && req.schema ? { format: zodOutputFormat(req.schema.zod) } : {};
    const effort = takesEffort ? { effort: req.effort ?? "low" } : {};
    const output_config = { ...effort, ...format };
    return {
      model: config.model,
      max_tokens: req.maxTokens,
      ...(haiku ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
      ...(Object.keys(output_config).length ? { output_config } : {}),
      system: blocks(req.system),
      messages: req.messages.map((m) => ({ role: m.role, content: blocks(m.content) })),
    };
  };

  return {
    async complete(req) {
      const { sdk, client } = await load();
      try {
        const response = await client.beta.messages.create(await params(req) as never, { signal: req.signal }) as unknown as { content: { type: string; text?: string }[]; stop_reason: string | null; usage: Parameters<typeof usageOf>[0] };
        const text = response.content.flatMap((b) => (b.type === "text" ? [b.text ?? ""] : [])).join("");
        return { text, stop: stopOf(response.stop_reason), usage: usageOf(response.usage) };
      } catch (error) {
        throw mapSdkError(error, sdk.default, info);
      }
    },

    async *stream(req): AsyncGenerator<StreamEvent> {
      const { sdk, client } = await load();
      try {
        const stream = client.beta.messages.stream(await params(req) as never, { signal: req.signal });
        for await (const event of stream as AsyncIterable<{ type: string; delta?: { type?: string; text?: string } }>) {
          if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) yield { type: "delta", text: event.delta.text };
        }
        const final = await stream.finalMessage() as unknown as { stop_reason: string | null; usage: Parameters<typeof usageOf>[0] };
        yield { type: "done", stop: stopOf(final.stop_reason), usage: usageOf(final.usage) };
      } catch (error) {
        throw mapSdkError(error, sdk.default, info);
      }
    },

    async listModels(signal) {
      const { sdk, client } = await load();
      try {
        const models: ModelInfo[] = [];
        for await (const m of client.models.list({ limit: 100 }, { signal })) {
          models.push({ id: m.id, label: m.display_name, contextTokens: m.max_input_tokens ?? undefined });
        }
        return models;
      } catch (error) {
        throw mapSdkError(error, sdk.default, info);
      }
    },
  };
}
