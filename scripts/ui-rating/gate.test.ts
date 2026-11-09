import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aiProblems, belowBar, DESIGNS, FACETS, missingShots, modelsLine, RATERS, reportProblems, roundSet, SCREENS, verdict } from "./gate.mjs";
import { PRO_ROUTING } from "./keys.mjs";
import { SETS, shotFiles } from "./sets.mjs";

function report(score = 9, screens: readonly string[] = SCREENS) {
  return {
    viewed_all_images: true,
    hands_on: ["tried it"],
    issues: [],
    overall: { score, why: "x" },
    ui: { score, why: "x" },
    ux: { score, why: "x" },
    screens: Object.fromEntries(screens.map((s) => [s, { overall: score, facets: Object.fromEntries(FACETS.map((f) => [f, { score, improve: "x" }])) }])),
  };
}
const round = (r = report) => DESIGNS.flatMap((design) => RATERS.map((rater) => ({ design, rater, report: r() })));

describe("the UI rating's bar (plan 158)", () => {
  it("passes when every rater gives every style at least the bar", () => {
    expect(verdict(round())).toMatchObject({ pass: true, below: [], missing: [], invalid: [] });
  });

  it("one facet of one screen from one rater fails the round, named", () => {
    const found = round();
    found[3].report.screens.search.facets.contrast = { score: 8.5, improve: "the selected row" };
    const v = verdict(found);
    expect(v.pass).toBe(false);
    expect(v.below).toEqual([{ design: found[3].design, rater: found[3].rater, screen: "search", facet: "contrast", score: 8.5, improve: "the selected row" }]);
  });

  it("a screen's overall counts as well as its facets", () => {
    const r = report();
    r.screens.row_menu.overall = 8;
    expect(belowBar([{ design: "lumen", rater: "codex", report: r }])).toMatchObject([{ screen: "row_menu", facet: "overall", score: 8 }]);
  });

  it("a missing report or a skipped cell can't pass by omission", () => {
    expect(verdict(round().slice(1))).toMatchObject({ pass: false, missing: ["lumen/claude"] });
    const r = report();
    delete r.screens.search.facets.clarity;
    expect(reportProblems(r)).toEqual(["search.clarity: no score"]);
  });

  it("a score under 10 has to say what would raise it, and images have to have been seen", () => {
    const r = report();
    r.screens.search.facets.clarity.improve = " ";
    r.viewed_all_images = false as true;
    expect(reportProblems(r)).toEqual(["did not view all the images", "search.clarity: no improve"]);
  });

  it("a report that never tried the app, or gives no reasons, is incomplete", () => {
    const r = report();
    r.hands_on = [];
    r.ui.why = "";
    expect(reportProblems(r)).toEqual(["did not try the app", "no ui reason"]);
  });
});

describe("plan 161: a round rates the set it froze", () => {
  const AI = SETS.ai.screens;

  it("an AI report is checked against the AI screens, an everyday one against the everyday screens", () => {
    const ai = () => report(9, AI);
    expect(verdict(round(ai), { screens: AI })).toMatchObject({ pass: true, invalid: [] });
    expect(verdict(round(), { screens: SETS.everyday.screens })).toMatchObject({ pass: true });
    // the other set's report can't pass for this one, by omission or by extra screens
    const crossed = verdict(round(), { screens: AI });
    expect(crossed.pass).toBe(false);
    expect(crossed.invalid).toContain("lumen/claude: no screen summary");
    expect(crossed.invalid).toContain("lumen/claude: split_inbox: not a screen of this round");
  });

  it("a cell under the bar is found on an AI screen too", () => {
    const found = round(() => report(9, AI));
    found[0]!.report.screens.ask.facets.feedback = { score: 8, improve: "say it's still searching" };
    expect(verdict(found, { screens: AI }).below).toEqual([{ design: found[0]!.design, rater: found[0]!.rater, screen: "ask", facet: "feedback", score: 8, improve: "say it's still searching" }]);
  });

  it("the screens come from round.json, never from a report; a round from before sets is everyday; an edited one is refused", () => {
    expect(roundSet({ designs: DESIGNS })).toEqual({ set: "everyday", screens: SETS.everyday.screens, shots: null });
    expect(roundSet({ set: "ai", screens: AI, shots: shotFiles("ai") }).screens).toEqual(AI);
    expect(() => roundSet({ set: "ai", screens: AI.slice(1), shots: shotFiles("ai") })).toThrow("screens aren't the ai set's");
    expect(() => roundSet({ set: "lunch" })).toThrow("unknown set");
    // a round with a set can't drop its evidence list, or thin it, and pass
    for (const shots of [undefined, null, [], shotFiles("ai").slice(2)]) expect(() => roundSet({ set: "ai", screens: AI, shots })).toThrow("shots aren't the ai set's");
  });

  it("the round's evidence is whole: every frozen shot, for every style", () => {
    const dir = mkdtempSync("/tmp/gate-test-");
    try {
      const shots = shotFiles("ai");
      expect(shots).toHaveLength(2 * 17);
      expect(shots).toContain("a01-summary-small-dark.png");
      mkdirSync(join(dir, "lumen", "shots"), { recursive: true });
      for (const f of shots.slice(1)) writeFileSync(join(dir, "lumen", "shots", f), "");
      expect(missingShots(dir, { set: "ai", screens: AI, shots, designs: ["lumen"] })).toEqual([`lumen/${shots[0]}`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("real models: round.json carries the model ids and each run, never a key", () => {
    const hosts = ["api.anthropic.com", "api.openai.com", "api.typesafe.ai"];
    const run = (mode: string, reached = ["api.anthropic.com", "api.openai.com"]) => ({ design: "lumen", mode, models: "real", reached, usage: { total: { usd: 0.21 } } });
    const real = (over: object = {}) => ({ set: "ai", screens: AI, shots: shotFiles("ai"), designs: ["lumen"], ai: { models: "real", providers: ["anthropic", "openai", "jev"], hosts, routing: PRO_ROUTING, runs: { lumen: [run("light"), run("dark")] } }, ...over });

    it("a whole record passes, and says which models answered and what they cost", () => {
      expect(aiProblems(real())).toEqual([]);
      expect(real().ai.routing).toMatchObject({ summary: "openai/gpt-6-luna", writing: "anthropic/claude-sonnet-5-5" });
      expect(modelsLine(real())).toContain("openai/gpt-6-luna");
      expect(modelsLine(real())).toContain("US$0.42");
    });

    it("an AI round from before real models ran on the stub, and an everyday round has no models", () => {
      expect(aiProblems({ set: "ai", screens: AI, shots: shotFiles("ai"), designs: ["lumen"] })).toEqual([]);
      expect(modelsLine({ set: "ai", screens: AI, shots: shotFiles("ai"), designs: ["lumen"] })).toContain("stand-in");
      expect(modelsLine({ designs: DESIGNS })).toBeNull();
    });

    it("without its model ids, a run per mode, or with a host no provider has, it fails", () => {
      const base = real();
      expect(aiProblems({ ...base, ai: { ...base.ai, routing: {} } })).toEqual(["a real-model round without the model each task ran on"]);
      expect(aiProblems({ ...base, ai: { ...base.ai, runs: { lumen: [run("light")] } } })).toEqual(["lumen dark: no record of the models' run"]);
      expect(aiProblems({ ...base, ai: { ...base.ai, runs: { lumen: [run("light"), run("dark", ["api.groq.com"])] } } })).toEqual(["lumen dark: reached api.groq.com, not a provider in use"]);
      expect(aiProblems({ ...base, ai: { ...base.ai, models: "gpt" } })).toEqual(["round.json names unknown models: gpt"]);
    });

    it("a round.json holding anything shaped like a key fails, in any set", () => {
      const leaked = real({ note: "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV" });
      expect(aiProblems(leaked)).toContain("round.json holds something shaped like an API key");
      expect(aiProblems({ designs: DESIGNS, note: "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345" })).toEqual(["round.json holds something shaped like an API key"]);
    });
  });
});
