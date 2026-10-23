import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { generateWithRepair, type WireCall } from "./generate";
import { AiError, type AiProvider, type FilterGenerationContext } from "./types";
import { systemPrompt, wireFilterSchema } from "./wire";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

export function createAnthropicProvider(options: { apiKey: string; model?: string; baseURL?: string }): AiProvider {
  // authToken: null so an ambient ANTHROPIC_AUTH_TOKEN never overrides the key the user saved in Settings
  const client = new Anthropic({ apiKey: options.apiKey, authToken: null, baseURL: options.baseURL, maxRetries: 2, timeout: 60_000 });
  const model = options.model || DEFAULT_ANTHROPIC_MODEL;

  const call: WireCall = async ({ prompt, ctx, repair, signal }) => {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
    if (repair) {
      messages.push(
        { role: "assistant", content: JSON.stringify(repair.previous) },
        { role: "user", content: `That filter is invalid: ${repair.error}. Return a corrected filter.` },
      );
    }
    try {
      const response = await client.beta.messages.create(
        {
          model,
          max_tokens: 4000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          // a short structured extraction: low effort keeps it fast
          output_config: { effort: "low", format: zodOutputFormat(wireFilterSchema) },
          system: systemPrompt(ctx),
          messages,
        },
        { signal },
      );
      // Check the stop reason before reading content: a refusal has no JSON body.
      if (response.stop_reason === "refusal") throw new AiError("The AI declined this request.", "refused");
      if (response.stop_reason === "max_tokens") throw new AiError("The AI response was cut off.", "invalid_output");
      const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new AiError("The AI returned malformed JSON.", "invalid_output");
      }
      const parsed = wireFilterSchema.safeParse(json);
      if (!parsed.success) throw new AiError("The AI returned an unexpected shape.", "invalid_output");
      return parsed.data;
    } catch (error) {
      if (error instanceof AiError) throw error;
      if (error instanceof Anthropic.AuthenticationError) throw new AiError("Invalid Anthropic API key.", "auth");
      if (error instanceof Anthropic.RateLimitError) throw new AiError("Rate limited by Anthropic, try again shortly.", "rate_limited");
      if (error instanceof Anthropic.APIError) throw new AiError(`Anthropic API error: ${error.message}`, "unavailable");
      throw new AiError(`Could not reach Anthropic: ${error instanceof Error ? error.message : String(error)}`, "unavailable");
    }
  };

  return {
    id: `anthropic:${model}`,
    generateFilter: (prompt: string, ctx: FilterGenerationContext, signal?: AbortSignal) => generateWithRepair(call, prompt, ctx, signal),
  };
}
