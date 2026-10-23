import { AiError, type FilterGenerationContext, type GeneratedFilter } from "./types";
import { convertWireFilter, type WireFilter } from "./wire";

/** One model call: returns the raw wire filter (or throws AiError). */
export type WireCall = (input: {
  prompt: string;
  ctx: FilterGenerationContext;
  /** validation feedback from a previous attempt, for the repair round */
  repair?: { previous: WireFilter; error: string };
  signal?: AbortSignal;
}) => Promise<WireFilter>;

/** Generates a filter with one repair retry when the output doesn't validate. */
export async function generateWithRepair(
  call: WireCall,
  prompt: string,
  ctx: FilterGenerationContext,
  signal?: AbortSignal,
): Promise<GeneratedFilter> {
  const first = await call({ prompt, ctx, signal });
  const r1 = convertWireFilter(first, ctx);
  if (r1.ok) return { name: r1.name, rule: r1.rule, explanation: r1.explanation };
  const second = await call({ prompt, ctx, repair: { previous: first, error: r1.error }, signal });
  const r2 = convertWireFilter(second, ctx);
  if (r2.ok) return { name: r2.name, rule: r2.rule, explanation: r2.explanation };
  throw new AiError(`The AI could not produce a valid filter: ${r2.error}`, "invalid_output");
}
