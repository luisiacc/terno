import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAi, deliveryOf, summaryBudget, type SummaryReader, type ThreadText } from "@terno/ai";
import { describe, expect, it } from "vitest";
import { promptText } from "../../packages/ai/src/types";
import { withoutQuotes } from "../../packages/core/src/text";
import { realKeys, realTransport, spendReport } from "./harness";

/**
 * Plan 150's eval: the summary prompt over the corpus in corpus/README.md, on the real model, writing what came back to
 * ~/.terno-evals/runs/<run>.jsonl for scoring and for a person to read. Real mail stays on this machine, so its results
 * do too. Needs the owner's go-ahead: TERNO_AI_SUMMARY_CORPUS=<run name>, and optionally:
 *
 * - TERNO_AI_SUMMARY_SETS: comma-separated sets (synthetic,enron,apache,python-es,debian-es); all by default
 * - TERNO_AI_SUMMARY_VARIANT: a file of JSON [[find, replace], …] applied to the system prompt, to try wording with no
 *   change to the code
 * - TERNO_AI_SUMMARY_MODEL: the model, GPT Luna by default
 *
 * A run already on disk carries on from where it stopped, and the harness's ledger holds the spend.
 */
const RUN = process.env.TERNO_AI_SUMMARY_CORPUS;
const HOME = join(homedir(), ".terno-evals");
const SYNTHETIC = join(import.meta.dirname, "corpus", "synthetic");
const MODEL = process.env.TERNO_AI_SUMMARY_MODEL ?? "gpt-6-luna";
const CONCURRENCY = 4;

interface Conversation {
  id: string;
  source?: string;
  author: string;
  language: string;
  tags: string[];
  subject: string;
  today: string;
  reader: SummaryReader;
  messages: { from: string; date: string; own: boolean; to?: string[]; cc?: string[]; list?: boolean; text: string }[];
}

const parsed = (who: string) => {
  const m = /^(.*?)\s*<([^>]+)>\s*$/.exec(who);
  return m ? { name: m[1]!.replace(/^"|"$/g, ""), email: m[2]! } : { name: "", email: who.trim() };
};

const readJsonl = (path: string): Conversation[] =>
  readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Conversation);

function load(sets: string[]): (Conversation & { set: string })[] {
  const out: (Conversation & { set: string })[] = [];
  for (const set of sets) {
    const paths = set === "synthetic" ? readdirSync(SYNTHETIC).filter((f) => f.endsWith(".jsonl")).sort().map((f) => join(SYNTHETIC, f)) : [join(HOME, "real-mail", `${set}.jsonl`)];
    for (const path of paths) if (existsSync(path)) out.push(...readJsonl(path).map((c) => ({ ...c, set })));
  }
  return out;
}

/** What `assemble` in packages/backend/src/summaries.ts sends: the newest inbound whole, the 12 before it without their quotes, then snippets. */
function thread(c: Conversation): ThreadText[] {
  const newest = [...c.messages].reverse().find((m) => !m.own) ?? c.messages[c.messages.length - 1]!;
  const others = c.messages.filter((m) => m !== newest).slice(-12);
  const own = new Set([c.reader.email.toLowerCase(), ...c.messages.filter((m) => m.own).map((m) => parsed(m.from).email.toLowerCase())]);
  return c.messages
    .filter((m) => m === newest || others.includes(m) || c.messages.indexOf(m) >= c.messages.length - 53)
    .map((m, i) => ({
      label: `m${i + 1}`,
      from: m.from,
      ...deliveryOf({ to: (m.to ?? []).map(parsed), cc: (m.cc ?? []).map(parsed), list: m.list === true }, own),
      date: m.date,
      own: m.own,
      text: m === newest ? m.text.slice(0, 16_000) : others.includes(m) ? withoutQuotes(m.text).slice(0, 1_600) || m.text.slice(0, 100) : withoutQuotes(m.text).replace(/\s+/g, " ").slice(0, 120),
    }));
}

/** The app's language, as a reader of this mail would have it. */
const readerLanguage = (c: Conversation) => (c.language === "es" || c.language === "mixed" ? "es" : "en");

describe.skipIf(!RUN)("summaries over the corpus", () => {
  it("writes each summary and its rows", async () => {
    const sets = (process.env.TERNO_AI_SUMMARY_SETS ?? "synthetic,enron,apache,python-es,debian-es").split(",");
    const variantPath = process.env.TERNO_AI_SUMMARY_VARIANT;
    const swaps = variantPath ? (JSON.parse(readFileSync(variantPath, "utf8")) as [string, string][]) : [];
    const budgeted = realTransport({ provider: "openai", model: MODEL }, `summary-corpus-${RUN}`);
    let swapped = false;
    const transport = {
      ...budgeted,
      complete: (req: Parameters<typeof budgeted.complete>[0], ...rest: unknown[]) => {
        let system = promptText(req.system);
        for (const [find, replace] of swaps) {
          if (!system.includes(find)) throw new Error(`the variant's text isn't in the prompt: ${find.slice(0, 60)}`);
          system = system.replace(find, replace);
          swapped = true;
        }
        return (budgeted.complete as (...a: unknown[]) => ReturnType<typeof budgeted.complete>)({ ...req, system }, ...rest);
      },
    };
    const ai = createAi({ id: "openai", model: MODEL, apiKey: realKeys().openai, fetch: globalThis.fetch, timeoutMs: 120_000, maxRetries: 0 }, { transport });

    const dir = join(HOME, "runs");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${RUN}.jsonl`);
    const done = new Set(existsSync(path) ? readJsonl(path).map((r) => r.id) : []);
    if (!existsSync(path)) writeFileSync(path, "");
    const queue = load(sets).filter((c) => !done.has(c.id));
    console.log(`${queue.length} to run, ${done.size} done, ${spendReport()}`);

    let failed = 0;
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        for (let c = queue.shift(); c; c = queue.shift()) {
          const input = thread(c);
          const started = Date.now();
          try {
            const r = await ai.summarize({ subject: c.subject, thread: input, reader: c.reader, language: readerLanguage(c), today: c.today, outputTokens: summaryBudget(null).outputTokens });
            appendFileSync(path, `${JSON.stringify({ id: c.id, set: c.set, language: readerLanguage(c), ms: Date.now() - started, summary: r.summary, items: r.items })}\n`);
          } catch (e) {
            failed++;
            appendFileSync(path, `${JSON.stringify({ id: c.id, set: c.set, language: readerLanguage(c), ms: Date.now() - started, error: e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 200) : "unknown" })}\n`);
          }
        }
      }),
    );
    console.log(`finished ${RUN}: ${failed} failed, ${spendReport()}`);
    if (swaps.length) expect(swapped).toBe(true);
  }, 3_600_000);
});
