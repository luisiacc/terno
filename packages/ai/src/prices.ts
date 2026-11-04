import { promptText, type CompletionRequest, type Usage } from "./types";

export interface ModelPrice {
  /** US dollars per million tokens */
  input: number;
  output: number;
  /** cache reads and writes, where they differ from input */
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * What Terno can state about a model's price: only what we were told, so an
 * unknown model shows no estimate rather than a wrong one. Haiku's 100k-token
 * surcharge isn't modelled, since no task sends that much.
 */
const PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  // the user's figure for input; output isn't known, so it's priced as if it were GPT's usual 4× to stay on the safe side
  "gpt-6-luna": { input: 0.1, output: 0.4 },
  "jev-latest": { input: 0.042, output: 0 },
  "jev-preview": { input: 0.042, output: 0 },
};

export function priceOf(model: string): ModelPrice | null {
  return PRICES[model] ?? null;
}

/** A cloud model nobody told us the price of: counted dear, so a ceiling still bites and nothing reads as free. */
export const UNKNOWN_CLOUD_PRICE: ModelPrice = { input: 10, output: 50 };

/** Generous on purpose: a reservation should overestimate. */
export function estimateInputTokens(req: Pick<CompletionRequest, "system" | "messages">): number {
  const chars = promptText(req.system).length + req.messages.reduce((n, m) => n + promptText(m.content).length, 0);
  return Math.ceil(chars / 2.5);
}

/** The most a request can cost: its whole input at the priciest way to read it (a cache write) plus every output token it may use. */
export function worstCaseUsd(price: ModelPrice, req: Pick<CompletionRequest, "system" | "messages" | "maxTokens">): number {
  return (estimateInputTokens(req) * Math.max(price.input, price.cacheWrite ?? 0) + req.maxTokens * price.output) / 1_000_000;
}

/** What a request cost at a price, in US dollars. */
export function costAt(price: ModelPrice, usage: Usage): number {
  const cached = (usage.cacheReadTokens ?? 0) * (price.cacheRead ?? price.input) + (usage.cacheWriteTokens ?? 0) * (price.cacheWrite ?? price.input);
  // OpenAI counts cached tokens inside input; Anthropic reports them apart. Only OpenAI's would double-count, and only upward.
  return (usage.inputTokens * price.input + usage.outputTokens * price.output + cached) / 1_000_000;
}

/** What a request cost in US dollars, or null when the price isn't known. */
export function costOf(model: string, usage: Usage): number | null {
  const price = priceOf(model);
  return price ? costAt(price, usage) : null;
}
