import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatedKind } from "@terno/core";
import { describe, expect, it } from "vitest";
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
 * text, the currency as written, and every dated thing its own item. Under the harness's hard cap; needs the owner's go-ahead: run
 * alone with TERNO_AI_DATED=1. TERNO_AI_DATED_MODEL picks the model (GPT Luna by default; a `claude-` model runs on
 * Anthropic), TERNO_AI_DATED_LANGUAGE the app's language (en by default).
 *
 * Precision outranks recall (the shipping bar: no wrong row in the view), and no settlement may be wrong: a wrong one
 * takes away what the user still has to do.
 */
type Accept<T> = T | T[];
/** `time`: what it must be (null: none); `text`: patterns its words must each match, in either language (prompt v5) */
interface Expected { kind: Accept<DatedKind>; due: Accept<string | null>; time?: string | null; text?: string[] }
interface Case {
  id: string;
  reader: { name: string; email: string };
  language: string;
  tags: string[];
  subject: string;
  messages: { from: string; text: string; to?: string[]; cc?: string[] }[];
  dated: { receivedAt: string; automated: boolean; open: { label: string; kind: DatedKind | "promise"; text: string; due?: string | null; time?: string | null }[]; items: Expected[]; also: Expected[]; settled: string[]; moved?: { label: string; due: string; time?: string }[]; mayMove?: { label: string; due: string; time?: string | null }[] };
}

/** TERNO_AI_DATED_CASES: only these ids (comma-separated), to look at a few again */
const ONLY = process.env.TERNO_AI_DATED_CASES?.split(",").filter(Boolean);
const CASES: Case[] = readFileSync(join(import.meta.dirname, "corpus", "dated", "dated.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Case).filter((c) => !ONLY || ONLY.includes(c.id));
const MODEL = process.env.TERNO_AI_DATED_MODEL ?? "gpt-6-luna";
const TARGET: RealTarget = { provider: MODEL.startsWith("claude-") ? "anthropic" : "openai", model: MODEL };
const LANGUAGE = process.env.TERNO_AI_DATED_LANGUAGE ?? "en";
/** An alert's line as the app shows it (datedText in apps/web/src/lib/dated.ts), in the app's language */
const appLine = (text: string) => (LANGUAGE === "es" ? es : en)["dated.alertSays"].replace("{text}", text);

const accepts = <T>(a: Accept<T>, value: T) => (Array.isArray(a) ? a.includes(value) : a === value);
const matches = (e: Expected, got: { kind: DatedKind; due: string | null; time: string | null }) => accepts(e.kind, got.kind) && accepts(e.due, got.due) && (e.time === undefined || e.time === got.time);
const nameOf = (from: string) => /^(.*?)\s*<[^>]+>\s*$/.exec(from)?.[1] ?? from;

describe.skipIf(process.env.TERNO_AI_DATED !== "1")("dated items on a small model", () => {
  it("finds what has a date, leaves out what doesn't, quotes the mail, and settles only on the mail's words", async () => {
    const tasks = realTasks(TARGET, "dated-eval");
    let expected = 0, found = 0, wrongItems = 0, invented = 0, wrongSettled = 0, missedSettled = 0, rightTimes = 0, times = 0, wrongMoved = 0, missedMoved = 0, unsafe = 0, wrongText = 0, unattributed = 0, selfAttributed = 0, madeUpDetail = 0;
    const lines: string[] = [];
    for (const c of CASES) {
      const mail = c.messages.at(-1)!;
      const addressedTo = (list: readonly string[]) => list.some((r) => r.includes(c.reader.email));
      const to = (mail.to ?? []) as string[];
      const cc = (mail.cc ?? []) as string[];
      const reader = { name: c.reader.name, addressed: addressedTo(to) ? ("to" as const) : addressedTo(cc) ? ("cc" as const) : ("none" as const) };
      const r = await tasks.readDates({ text: mail.text, subject: c.subject, from: { name: nameOf(mail.from), automated: c.dated.automated }, reader, to: to.map(nameOf), cc: cc.map(nameOf), receivedAt: c.dated.receivedAt, open: c.dated.open, language: LANGUAGE });
      const left = [...r.items];
      const problems: string[] = [];
      for (const e of c.dated.items) {
        expected++;
        // a time picks among two of a kind on one day (prompt v5); then any of the kind and day
        const timed = e.time !== undefined ? left.findIndex((got) => matches(e, got)) : -1;
        const at = timed >= 0 ? timed : left.findIndex((got) => matches({ ...e, time: undefined }, got));
        if (at < 0) {
          problems.push(`missed ${JSON.stringify(e)}`);
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
        left.splice(at, 1);
      }
      for (const got of left) {
        if (c.dated.also.some((e) => matches(e, got))) continue;
        wrongItems++;
        problems.push(`wrong ${got.kind} ${got.due} "${got.text}", quoting "${got.quote}"`);
      }
      for (const got of r.items) {
        // as the app's own check reads a quote (checkDates): the words, whatever punctuation joins them
        const words = (t: string) => normalizeText(t).toLowerCase().replace(/[^\p{L}\p{N}$€£%]+/gu, " ").trim();
        if (!words(mail.text).includes(words(got.quote))) {
          invented++;
          problems.push(`quote not in the mail: "${got.quote}"`);
        }
      }
      const settled = new Set(r.settled.map((s) => s.label));
      for (const s of settled) {
        if (c.dated.settled.includes(s)) continue;
        wrongSettled++;
        problems.push(`settled ${s}`);
      }
      for (const s of c.dated.settled) {
        if (settled.has(s)) continue;
        missedSettled++;
        problems.push(`didn't settle ${s}`);
      }
      // prompt v3: a later message's new day for an open item, never a new item
      const want = c.dated.moved ?? [];
      for (const m of r.moved ?? []) {
        const w = want.find((x) => x.label === m.label);
        if (w && w.due === m.due && (w.time === undefined || w.time === m.time)) continue;
        if ((c.dated.mayMove ?? []).some((x) => x.label === m.label && x.due === m.due && (x.time === undefined || x.time === m.time))) continue;
        wrongMoved++;
        problems.push(`moved ${m.label} to ${m.due} ${m.time ?? ""}`);
      }
      for (const w of want) {
        if ((r.moved ?? []).some((m) => m.label === w.label)) continue;
        missedMoved++;
        problems.push(`didn't move ${w.label}`);
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
      lines.push(`${problems.length ? "✗" : "✓"} ${c.id} [${c.tags.join(",")}] ${r.items.map((i) => `${i.kind} ${i.due}${i.time ? ` ${i.time}` : ""} "${i.text}"`).join("; ") || "nothing"}${r.moved?.length ? ` · moved ${r.moved.map((m) => `${m.label} ${m.due}${m.time ? ` ${m.time}` : ""}`).join(", ")}` : ""}${problems.length ? `\n    ${problems.join("\n    ")}` : ""}`);
    }
    process.stderr.write(`${lines.join("\n")}\n${JSON.stringify({ model: MODEL, language: LANGUAGE, found, expected, wrongItems, invented, rightTimes, times, wrongSettled, missedSettled, wrongMoved, missedMoved, unsafe, wrongText, unattributed, selfAttributed, madeUpDetail })}\n${spendReport()}\n`);
    expect(wrongItems).toBeLessThanOrEqual(1);
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
  }, 900_000);
});
