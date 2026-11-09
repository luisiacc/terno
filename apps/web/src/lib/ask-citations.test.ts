import { describe, expect, it } from "vitest";
import { answerBlocks, boldParts, citationRuns } from "./ask-citations";

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

describe("plan 162 (after ai162-r04): an answer's lists and bold", () => {
  it("reads '- ' and '1. ' lines as lists, the rest as paragraphs split by a blank line", () => {
    expect(answerBlocks("Three wrote:\n- Isabella Cruz, on 18 October [2]\n- Isabella Rivera [3]\n\nThat's all.")).toEqual([
      { kind: "p", text: "Three wrote:" },
      { kind: "ul", items: ["Isabella Cruz, on 18 October [2]", "Isabella Rivera [3]"] },
      { kind: "p", text: "That's all." },
    ]);
    expect(answerBlocks("1. First [1]\n2) Second")).toEqual([{ kind: "ol", items: ["First [1]", "Second"] }]);
    // a hyphen inside a sentence is a hyphen
    expect(answerBlocks("A well-known - and old - sender")).toEqual([{ kind: "p", text: "A well-known - and old - sender" }]);
  });
  it("reads **bold** and nothing else; a lone ** is dropped", () => {
    expect(boldParts("Paid **USD 200** [1] on *Friday*")).toEqual([{ text: "Paid ", bold: false }, { text: "USD 200", bold: true }, { text: " [1] on *Friday*", bold: false }]);
    expect(boldParts("odd ** marker")).toEqual([{ text: "odd  marker", bold: false }]);
  });
});
