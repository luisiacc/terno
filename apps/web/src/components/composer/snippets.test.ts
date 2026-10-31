// @vitest-environment jsdom
/**
 * Plan 89: a snippet into the text: variables filled across formatting (each
 * keeping its first character's marks), the unfilled one selected, an empty
 * body replaced whole, a one-line snippet joining the caret's line, one undo
 * step, and never an image.
 */
import { fromPlainText, schema, toPlainText } from "@terno/richtext";
import { undo } from "prosemirror-history";
import { EditorState, TextSelection } from "prosemirror-state";
import { Transform } from "prosemirror-transform";
import { describe, expect, it } from "vitest";
import { newState } from "./editor";
import { filledBody, fillVariables, insertSnippetTr, snippetDoc, withoutImages } from "./snippets";

const { nodes, marks } = schema;
const p = (...content: Parameters<typeof nodes.paragraph.create>[1][]) => nodes.paragraph.create(null, content.flat() as never);
const text = (s: string, m: ReturnType<typeof marks.bold.create>[] = []) => schema.text(s, m);

describe("fillVariables", () => {
  it("fills a variable split by formatting, with its first character's marks", () => {
    const bold = marks.bold.create();
    const doc = nodes.doc.create(null, [p([text("Hi "), text("{first", [bold]), text("_name}!")])]);
    const tr = new Transform(doc);
    expect(fillVariables(tr, 0, doc.content.size, { first_name: "Ana" })).toEqual([]);
    expect(tr.doc.textContent).toBe("Hi Ana!");
    const ana = tr.doc.firstChild!.child(1);
    expect([ana.text, ana.marks.map((m) => m.type.name)]).toEqual(["Ana", ["bold"]]);
  });

  it("returns the unfilled ones where they end up, around values longer and shorter than their tokens", () => {
    const doc = fromPlainText("{email} {first_name} {my_name} {last_name}");
    const tr = new Transform(doc);
    const left = fillVariables(tr, 0, doc.content.size, { email: "a@verylongdomain.example", my_name: "Lu" });
    expect(tr.doc.textContent).toBe("a@verylongdomain.example {first_name} Lu {last_name}");
    expect(left.map((r) => tr.doc.textBetween(r.from, r.to))).toEqual(["{first_name}", "{last_name}"]);
  });

  it("only touches the range it was given", () => {
    const doc = fromPlainText("{first_name}\n{first_name}");
    const tr = new Transform(doc);
    fillVariables(tr, doc.child(0).nodeSize, doc.content.size, { first_name: "Ana" });
    expect(toPlainText(tr.doc)).toBe("{first_name}\nAna");
  });
});

describe("insertSnippetTr", () => {
  const snippet = snippetDoc("<p>Thanks, <b>{first_name}</b>!</p>", "");

  it("replaces an empty body whole and puts the caret after it", () => {
    const state = newState(fromPlainText(""));
    const next = state.apply(insertSnippetTr(state, snippet, { first_name: "Ana" }));
    expect(toPlainText(next.doc)).toBe("Thanks, Ana!");
    expect(next.doc.childCount).toBe(1);
    expect(next.selection.empty && next.selection.from).toBe(next.doc.content.size - 1);
  });

  it("joins a one-line snippet into the line at the caret, the user's text untouched", () => {
    let state = newState(fromPlainText("Hello {first_name} — "));
    state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
    const next = state.apply(insertSnippetTr(state, snippet, { first_name: "Ana" }));
    expect(toPlainText(next.doc)).toBe("Hello {first_name} — Thanks, Ana!");
  });

  it("selects the first variable it couldn't fill, to type over", () => {
    const state = newState(fromPlainText(""));
    const next = state.apply(insertSnippetTr(state, snippetDoc("", "Dear {first_name},\nBest, {my_first_name}"), { my_first_name: "Luis" }));
    expect(next.doc.textBetween(next.selection.from, next.selection.to)).toBe("{first_name}");
    expect(toPlainText(next.doc)).toBe("Dear {first_name},\nBest, Luis");
  });

  it("is one undo step, apart from what was typed just before", () => {
    let state = newState(fromPlainText(""));
    state = state.apply(state.tr.insertText("Hi"));
    state = state.apply(insertSnippetTr(state, snippetDoc("", " there"), {}));
    expect(toPlainText(state.doc)).toBe("Hi there");
    undo(state, (tr) => (state = state.apply(tr)));
    expect(toPlainText(state.doc)).toBe("Hi");
  });
});

it("never carries an image", () => {
  const doc = nodes.doc.create(null, [p([text("a"), nodes.image.create({ cid: "x@terno" }), text("b")])]);
  expect(withoutImages(doc).textContent).toBe("ab");
  const html = filledBody('<p>Hi {first_name}<img src="cid:abc@terno"></p>', "", { first_name: "Ana" }).html;
  expect(html).not.toMatch(/<img/i);
  expect(html).toContain("Hi Ana");
});

it("an empty state stays valid (no plugins needed for the transform)", () => {
  const state = EditorState.create({ doc: fromPlainText("") });
  expect(() => state.apply(insertSnippetTr(state, snippetDoc("", "x"), {}))).not.toThrow();
});
