import { toPlainText } from "@terno/richtext";
import { closeHistory, undo } from "prosemirror-history";
import type { EditorState } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import { gapPieces } from "../ai-card";
import { docOf, newState } from "./editor";
import { findGaps, gapsKey, withGaps } from "./gaps";
import { generatedTr } from "./generated";

/** Plan 161: the model's gaps, marked in the real editor state, with its real plugins. */
const write = (state: EditorState, text: string, gaps: string[]) => state.apply(withGaps(generatedTr(state, text, "replace", gaps[0]), gaps));
const marked = (state: EditorState) => gapsKey.getState(state)!.set.find().map((d) => state.doc.textBetween(d.from, d.to));
const type = (state: EditorState, text: string, at = state.doc.content.size - 1) => state.apply(state.tr.insertText(text, at));

describe("the model's gaps in the composer", () => {
  it("marks exactly the gaps it was given, every time each is there, and never a bracket the user typed", () => {
    let state = write(newState(docOf("", "")), "Yes. [What you think.]\n\nSee [this]. [What you think.]", ["[What you think.]"]);
    expect(marked(state)).toEqual(["[What you think.]", "[What you think.]"]);
    state = type(state, " [mine]");
    expect(marked(state)).toEqual(["[What you think.]", "[What you think.]"]);
  });

  it("follows edits: filled in, the mark goes; undone, it's back", () => {
    let state = write(newState(docOf("", "")), "Yes. [When.] Thanks.", ["[When.]"]);
    const at = findGaps(state.doc, ["[When.]"])[0]!;
    state = state.apply(closeHistory(state.tr.insertText("Friday", at.from, at.to)));
    expect(toPlainText(state.doc)).toBe("Yes. Friday Thanks.");
    expect(marked(state)).toEqual([]);
    undo(state, (tr) => { state = state.apply(tr); });
    expect(marked(state)).toEqual(["[When.]"]);
  });

  it("does nothing, and keeps no set, when a draft came with none", () => {
    const before = newState(docOf("", ""));
    const state = write(before, "Plain. [not a gap]", []);
    expect(gapsKey.getState(state)).toBe(gapsKey.getState(before));
    expect(marked(state)).toEqual([]);
  });

  it("a match ends at a line's end, as findPlaceholders reads one", () => {
    const state = newState(docOf("", "Start [half\nrest]"));
    expect(findGaps(state.doc, ["[half\nrest]"])).toEqual([]);
  });
});

describe("the card's pieces", () => {
  it("splits on exactly the given gaps, keeping every character", () => {
    const pieces = gapPieces("Thanks. [What you think.] See [this]. [What you think.]", ["[What you think.]", "[What you think.]"]);
    expect(pieces.filter((p) => p.gap).map((p) => p.text)).toEqual(["[What you think.]", "[What you think.]"]);
    expect(pieces.map((p) => p.text).join("")).toBe("Thanks. [What you think.] See [this]. [What you think.]");
    // a gap's regex characters are literal
    expect(gapPieces("a (b) [c.*]", ["[c.*]"]).filter((p) => p.gap).map((p) => p.text)).toEqual(["[c.*]"]);
    expect(gapPieces("none here", [])).toEqual([{ text: "none here", gap: false }]);
  });
});
