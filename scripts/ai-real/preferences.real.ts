import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkPreferences, isSemantic, preferenceDecision, semanticReaching, verdictBasis, wantedBy, type PreferenceRule, type PreferenceTarget } from "@terno/core";
import { describe, expect, it } from "vitest";
import { addressKey } from "../../packages/core/src/people";
import { checkWanted, excerptAround, judgeRows } from "../../packages/backend/src/preferences";
import { realTasks, spendReport, type RealTarget } from "./harness";
import { HELDOUT } from "./corpus/preferences/heldout";
import { PROFILES, type Expect, type Mail, type Profile } from "./corpus/preferences/profiles";

/**
 * Plan 249's eval, end to end on real models (the Codex review's revision 11): each profile's raw words are compiled
 * (`compilePreferences`) and checked as Save does; then each of its mails goes the way the app takes it: v16's items (given:
 * the words never change v16) are judged by the matcher for the semantic hide and first rules; mail a show rule admits by
 * its sender or cues gets the second reader, and its answer the app's own checks; what the feed would show is scored
 * against the profile's expectation. Scored, as the shipping bar has it: a forbidden row shown, a wanted row missed, an
 * unrelated row lost, a first not first, and anything unsafe brought in.
 *
 * Run alone with TERNO_AI_REAL=1 TERNO_AI_WORDS=1 (fictional mail only); TERNO_AI_WORDS_MODEL picks the model (GPT Luna
 * by default; a `claude-` model runs on Anthropic), TERNO_AI_WORDS_REPEAT reads each profile that many times,
 * TERNO_AI_WORDS_OUT names a directory for the report, and TERNO_AI_WORDS_SET=heldout runs the held-out profiles (written
 * blind to the prompts, never tuned against) instead of the tuning corpus.
 */
const MODEL = process.env.TERNO_AI_WORDS_MODEL ?? "gpt-6-luna";
const TARGET: RealTarget = { provider: MODEL.startsWith("claude-") ? "anthropic" : "openai", model: MODEL };
const REPEAT = Number(process.env.TERNO_AI_WORDS_REPEAT ?? 1);
const HELD_OUT = process.env.TERNO_AI_WORDS_SET === "heldout";
const SET = HELD_OUT ? HELDOUT : PROFILES;
const NOW = new Date(2026, 10, 10, 12).getTime();

type Outcome = { mail: string; expect: Expect; got: "shown" | "hidden" | "first" | "wanted" | "none"; ok: boolean; note: string; detail?: string };

const unclear = (said: string) => `unclear: ${said}`;

async function run(profile: Profile, label: string): Promise<{ rules: PreferenceRule[]; notes: string[]; outcomes: Outcome[] }> {
  const ai = realTasks(TARGET, label);
  const compiled = await ai.compilePreferences({ text: profile.words, language: profile.language });
  const { rules, notes } = checkPreferences(compiled, profile.words, unclear);
  const basis = verdictBasis(rules);
  // v16's items, as targets the rules see
  const rows = profile.mails.flatMap((m) => m.items.map((item, i) => ({ mail: m, item, key: `${m.id}:${i}`, target: { kind: item.kind, senderKey: addressKey(m.from.email), senderName: m.from.name } as PreferenceTarget })));
  // the matcher, as the worker asks it (`judgeRows`: a first reading, hides confirmed, rows an only drops asked again), 25 a batch
  const reaching = rows.filter((r) => semanticReaching(rules, r.target).length);
  const verdicts = new Map<string, string[]>();
  for (let i = 0; i < reaching.length; i += 25) {
    const batch = reaching.slice(i, i + 25);
    const judged = await judgeRows(ai, rules, batch.map((r, j) => ({ row: { ...r.target, key: r.key }, target: { id: `t${j + 1}`, kind: r.item.kind, text: r.item.text, from: r.mail.from.name, subject: r.mail.subject, excerpt: excerptAround(r.mail.text, r.item.quote, 600) } })));
    for (const [key, keys] of judged.rules) verdicts.set(key, judged.failed.has(key) ? [] : keys);
  }
  const shows = rules.filter((r) => r.effect === "show");
  const outcomes: Outcome[] = [];
  for (const mail of profile.mails) {
    const decisions = mail.items.map((_, i) => {
      const key = `${mail.id}:${i}`;
      const v = verdicts.get(key);
      return preferenceDecision(rules, rows.find((r) => r.key === key)!.target, v ? { basis, rules: v } : undefined, basis);
    });
    // the second reader: only for what a show admits (its sender or a cue), with the app's checks on its answer
    let wanted: ReturnType<typeof checkWanted> = [];
    const admitted = wantedBy(shows, { senderKey: addressKey(mail.from.email), subject: mail.subject, fromName: mail.from.name, text: mail.text });
    if (admitted.length) {
      const map = new Map(admitted.map((r, i) => [`r${i + 1}`, r]));
      const result = await ai.readWanted({
        text: mail.text,
        subject: mail.subject,
        from: { name: mail.from.name, automated: mail.automated },
        reader: "Alex",
        receivedAt: "Tuesday, 10 November 2026, 12:00",
        zone: "Europe/Madrid",
        language: profile.language,
        rules: [...map].map(([id, r]) => ({ id, about: r.about ?? null, unless: r.unless ?? null, understood: r.understood, ...(r.kinds?.length ? { kinds: r.kinds } : {}) })),
        open: mail.items.map((i) => ({ kind: i.kind, text: i.text })),
      });
      wanted = checkWanted(result, { text: mail.text, subject: mail.subject, arrivedAt: NOW, rules: map, already: mail.items });
      // a wanted item is itself judged by the hides (a hide wins)
      wanted = wanted.filter((w) => !preferenceDecision(rules.filter((r) => !isSemantic(r)), { kind: w.kind, senderKey: addressKey(mail.from.email), senderName: mail.from.name }, undefined, basis).hide);
    }
    outcomes.push(score(mail, decisions, wanted.length > 0, rules, admitted.length > 0));
  }
  return { rules, notes: notes.map((n) => n.kind), outcomes };
}

function score(mail: Mail, decisions: { hide: boolean; first: boolean }[], wanted: boolean, rules: readonly PreferenceRule[], admitted: boolean): Outcome {
  const shown = decisions.some((d) => !d.hide);
  const first = decisions.some((d) => !d.hide && d.first);
  const got: Outcome["got"] = mail.items.length ? (!shown ? (wanted ? "wanted" : "hidden") : first ? "first" : "shown") : wanted ? "wanted" : "none";
  const ok = mail.expect === got || (mail.expect === "shown" && got === "first" && !rules.some((r) => r.effect === "first"));
  return { mail: mail.id, expect: mail.expect, got, ok, note: mail.note, ...(admitted ? { detail: "admitted" } : {}) };
}

describe.runIf(process.env.TERNO_AI_WORDS === "1")(`plan 249: What matters in the user's words, end to end (${MODEL})`, () => {
  it("compiles each profile's words and scores what the feed would show", { timeout: 1_800_000 }, async () => {
    const report: string[] = [];
    const totals = { mails: 0, ok: 0, forbidden: 0, missed: 0, lost: 0, firstMissed: 0, firstExtra: 0, overreach: 0, notesMissed: 0 };
    for (let n = 0; n < REPEAT; n++)
      for (const profile of SET) {
        const { rules, notes, outcomes } = await run(profile, `words:${profile.id}`);
        report.push(`## ${profile.id} (${profile.language}) #${n + 1}`, `> ${profile.words}`, "", ...rules.map((r) => `- ${r.effect}${r.kinds ? ` [${r.kinds.join(",")}]` : ""}${r.senders ? ` {${r.senders.join(",")}}` : ""}${r.names ? ` names: ${r.names.join(", ")}` : ""}${r.about ? ` about: ${r.about}` : ""}${r.unless ? ` unless: ${r.unless}` : ""}${r.cues ? ` cues: ${r.cues.join(", ")}` : ""} — "${r.understood}"`), ...notes.map((k) => `- note: ${k}`), "");
        for (const want of profile.notes ?? []) if (!notes.includes(want)) totals.notesMissed++;
        for (const o of outcomes) {
          totals.mails++;
          if (o.ok) totals.ok++;
          else if (o.expect === "hidden") totals.forbidden++;
          else if (o.expect === "wanted") totals.missed++;
          else if (o.expect === "first") totals.firstMissed++;
          else if (o.expect === "none") totals.overreach++;
          // shown but put first by a rule that shouldn't have: an order slip, never a row lost
          else if (o.got === "first") totals.firstExtra++;
          else totals.lost++;
          report.push(`${o.ok ? "✓" : "✗"} ${o.mail}: expected ${o.expect}, got ${o.got}${o.detail ? ` (${o.detail})` : ""} — ${o.note}`);
        }
        report.push("");
      }
    report.push(`**${totals.ok} of ${totals.mails}**: forbidden shown ${totals.forbidden}, wanted missed ${totals.missed}, unrelated lost ${totals.lost}, first missed ${totals.firstMissed}, first extra ${totals.firstExtra}, over-reach ${totals.overreach}, notes missed ${totals.notesMissed}. ${spendReport()}`);
    const text = report.join("\n");
    console.log(text);
    const out = process.env.TERNO_AI_WORDS_OUT;
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, `words-${MODEL}${HELD_OUT ? "-heldout" : ""}.md`), text);
    }
    // the shipping bar: nothing forbidden shown, nothing unrelated lost, nothing unsafe brought in
    expect({ forbidden: totals.forbidden, lost: totals.lost, overreach: totals.overreach }).toEqual({ forbidden: 0, lost: 0, overreach: 0 });
  });
});
