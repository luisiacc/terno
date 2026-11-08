// What a round scored against the bar (plan 158): every score from every rater on every screen of every style. The
// screens are the round's own, frozen in its round.json when it started (plan 161), never a report's.
//   node scripts/ui-rating/gate.mjs <roundDir>     writes summary.md there; exit 1 below the bar
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SETS, shotFiles } from "./sets.mjs";

export const BAR = 9;
/** The everyday set's screens (plan 158), the default for a round from before sets */
export const SCREENS = SETS.everyday.screens;
export const UI_FACETS = ["typography", "contrast", "placement", "hierarchy", "controls", "density"];
export const UX_FACETS = ["efficiency", "clarity", "feedback", "consistency", "accessibility"];
export const FACETS = [...UI_FACETS, ...UX_FACETS];
export const RATERS = ["claude", "codex"];
export const DESIGNS = ["lumen", "atelier", "macos", "graphite"];

const isScore = (n) => typeof n === "number" && n >= 1 && n <= 10;

/** What's wrong with a report's shape: a rater that skipped a cell mustn't pass by omission. */
export function reportProblems(report, screens = SCREENS) {
  const problems = [];
  if (report.viewed_all_images !== true) problems.push("did not view all the images");
  if (!report.hands_on?.length) problems.push("did not try the app");
  if (!Array.isArray(report.issues)) problems.push("no issues list");
  for (const k of ["overall", "ui", "ux"]) {
    if (!isScore(report[k]?.score)) problems.push(`no ${k} score`);
    else if (!report[k].why?.trim()) problems.push(`no ${k} reason`);
  }
  for (const s of screens) {
    const screen = report.screens?.[s];
    if (!screen) { problems.push(`no screen ${s}`); continue; }
    if (!isScore(screen.overall)) problems.push(`${s}: no overall`);
    for (const f of FACETS) {
      const facet = screen.facets?.[f];
      if (!isScore(facet?.score)) problems.push(`${s}.${f}: no score`);
      else if (facet.score < 10 && !facet.improve?.trim()) problems.push(`${s}.${f}: no improve`);
    }
  }
  // a screen the round didn't rate can't stand in for one it did, or count toward it
  for (const s of Object.keys(report.screens ?? {})) if (!screens.includes(s)) problems.push(`${s}: not a screen of this round`);
  return problems;
}

/** Every score under the bar, lowest first. */
export function belowBar(reports, bar = BAR, screens = SCREENS) {
  const out = [];
  for (const { design, rater, report } of reports) {
    for (const k of ["overall", "ui", "ux"]) if (report[k].score < bar) out.push({ design, rater, screen: "app", facet: k, score: report[k].score, improve: report[k].why });
    for (const s of screens) {
      if (report.screens[s].overall < bar) out.push({ design, rater, screen: s, facet: "overall", score: report.screens[s].overall, improve: "" });
      for (const f of FACETS) {
        const { score, improve } = report.screens[s].facets[f];
        if (score < bar) out.push({ design, rater, screen: s, facet: f, score, improve });
      }
    }
  }
  return out.sort((a, b) => a.score - b.score);
}

/** The round's verdict: passed only with every report there, whole, and nothing under the bar. */
export function verdict(found, { designs = DESIGNS, raters = RATERS, bar = BAR, screens = SCREENS } = {}) {
  const missing = designs.flatMap((design) => raters.filter((rater) => !found.some((r) => r.design === design && r.rater === rater)).map((rater) => `${design}/${rater}`));
  const invalid = found.flatMap((r) => reportProblems(r.report, screens).map((p) => `${r.design}/${r.rater}: ${p}`));
  const below = invalid.length ? [] : belowBar(found, bar, screens);
  return { pass: !missing.length && !invalid.length && !below.length, missing, invalid, below };
}

/**
 * What a round was frozen to rate: its set, screens and shots, from round.json. A round from before sets (plan 158) is
 * the everyday set. A round.json that disagrees with its set's definition was edited after the round began.
 */
export function roundSet(round) {
  // before sets (plan 158): no set, no screens, no shots
  if (round.set === undefined && round.screens === undefined && round.shots === undefined) return { set: "everyday", screens: SETS.everyday.screens, shots: null };
  const set = round.set;
  if (!SETS[set]) throw new Error(`round.json names an unknown set: ${set}`);
  if (round.screens?.join() !== SETS[set].screens.join()) throw new Error(`round.json's screens aren't the ${set} set's`);
  // the evidence list can't be thinned to make a round whole
  if (!Array.isArray(round.shots) || round.shots.join() !== shotFiles(set).join()) throw new Error(`round.json's shots aren't the ${set} set's`);
  return { set, screens: round.screens, shots: round.shots };
}

/** Every shot round.json froze, for every style it rated: the evidence is whole, or the round is. */
export function missingShots(dir, round) {
  const { shots } = roundSet(round);
  if (!shots) return [];
  return round.designs.flatMap((design) => shots.filter((f) => !existsSync(join(dir, design, "shots", f))).map((f) => `${design}/${f}`));
}

function readRound(dir) {
  const found = [];
  for (const design of readdirSync(dir)) for (const rater of RATERS) {
    const file = join(dir, design, `${rater}.json`);
    if (existsSync(file)) found.push({ design, rater, report: JSON.parse(readFileSync(file, "utf8")) });
  }
  return found;
}

function summary(found, result, SCREENS) {
  const lines = [`# ${result.pass ? "PASS" : "BELOW THE BAR"}: every score at least ${BAR}\n`];
  if (result.missing.length) lines.push(`Missing: ${result.missing.join(", ")}\n`);
  if (result.invalid.length) lines.push(`Invalid:\n${result.invalid.map((p) => `- ${p}`).join("\n")}\n`);
  const avg = (ns) => (ns.reduce((a, b) => a + b, 0) / ns.length).toFixed(2);
  lines.push("| Style | Rater | Overall | UI | UX | Lowest | Cells below |", "|---|---|---:|---:|---:|---:|---:|");
  for (const r of found) {
    const cells = SCREENS.flatMap((s) => [r.report.screens[s].overall, ...FACETS.map((f) => r.report.screens[s].facets[f].score)]);
    lines.push(`| ${r.design} | ${r.rater} | ${r.report.overall.score} | ${r.report.ui.score} | ${r.report.ux.score} | ${Math.min(...cells)} | ${cells.filter((c) => c < BAR).length}/${cells.length} |`);
  }
  lines.push("\n## Screens, each rater's overall\n", `| Screen | ${found.map((r) => `${r.design} ${r.rater}`).join(" | ")} |`, `|---|${found.map(() => "---:").join("|")}|`);
  for (const s of SCREENS) lines.push(`| ${s} | ${found.map((r) => r.report.screens[s].overall).join(" | ")} |`);
  lines.push("\n## Facets, mean across screens\n", `| Facet | ${found.map((r) => `${r.design} ${r.rater}`).join(" | ")} |`, `|---|${found.map(() => "---:").join("|")}|`);
  for (const f of FACETS) lines.push(`| ${f} | ${found.map((r) => avg(SCREENS.map((s) => r.report.screens[s].facets[f].score))).join(" | ")} |`);
  lines.push(`\n## Below the bar (${result.below.length})\n`);
  for (const b of result.below) lines.push(`- **${b.score}** ${b.design}/${b.rater} ${b.screen}.${b.facet}: ${b.improve}`);
  return lines.join("\n") + "\n";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) throw new Error("usage: gate.mjs <roundDir>");
  if (!existsSync(join(dir, "round.json"))) throw new Error(`${dir} isn't a round`);
  const round = JSON.parse(readFileSync(join(dir, "round.json"), "utf8"));
  const { designs, raters } = round;
  const { set, screens } = roundSet(round);
  const found = readRound(dir);
  // a narrowed round reports its numbers and can't pass the rule
  const result = verdict(found, { screens });
  const shotsMissing = missingShots(dir, round);
  if (shotsMissing.length) {
    result.pass = false;
    result.invalid.push(...shotsMissing.map((f) => `missing evidence: ${f}`));
  }
  if (designs.length !== DESIGNS.length || raters.length !== RATERS.length) console.log("a narrowed round: it can't pass the rule");
  console.log(`set: ${set} (${screens.length} screens)`);
  writeFileSync(join(dir, "summary.md"), summary(found, result, screens));
  console.log(`${result.pass ? "PASS" : "below the bar"}: ${result.below.length} cells under ${BAR}, ${result.missing.length} reports missing, ${result.invalid.length} problems. ${join(dir, "summary.md")}`);
  process.exit(result.pass ? 0 : 1);
}
