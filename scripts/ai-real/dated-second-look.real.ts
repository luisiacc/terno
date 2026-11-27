import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { costAt, createAi, datedPrompt, type DatedInput, type DatedResult, type ModelTransport } from "@terno/ai";
import type { DatedKind, DatedRow } from "@terno/core";
import { describe, expect, it } from "vitest";
import { readDatesTask } from "../../packages/ai/src/dated";
import { checkDates } from "../../packages/backend/src/dated";
import { lookAt, secondLook } from "../../packages/backend/src/dated-second-look";
import { evalPriceOf, realTransport, spendReport, type RealTarget } from "./harness";

/**
 * Plan 210 (iteration 5, revision 3): the second look, measured and judged.
 *
 * - **Replay** (TERNO_AI_SECOND_LOOK_REPLAY=1, no network, no spend): the user panel's recorded first readings
 *   (`<panel>/db/<persona>/readings.jsonl`, TERNO_PANEL_DIR, default /tmp/terno-scratch/p204/panel) as the model, through the
 *   worker's own trigger (`lookAt`): how many of the panel's mails would get a second look, and what it would send
 *   (characters of the prompt, ~4 a token).
 * - **Eval** (TERNO_AI_SECOND_LOOK=1, real models, under the shared ledger): corpus/dated/second-look.jsonl, the panel's two
 *   dated sentences the first reading lost (Margaret's book club, Sam's spring registration, en and es) and traps a second
 *   look must leave out (a newsletter's two listed events, a person's sign-off, another person's room booking, a webinar
 *   listing), through `secondLook` and `checkDates` as the worker runs them. TERNO_AI_DATED_MODEL picks the model,
 *   TERNO_AI_DATED_REPEAT the readings per case (5).
 */

const PANEL = process.env.TERNO_PANEL_DIR ?? "/tmp/terno-scratch/p204/panel";
const RECEIVED = "You read one email a person received";

type Wire = Pick<DatedResult, "items" | "settled" | "moved" | "replaced">;
const between = (text: string, tag: string) => new RegExp(`<${tag}>\\n?([\\s\\S]*?)\\n?</${tag}>`).exec(text)?.[1] ?? "";

describe.skipIf(process.env.TERNO_AI_SECOND_LOOK_REPLAY !== "1")("the second look on the panel's recorded readings (offline)", () => {
  it("counts the mails it would ask about again, and what it would send", () => {
    const personas = readdirSync(join(PANEL, "db")).filter((p) => existsSync(join(PANEL, "db", p, "readings.jsonl")));
    let mails = 0, triggered = 0, sentences = 0, chars = 0, firstChars = 0;
    const lines: string[] = [];
    for (const persona of personas) {
      const box = JSON.parse(readFileSync(join(PANEL, "mail", `${persona}.json`), "utf8")) as { messages: { subject: string; date: string; text: string }[] };
      const seen = new Set<string>();
      for (const line of readFileSync(join(PANEL, "db", persona, "readings.jsonl"), "utf8").split("\n").filter(Boolean)) {
        const r = JSON.parse(line) as { task: string; input: string; output: string };
        if (!r.task.startsWith(RECEIVED) || seen.has(r.input)) continue;
        seen.add(r.input);
        let first: Wire;
        try {
          first = JSON.parse(r.output) as Wire;
        } catch {
          continue;
        }
        mails++;
        const subject = between(r.input, "subject").trim();
        const text = between(r.input, "mail");
        const mail = box.messages.find((m) => m.subject.trim() === subject && m.text.slice(0, 40) === text.slice(0, 40)) ?? box.messages.find((m) => m.subject.trim() === subject);
        const arrivedAt = mail ? new Date(mail.date).getTime() : new Date("2026-11-13T09:00:00").getTime();
        const shown = [...between(r.input, "open_items").matchAll(/^[op]\d+ \([a-z]+(?:, (\d{4}-\d{2}-\d{2}))?/gm)].map((m) => ({ due: m[1] ?? null }));
        const asked = lookAt({ text, subject, arrivedAt, automated: r.input.startsWith("Sent from an automated"), shown, first: { items: first.items ?? [], settled: first.settled ?? [], moved: first.moved ?? [], replaced: first.replaced ?? [] } });
        firstChars += r.input.length;
        if (!asked.length) continue;
        triggered++;
        sentences += asked.length;
        // what the look sends beyond the system prompt: the first reading's prompt again, with the sentences and their words
        const input = { text, subject, from: { name: between(r.input, "from"), automated: r.input.startsWith("Sent from an automated") }, reader: { name: "", addressed: "to" }, to: [], cc: [], receivedAt: "", zone: "UTC", open: [], language: "en" } satisfies DatedInput;
        chars += datedPrompt({ ...input, again: asked }).length - datedPrompt(input).length + r.input.length;
        lines.push(`${persona}: "${subject}" → ${asked.map((s) => `"${s}"`).join(" · ")}`);
      }
    }
    const system = readDatesTask({ text: "", subject: "", from: { name: "", automated: false }, reader: { name: "", addressed: "to" }, to: [], cc: [], receivedAt: "", zone: "UTC", open: [], language: "en" }).system.length;
    process.stderr.write(`${lines.join("\n")}\n${JSON.stringify({ mails, triggered, rate: +(triggered / Math.max(1, mails)).toFixed(3), sentences, systemChars: system, lookPromptChars: chars, firstPromptChars: firstChars, extraTokensApprox: Math.round((triggered * system + chars) / 4) })}\n`);
    expect(mails).toBeGreaterThan(0);
  });
});

type Accept<T> = T | T[];
interface Expected { kind: Accept<DatedKind>; due: Accept<string | null>; time?: string | null }
interface Case {
  id: string;
  reader: { name: string; email: string };
  language: string;
  today: string;
  tags: string[];
  subject: string;
  messages: { from: string; text: string; to?: string[]; cc?: string[] }[];
  /** `first`: the first reading as the panel recorded it (the item it lost), for the look to start from as it did there */
  dated: { receivedAt: string; zone?: string; automated: boolean; items: Expected[]; also: Expected[]; first?: DatedResult };
}

const REPEAT = Math.max(1, Number(process.env.TERNO_AI_DATED_REPEAT ?? 5));
/** TERNO_AI_SECOND_LOOK_MODES: "fresh", "recorded" or both (comma-separated; both by default) */
const MODES = new Set(process.env.TERNO_AI_SECOND_LOOK_MODES?.split(",").filter(Boolean) ?? ["fresh", "recorded"]);
const ONLY = process.env.TERNO_AI_DATED_CASES?.split(",").filter(Boolean);
const CASES: Case[] = existsSync(join(import.meta.dirname, "corpus", "dated", "second-look.jsonl"))
  ? readFileSync(join(import.meta.dirname, "corpus", "dated", "second-look.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Case).filter((c) => !ONLY?.length || ONLY.includes(c.id))
  : [];
const MODEL = process.env.TERNO_AI_DATED_MODEL ?? "gpt-6-luna";
const TARGET: RealTarget = { provider: MODEL.startsWith("claude-") ? "anthropic" : "openai", model: MODEL };
const accepts = <T>(a: Accept<T>, value: T) => (Array.isArray(a) ? a.includes(value) : a === value);
const matches = (e: Expected, got: { kind: DatedKind; due: string | null; time: string | null }) => accepts(e.kind, got.kind) && accepts(e.due, got.due) && (e.time === undefined || e.time === got.time);
const nameOf = (from: string) => /^(.*?)\s*<[^>]+>\s*$/.exec(from)?.[1] ?? from;
const clockOf = (ms: number) => new Date(ms).toTimeString().slice(0, 5);

describe.skipIf(process.env.TERNO_AI_SECOND_LOOK !== "1")("the second look on a small model", () => {
  it("recovers the panel's lost dated sentences and leaves the traps out", async () => {
    const answers: string[] = [];
    // tokens as the provider counted them, by phase: the shared ledger's total moves with other runs too
    const tokens = { first: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, look: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    let phase: keyof typeof tokens = "first";
    const base = realTransport(TARGET, "dated-second-look-eval");
    const counted: ModelTransport = {
      ...base,
      complete: async (req) => {
        const c = await base.complete(req);
        answers.push(c.text);
        tokens[phase].inputTokens += c.usage?.inputTokens ?? 0;
        tokens[phase].outputTokens += c.usage?.outputTokens ?? 0;
        tokens[phase].cacheReadTokens += c.usage?.cacheReadTokens ?? 0;
        tokens[phase].cacheWriteTokens += c.usage?.cacheWriteTokens ?? 0;
        return c;
      },
    };
    const tasks = createAi({ id: TARGET.provider, model: MODEL, apiKey: null, fetch: globalThis.fetch, timeoutMs: 90_000, maxRetries: 0 }, { transport: counted });
    // `fresh`: a first reading of its own, then the look when it's needed; `recorded`: the panel's first answer, then the look
    const score = { fresh: { readings: 0, expected: 0, found: 0, recovered: 0, wrongShown: 0, looks: 0 }, recorded: { readings: 0, expected: 0, found: 0, recovered: 0, wrongShown: 0, looks: 0 } };
    let failures = 0;
    const lines: string[] = [];
    for (const c of CASES) {
      const mail = c.messages.at(-1)!;
      const to = mail.to ?? [];
      const cc = mail.cc ?? [];
      const reader = { name: c.reader.name, addressed: to.some((r) => r.includes(c.reader.email)) ? ("to" as const) : cc.some((r) => r.includes(c.reader.email)) ? ("cc" as const) : ("none" as const) };
      const arrivedAt = new Date(`${c.today}T09:00:00`).getTime();
      const input: DatedInput = { text: mail.text, subject: c.subject, from: { name: nameOf(mail.from), automated: c.dated.automated }, reader, to: to.map(nameOf), cc: cc.map(nameOf), receivedAt: c.dated.receivedAt, zone: c.dated.zone ?? (c.language === "es" ? "Europe/Madrid" : "America/New_York"), open: [], language: c.language };
      const check = (r: DatedResult) => checkDates(r, { text: mail.text, subject: c.subject, arrivedAt, open: new Map<string, DatedRow>(), fromScan: false, now: 0, sender: { person: !c.dated.automated }, reader, others: [...to, ...cc].filter((p) => !p.includes(c.reader.email)).map(nameOf), threadId: 1, senderKey: "sender@case.example", from: nameOf(mail.from) }).rows.map((r) => ({ kind: r.kind, due: r.dated ? r.dueDay : null, time: r.timed ? clockOf(r.dueAt) : null, text: r.text, quote: r.quote }));
      for (const mode of ["fresh", "recorded"] as const) {
        if (!MODES.has(mode) || (mode === "recorded" && !c.dated.first)) continue;
        for (let k = 0; k < REPEAT; k++) {
          const s = score[mode];
          s.readings++;
          answers.length = 0;
          let first: DatedResult;
          let looked: Awaited<ReturnType<typeof secondLook>>;
          try {
            phase = "first";
            first = mode === "recorded" ? c.dated.first! : await tasks.readDates(input);
            phase = "look";
            looked = await secondLook(first, { text: mail.text, subject: c.subject, arrivedAt, automated: c.dated.automated, from: nameOf(mail.from), now: arrivedAt, shown: [], input, promptChars: Infinity }, { recheck: async () => "go", claim: async () => true, read: (i) => tasks.readDates(i), aborted: () => false });
          } catch (error) {
            failures++;
            lines.push(`✗ ${c.id} (${mode}) failed: ${error instanceof Error ? error.message : String(error)}`);
            continue;
          }
          if (typeof looked !== "object") continue;
          if (looked.asked) s.looks++;
          if (looked.error) lines.push(`  ${c.id} (${mode}): the look failed: ${looked.error instanceof Error ? looked.error.message : String(looked.error)}`);
          const shown = check(looked.result);
          const firstRows = check(first);
          const problems: string[] = [];
          const left = [...shown];
          for (const e of c.dated.items) {
            s.expected++;
            const at = left.findIndex((g) => matches(e, g));
            if (at < 0) {
              problems.push(`missed ${JSON.stringify(e)}`);
              continue;
            }
            s.found++;
            if (!firstRows.some((r) => matches(e, r))) s.recovered++;
            left.splice(at, 1);
          }
          for (const g of left) {
            if (c.dated.also.some((e) => matches(e, g))) continue;
            s.wrongShown++;
            problems.push(`wrong ${g.kind} ${g.due}${g.time ? ` ${g.time}` : ""} "${g.text}", quoting "${g.quote}"`);
          }
          // TERNO_AI_DATED_RAW=1: what the model wrote, the look's answer last
          if (problems.length && process.env.TERNO_AI_DATED_RAW === "1") problems.push(...answers.map((a) => `raw: ${a.replace(/\s+/g, " ")}`));
          lines.push(`${problems.length ? "✗" : "✓"} ${c.id} (${mode}) [${c.tags.join(",")}] ${looked.asked ? `looked at ${looked.asked}` : "no look"}: ${shown.map((g) => `${g.kind} ${g.due}${g.time ? ` ${g.time}` : ""} "${g.text}"`).join("; ") || "nothing"}${problems.length ? `\n    ${problems.join("\n    ")}` : ""}`);
        }
      }
    }
    const price = evalPriceOf(MODEL);
    const usd = (t: (typeof tokens)["first"]) => (price ? +costAt(price, t).toFixed(5) : null);
    const looks = score.fresh.looks + score.recorded.looks;
    // the prompt's whole size: what a cache read or wrote is part of it
    const per = (t: (typeof tokens)["first"], n: number) => (n ? { inputTokens: Math.round((t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens) / n), outputTokens: Math.round(t.outputTokens / n) } : null);
    process.stderr.write(`${lines.join("\n")}\n${JSON.stringify({ model: MODEL, ...score, failures, tokens, firstUsd: usd(tokens.first), lookUsd: usd(tokens.look), perLook: per(tokens.look, looks), perFirst: per(tokens.first, score.fresh.readings) })}\n${spendReport()}\n`);
    const wrongShown = score.fresh.wrongShown + score.recorded.wrongShown;
    const found = score.fresh.found + score.recorded.found;
    const expected = score.fresh.expected + score.recorded.expected;
    expect(wrongShown).toBe(0);
    expect(failures).toBe(0);
    expect(found).toBeGreaterThanOrEqual(0.8 * expected);
  }, 3_600_000);
});
