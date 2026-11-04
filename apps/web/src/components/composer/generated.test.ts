import { toPlainText } from "@terno/richtext";
import { undo } from "prosemirror-history";
import type { EditorState } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import { docOf, newState } from "./editor";
import { generatedTr } from "./generated";

/** Plan 133 §10.1: the real document, the real history. */
const apply = (state: EditorState, ...args: Parameters<typeof generatedTr> extends [unknown, ...infer R] ? R : never) => state.apply(generatedTr(state, ...args));
const undone = (state: EditorState) => {
  let next = state;
  undo(state, (tr) => { next = state.apply(tr); });
  return next;
};

describe("model text into the document", () => {
  it("a line is a paragraph, a blank line an empty one, and the text reads back the same: what provenance compares", () => {
    const text = "Hi Tom,\n\nThat works.\n- one\n- two\n\nThanks";
    const state = apply(newState(docOf("", "")), text, "replace");
    expect(toPlainText(state.doc)).toBe(text);
    expect(state.doc.childCount).toBe(7);
  });

  it("is one undo step, and undo restores the empty body", () => {
    const state = apply(newState(docOf("", "")), "One\n\nTwo\n\nThree", "replace");
    const back = undone(state);
    expect(toPlainText(back.doc)).toBe("");
  });

  it("replaces notes, and undo brings them back exactly", () => {
    const notes = newState(docOf("", "fine with the 19th"));
    const state = apply(notes, "A full draft.", "replace");
    expect(toPlainText(state.doc)).toBe("A full draft.");
    expect(toPlainText(undone(state).doc)).toBe("fine with the 19th");
  });

  it("inserts below notes with a blank line, keeping them", () => {
    const state = apply(newState(docOf("", "fine with the 19th")), "A full draft.", "below");
    expect(toPlainText(state.doc)).toBe("fine with the 19th\n\nA full draft.");
    expect(toPlainText(undone(state).doc)).toBe("fine with the 19th");
  });

  it("the caret goes to the first placeholder, selected; otherwise the end", () => {
    const withOne = apply(newState(docOf("", "")), "See you on [date] at [time].", "replace", "[date]");
    const { from, to } = withOne.selection;
    expect(withOne.doc.textBetween(from, to)).toBe("[date]");
    const none = apply(newState(docOf("", "")), "See you.", "replace");
    expect(none.selection.empty).toBe(true);
    expect(none.selection.from).toBe(none.doc.content.size - 1);
  });

  it("below, the placeholder found is in what it wrote, not in the notes", () => {
    const state = apply(newState(docOf("", "my [date] here")), "On [date] then.", "below", "[date]");
    const { from, $from } = state.selection;
    expect($from.parent.textContent).toBe("On [date] then.");
    expect(state.doc.textBetween(from, state.selection.to)).toBe("[date]");
  });

  it("model output bypasses a snippet's variables: a literal {first_name} stays literal", () => {
    const state = apply(newState(docOf("", "")), "Dear {first_name}", "replace");
    expect(toPlainText(state.doc)).toBe("Dear {first_name}");
  });
});
