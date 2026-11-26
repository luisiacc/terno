import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { promptText } from "../../packages/ai/src/types";
import { realTransport, spendReport } from "./harness";

/**
 * Plan 279's judge: each card of a summaries-corpus run (TERNO_JUDGE_RUN=<run>), scored against its conversation and the
 * conversation's answer key (a panel person's `expect`, a fictional conversation's `truth`) by one fixed judge model
 * (TERNO_JUDGE_MODEL, Claude Sonnet 5.5 by default), on the panel's six facets, with every wrong or missing fact and its
 * evidence. Absolute scores, the same rubric every time, so prompt variants compare by their means; a run judged twice
 * gives the judge's own noise. Writes ~/.terno-evals/runs/<run>.<judge label>.jsonl, carrying on where it stopped.
 */
const RUN = process.env.TERNO_JUDGE_RUN;
const MODEL = process.env.TERNO_JUDGE_MODEL ?? "claude-sonnet-5-5";
const LABEL = process.env.TERNO_JUDGE_LABEL ?? "judge";
const HOME = join(homedir(), ".terno-evals");
const SYNTHETIC = join(import.meta.dirname, "corpus", "synthetic");
const CONCURRENCY = 4;

interface Message { from: string; date: string; own: boolean; to?: string[]; cc?: string[]; text: string; read?: boolean }
interface Conversation { id: string; subject: string; today: string; reader: { name: string; email: string }; messages: Message[]; expect?: unknown; truth?: unknown }
interface Card { id: string; summary?: string; since?: string; newLabels?: string[]; items?: { kind: string; text: string; message: string; due?: string; byReply?: boolean }[]; error?: string }

const conversations = (): Map<string, Conversation> => {
  const files = [...readdirSync(SYNTHETIC).filter((f) => f.endsWith(".jsonl")).map((f) => join(SYNTHETIC, f)), join(HOME, "panel279", "all.jsonl")];
  const out = new Map<string, Conversation>();
  for (const f of files) if (existsSync(f)) for (const l of readFileSync(f, "utf8").split("\n").filter(Boolean)) { const c = JSON.parse(l) as Conversation; out.set(c.id, c); }
  return out;
};

const SYSTEM = `You judge one AI-written summary card of an email conversation for the person reading it (the reader). Be strict and evidence-based. The card has:
- "Since": a short paragraph on what the new, unread messages changed (shown by default when present). When the card has none, the reader sees the whole summary by default.
- "Whole": the summary of the whole conversation, one click away.
- Rows: kinds action (a to-do for the reader), question (asked of the reader), waiting (what someone else owes the reader), date, decision; each may have a due day; "(done outside this mail)" marks a to-do still open that is done by a call, a payment, a form or a visit rather than by replying; it is NOT finished.

You get the conversation (oldest first; messages marked NEW are the unread ones), the card, and an answer key (what the reader expects, or the truth about the conversation: use it as a strong hint, but the mail decides).

Score 0 to 10, whole numbers:
- since_accurate: everything the default view says is true to the mail, credited to the right person, nothing old presented as new. (No new mail or no Since: score the whole summary instead.)
- since_needed: the default view tells the reader what changed and what is now asked of them, so they needn't open the mail. A real change (a moved date, a new amount, a cancellation, a decision) with no Since, or a Since that misses the main change, scores low.
- concise: no filler, no repetition, no padding; short sentences a busy person reads at a glance.
- rows_right: every row is right and the reader's to-dos, questions and what's owed to them are all there, with their days; nothing that isn't theirs. By the product's rule, what other people owe each other is never a row: never count it as missing.
- whole_accurate: the whole summary is true and complete on what matters.
- rely: would a careful reader rely on this card daily?

List every wrong claim (the card's words, and the mail's words that contradict it, or the messages checked and found silent) and every missing key fact, deadline, amount or ask, each with severity high (could make the reader act wrongly or miss something that matters) or low. Style and omissions of trivia are not wrong.

Answer with JSON only: {"since_accurate":n,"since_needed":n,"concise":n,"rows_right":n,"whole_accurate":n,"rely":n,"wrong":[{"words":"...","evidence":"...","severity":"high|low"}],"missing":[{"what":"...","severity":"high|low"}]}`;

function show(c: Conversation, card: Card): string {
  const n = c.messages.length;
  const first = n - (card.newLabels?.length ?? 0);
  const mail = c.messages.map((m, i) => `<message id="m${i + 1}" from="${m.from}" date="${m.date}"${m.own ? ' author="the reader"' : ""}${card.newLabels?.length && i >= first ? " NEW" : ""}>\n${m.text}\n</message>`).join("\n\n");
  const rows = (card.items ?? []).map((i) => `- ${i.kind}${i.due ? ` (due ${i.due})` : ""}${i.kind === "action" && i.byReply === false ? " (done outside this mail)" : ""}: ${i.text} [cites ${i.message}]`).join("\n") || "(none)";
  const view = card.since ? `Since: ${card.since}\n\nWhole: ${card.summary}` : `(no Since: the whole summary is the default view)\n\nWhole: ${card.summary}`;
  return `<conversation subject="${c.subject}" today="${c.today}" reader="${c.reader.name} <${c.reader.email}>">\n${mail}\n</conversation>\n\n<card>\n${view}\n\nRows:\n${rows}\n</card>\n\n<answer_key>\n${JSON.stringify(c.expect ?? c.truth ?? null)}\n</answer_key>`;
}

const json = (text: string): unknown => {
  const at = text.indexOf("{");
  return JSON.parse(text.slice(at, text.lastIndexOf("}") + 1));
};

describe.skipIf(!RUN)("judging a summaries run", () => {
  it("scores each card", async () => {
    const convs = conversations();
    const cards = readFileSync(join(HOME, "runs", `${RUN}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Card);
    const out = join(HOME, "runs", `${RUN}.${LABEL}.jsonl`);
    const done = new Set(existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { id: string }).id) : []);
    if (!existsSync(out)) writeFileSync(out, "");
    const provider = MODEL.startsWith("claude") ? ("anthropic" as const) : ("openai" as const);
    const transport = realTransport({ provider, model: MODEL }, `summary-judge-${RUN}`);
    const queue = cards.filter((c) => !done.has(c.id) && convs.has(c.id) && !c.error);
    console.log(`${queue.length} to judge, ${spendReport()}`);
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      for (let card = queue.shift(); card; card = queue.shift()) {
        const c = convs.get(card.id)!;
        try {
          const reply = await transport.complete({ system: SYSTEM, messages: [{ role: "user", content: show(c, card) }], output: "text", maxTokens: 4000, signal: new AbortController().signal });
          appendFileSync(out, `${JSON.stringify({ id: card.id, ...(json(promptText(reply.text)) as object) })}\n`);
        } catch (e) {
          appendFileSync(out, `${JSON.stringify({ id: card.id, error: e instanceof Error ? e.message.slice(0, 200) : "unknown" })}\n`);
        }
      }
    }));
    console.log(`judged ${RUN}, ${spendReport()}`);
  }, 3_600_000);
});
