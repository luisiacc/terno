import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { budgetedTransport, createAi, transportFor, type AiOptions, type AiTasks, type ModelTransport, type ProviderConfig, type SpendLedger } from "@terno/ai";
import { fileLedger as ledgerAt } from "@terno/ai/file-ledger";

/**
 * Runs against real models, for evals and proofs, and nothing else. Never
 * collected by `pnpm test`: only `vitest --config vitest.real.config.ts` sees
 * these, and that refuses to start without TERNO_AI_REAL=1.
 *
 * Every request goes through one ledger on disk with a hard ceiling. It's kept
 * across runs, so a second run can't start the count again.
 */
export const HARD_CAP_USD = Number(process.env.TERNO_AI_CAP_USD ?? 5);
if (!(HARD_CAP_USD > 0 && HARD_CAP_USD <= 5)) throw new Error("TERNO_AI_CAP_USD must be above 0 and at most 5");

export const LEDGER_PATH = process.env.TERNO_AI_LEDGER ?? "/tmp/terno-ai/spend.jsonl";

export function fileLedger(path: string = LEDGER_PATH, capUsd: number = HARD_CAP_USD): SpendLedger {
  return ledgerAt(path, capUsd);
}

/** The repo's .env, read only here and held only in this process. Values are never logged. */
export function realKeys(): { anthropic: string; openai: string; jev: string } {
  const text = readFileSync(resolve(process.cwd(), ".env"), "utf8");
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) env[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  return { anthropic: env.ANTHROPIC_API_KEY ?? "", openai: env.OPENAI_API_KEY ?? "", jev: env.JEV_API_KEY ?? "" };
}

export interface RealTarget {
  provider: "anthropic" | "openai" | "jev";
  model: string;
}

/** Tasks on a real model, under the ledger: the same createAi the app uses. */
export function realTasks(target: RealTarget, label: string, options: AiOptions = {}): AiTasks {
  const keys = realKeys();
  const config: ProviderConfig = {
    id: target.provider,
    model: target.model,
    apiKey: keys[target.provider],
    fetch: globalThis.fetch,
    timeoutMs: 90_000,
    // a retry would be a request the ledger never saw
    maxRetries: 0,
  };
  const ledger = fileLedger();
  return createAi(config, {
    ...options,
    wrapTransport: (transport) => budgetedTransport(transport, target.model, ledger, label),
    ...(target.provider === "jev" ? {} : { transport: transportFor(config) }),
  });
}

/** A bare transport under the same ledger, for what isn't an app task: fixtures and judges in an eval. */
export function realTransport(target: RealTarget, label: string): ModelTransport {
  const keys = realKeys();
  const config: ProviderConfig = { id: target.provider, model: target.model, apiKey: keys[target.provider], fetch: globalThis.fetch, timeoutMs: 120_000, maxRetries: 0 };
  return budgetedTransport(transportFor(config), target.model, fileLedger(), label);
}

export function spendReport(): string {
  const ledger = fileLedger();
  return `spent $${ledger.spent().toFixed(4)} of $${ledger.capUsd.toFixed(2)}`;
}
