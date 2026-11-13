import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { costAt, runStructured, WRITING_PROMPT_VERSION, JUDGE_PROMPT_VERSION, type Effort, type Usage } from "@terno/ai";
import { screenNotes, type VoiceJudgment } from "../../packages/core/src/index";
import { evalPriceOf, fileLedger, realTasks, realTransport, spendReport } from "./harness";
import {
  ARMS,
  authorshipTask,
  buildFixture,
  canaryLeaks,
  draftRequest,
  exchangesTask,
  FIXTURE_DIR,
  hashString,
  loadFixtures,
  meaningTask,
  measureDraft,
  PERSONA_SPECS,
  readFixtureCorpus,
  sampleFor,
  scopesFor,
  type AuthorshipVerdict,
  type DraftMeasures,
  type MeaningVerdict,
} from "./drafting-lib";
import type { GeneratedExchange } from "./drafting-personas";

/**
 * Plan 133 §11's thin experiment. Stages, one at a time, by TERNO_DRAFT_STAGE, so nothing paid runs by accident:
 *
 *   fixtures   generate the personas with Haiku and write them to packages/mock-data (committed; never needed again)
 *   profiles   judge the scopes the cases use, on Sonnet; kept in /tmp, so a rerun costs nothing
 *   drafts     TERNO_DRAFT_ARMS=a,b  TERNO_DRAFT_CASES=x,y  (a draft already made at this prompt version is skipped)
 *              TERNO_DRAFT_MODEL=gpt-6-sol to draft on another model than Sonnet; TERNO_DRAFT_REASONING=default,low to send
 *              OpenAI's reasoning_effort ("default" sends none, as the app does). Each pairing is its own arm, `arm~model:effort`.
 *   judges     Haiku reads the drafts: meaning kept, and which of two is the real one
 *   report     no network: tables, drafting-results.md, the blind pairs
 *
 * Results live in /tmp/terno-ai. Real models only through the harness, under its ledger.
 */
const OUT = "/tmp/terno-ai";
const JUDGMENTS = `${OUT}/drafting-judgments.json`;
const RUNS = `${OUT}/drafting-runs.jsonl`;
const VERDICTS = `${OUT}/drafting-verdicts.json`;
const GENERATED = `${OUT}/drafting-generated.json`;
const ERRORS = `${OUT}/drafting-errors.jsonl`;

const SONNET = { provider: "anthropic" as const, model: "claude-sonnet-5-5" };
const HAIKU = { provider: "anthropic" as const, model: "claude-haiku-5-5" };

const stage = process.env.TERNO_DRAFT_STAGE ?? "";
const list = (name: string) => (process.env[name] ? process.env[name]!.split(",").map((s) => s.trim()) : null);

const DRAFTER = (() => {
  const model = process.env.TERNO_DRAFT_MODEL ?? SONNET.model;
  return { provider: model.startsWith("claude") ? ("anthropic" as const) : ("openai" as const), model };
})();
const REASONING = (list("TERNO_DRAFT_REASONING") ?? ["default"]).map((r) => {
  if (r !== "default" && r !== "low" && r !== "medium" && r !== "high") throw new Error(`TERNO_DRAFT_REASONING: default, low, medium or high, not ${r}`);
  return r as Effort | "default";
});
/** Sonnet with nothing overridden keeps the plain arm ids, so earlier runs still compare. */
const armTag = (reasoning: Effort | "default") => (DRAFTER.model === SONNET.model && reasoning === "default" ? "" : `~${DRAFTER.model}:${reasoning}`);
const baseArm = (stored: string) => ARMS.find((a) => a.id === stored.split("~")[0]);

interface StoredJudgment {
  promptVersion: number;
  judgment: VoiceJudgment;
  rejected: { note: string; reason: string }[];
  sampleSize: number;
  canariesInSample: string[];
}

interface Run {
  caseId: string;
  persona: string;
  arm: string;
  promptVersion: number;
  draft: string;
  stop: string;
  ttftMs: number | null;
  totalMs: number;
  usage: Usage | null;
  usd: number | null;
  examples: number;
  measures: DraftMeasures;
}

const readJson = <T>(path: string, fallback: T): T => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback);
const loadRuns = (): Run[] => (existsSync(RUNS) ? readFileSync(RUNS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Run) : []);
const judgmentKey = (persona: string, scopeKey: string) => `${persona}:${scopeKey}`;

function loadJudgments(persona: string): Map<string, VoiceJudgment> {
  const all = readJson<Record<string, StoredJudgment>>(JUDGMENTS, {});
  const out = new Map<string, VoiceJudgment>();
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(`${persona}:`) && value.promptVersion === JUDGE_PROMPT_VERSION) out.set(key.slice(persona.length + 1), value.judgment);
  }
  return out;
}

describe.runIf(stage === "fixtures")("fixtures", () => {
  it(
    "generates the personas with Haiku",
    async () => {
      mkdirSync(OUT, { recursive: true });
      mkdirSync(FIXTURE_DIR, { recursive: true });
      const transport = realTransport(HAIKU, "drafting-fixtures");
      const generated = readJson<Record<string, Record<string, GeneratedExchange[]>>>(GENERATED, {});
      const only = list("TERNO_DRAFT_PERSONAS");
      for (const persona of PERSONA_SPECS) {
        if (only && !only.includes(persona.id)) continue;
        generated[persona.id] ??= {};
        for (const rel of persona.relationships) {
          if (generated[persona.id]![rel.key]) continue;
          const scenarios = (rel.holdouts ?? []).map((h) => h.scenario);
          const exchanges = await runStructured(transport, exchangesTask(persona, rel, rel.count, scenarios), { output: "json_schema", signal: AbortSignal.timeout(170_000) });
          generated[persona.id]![rel.key] = exchanges;
          // kept as it goes: a failure part-way doesn't pay twice
          writeFileSync(GENERATED, JSON.stringify(generated, null, 1));
          console.log(persona.id, rel.key, exchanges.length, spendReport());
        }
        const fixture = buildFixture(persona, generated[persona.id]!);
        writeFileSync(resolve(FIXTURE_DIR, `${persona.id}.json`), `${JSON.stringify(fixture, null, 1)}\n`);
        console.log(persona.id, "sent", fixture.sent.length, "cases", fixture.cases.length);
      }
    },
    900_000,
  );
});

describe.runIf(stage === "inspect")("inspect", () => {
  it("prints what the local pipeline makes of the fixtures, with no network", () => {
    for (const f of loadFixtures()) {
      const corpus = readFixtureCorpus(f);
      const judgments = loadJudgments(f.id);
      const shown = new Set(list("TERNO_DRAFT_CASES") ?? f.cases.filter((c) => c.kind !== "attack").map((c) => c.id));
      for (const c of f.cases) {
        if (!shown.has(c.id)) continue;
        const arm = ARMS.find((a) => a.id === (process.env.TERNO_DRAFT_ARM ?? "judged+examples"))!;
        const { input, examples } = draftRequest(f, c, corpus, arm, judgments);
        console.log(`\n===== ${c.id} scopes: ${scopesFor(c, corpus).map((s) => `${s.key}(${s.mails.length})`).join(" ")} examples: ${examples}`);
        for (const v of input.voice) console.log(`--- ${v.scope}\n${v.text}`);
      }
    }
  });
});

describe.runIf(stage === "rescreen")("rescreen", () => {
  it("runs stored notes through the current screen, with no network", () => {
    const stored = readJson<Record<string, StoredJudgment>>(JUDGMENTS, {});
    for (const f of loadFixtures()) {
      const corpus = readFixtureCorpus(f);
      const scopes = new Map(f.cases.flatMap((c) => scopesFor(c, corpus)).map((s) => [s.key, s]));
      for (const scope of scopes.values()) {
        const entry = stored[judgmentKey(f.id, scope.key)];
        if (!entry) continue;
        const notes = [...entry.judgment.notes, ...entry.rejected.map((r) => r.note)];
        const { kept, rejected } = screenNotes(notes, sampleFor(scope));
        entry.judgment.notes = kept;
        entry.rejected = rejected;
        console.log(judgmentKey(f.id, scope.key), `\n  kept: ${kept.join(" | ")}`, `\n  rejected: ${rejected.map((r) => `${r.reason}: ${r.note}`).join(" | ") || "-"}`);
      }
    }
    writeFileSync(JUDGMENTS, JSON.stringify(stored, null, 1));
  });
});

describe.runIf(stage === "profiles")("profiles", () => {
  it(
    "judges the scopes the cases use",
    async () => {
      const tasks = realTasks(SONNET, "drafting-judge");
      const stored = readJson<Record<string, StoredJudgment>>(JUDGMENTS, {});
      const only = list("TERNO_DRAFT_SCOPES");
      for (const f of loadFixtures()) {
        const corpus = readFixtureCorpus(f);
        const scopes = new Map(f.cases.flatMap((c) => scopesFor(c, corpus)).map((s) => [s.key, s]));
        for (const scope of scopes.values()) {
          const key = judgmentKey(f.id, scope.key);
          if (only && !only.includes(key)) continue;
          if (stored[key]?.promptVersion === JUDGE_PROMPT_VERSION) continue;
          const sample = sampleFor(scope);
          const canariesInSample = f.canaries.flatMap((c) => c.terms.filter((t) => sample.some((m) => m.text.toLowerCase().includes(t))));
          const language = scope.mails.filter((m) => m.language === "es").length > scope.mails.length / 2 ? "Spanish" : "English";
          const r = await tasks.judgeVoice({ scope: scope.scope, language, sample });
          stored[key] = { promptVersion: JUDGE_PROMPT_VERSION, judgment: r.judgment, rejected: r.rejected, sampleSize: sample.length, canariesInSample };
          writeFileSync(JUDGMENTS, JSON.stringify(stored, null, 1));
          console.log(key, "sample", sample.length, "canaries", canariesInSample.join(",") || "-", JSON.stringify(r.judgment.traits), r.judgment.notes, "rejected", r.rejected, spendReport());
        }
      }
    },
    900_000,
  );
});

describe.runIf(stage === "drafts")("drafts", () => {
  it(
    "writes each case in each arm",
    async () => {
      const arms = ARMS.filter((a) => (list("TERNO_DRAFT_ARMS") ?? []).includes(a.id));
      expect(arms.length).toBeGreaterThan(0);
      const cases = list("TERNO_DRAFT_CASES");
      const kinds = list("TERNO_DRAFT_KINDS");
      const price = evalPriceOf(DRAFTER.model);
      const drafters = REASONING.map((reasoning) => ({
        reasoning,
        tag: armTag(reasoning),
        tasks: realTasks(DRAFTER, `drafting${armTag(reasoning)}`, {}, reasoning === "default" ? undefined : (req) => ({ ...req, reasoningEffort: reasoning })),
      }));
      mkdirSync(OUT, { recursive: true });
      const done = new Set(loadRuns().map((r) => `${r.caseId}|${r.arm}|${r.promptVersion}`));
      // refine shortens the last draft made by the same model and effort
      const latest = new Map(loadRuns().filter((r) => r.promptVersion === WRITING_PROMPT_VERSION && baseArm(r.arm)?.id === "local+examples").map((r) => [`${r.caseId}${r.arm.slice("local+examples".length)}`, r.draft]));
      let turn = 0;
      for (const f of loadFixtures()) {
        const corpus = readFixtureCorpus(f);
        const judgments = loadJudgments(f.id);
        for (const c of f.cases) {
          if (cases && !cases.includes(c.id)) continue;
          if (kinds && !kinds.includes(c.kind)) continue;
          // the attacks run only when named: they have no original to compare
          if (c.kind === "attack" && !cases && !kinds) continue;
          for (const arm of arms) {
            // settings take turns going first, so neither always meets the network first
            const order = turn++ % 2 === 0 ? drafters : [...drafters].reverse();
            for (const drafter of order) {
              const armId = `${arm.id}${drafter.tag}`;
              if (done.has(`${c.id}|${armId}|${WRITING_PROMPT_VERSION}`)) continue;
              const { input, examples } = draftRequest(f, c, corpus, arm, judgments, latest.get(`${c.id}${drafter.tag}`));
              const started = performance.now();
              let first: number | null = null;
              const result = await drafter.tasks
                .compose(input, {
                  effort: arm.effort,
                  onDelta: () => {
                    first ??= performance.now() - started;
                  },
                })
                .catch((error: unknown) => {
                  // kept apart and not marked done, so a rerun tries it again; a spent cap still stops the run
                  if ((error as Error).name === "BudgetExceededError") throw error;
                  appendFileSync(ERRORS, `${JSON.stringify({ caseId: c.id, arm: armId, promptVersion: WRITING_PROMPT_VERSION, error: String(error), afterMs: Math.round(performance.now() - started), at: new Date().toISOString() })}\n`);
                  console.log(`\n=== ${c.id} / ${armId}  FAILED after ${Math.round(performance.now() - started)}ms: ${String(error)}`);
                  return null;
                });
              if (!result) continue;
              const usage = result.usage ?? null;
              const run: Run = {
                caseId: c.id,
                persona: f.id,
                arm: armId,
                promptVersion: WRITING_PROMPT_VERSION,
                draft: result.text,
                stop: result.stop,
                ttftMs: first === null ? null : Math.round(first),
                totalMs: Math.round(performance.now() - started),
                usage,
                usd: usage && price ? costAt(price, usage) : null,
                examples,
                measures: measureDraft(f, c, input, result.text, corpus),
              };
              appendFileSync(RUNS, `${JSON.stringify(run)}\n`);
              if (arm.id === "local+examples") latest.set(`${c.id}${drafter.tag}`, result.text);
              console.log(`\n=== ${c.id} / ${armId} / v${WRITING_PROMPT_VERSION}  ttft ${run.ttftMs}ms  total ${run.totalMs}ms  in ${usage?.inputTokens} read ${usage?.cacheReadTokens} write ${usage?.cacheWriteTokens} out ${usage?.outputTokens}  $${run.usd?.toFixed(4)}\n${result.text}\n--- original\n${c.original ?? "(attack)"}`);
              console.log(spendReport());
            }
          }
        }
      }
    },
    1_500_000,
  );
});

describe.runIf(stage === "judges")("judges", () => {
  it(
    "reads the drafts with Haiku",
    async () => {
      const transport = realTransport(HAIKU, "drafting-reader");
      const verdicts = readJson<Record<string, { meaning?: MeaningVerdict; authorship?: AuthorshipVerdict & { truth: string } }>>(VERDICTS, {});
      const fixtures = new Map(loadFixtures().map((f) => [f.id, f]));
      const signal = () => AbortSignal.timeout(60_000);
      for (const run of loadRuns()) {
        const key = `${run.caseId}|${run.arm}|${run.promptVersion}`;
        const entry = (verdicts[key] ??= {});
        const f = fixtures.get(run.persona)!;
        const c = f.cases.find((x) => x.id === run.caseId)!;
        // nothing to compare these with: read by eye
        if (baseArm(run.arm)?.mode || c.kind === "attack") continue;
        if (!entry.meaning) entry.meaning = await runStructured(transport, meaningTask(c, run.draft), { output: "json_schema", signal: signal() });
        if (!entry.authorship && c.original) {
          const corpus = readFixtureCorpus(f);
          const realSamples = (corpus.byAccount.get(c.account) ?? []).filter((m) => m.to.includes(c.to.address) || m.to.some((a) => a.split("@")[1] === c.to.address.split("@")[1])).slice(-5).map((m) => m.text);
          const draftFirst = hashString(key) % 2 === 0;
          const verdict = await runStructured(transport, authorshipTask(realSamples, draftFirst ? run.draft : c.original, draftFirst ? c.original : run.draft), { output: "json_schema", signal: signal() });
          entry.authorship = { ...verdict, truth: draftFirst ? "B" : "A" };
        }
        writeFileSync(VERDICTS, JSON.stringify(verdicts, null, 1));
      }
      console.log(spendReport());
    },
    900_000,
  );
});

const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const pct = (hits: number, n: number) => (n ? `${Math.round((hits / n) * 100)}%` : "-");

describe.runIf(stage === "report")("report", () => {
  it("writes the tables, the results and the blind pairs", () => {
    const version = Number(process.env.TERNO_DRAFT_VERSION ?? WRITING_PROMPT_VERSION);
    const verdicts = readJson<Record<string, { meaning?: MeaningVerdict; authorship?: AuthorshipVerdict & { truth: string } }>>(VERDICTS, {});
    const fixtures = loadFixtures();
    const cases = new Map(fixtures.flatMap((f) => f.cases.map((c) => [c.id, { f, c }] as const)));
    // measured again from the text, so a better measure doesn't need a new draft
    const runs = loadRuns()
      .filter((r) => r.promptVersion === version && baseArm(r.arm))
      .map((r) => {
        const { f, c } = cases.get(r.caseId)!;
        const arm = baseArm(r.arm)!;
        const corpus = readFixtureCorpus(f);
        return { ...r, measures: measureDraft(f, c, draftRequest(f, c, corpus, arm, loadJudgments(f.id)).input, r.draft, corpus) };
      });
    const arms = [...new Set(runs.map((r) => r.arm))].filter((a) => !baseArm(a)?.mode);
    const verdictOf = (r: Run) => verdicts[`${r.caseId}|${r.arm}|${r.promptVersion}`];

    const rows = arms.map((arm) => {
      const all = runs.filter((r) => r.arm === arm && cases.get(r.caseId)?.c.original);
      const n = all.length;
      const m = all.map((r) => r.measures);
      const fooled = all.filter((r) => {
        const v = verdictOf(r)?.authorship;
        return v && v.real !== v.truth;
      }).length;
      const kept = all.filter((r) => verdictOf(r)?.meaning?.kept).length;
      const added = all.filter((r) => (verdictOf(r)?.meaning?.added.length ?? 0) > 0).length;
      const ttft = all.map((r) => r.ttftMs ?? 0).sort((a, b) => a - b);
      const total = all.map((r) => r.totalMs).sort((a, b) => a - b);
      return {
        arm,
        n,
        // a short instruction's original says more than it was asked to, so its length proves nothing
        lengthOff: mean(all.filter((r) => cases.get(r.caseId)!.c.kind !== "short-instruction").map((r) => r.measures.lengthOff)).toFixed(2),
        words: Math.round(mean(m.map((x) => x.words))),
        original: Math.round(mean(m.map((x) => x.originalWords))),
        greeting: pct(m.filter((x) => x.greetingMatch).length, n),
        signOff: pct(m.filter((x) => x.signOffMatch).length, n),
        bang: pct(m.filter((x) => x.exclamationMatch).length, n),
        lower: pct(m.filter((x) => x.lowercaseMatch).length, n),
        invented: m.filter((x) => x.invented.length > 0).length,
        placeholders: m.filter((x) => x.placeholders > 0).length,
        kept: pct(kept, n),
        added,
        fooled: pct(fooled, n),
        ttftMedian: ttft[Math.floor(ttft.length / 2)] ?? 0,
        totalMedian: total[Math.floor(total.length / 2)] ?? 0,
        usd: mean(all.map((r) => r.usd ?? 0)).toFixed(4),
        output: Math.round(mean(all.map((r) => r.usage?.outputTokens ?? 0))),
        read: Math.round(mean(all.map((r) => r.usage?.cacheReadTokens ?? 0))),
      };
    });
    const header = "| arm | n | length off | words (orig) | greeting | sign-off | ! | lowercase | invented | [ ] | kept | added | fooled judge | ttft ms | total ms | output tok | cache read | $/draft |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";
    const table = rows.map((r) => `| ${r.arm} | ${r.n} | ${r.lengthOff} | ${r.words} (${r.original}) | ${r.greeting} | ${r.signOff} | ${r.bang} | ${r.lower} | ${r.invented} | ${r.placeholders} | ${r.kept} | ${r.added} | ${r.fooled} | ${r.ttftMedian} | ${r.totalMedian} | ${r.output} | ${r.read} | ${r.usd} |`).join("\n");

    const judgments = readJson<Record<string, StoredJudgment>>(JUDGMENTS, {});
    const profileLeaks: string[] = [];
    for (const f of fixtures) {
      const corpus = readFixtureCorpus(f);
      const judged = new Map(Object.entries(judgments).filter(([k]) => k.startsWith(`${f.id}:`)).map(([k, v]) => [k.slice(f.id.length + 1), v]));
      for (const c of f.cases) {
        for (const scope of scopesFor(c, corpus)) {
          const j = judged.get(scope.key);
          const stored = JSON.stringify({ notes: j?.judgment.notes ?? [], rejected: j?.rejected ?? [] });
          for (const canary of f.canaries) for (const term of canary.terms) if (stored.toLowerCase().includes(term)) profileLeaks.push(`${f.id} ${scope.key} note: ${term}`);
        }
      }
    }
    const screened = Object.entries(judgments).flatMap(([k, v]) => v.rejected.map((r) => `${k}: ${r.reason}: ${r.note}`));
    const draftLeaks = runs.filter((r) => r.measures.canaryLeaks.length > 0).map((r) => `${r.caseId} / ${r.arm}: ${r.measures.canaryLeaks.join(", ")}`);

    const lines = [`# Drafting experiment, prompt v${version}\n`, `${header}\n${table}\n`, `Spend: ${spendReport()}\n`];
    lines.push(`Canaries in stored notes: ${profileLeaks.length ? profileLeaks.join("; ") : "none"}. In drafts to other people: ${draftLeaks.length ? draftLeaks.join("; ") : "none"}.\n`);
    lines.push(`Notes the screen removed (${screened.length}):\n${screened.map((s) => `- ${s}`).join("\n") || "- none"}\n`);
    lines.push(`Canary terms that reached a judged sample: ${[...new Set(Object.values(judgments).flatMap((v) => v.canariesInSample))].join(", ") || "none"}\n`);
    for (const { f, c } of cases.values()) {
      const theirs = runs.filter((r) => r.caseId === c.id);
      if (theirs.length === 0) continue;
      lines.push(`\n---\n\n## ${c.id} (${c.kind}, ${f.name}, ${c.account} → ${c.to.name})\n`);
      lines.push(`**Inbound:**\n\n> ${(c.thread[c.thread.length - 1]?.text ?? "").replace(/\n/g, "\n> ")}\n`);
      lines.push(`**Instruction:** ${c.instruction}\n`);
      lines.push(`**Original:**\n\n\`\`\`\n${c.original ?? "(attack: no original)"}\n\`\`\`\n`);
      for (const r of theirs) {
        const v = verdictOf(r);
        const flags = [`${r.measures.words}w`, r.measures.greetingMatch ? "greeting ok" : "greeting off", r.measures.signOffMatch ? "sign-off ok" : "sign-off off", r.measures.invented.length ? `invented: ${r.measures.invented.map((i) => i.text).join(", ")}` : "", v?.meaning && !v.meaning.kept ? `lost: ${v.meaning.lost.join("; ")}` : "", v?.meaning?.added.length ? `added: ${v.meaning.added.join("; ")}` : ""].filter(Boolean).join(" · ");
        lines.push(`**${r.arm}** (${flags})\n\n\`\`\`\n${r.draft}\n\`\`\`\n`);
      }
    }
    writeFileSync(`${OUT}/drafting-results.md`, lines.join("\n"));

    // for the user's read: one draft per case, from the arm they name, shuffled by a fixed seed
    const blindArm = process.env.TERNO_DRAFT_BLIND_ARM ?? arms[arms.length - 1]!;
    const pairs = runs.filter((r) => r.arm === blindArm && cases.get(r.caseId)?.c.original).sort((a, b) => hashString(a.caseId + "pair") - hashString(b.caseId + "pair"));
    const blind = [`# Blind pairs (${pairs.length})\n\nFor each pair: which one did this person really write? Would you send the other with little editing?\n`];
    const key = [`# Answer key (arm: ${blindArm}, prompt v${version})\n`];
    pairs.forEach((r, i) => {
      const { f, c } = cases.get(r.caseId)!;
      const draftIsA = hashString(`${r.caseId}side`) % 2 === 0;
      const real = c.original!;
      blind.push(`## Pair ${i + 1}: ${f.name}, to ${c.to.name}\n\n${f.brief}\n\n**They received:**\n\n> ${(c.thread[c.thread.length - 1]?.text ?? "").replace(/\n/g, "\n> ")}\n\n**A**\n\n\`\`\`\n${draftIsA ? r.draft : real}\n\`\`\`\n\n**B**\n\n\`\`\`\n${draftIsA ? real : r.draft}\n\`\`\`\n`);
      key.push(`- Pair ${i + 1} (${c.id}): the draft is ${draftIsA ? "A" : "B"}, the original ${draftIsA ? "B" : "A"}`);
    });
    writeFileSync(`${OUT}/blind-pairs.md`, blind.join("\n"));
    writeFileSync(`${OUT}/blind-pairs-key.md`, key.join("\n") + "\n");

    const ledger = fileLedger();
    console.log(`${header}\n${table}\n\nspent $${ledger.spent().toFixed(4)}`);
    console.log("draft leaks", draftLeaks, "profile leaks", profileLeaks, "attacks", runs.filter((r) => cases.get(r.caseId)?.c.kind === "attack").map((r) => `${r.caseId}: ${canaryLeaks(cases.get(r.caseId)!.f, "", r.draft).length}`));
  });
});
