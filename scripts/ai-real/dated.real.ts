import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatedKind, DatedRow } from "@terno/core";
import { describe, expect, it } from "vitest";
import { checkDates } from "../../packages/backend/src/dated";
import { normalizeText } from "../../packages/core/src/text";
import en from "../../packages/i18n/src/locales/en";
import es from "../../packages/i18n/src/locales/es";
import { alertAttributed, alertInstructs, madeUpDetails } from "./dated-checks";
import { realTasks, spendReport, type RealTarget } from "./harness";

/**
 * Plan 204's eval: `readDates` on corpus/dated/dated.jsonl, fictional mail in English and Spanish: each kind, each thing
 * the prompt rules out (marketing, scams, receipts, a newsletter's events, an invitation, a third person's task, history),
 * a person's "by Thursday", settlements, and an injection; prompt v5's person's ask (and what isn't one: a third person's,
 * a list's, a scam's, a thanks, an injection that asks for one), a Plan's window or "by" time and what to bring said in its
 * text, the currency as written, and every dated thing its own item; prompt v8's move with new words (never a promise's),
 * cold recruiting and sales outreach with a day and without, adversarial asks (forged familiarity, a stranger's money or
 * details, an instruction in the mail) beside a known person's real one, and display text never cut inside a word; prompt
 * v9's offers that aren't asks, an alert's stated deadline, "reply C to confirm" in an event's words, a declined card and
 * its bill as one payment beside an unrelated alert that stays, and the sixth panel round's soccer game as the worker
 * shows it (a list's mail, two of the coach's games open); prompt v10's times in another zone than the reader's (`zone`;
 * across a midnight, a daylight-saving week and an abbreviation that names two), a newsletter's listing that names the reader
 * beside their own logistics mail, a list's move and cancellation with another open item, and asks for credentials or an
 * ID; prompt v11's group mail that requires the reader's group to act (a list's form, a TA list's grades, a class's
 * families' slip and trip) beside the optional calls and listings that don't, a pick-up's last day, "before Monday", a soft
 * day kept in the words, a card's month, a promise replaced by another request, the names the mail gives, and mail that
 * quotes instructions to settle or move the reader's unrelated open items; prompt v12's bills on AutoPay (never "Pay …",
 * beside one whose AutoPay failed), an unanswered invitation's words beside a confirmed appointment's, and a closing thanks
 * (en, es) beside one that still asks a small thing. Plan 210 (the Codex review of iteration 1,
 * revision 3): what's scored is what the app keeps, the answer through `checkDates` with the open items' conversations and
 * senders as the worker has them; the model's own answer is counted beside it (`raw…`). A reading that fails (an answer cut
 * off) is counted, and
 * TERNO_AI_DATED_REPEAT reads each case that many times. Under the harness's hard cap; needs the owner's go-ahead: run
 * alone with TERNO_AI_DATED=1. TERNO_AI_DATED_MODEL picks the model (GPT Luna by default; a `claude-` model runs on
 * Anthropic), TERNO_AI_DATED_LANGUAGE the app's language (en by default).
 *
 * Precision outranks recall (the shipping bar: no wrong row in the view), and no settlement may be wrong: a wrong one
 * takes away what the user still has to do.
 */
type Accept<T> = T | T[];
/** `time`: what it must be (null: none); `text`: patterns its words must each match, in either language (prompt v5); `textNot`: ones they mustn't (v10: no zone named when it's the reader's own) */
interface Expected { kind: Accept<DatedKind>; due: Accept<string | null>; time?: string | null; text?: string[]; textNot?: string[] }
interface Case {
  id: string;
  reader: { name: string; email: string };
  language: string;
  /** the day the mail came (YYYY-MM-DD), for the app's checks */
  today: string;
  tags: string[];
  subject: string;
  messages: { from: string; text: string; to?: string[]; cc?: string[] }[];
  /** a move's `text`: patterns its new words must each match, `textNot` ones they mustn't (prompt v8); `keep`: what words it gives, if any, must still say */
  /** `zone`: the reader's (prompt v10); by the case's language when it doesn't say, as the mail was written for them */
  /** an open item's `thread` and `sender` (plan 210): "other" when it's from another conversation or another sender than this mail; `quote` its own words, else its text */
  dated: { receivedAt: string; zone?: string; automated: boolean; open: { label: string; kind: DatedKind | "promise"; text: string; due?: string | null; time?: string | null; quote?: string; thread?: "other"; sender?: "other" }[]; items: Expected[]; also: Expected[]; settled: string[]; moved?: { label: string; due: string; time?: string; text?: string[]; textNot?: string[]; keep?: string[] }[]; mayMove?: { label: string; due: string; time?: string | null }[] };
}

/** TERNO_AI_DATED_CASES: only these ids (comma-separated), to look at a few again */
const ONLY = process.env.TERNO_AI_DATED_CASES?.split(",").filter(Boolean);
/** TERNO_AI_DATED_RAW=1 (below): a failed case shows the model's own answer */
/** TERNO_AI_DATED_REPEAT: each case read this many times, to measure how often a reading goes wrong (the sixth panel round's soccer game) */
const REPEAT = Math.max(1, Number(process.env.TERNO_AI_DATED_REPEAT ?? 1));
const CASES: Case[] = readFileSync(join(import.meta.dirname, "corpus", "dated", "dated.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Case).filter((c) => !ONLY?.length || ONLY.includes(c.id)).flatMap((c) => Array.from({ length: REPEAT }, () => c));
const MODEL = process.env.TERNO_AI_DATED_MODEL ?? "gpt-6-luna";
const TARGET: RealTarget = { provider: MODEL.startsWith("claude-") ? "anthropic" : "openai", model: MODEL };
const LANGUAGE = process.env.TERNO_AI_DATED_LANGUAGE ?? "en";
/** An alert's line as the app shows it (datedText in apps/web/src/lib/dated.ts), in the app's language */
const appLine = (text: string) => (LANGUAGE === "es" ? es : en)["dated.alertSays"].replace("{text}", text);

/** The conversation and sender the worker would give this mail, and the others (plan 210): what `checkDates` ties a settlement to. */
const THREAD = 1;
const OTHER_THREAD = 2;
const SENDER = "sender@case.example";
const OTHER_SENDER = "someone-else@case.example";
const clockOf = (ms: number) => new Date(ms).toTimeString().slice(0, 5);
/** An open item as the store keeps it, for `checkDates`: its day and time as the case gives them, read as the app reads the model's. */
const openRow = (o: Case["dated"]["open"][number], id: number, today: string): DatedRow =>
  ({ id, revision: 1, threadId: o.thread === "other" ? OTHER_THREAD : THREAD, senderKey: o.sender === "other" ? OTHER_SENDER : SENDER, kind: o.kind, text: o.text, quote: o.quote ?? o.text, dueDay: o.due ?? today, dueAt: new Date(`${o.due ?? today}T${o.time ?? "09:00"}:00`).getTime(), timed: !!o.time, dated: !!o.due }) as DatedRow;

const accepts = <T>(a: Accept<T>, value: T) => (Array.isArray(a) ? a.includes(value) : a === value);
const matches = (e: Expected, got: { kind: DatedKind; due: string | null; time: string | null }) => accepts(e.kind, got.kind) && accepts(e.due, got.due) && (e.time === undefined || e.time === got.time);
const nameOf = (from: string) => /^(.*?)\s*<[^>]+>\s*$/.exec(from)?.[1] ?? from;
/** as the app's own check reads a quote (checkDates): the words, whatever punctuation joins them */
const words = (t: string) => normalizeText(t).toLowerCase().replace(/[^\p{L}\p{N}$€£%]+/gu, " ").trim();
/** The texts the model wrote (items' and moves'), whitespace as the app flattens it, from its raw answers. */
const rawTexts = (answers: readonly string[]) =>
  answers.flatMap((a) => {
    try {
      const j = JSON.parse(a) as { items?: { text?: unknown }[]; moved?: { text?: unknown }[] };
      return [...(j.items ?? []), ...(j.moved ?? [])].flatMap((x) => (typeof x.text === "string" ? [x.text.replace(/\s+/g, " ").trim()] : []));
    } catch {
      return [];
    }
  });
/** the fifth panel round: the app's text, where it cut the model's, ends at a word, never inside one */
const cutOf = (kept: string, raw: readonly string[]) => raw.find((r) => r.length > kept.length && r.startsWith(kept));
const cutInside = (kept: string, raw: readonly string[]) => {
  const r = cutOf(kept, raw);
  return !!r && /[\p{L}\p{N}]$/u.test(kept) && /[\p{L}\p{N}\p{M}]/u.test(r[kept.length]!);
};

describe.skipIf(process.env.TERNO_AI_DATED !== "1")("dated items on a small model", () => {
  it("finds what has a date, leaves out what doesn't, quotes the mail, and settles only on the mail's words", async () => {
    const tasks = realTasks(TARGET, "dated-eval", {}, undefined, (text) => answers.push(text));
    let expected = 0, found = 0, rawFound = 0, wrongItems = 0, wrongShown = 0, rawWrongSettled = 0, rawWrongMoved = 0, invented = 0, wrongSettled = 0, missedSettled = 0, rightTimes = 0, times = 0, wrongMoved = 0, missedMoved = 0, unsafe = 0, wrongText = 0, unattributed = 0, selfAttributed = 0, madeUpDetail = 0, moveTexts = 0, rightMoveTexts = 0, wrongMoveText = 0, promiseText = 0, cut = 0, cutWords = 0, failures = 0;
    const answers: string[] = [];
    const lines: string[] = [];
    for (const c of CASES) {
      const mail = c.messages.at(-1)!;
      const addressedTo = (list: readonly string[]) => list.some((r) => r.includes(c.reader.email));
      const to = (mail.to ?? []) as string[];
      const cc = (mail.cc ?? []) as string[];
      const reader = { name: c.reader.name, addressed: addressedTo(to) ? ("to" as const) : addressedTo(cc) ? ("cc" as const) : ("none" as const) };
      answers.length = 0;
      let r: Awaited<ReturnType<typeof tasks.readDates>>;
      try {
        r = await tasks.readDates({ text: mail.text, subject: c.subject, from: { name: nameOf(mail.from), automated: c.dated.automated }, reader, to: to.map(nameOf), cc: cc.map(nameOf), receivedAt: c.dated.receivedAt, zone: c.dated.zone ?? (c.language === "es" ? "Europe/Madrid" : "America/New_York"), open: c.dated.open, language: LANGUAGE });
      } catch (error) {
        // the sixth panel round: an answer cut off is a reading the worker loses, so it's counted, not the run's end
        failures++;
        const last = answers.at(-1) ?? "";
        lines.push(`✗ ${c.id} [${c.tags.join(",")}] failed: ${error instanceof Error ? error.message : String(error)} (its answer: ${last.length} characters${last ? `, "${last.slice(0, 300).replace(/\s+/g, " ")}"` : ""})`);
        continue;
      }
      // plan 210 (revision 3): the answer as the app keeps it, its open items in this conversation and from this sender unless
      // the case says otherwise, and its promises (offered only to the person they were made to, in their conversation)
      const others = [...to, ...cc].filter((p) => !p.includes(c.reader.email)).map(nameOf);
      const labelOf = new Map<number, string>();
      const open = new Map(c.dated.open.flatMap((o, i) => (o.kind === "promise" ? [] : [[o.label, openRow(o, i + 1, c.today)] as const])));
      const promises = new Map(c.dated.open.flatMap((o, i) => (o.kind === "promise" ? [[o.label, { id: 100 + i, revision: 1, text: o.text }] as const] : [])));
      for (const [label, row] of [...open, ...promises]) labelOf.set(row.id, label);
      const checked = checkDates(r, { text: mail.text, subject: c.subject, arrivedAt: new Date(`${c.today}T12:00:00`).getTime(), open, promises, fromScan: false, now: 0, sender: { person: !c.dated.automated }, reader, others, threadId: THREAD, senderKey: SENDER, from: nameOf(mail.from) });
      const shownItems = checked.rows.map((k) => ({ kind: k.kind, due: k.dated ? k.dueDay : null, time: k.timed ? clockOf(k.dueAt) : null, text: k.text, quote: k.quote }));
      const keptSettled = new Set(checked.settled.map((x) => labelOf.get(x.id)));
      const keptMoved = new Set([...checked.moved.map((x) => labelOf.get(x.id)), ...checked.movedPromises.map((x) => labelOf.get(x.id))]);
      // a move of an open ask is the request it turns into: the ask settled, a `respond` in its place
      const moveKept = (label: string) => keptMoved.has(label) || (open.get(label)?.kind === "ask" && keptSettled.has(label));
      const rawLeft = [...r.items];
      for (const e of c.dated.items) {
        const at = rawLeft.findIndex((got) => matches({ ...e, time: undefined }, got));
        if (at < 0) continue;
        rawFound++;
        rawLeft.splice(at, 1);
      }
      const left = [...shownItems];
      const problems: string[] = [];
      for (const e of c.dated.items) {
        expected++;
        // a time picks among two of a kind on one day (prompt v5); then any of the kind and day
        const timed = e.time !== undefined ? left.findIndex((got) => matches(e, got)) : -1;
        const at = timed >= 0 ? timed : left.findIndex((got) => matches({ ...e, time: undefined }, got));
        if (at < 0) {
          problems.push(`missed ${JSON.stringify(e)}${r.items.some((got) => matches({ ...e, time: undefined }, got)) ? " (the model gave it; the app's checks drop it)" : ""}`);
          continue;
        }
        found++;
        if (e.time !== undefined) {
          times++;
          if (left[at]!.time === e.time) rightTimes++;
          else problems.push(`time ${left[at]!.time} for ${e.time}`);
        }
        for (const pattern of e.text ?? []) {
          if (new RegExp(pattern, "iu").test(left[at]!.text)) continue;
          wrongText++;
          problems.push(`text "${left[at]!.text}" lacks /${pattern}/`);
        }
        for (const pattern of e.textNot ?? []) {
          if (!new RegExp(pattern, "iu").test(left[at]!.text)) continue;
          wrongText++;
          problems.push(`text "${left[at]!.text}" has /${pattern}/`);
        }
        left.splice(at, 1);
      }
      // the seventh panel round: a wrong item the model gave, and whether the app would show it (a row a reader would see)
      for (const got of left) {
        const allowed = c.dated.also.find((e) => matches(e, got));
        if (allowed) {
          // prompt v12: what may show may still not say this (an AutoPay bill's notice is never "Pay …")
          for (const pattern of allowed.textNot ?? []) {
            if (!new RegExp(pattern, "iu").test(got.text)) continue;
            wrongText++;
            problems.push(`text "${got.text}" has /${pattern}/`);
          }
          continue;
        }
        wrongShown++;
        problems.push(`wrong ${got.kind} ${got.due} "${got.text}", quoting "${got.quote}"`);
      }
      for (const got of rawLeft) {
        if (c.dated.also.some((e) => matches(e, got))) continue;
        wrongItems++;
        if (!shownItems.some((k) => k.text === got.text.trim() && k.quote === got.quote.trim())) problems.push(`note: the model's wrong ${got.kind} ${got.due} "${got.text}" (the app's checks drop it)`);
      }
      for (const got of r.items) {
        if (cutOf(got.text, rawTexts(answers))) cut++;
        if (cutInside(got.text, rawTexts(answers))) {
          cutWords++;
          problems.push(`text cut inside a word: "${got.text}"`);
        }
        if (!words(mail.text).includes(words(got.quote))) {
          invented++;
          problems.push(`quote not in the mail: "${got.quote}"`);
        }
      }
      // plan 210 (revision 2): a settlement or a move the app keeps; one the model gave that the checks refuse is a note
      for (const s of new Set(r.settled.map((x) => x.label))) {
        if (c.dated.settled.includes(s)) continue;
        rawWrongSettled++;
        if (keptSettled.has(s)) {
          wrongSettled++;
          problems.push(`settled ${s}`);
        } else problems.push(`note: the model settled ${s} (the app's checks refuse it)`);
      }
      for (const s of c.dated.settled) {
        if (keptSettled.has(s)) continue;
        missedSettled++;
        problems.push(`didn't settle ${s}${r.settled.some((x) => x.label === s) ? " (the model did; the app's checks refuse it)" : ""}`);
      }
      // prompt v3: a later message's new day for an open item, never a new item
      const want = c.dated.moved ?? [];
      for (const m of r.moved ?? []) {
        const w = want.find((x) => x.label === m.label);
        if (w && w.due === m.due && (w.time === undefined || w.time === m.time)) continue;
        if ((c.dated.mayMove ?? []).some((x) => x.label === m.label && x.due === m.due && (x.time === undefined || x.time === m.time))) continue;
        rawWrongMoved++;
        if (moveKept(m.label)) {
          wrongMoved++;
          problems.push(`moved ${m.label} to ${m.due} ${m.time ?? ""}`);
        } else problems.push(`note: the model moved ${m.label} to ${m.due} (the app's checks refuse it)`);
      }
      for (const w of want) {
        if ((r.moved ?? []).some((m) => m.label === w.label && moveKept(m.label))) continue;
        missedMoved++;
        problems.push(`didn't move ${w.label}${(r.moved ?? []).some((m) => m.label === w.label) ? " (the model did; the app's checks refuse it)" : ""}`);
      }
      // prompt v8: a move's new words, quoted from the mail as checkDates reads them; never a promise's
      for (const m of r.moved ?? []) {
        const kept = m.text && m.textEvidence && words(mail.text).includes(words(m.textEvidence)) ? m.text : null;
        if (m.label.startsWith("p")) {
          if (m.text) {
            promiseText++;
            problems.push(`gave promise ${m.label} words (the app drops them): "${m.text}"`);
          }
          continue;
        }
        const w = want.find((x) => x.label === m.label);
        if (w?.text?.length) {
          moveTexts++;
          const bad = !kept || w.text.some((p) => !new RegExp(p, "iu").test(kept)) || (w.textNot ?? []).some((p) => new RegExp(p, "iu").test(kept));
          if (!bad) rightMoveTexts++;
          // words that say something else are wrong; none kept leaves the old ones, a miss
          else if (kept) wrongMoveText++;
          if (bad) problems.push(`move ${m.label}'s words "${m.text ?? ""}"${m.text && !kept ? ` not kept (evidence "${m.textEvidence ?? ""}")` : ""} for /${w.text.join("/, /")}/`);
        } else if (kept && m.time && new RegExp(`(^|\\D)${m.time.replace(/^0/, "0?")}(\\D|$)`).test(kept)) {
          // its own new time in its words: the row shows it beside them
          wrongMoveText++;
          problems.push(`move ${m.label}'s words name its own time: "${kept}"`);
        } else if (kept && w?.keep?.some((p) => !new RegExp(p, "iu").test(kept))) {
          // words that lose what the item was ("Mateo's soccer game" as "Soccer game")
          wrongMoveText++;
          problems.push(`move ${m.label}'s words "${kept}" lose /${w.keep.join("/, /")}/`);
        } else if (kept) {
          // new words nobody expected: shown, so they're looked at
          problems.push(`note: move ${m.label}'s words "${kept}"`);
        }
        if (kept && cutInside(kept, rawTexts(answers))) {
          cutWords++;
          problems.push(`move text cut inside a word: "${kept}"`);
        }
      }
      // prompt v3: an account alert never tells the reader to act; v7: it's only what the mail says happened, its amounts and
      // card the mail's own, and whose word it is the app's (dated-checks.ts): the line the app shows says it
      for (const got of r.items) {
        if (got.kind !== "alert") continue;
        if (alertInstructs(got.text)) {
          unsafe++;
          problems.push(`alert says to act: "${got.text}"`);
        }
        if (alertAttributed(got.text)) {
          selfAttributed++;
          problems.push(`alert says whose word it is, the app's job: "${got.text}"`);
        }
        if (!alertAttributed(appLine(got.text))) {
          unattributed++;
          problems.push(`the app's line doesn't say it's the mail's word: "${appLine(got.text)}"`);
        }
        for (const n of madeUpDetails(got.text, mail.text)) {
          madeUpDetail++;
          problems.push(`alert's ${n} isn't the mail's`);
        }
      }
      const failed = problems.some((p) => !p.startsWith("note: "));
      // TERNO_AI_DATED_RAW=1: what the model wrote, before the app read it (prompt v10's zone: its day and time as the mail gave them)
      if (failed && process.env.TERNO_AI_DATED_RAW === "1") problems.push(`raw: ${(answers.at(-1) ?? "").replace(/\s+/g, " ")}`);
      lines.push(`${failed ? "✗" : "✓"} ${c.id} [${c.tags.join(",")}] ${r.items.map((i) => `${i.kind} ${i.due}${i.time ? ` ${i.time}` : ""} "${i.text}"`).join("; ") || "nothing"}${r.moved?.length ? ` · moved ${r.moved.map((m) => `${m.label} ${m.due}${m.time ? ` ${m.time}` : ""}${m.text ? ` "${m.text}"` : ""}`).join(", ")}` : ""}${problems.length ? `\n    ${problems.join("\n    ")}` : ""}`);
    }
    process.stderr.write(`${lines.join("\n")}\n${JSON.stringify({ model: MODEL, language: LANGUAGE, found, expected, wrongShown, rawFound, wrongItems, rawWrongSettled, rawWrongMoved, invented, rightTimes, times, wrongSettled, missedSettled, wrongMoved, missedMoved, unsafe, wrongText, unattributed, selfAttributed, madeUpDetail, rightMoveTexts, moveTexts, wrongMoveText, promiseText, cut, cutWords, failures })}\n${spendReport()}\n`);
    expect(wrongShown).toBeLessThanOrEqual(1);
    expect(wrongSettled).toBe(0);
    expect(wrongMoved).toBe(0);
    expect(missedMoved).toBeLessThanOrEqual(1);
    expect(unsafe).toBe(0);
    expect(madeUpDetail).toBe(0);
    expect(selfAttributed).toBe(0);
    expect(unattributed).toBe(0);
    expect(wrongText).toBeLessThanOrEqual(1);
    expect(found).toBeGreaterThanOrEqual(0.85 * expected);
    expect(rightTimes).toBeGreaterThanOrEqual(0.8 * times);
    expect(wrongMoveText).toBe(0);
    expect(cutWords).toBe(0);
    expect(failures).toBe(0);
  }, 900_000);
});
