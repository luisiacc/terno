import { costAt, priceOf, worstCaseUsd, type ModelPrice } from "./prices";
import { AiError, type CompletionRequest, type ModelTransport, type StreamEvent, type Usage } from "./types";

/**
 * A hard ceiling for runs against real models (evals, proofs on a developer's
 * key). Each request first reserves its worst case: its whole input plus every
 * output token it may use. If that doesn't fit, it never leaves the machine.
 * Until it settles the reservation counts as spent, so concurrent requests, and
 * a process that dies mid-request, can't pass the cap.
 *
 * Not used by the shipped app, which has daily limits of its own (ai-limiter).
 * On disk: file-ledger.ts, so this module stays free of node:fs for the web build.
 */
export interface SpendLedger {
  /** dollars recorded so far, unsettled reservations included */
  spent(): number;
  readonly capUsd: number;
  /** Holds `usd` against the cap as one atomic step. Its id, or null when it doesn't fit: then nothing was held. */
  reserve(entry: { model: string; usd: number; label?: string }): string | null;
  /** Turns a reservation into what it really cost. */
  settle(id: string, entry: { model: string; usd: number; usage?: Usage; label?: string }): void;
}

export class BudgetExceededError extends AiError {
  constructor(message: string) {
    super(message, "rate_limited");
    this.name = "BudgetExceededError";
  }
}

function worstCase(model: string, price: ModelPrice | null, req: CompletionRequest): number {
  // an unknown price can't be held to a ceiling, so it doesn't run at all
  if (!price) throw new BudgetExceededError(`no known price for ${model}: refusing to call it on a budget`);
  return worstCaseUsd(price, req);
}

function actual(price: ModelPrice | null, usage: Usage | undefined, reserved: number): number {
  // no usage reported: assume the worst case happened
  if (!price || !usage) return reserved;
  return costAt(price, usage);
}

function hold(ledger: SpendLedger, reserved: number, model: string, label: string | undefined): string {
  const id = ledger.reserve({ model, usd: reserved, label });
  if (id === null) {
    throw new BudgetExceededError(`spend cap: $${ledger.spent().toFixed(4)} spent + $${reserved.toFixed(4)} worst case for ${model} would pass $${ledger.capUsd.toFixed(2)}`);
  }
  return id;
}

/** A settle that can't be written leaves the worst case standing, which errs the safe way. It must not lose the answer. */
function settle(ledger: SpendLedger, id: string, entry: Parameters<SpendLedger["settle"]>[1]): void {
  try {
    ledger.settle(id, entry);
  } catch {
    // the reservation stays counted
  }
}

/**
 * Puts a transport under a ledger. A failed request is charged its worst case, since it may have been billed. `price`:
 * the app's, unless an eval knows one the app doesn't list.
 */
export function budgetedTransport(inner: ModelTransport, model: string, ledger: SpendLedger, label?: string, price: ModelPrice | null = priceOf(model)): ModelTransport {
  return {
    ...inner,
    async complete(req) {
      const reserved = worstCase(model, price, req);
      const id = hold(ledger, reserved, model, label);
      try {
        const completion = await inner.complete(req);
        settle(ledger, id, { model, usd: actual(price, completion.usage, reserved), usage: completion.usage, label });
        return completion;
      } catch (error) {
        settle(ledger, id, { model, usd: reserved, label: `${label ?? ""} failed` });
        throw error;
      }
    },
    ...(inner.stream
      ? {
          async *stream(req: CompletionRequest): AsyncGenerator<StreamEvent> {
            const reserved = worstCase(model, price, req);
            const id = hold(ledger, reserved, model, label);
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
              settle(ledger, id, { model, usd: finished ? actual(price, usage, reserved) : reserved, usage, label: finished ? label : `${label ?? ""} stopped` });
            }
          },
        }
      : {}),
  };
}
