import { describe, expect, it } from "vitest";
import { citationRuns } from "./ask-citations";

describe("an answer's citations keep to their words (plan 161)", () => {
  it("binds a marker to the word before it and the punctuation after, the model's space gone", () => {
    expect(citationRuns("Isabella asks you to look into it [1]. Isabella Rivera raised the same on 14 July [2].")).toEqual([
      { text: "Isabella asks you to look into " },
      { lead: "it", cites: [1], trail: "." },
      { text: " Isabella Rivera raised the same on 14 " },
      { lead: "July", cites: [2], trail: "." },
    ]);
  });

  it("takes a stray space before the punctuation, and closing quotes and brackets with it", () => {
    expect(citationRuns("It renews [1] .")).toEqual([{ text: "It " }, { lead: "renews", cites: [1], trail: "." }]);
    expect(citationRuns("“late” [1]”), then")).toEqual([{ lead: "“late”", cites: [1], trail: "”)," }, { text: " then" }]);
  });

  it("markers side by side share one run; one at the start has no word", () => {
    expect(citationRuns("Both said so [1][2] [3].")).toEqual([{ text: "Both said " }, { lead: "so", cites: [1, 2, 3], trail: "." }]);
    expect(citationRuns("[1] First.")).toEqual([{ lead: "", cites: [1], trail: "" }, { text: " First." }]);
    expect(citationRuns("No citations here.")).toEqual([{ text: "No citations here." }]);
  });
});
