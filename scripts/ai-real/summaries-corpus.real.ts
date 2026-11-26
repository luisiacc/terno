import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAi, deliveryOf, summarizeTask, summaryBudget, summaryPrompt, type SummaryReader, type ThreadText } from "@terno/ai";
import { runStructured } from "../../packages/ai/src/ladder";
import type { CompletionRequest, ModelTransport } from "../../packages/ai/src/types";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { promptText } from "../../packages/ai/src/types";
import { withoutQuotes } from "../../packages/core/src/text";
import { realKeys, realTransport, spendReport } from "./harness";

/**
 * Plan 150's eval: the summary prompt over the corpus in corpus/README.md, on the real model, writing what came back to
 * ~/.terno-evals/runs/<run>.jsonl for scoring and for a person to read. Real mail stays on this machine, so its results
 * do too. Needs the owner's go-ahead: TERNO_AI_SUMMARY_CORPUS=<run name>, and optionally:
 *
 * - TERNO_AI_SUMMARY_SETS: comma-separated sets (synthetic,enron,apache,python-es,debian-es); all by default. A real
 *   set from another seed is <folder>/<set>, as real-mail-fresh/enron
 * - TERNO_AI_SUMMARY_VARIANT: a file of JSON [[find, replace], …] applied to the system prompt, to try wording with no
 *   change to the code
 * - TERNO_AI_SUMMARY_TAIL: a file whose text goes after the mail, at the end of the first user turn
 * - TERNO_AI_SUMMARY_MODEL: the model, GPT Luna by default
 * - TERNO_AI_SUMMARY_EFFORT: low, medium or high in place of the task's own, or default for none at all
 * - TERNO_AI_SUMMARY_VERIFY=1: a second pass that checks the first against the mail
 * - TERNO_AI_SUMMARY_IDS: a file of JSON ids, to run only those
 * - TERNO_AI_SUMMARY_SYSTEM (plan 279): a file holding a whole system prompt in place of the app's, with {{language}} and
 *   {{today}} filled in, and what's between <<since>> and <</since>> kept only when the request asks for a since
 * - TERNO_AI_SUMMARY_VERBOSITY (plan 279): OpenAI's verbosity, low, medium or high
 * - TERNO_AI_SUMMARY_NOTES (plan 279): a file holding a first pass's system prompt: the model reads the mail once to take
 *   notes, and the card is asked with those notes after the mail
 * - TERNO_AI_SUMMARY_ANNOTATE=1 (plan 279): each date with its weekday, and the lines put to the reader by name and the
 *   reader's own "I'll …" sentences listed after the mail
 * - TERNO_AI_SUMMARY_SAMPLES=<k> (plan 279): k answers in parallel; the first is the card, all are kept ("samples") for
 *   combining afterwards
 * - TERNO_AI_SUMMARY_ROWS_CALL=1 (plan 279): a parallel call writes only the rows, from the raw thread; its rows are the
 *   card's (the first call's are kept as "itemsA"); =ledger: that call goes through every message first, quoting each
 *   request with its owner and status, and code keeps the reader's open ones
 * - TERNO_AI_SUMMARY_ROWS_FIRST=1 (plan 279): the schema sent asks for the rows before the summary
 * - TERNO_AI_SUMMARY_LAST (plan 279): a file whose text replaces the user turn's last instruction
 * - TERNO_AI_SUMMARY_AUDIT (plan 279): a file holding the instruction for a second pass that gets the first answer in
 *   <draft> and returns the card again (the first is kept as "draft")
 * - TERNO_AI_SUMMARY_SINCE=1 (plan 279): each conversation of two or more messages is read up to its last run of
 *   mail from others after the reader's last reply (the last message alone when the reader never wrote and everything
 *   is theirs), and that run is marked new="yes". Unset, the same conversations go with no marks: version 8's words
 * - TERNO_AI_SUMMARY_TAIL_MAIL=courtesy|material (plan 279): a short reply from the last sender is added to each
 *   conversation, today, and is the only new message: a courtesy one should leave the since empty, a material one not
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
  /** `read` (plan 279): when given, what's new starts as production's rule has it: the run after the last message that's yours or read */
  messages: { from: string; date: string; own: boolean; to?: string[]; cc?: string[]; list?: boolean; text: string; read?: boolean }[];
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
    const paths = set === "synthetic" ? readdirSync(SYNTHETIC).filter((f) => f.endsWith(".jsonl")).sort().map((f) => join(SYNTHETIC, f)) : [join(HOME, ...(set.includes("/") ? [] : ["real-mail"]), `${set}.jsonl`)];
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

/** Plan 279: what a short reply adds, by kind and language; the since is judged against these. */
const TAILS = {
  courtesy: { en: ["Thanks, got it.", "Great, thank you!", "Will do.", "Perfect, thanks for the update."], es: ["Gracias, recibido.", "¡Perfecto, gracias!", "De acuerdo, lo hago.", "Genial, gracias por avisar."] },
  material: { en: ["Change of plan: let's do Thursday 14 May instead, same time.", "Approved. Go ahead with the second option.", "Sorry, we have to cancel this. I'll explain later.", "The price is now 1,450 instead, final offer."], es: ["Cambio de planes: mejor el jueves 14 de mayo, a la misma hora.", "Aprobado. Adelante con la segunda opción.", "Lo siento, tenemos que cancelarlo. Luego te explico.", "El precio ahora es 1.450, última oferta."] },
} as const;

/** A short reply from the last person who wrote, on the conversation's today: its only new message. */
function withTail(c: Conversation, kind: keyof typeof TAILS): Conversation {
  const last = [...c.messages].reverse().find((m) => !m.own) ?? c.messages[c.messages.length - 1]!;
  const pool = TAILS[kind][c.language === "es" ? "es" : "en"];
  let h = 0;
  for (const ch of c.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { ...c, messages: [...c.messages, { from: last.own ? c.messages.find((m) => !m.own)?.from ?? last.from : last.from, date: c.today, own: false, to: [c.reader.email], text: pool[h % pool.length]! }] };
}

/** Plan 279: where the new run starts, by index: after the reader's last reply, or the last message alone (null: none) */
function newFrom(c: Conversation, tail: boolean): number | null {
  const n = c.messages.length;
  if (n < 2) return null;
  if (!tail && c.messages.some((m) => m.read !== undefined)) {
    let anchor = n - 1;
    while (anchor >= 0 && !c.messages[anchor]!.own && c.messages[anchor]!.read === false) anchor--;
    return anchor >= 0 && anchor < n - 1 && c.messages.slice(0, anchor + 1).some((m) => !m.own) ? anchor + 1 : null;
  }
  const lastOwn = c.messages.map((m) => m.own).lastIndexOf(true);
  const from = tail ? n - 1 : lastOwn === n - 1 ? null : lastOwn >= 0 ? lastOwn + 1 : n - 1;
  // as production: something of someone else's comes before it (Fable review, round 2)
  return from !== null && c.messages.slice(0, from).some((m) => !m.own) ? from : null;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Plan 279 (Fable 6): what's put to the reader by name, and their own promises, listed after the mail with the message
 * each is in, so a line buried in a long message isn't lost. Labels as sent.
 */
function aboutYou(c: Conversation, sent: readonly ThreadText[]): string {
  const first = c.reader.name.split(/\s+/)[0] ?? "";
  const offset = c.messages.length - sent.length;
  const named = new RegExp(`^\\s*${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b\\s*[,:—-]`, "i");
  const promise = /\b(I'll|I will|I can|I shall|I'm going to|I am going to|Yo (?:te |le |les )?(?:mando|llevo|envío|paso)|Te (?:mando|paso|envío))\b/i;
  const out: string[] = [];
  c.messages.forEach((m, i) => {
    if (i < offset) return;
    const label = sent[i - offset]!.label;
    for (const raw of withoutQuotes(m.text).split(/\n+/)) {
      const line = raw.trim();
      if (!line) continue;
      if (!m.own && first && named.test(line)) out.push(`- ${label}, put to you: "${line.slice(0, 240)}"`);
      if (m.own) for (const sentence of line.split(/(?<=[.!?])\s+/)) if (promise.test(sentence)) out.push(`- ${label}, your own words: "${sentence.slice(0, 240)}"`);
    }
  });
  return out.length ? `<about_you>\nLines put to you by name, and your own promises, as found in the mail (the mail decides):\n${out.join("\n")}\n</about_you>` : "";
}

/** Plan 279 (Fable, round 2): the card's schema with the rows first. */
const rowsFirstWire = (since: boolean) => {
  const row = z.object({ kind: z.enum(["decision", "date", "action", "question", "waiting"]), text: z.string(), message: z.string(), due: z.string().nullable(), byReply: z.boolean() });
  return since ? z.object({ items: z.array(row), summary: z.string(), since: z.string() }) : z.object({ items: z.array(row), summary: z.string() });
};

/** The app's caps on a card's rows, in order: six asks, six dates or decisions, two waiting. */
function capped<T extends { kind: string }>(rows: readonly T[]): T[] {
  const left: Record<string, number> = { ask: 6, date: 6, waiting: 2 };
  return rows.filter((r) => left[group(r.kind)]!-- > 0);
}

/** Plan 279 (Fable 5, Astra 2): the rows alone, from the raw thread, in a call of their own. */
const rowWire = z.object({ items: z.array(z.preprocess((v: unknown) => (v && typeof v === "object" ? { due: null, byReply: true, ...(v as object) } : v), z.object({ kind: z.enum(["decision", "date", "action", "question", "waiting"]), text: z.string(), message: z.string(), due: z.string().nullable(), byReply: z.boolean() }))) });
async function rowsOnly(transport: ModelTransport, request: Parameters<typeof summarizeTask>[0]) {
  const task = summarizeTask(request);
  const labels = new Set(request.thread.map((t) => t.label));
  const rows = await runStructured(transport, {
    system: `${promptText(task.system)}\n\n<this_answer>\nThis answer returns only "items": the reader's complete checklist. Go through the messages in order and include every to-do and question put to the reader, every promise of theirs still open, what is owed to them, and every deadline, payment, appointment or meeting they have to keep, applying the rules above. Leave out what's done, withdrawn or overtaken.\n</this_answer>`,
    prompt: task.prompt,
    schema: { name: "thread_rows", zod: rowWire },
    example: { items: [] },
    maxTokens: task.maxTokens,
    effort: task.effort,
    validate: (w) => ({ ok: true, value: capped(w.items.filter((i) => labels.has(i.message))).map((i) => ({ kind: i.kind, text: i.text.trim(), message: i.message, ...(i.due && /^\d{4}-\d{2}-\d{2}$/.test(i.due) ? { due: i.due } : {}), ...(i.kind === "action" && i.byReply === false ? { byReply: false } : {}) })) }),
  }, { output: "json_schema", signal: new AbortController().signal });
  return rows;
}

/**
 * Plan 279 (Astra, round 2, idea 2): the rows from a disposition of every message: each request, choice, promise or
 * thing owed in it, quoted, with its owner and status, before any row is written; code keeps the reader's open ones.
 */
const ROW = z.object({ kind: z.enum(["decision", "date", "action", "question", "waiting"]), text: z.string(), due: z.string().nullable(), byReply: z.boolean() });
const ledgerWire = z.object({
  messages: z.array(z.object({
    id: z.string(),
    found: z.array(z.object({
      quote: z.string(),
      owner: z.enum(["reader", "someone else", "unclear"]),
      status: z.enum(["open", "done", "withdrawn", "overtaken"]),
      row: ROW.nullable(),
    })),
  })),
});
const CAPS = { ask: 6, date: 6, waiting: 2 } as const;
const wordSet = (t: string) => new Set(t.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []);
const alikeWords = (a: string, b: string) => {
  const x = wordSet(a), y = wordSet(b);
  const shared = [...x].filter((w) => y.has(w)).length;
  // "Send the contract to Ana" and "… to Kit" are two: a name or a figure that differs keeps them apart
  const marked = (t: string) => new Set(t.match(/\p{Lu}[\p{L}']*|\d[\d.,:]*/gu) ?? []);
  const mx = marked(a), my = marked(b);
  const sameMarks = [...mx].every((w) => my.has(w) || x.has(w.toLowerCase()) && !/\d/.test(w)) && [...my].every((w) => mx.has(w) || y.has(w.toLowerCase()) && !/\d/.test(w));
  return sameMarks && shared / Math.max(1, new Set([...x, ...y]).size) >= 0.6;
};
const group = (k: string) => (k === "action" || k === "question" ? "ask" : k === "waiting" ? "waiting" : "date");
async function rowsLedger(transport: ModelTransport, request: Parameters<typeof summarizeTask>[0]) {
  const task = summarizeTask(request);
  const labels = new Set(request.thread.map((t) => t.label));
  return runStructured(transport, {
    system: `${promptText(task.system)}\n\n<this_answer>\nThis answer is a ledger, not the card. Go through every message in order. In "messages", give each message's id and in "found" everything in it that asks, offers, promises, sets a date, a payment or an appointment, or is owed: quote the operative words; say whose it is (the reader's by the rules above, someone else's, or unclear); and its status after the last message (open, done, withdrawn or overtaken by a later message). "found" is [] when a message has none. For the reader's open ones, "row" is the card's row for it (kind, text, due, byReply, as the card's rules say); otherwise null.\n</this_answer>`,
    prompt: task.prompt,
    schema: { name: "thread_ledger", zod: ledgerWire },
    example: { messages: [] },
    maxTokens: task.maxTokens,
    effort: task.effort,
    validate: (w) => {
      const used = { ask: 0, date: 0, waiting: 0 };
      const rows = [];
      for (const m of w.messages) {
        if (!labels.has(m.id)) continue;
        for (const f of m.found) {
          if (f.owner !== "reader" || f.status !== "open" || !f.row) continue;
          const g = group(f.row.kind);
          // the same obligation named again in a later message: the later one stands
          const twin = rows.findIndex((r) => group(r.kind) === g && (r.due ?? null) === (f.row!.due ?? null) && alikeWords(r.text, f.row!.text));
          if (twin >= 0) rows.splice(twin, 1);
          else if (used[g] >= CAPS[g]) continue;
          else used[g]++;
          rows.push({ kind: f.row.kind, text: f.row.text.trim(), message: m.id, ...(f.row.due && /^\d{4}-\d{2}-\d{2}$/.test(f.row.due) ? { due: f.row.due } : {}), ...(f.row.kind === "action" && f.row.byReply === false ? { byReply: false } : {}) });
        }
      }
      return { ok: true, value: rows };
    },
  }, { output: "json_schema", signal: new AbortController().signal });
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
    const tail = process.env.TERNO_AI_SUMMARY_TAIL ? readFileSync(process.env.TERNO_AI_SUMMARY_TAIL, "utf8").trim() : "";
    // plan 279's two passes: each card's first-pass notes, by the exact prompt they belong to
    const notesSystem = process.env.TERNO_AI_SUMMARY_NOTES ? readFileSync(process.env.TERNO_AI_SUMMARY_NOTES, "utf8").trim() : null;
    const notesFor = new Map<string, string>();
    /** plan 279's annotation: what's appended after the mail, by the exact prompt it belongs to */
    const extraFor = new Map<string, string>();
    /** plan 279's routing: the output tokens of each call made for a card, by the card's prompt */
    const tokensFor = new Map<string, number[]>();
    const transport = {
      ...budgeted,
      complete: (req: Parameters<typeof budgeted.complete>[0], ...rest: unknown[]) => {
        let system = promptText(req.system);
        const whole = process.env.TERNO_AI_SUMMARY_SYSTEM ? readFileSync(process.env.TERNO_AI_SUMMARY_SYSTEM, "utf8") : null;
        if (whole) {
          const asksSince = system.includes('- "since":') || system.includes("<since>");
          const today = /Today is (\d{4}-\d{2}-\d{2})/.exec(system)?.[1] ?? "";
          const language = /Write in (\w+)\./.exec(system)?.[1] ?? "English";
          // what a pass appends to the app's prompt (an audit, a verify, a rows call), which ends at </style>, stays after the variant
          const styleEnd = system.lastIndexOf("</style>");
          const appended = styleEnd < 0 ? "" : system.slice(styleEnd + "</style>".length).trim();
          system = whole.replace(/<<since>>([\s\S]*?)<<\/since>>/g, (_, kept: string) => (asksSince ? kept : "")).replaceAll("{{language}}", language).replaceAll("{{today}}", today).trim();
          if (appended) system = `${system}\n\n${appended}`;
        }
        for (const [find, replace] of swaps) {
          if (!system.includes(find)) throw new Error(`the variant's text isn't in the prompt: ${find.slice(0, 60)}`);
          system = system.replace(find, replace);
          swapped = true;
        }
        // plan 279 (Astra, round 2): the user turn's last instruction in place of the app's
        const last = process.env.TERNO_AI_SUMMARY_LAST ? readFileSync(process.env.TERNO_AI_SUMMARY_LAST, "utf8").trim() : null;
        const lastSwapped = !last ? req.messages : req.messages.map((m, i) => {
          if (i !== 0) return m;
          const text = promptText(m.content);
          const at = text.lastIndexOf("\n\nWrite the card for the reader above.");
          if (at < 0) throw new Error("the user turn's last instruction isn't where it was");
          const end = text.indexOf("\n", at + 2);
          return { ...m, content: `${text.slice(0, at)}\n\n${last}${end < 0 ? "" : text.slice(end)}` };
        });
        const withTail = tail ? lastSwapped.map((m, i) => (i === 0 ? { ...m, content: `${promptText(m.content)}\n\n${tail}` } : m)) : lastSwapped;
        const notes = notesFor.get(promptText(req.messages[0]!.content));
        const extra = extraFor.get(promptText(req.messages[0]!.content));
        const withNotes = notes ? withTail.map((m, i) => (i === 0 ? { ...m, content: `${promptText(m.content)}\n\n<notes>\nNotes from a first read of this mail (check them against the mail; the mail decides):\n${notes}\n</notes>` } : m)) : withTail;
        const messages = extra ? withNotes.map((m, i) => (i === 0 ? { ...m, content: `${promptText(m.content)}\n\n${extra}` } : m)) : withNotes;
        const asked = process.env.TERNO_AI_SUMMARY_EFFORT as typeof req.effort | "default" | undefined;
        // "default": what a model does with none asked, as OpenAI's did before plan 202
        const effort = asked === "default" ? undefined : (asked ?? req.effort);
        const reasoningEffort = asked === "default" ? undefined : (asked ?? req.reasoningEffort);
        const verbosity = process.env.TERNO_AI_SUMMARY_VERBOSITY as CompletionRequest["verbosity"] | undefined;
        // plan 279 (Fable, round 2): the rows before the summary in the schema sent; the answer is parsed as before
        const rowsFirst = process.env.TERNO_AI_SUMMARY_ROWS_FIRST === "1" && req.schema?.name === "thread_summary";
        const hasSince = rowsFirst && "since" in ((z.toJSONSchema(req.schema!.zod, { io: "input" }) as { properties?: object }).properties ?? {});
        const schema = rowsFirst ? { name: "thread_summary", zod: rowsFirstWire(hasSince) } : req.schema;
        const done = (budgeted.complete as (...a: unknown[]) => ReturnType<typeof budgeted.complete>)({ ...req, system, messages, effort, reasoningEffort, ...(schema ? { schema } : {}), ...(verbosity ? { verbosity } : {}) }, ...rest);
        // plan 279's routing: the tokens each card's calls wrote (a reasoning model's thinking counts), by the card's prompt
        const key = promptText(req.messages[0]!.content);
        return done.then((r) => {
          const u = r.usage;
          if (u) tokensFor.set(key, [...(tokensFor.get(key) ?? []), u.outputTokens]);
          return r;
        });
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
          const tailKind = process.env.TERNO_AI_SUMMARY_TAIL_MAIL as keyof typeof TAILS | undefined;
          const conv = tailKind ? withTail(c, tailKind) : c;
          const from = process.env.TERNO_AI_SUMMARY_SINCE === "1" || tailKind ? newFrom(conv, !!tailKind) : null;
          // the same labels thread() gives: what was sent of each message, newest last
          const sent = thread(conv);
          const offset = conv.messages.length - sent.length;
          // as production does (Codex code review 12): a since only when its first message and one before it are sent
          const asked = from !== null && from > offset;
          const marked = !asked ? sent : sent.map((t, i) => (i + offset >= from ? { ...t, isNew: true } : t));
          const annotate = process.env.TERNO_AI_SUMMARY_ANNOTATE === "1";
          const input = annotate ? marked.map((t) => ({ ...t, date: `${t.date} ${WEEKDAYS[new Date(`${t.date}T12:00:00Z`).getUTCDay()]}` })) : marked;
          const started = Date.now();
          try {
            const request = { subject: conv.subject, thread: input, reader: conv.reader, language: readerLanguage(conv), today: conv.today, outputTokens: summaryBudget(null, asked).outputTokens };
            if (notesSystem) {
              const prompt = summaryPrompt({ subject: request.subject, thread: request.thread, reader: request.reader });
              const first = await budgeted.complete({ system: notesSystem.replaceAll("{{today}}", request.today), messages: [{ role: "user", content: prompt }], output: "text", maxTokens: 4000, signal: new AbortController().signal });
              notesFor.set(prompt, promptText(first.text).trim());
            }
            if (annotate) {
              const lines = aboutYou(conv, marked);
              if (lines) extraFor.set(summaryPrompt({ subject: request.subject, thread: request.thread, reader: request.reader }), lines);
            }
            const k = Number(process.env.TERNO_AI_SUMMARY_SAMPLES ?? "1");
            const rowsCall = process.env.TERNO_AI_SUMMARY_ROWS_CALL === "1" ? rowsOnly(transport as ModelTransport, request) : process.env.TERNO_AI_SUMMARY_ROWS_CALL === "ledger" ? rowsLedger(transport as ModelTransport, request) : null;
            const answers = await Promise.all(Array.from({ length: k }, () => ai.summarize(request)));
            let r = answers[0]!;
            const samples = k > 1 ? answers.map((a) => ({ summary: a.summary, items: a.items, since: a.since ?? "" })) : undefined;
            let itemsA: typeof r.items | undefined;
            if (rowsCall) {
              itemsA = r.items;
              r = { ...r, items: await rowsCall };
            }
            if (process.env.TERNO_AI_SUMMARY_VERIFY === "1") {
              const task = summarizeTask(request);
              r = await runStructured(transport as ModelTransport, {
                ...task,
                system: `${promptText(task.system)}\n\nA first draft of the answer is in <draft>. Check every statement in it against the messages, one by one: who said it, what they said, how sure they were, what's still open after the last message, and each name, date and amount. Remove or correct anything the messages don't support. Add only what the rules above require. Return the corrected answer in the same format, or the draft unchanged if it holds.`,
                prompt: `${task.prompt}\n\n<draft>${JSON.stringify(r)}</draft>`,
              }, { output: "json_schema", signal: new AbortController().signal });
            }
            let draft: typeof r | undefined;
            if (process.env.TERNO_AI_SUMMARY_AUDIT) {
              const task = summarizeTask(request);
              draft = r;
              const shown = { summary: r.summary, items: r.items, ...(asked ? { since: r.since ?? "" } : {}) };
              r = await runStructured(transport as ModelTransport, {
                ...task,
                system: `${promptText(task.system)}\n\n${readFileSync(process.env.TERNO_AI_SUMMARY_AUDIT, "utf8").trim()}`,
                prompt: `${task.prompt}\n\n<draft>${JSON.stringify(shown)}</draft>`,
              }, { output: "json_schema", signal: new AbortController().signal });
            }
            const newLabels = input.filter((t) => t.isNew).map((t) => t.label);
            const tokens = tokensFor.get(summaryPrompt({ subject: request.subject, thread: request.thread, reader: request.reader }));
            appendFileSync(path, `${JSON.stringify({ id: c.id, set: c.set, language: readerLanguage(c), ms: Date.now() - started, ...(tokens ? { tokens } : {}), summary: r.summary, items: r.items, ...(itemsA ? { itemsA } : {}), ...(draft ? { draft: { summary: draft.summary, items: draft.items, since: draft.since ?? "" } } : {}), ...(samples ? { samples } : {}), ...(asked ? { newLabels, since: r.since ?? "" } : {}), ...(tailKind ? { tail: conv.messages.at(-1)!.text } : {}) })}\n`);
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
