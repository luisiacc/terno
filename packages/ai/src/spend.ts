import { priceOf } from "./prices";
import { AiError, promptText, type CompletionRequest, type ModelTransport, type StreamEvent, type Usage } from "./types";

/**
 * A hard ceiling for runs against real models (evals, proofs on a developer's
 * key). Each request first reserves its worst case: its whole input plus every
 * output token it may use. If that doesn't fit, it never leaves the machine.
 * After it finishes, the reservation becomes what it really cost.
 *
 * Not used by the shipped app, which has daily limits of its own (ai-limiter).
 */
export interface SpendLedger {
  /** dollars recorded so far */
  spent(): number;
  readonly capUsd: number;
  record(entry: { model: string; usd: number; usage?: Usage; label?: string }): void;
}

export class BudgetExceededError extends AiError {
  constructor(message: string) {
    super(message, "rate_limited");
    this.name = "BudgetExceededError";
  }
}

/** Generous on purpose: a reservation should overestimate. */
function inputTokens(req: CompletionRequest): number {
  const chars = promptText(req.system).length + req.messages.reduce((n, m) => n + promptText(m.content).length, 0);
  return Math.ceil(chars / 2.5);
}

function worstCase(model: string, req: CompletionRequest): number {
  const price = priceOf(model);
  // an unknown price can't be held to a ceiling, so it doesn't run at all
  if (!price) throw new BudgetExceededError(`no known price for ${model}: refusing to call it on a budget`);
  // a cache write is the priciest way to read input
  return (inputTokens(req) * Math.max(price.input, price.cacheWrite ?? 0) + req.maxTokens * price.output) / 1_000_000;
}

function actual(model: string, usage: Usage | undefined, reserved: number): number {
  const price = priceOf(model);
  // no usage reported: assume the worst case happened
  if (!price || !usage) return reserved;
  return (usage.inputTokens * price.input + usage.outputTokens * price.output + (usage.cacheReadTokens ?? 0) * (price.cacheRead ?? price.input) + (usage.cacheWriteTokens ?? 0) * (price.cacheWrite ?? price.input)) / 1_000_000;
}

function admit(ledger: SpendLedger, reserved: number, model: string): void {
  const after = ledger.spent() + reserved;
  if (after > ledger.capUsd) {
    throw new BudgetExceededError(`spend cap: $${ledger.spent().toFixed(4)} spent + $${reserved.toFixed(4)} worst case for ${model} would pass $${ledger.capUsd.toFixed(2)}`);
  }
}

/** Puts a transport under a ledger. A failed request is charged its worst case, since it may have been billed. */
export function budgetedTransport(inner: ModelTransport, model: string, ledger: SpendLedger, label?: string): ModelTransport {
  return {
    ...inner,
    async complete(req) {
      const reserved = worstCase(model, req);
      admit(ledger, reserved, model);
      try {
        const completion = await inner.complete(req);
        ledger.record({ model, usd: actual(model, completion.usage, reserved), usage: completion.usage, label });
        return completion;
      } catch (error) {
        ledger.record({ model, usd: reserved, label: `${label ?? ""} failed` });
        throw error;
      }
    },
    ...(inner.stream
      ? {
          async *stream(req: CompletionRequest): AsyncGenerator<StreamEvent> {
            const reserved = worstCase(model, req);
            admit(ledger, reserved, model);
            let usage: Usage | undefined;
            let finished = false;
            try {
              for await (const event of inner.stream!(req)) {
                if (event.type === "done") {
                  usage = event.usage;
                  finished = true;
                }
                yield event;
              }
            } finally {
              // stopped early or failed: billed for what ran, which we can't see, so the worst case stands
              ledger.record({ model, usd: finished ? actual(model, usage, reserved) : reserved, usage, label: finished ? label : `${label ?? ""} stopped` });
            }
          },
        }
      : {}),
  };
}
