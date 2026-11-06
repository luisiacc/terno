import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAi, deliveryOf, summarizeTask, summaryBudget, type SummaryReader, type ThreadText } from "@terno/ai";
import { runStructured } from "../../packages/ai/src/ladder";
import type { ModelTransport } from "../../packages/ai/src/types";
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
 * - TERNO_AI_SUMMARY_EFFORT: low, medium or high in place of the task's own
 * - TERNO_AI_SUMMARY_VERIFY=1: a second pass that checks the first against the mail
 * - TERNO_AI_SUMMARY_IDS: a file of JSON ids, to run only those
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
  const last = c.messages[c.messages.length - 1]!;
  const own = new Set([c.reader.email.toLowerCase(), ...c.messages.filter((m) => m.own).map((m) => parsed(m.from).email.toLowerCase())]);
  return c.messages
    .filter((m) => m === newest || others.includes(m) || c.messages.indexOf(m) >= c.messages.length - 53)
    .map((m, i) => ({
      label: `m${i + 1}`,
      from: m.from,
      ...deliveryOf({ to: (m.to ?? []).map(parsed), cc: (m.cc ?? []).map(parsed), list: m.list === true }, own),
      date: m.date,
      own: m.own,
      text: m === newest ? m.text.slice(0, 16_000) : m === last && withoutQuotes(m.text) !== m.text ? `${withoutQuotes(m.text).slice(0, 1_600)}\n\n${m.text.slice(0, 6_000)}` : others.includes(m) ? withoutQuotes(m.text).slice(0, 1_600) || m.text.slice(0, 100) : withoutQuotes(m.text).replace(/\s+/g, " ").slice(0, 120),
    }));
}

/** The app's language, as a reader of this mail would have it. */
const readerLanguage = (c: Conversation) => (c.language === "es" || c.language === "mixed" ? "es" : "en");

describe.skipIf(!RUN)("summaries over the corpus", () => {
  it("writes each summary and its rows", async () => {
    const sets = (process.env.TERNO_AI_SUMMARY_SETS ?? "synthetic,enron,apache,python-es,debian-es").split(",");
    const variantPath = process.env.TERNO_AI_SUMMARY_VARIANT;
    const swaps = variantPath ? (JSON.parse(readFileSync(variantPath, "utf8")) as [string, string][]) : [];
    const provider = MODEL.startsWith("claude") ? ("anthropic" as const) : ("openai" as const);
    const budgeted = realTransport({ provider, model: MODEL }, `summary-corpus-${RUN}`);
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
        const effort = (process.env.TERNO_AI_SUMMARY_EFFORT as typeof req.effort | undefined) ?? req.effort;
        return (budgeted.complete as (...a: unknown[]) => ReturnType<typeof budgeted.complete>)({ ...req, system, effort }, ...rest);
      },
    };
    const ai = createAi({ id: provider, model: MODEL, apiKey: realKeys()[provider], fetch: globalThis.fetch, timeoutMs: 120_000, maxRetries: 0 }, { transport });

    const dir = join(HOME, "runs");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${RUN}.jsonl`);
    const done = new Set(existsSync(path) ? readJsonl(path).map((r) => r.id) : []);
    if (!existsSync(path)) writeFileSync(path, "");
    const only = process.env.TERNO_AI_SUMMARY_IDS ? new Set(JSON.parse(readFileSync(process.env.TERNO_AI_SUMMARY_IDS, "utf8")) as string[]) : null;
    const queue = load(sets).filter((c) => !done.has(c.id) && (!only || only.has(c.id)));
    console.log(`${queue.length} to run, ${done.size} done, ${spendReport()}`);

    let failed = 0;
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        for (let c = queue.shift(); c; c = queue.shift()) {
          const input = thread(c);
          const started = Date.now();
          try {
            const request = { subject: c.subject, thread: input, reader: c.reader, language: readerLanguage(c), today: c.today, outputTokens: summaryBudget(null).outputTokens };
            let r = await ai.summarize(request);
            if (process.env.TERNO_AI_SUMMARY_VERIFY === "1") {
              const task = summarizeTask(request);
              r = await runStructured(transport as ModelTransport, {
                ...task,
                system: `${promptText(task.system)}\n\nA first draft of the answer is in <draft>. Check every statement in it against the messages, one by one: who said it, what they said, how sure they were, what's still open after the last message, and each name, date and amount. Remove or correct anything the messages don't support. Add only what the rules above require. Return the corrected answer in the same format, or the draft unchanged if it holds.`,
                prompt: `${task.prompt}\n\n<draft>${JSON.stringify(r)}</draft>`,
              }, { output: "json_schema", signal: new AbortController().signal });
            }
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
