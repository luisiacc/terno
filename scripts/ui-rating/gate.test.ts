import { describe, expect, it } from "vitest";
import { belowBar, DESIGNS, FACETS, RATERS, reportProblems, SCREENS, verdict } from "./gate.mjs";

function report(score = 9) {
  return {
    viewed_all_images: true,
    overall: { score, why: "x" },
    ui: { score, why: "x" },
    ux: { score, why: "x" },
    screens: Object.fromEntries(SCREENS.map((s) => [s, { overall: score, facets: Object.fromEntries(FACETS.map((f) => [f, { score, improve: "x" }])) }])),
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
});
