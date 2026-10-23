import type { FilterRule } from "@unica/core";

export interface FilterGenerationContext {
  now: number;
  categories: { id: number; name: string }[];
  accounts: { id: number; email: string; displayName: string }[];
}

export interface GeneratedFilter {
  name: string;
  rule: FilterRule;
  explanation: string;
}

export interface AiProvider {
  readonly id: string;
  generateFilter(prompt: string, ctx: FilterGenerationContext, signal?: AbortSignal): Promise<GeneratedFilter>;
}

export class AiError extends Error {
  constructor(
    message: string,
    readonly kind: "invalid_output" | "refused" | "auth" | "rate_limited" | "unavailable",
  ) {
    super(message);
    this.name = "AiError";
  }
}
