import type Anthropic from "@anthropic-ai/sdk";
import { resolveBaseURL } from "./providers";
import { mapSdkError } from "./sdk-errors";
import { AiError, type ModelInfo, type ModelTransport, type ProviderConfig } from "./types";

type Sdk = typeof import("@anthropic-ai/sdk");

/** Anthropic Messages API. The SDK is imported on first use so backend boot never pays for it. */
export function anthropicTransport(config: ProviderConfig): ModelTransport {
  const baseURL = resolveBaseURL(config)!;
  const info = { label: "Anthropic", local: false, host: new URL(baseURL).host };
  let loaded: Promise<{ sdk: Sdk; client: Anthropic }> | null = null;
  const load = () =>
    (loaded ??= import("@anthropic-ai/sdk").then((sdk) => {
      if (!config.apiKey) throw new AiError("Guarda tu API key de Anthropic en Ajustes → IA.", "not_configured");
      // Every option explicit: ambient ANTHROPIC_* env vars must never redirect or re-key requests.
      const { default: Anthropic } = sdk;
      const client = new Anthropic({ apiKey: config.apiKey, authToken: null, baseURL, maxRetries: config.maxRetries, timeout: config.timeoutMs, fetch: config.fetch });
      return { sdk, client };
    }));

  return {
    async complete(req) {
      const { sdk, client } = await load();
      const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
      try {
        const response = await client.beta.messages.create(
          {
            model: config.model,
            max_tokens: req.maxTokens,
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
            // a short structured extraction: low effort keeps it fast
            output_config: req.output === "json_schema" && req.schema ? { effort: "low", format: zodOutputFormat(req.schema.zod) } : { effort: "low" },
            system: req.system,
            messages: req.messages,
          },
          { signal: req.signal },
        );
        const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
        const stop = response.stop_reason === "refusal" ? "refusal" : response.stop_reason === "max_tokens" ? "length" : "end";
        return { text, stop };
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
