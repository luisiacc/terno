/**
 * The ghost plugin's rules on editor states (plan 18 §4.4), without a DOM:
 * what consumes a suggestion and what dismisses it, acceptance as its own
 * undo step, kept states without it, and the bounded window before the caret.
 */
import { fromPlainText, schema } from "@terno/richtext";
import { closeHistory, history, undo, redo } from "prosemirror-history";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import { Slice, Fragment } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { describe, expect, it } from "vitest";
import { acceptGhost, dismissGhost, ghostKey, ghostPlugin, windowAt, withoutGhost } from "./ghost";

const { nodes, marks } = schema;
const plugin = ghostPlugin(() => undefined);

function stateOf(text: string, caret?: number): EditorState {
  const doc = fromPlainText(text);
  const s = EditorState.create({ doc, plugins: [plugin, history()] });
  return s.apply(s.tr.setSelection(caret === undefined ? TextSelection.atEnd(doc) : TextSelection.create(doc, caret)));
}

/** A stand-in view: dispatch applies (what the plugin's commands need). */
function viewOf(state: EditorState) {
  const v = {
    state,
    dispatch(tr: Transaction) {
      v.state = v.state.apply(tr);
    },
  };
  return v as unknown as EditorView & { state: EditorState };
}

const ghost = (s: EditorState) => ghostKey.getState(s)!.ghost;
const typed = (s: EditorState) => ghostKey.getState(s)!.typed;
const show = (s: EditorState, text: string) => s.apply(s.tr.setMeta(ghostKey, { set: { text, pos: s.selection.from } }).setMeta("addToHistory", false));
const type = (s: EditorState, text: string) => s.apply(s.tr.insertText(text));

describe("consuming and dismissing", () => {
  it("typing the ghost's next characters consumes them; anything else dismisses it", () => {
    let s = show(stateOf("Let me know if"), " you have any questions.");
    expect(ghost(s)?.text).toBe(" you have any questions.");
    s = type(s, " yo");
    expect(ghost(s)?.text).toBe("u have any questions.");
    expect(ghost(s)?.pos).toBe(s.selection.from);
    s = type(s, "x");
    expect(ghost(s)).toBeNull();
  });

  it("typing all of it, a deletion, a caret move or a selection dismisses it", () => {
    const base = show(stateOf("Thanks for"), " your help");
    expect(ghost(type(base, " your help"))).toBeNull();
    expect(ghost(base.apply(base.tr.delete(base.selection.from - 1, base.selection.from)))).toBeNull();
    expect(ghost(base.apply(base.tr.setSelection(TextSelection.create(base.doc, 2))))).toBeNull();
    expect(ghost(base.apply(base.tr.setSelection(TextSelection.create(base.doc, 1, 4))))).toBeNull();
  });

  it("a paste, an IME composition and undo dismiss it and don't count as typing", () => {
    const base = show(stateOf("Thanks for"), " your help");
    const paste = base.apply(base.tr.replaceSelection(new Slice(Fragment.from(schema.text(" y")), 0, 0)).setMeta("uiEvent", "paste"));
    expect(ghost(paste)).toBeNull();
    expect(typed(paste)).toBe(typed(base));
    const composed = base.apply(base.tr.insertText(" y").setMeta("composition", 1));
    expect(ghost(composed)).toBeNull();
    expect(typed(composed)).toBe(typed(base));
    expect(typed(type(base, "!"))).toBe(typed(base) + 1);
  });

  it("dismissGhost clears it outside the history; a kept state has none", () => {
    const v = viewOf(show(stateOf("Hi"), " there"));
    expect(withoutGhost(v.state) === v.state).toBe(false);
    expect(ghost(withoutGhost(v.state))).toBeNull();
    expect(dismissGhost(v)).toBe(true);
    expect(ghost(v.state)).toBeNull();
    expect(dismissGhost(v)).toBe(false);
    expect(withoutGhost(v.state)).toBe(v.state);
  });
});

describe("accepting", () => {
  it("Tab's acceptance inserts the whole ghost as one undo step; what is typed next is another", () => {
    const v = viewOf(show(type(stateOf(""), "Let me know if"), " you have any questions."));
    // typing grouped so far: separate the history as the editor's typing pause would
    v.dispatch(closeHistory(v.state.tr));
    expect(acceptGhost(v)).toBe(true);
    expect(v.state.doc.textContent).toBe("Let me know if you have any questions.");
    expect(ghost(v.state)).toBeNull();
    expect(v.state.selection.from).toBe(v.state.doc.content.size - 1);
    v.dispatch(v.state.tr.insertText(" Thanks"));
    undo(v.state, v.dispatch);
    expect(v.state.doc.textContent).toBe("Let me know if you have any questions.");
    undo(v.state, v.dispatch);
    expect(v.state.doc.textContent).toBe("Let me know if");
    redo(v.state, v.dispatch);
    expect(v.state.doc.textContent).toBe("Let me know if you have any questions.");
  });

  it("→ accepts the next word and keeps the rest showing", () => {
    const v = viewOf(show(stateOf("Let me know if"), " you have any questions."));
    acceptGhost(v, true);
    expect(v.state.doc.textContent).toBe("Let me know if you");
    expect(ghost(v.state)?.text).toBe(" have any questions.");
    acceptGhost(v, true);
    acceptGhost(v, true);
    acceptGhost(v, true);
    expect(v.state.doc.textContent).toBe("Let me know if you have any questions.");
    expect(ghost(v.state)).toBeNull();
  });

  it("accepted text takes the marks at the caret (a bold sentence continues bold)", () => {
    const doc = nodes.doc.create(null, nodes.paragraph.create(null, schema.text("Thanks for", [marks.bold.create()])));
    let s = EditorState.create({ doc, plugins: [plugin, history()], selection: TextSelection.atEnd(doc) });
    s = show(s, " your help");
    const v = viewOf(s);
    acceptGhost(v);
    expect(v.state.doc.firstChild!.childCount).toBe(1);
    expect(marks.bold.isInSet(v.state.doc.firstChild!.firstChild!.marks)).toBeTruthy();
  });
});

describe("the window before the caret", () => {
  it("at the end of a line: up to 1,000 characters, earlier lines included", () => {
    expect(windowAt(stateOf("Hi Ana,\nLet me know if"))).toBe("Hi Ana,\nLet me know if");
    expect(windowAt(stateOf("Let me know if   "))).toBe("Let me know if   ");
  });

  it("nothing mid-line, on an empty line, in a selection", () => {
    expect(windowAt(stateOf("Let me know if you", 5))).toBeNull();
    expect(windowAt(stateOf("Hi\n"))).toBeNull();
    const s = stateOf("Hello there");
    expect(windowAt(s.apply(s.tr.setSelection(TextSelection.create(s.doc, 1, 4))))).toBeNull();
  });

  it("nothing in a quote, a link or fixed-width text", () => {
    const quoted = nodes.doc.create(null, nodes.blockquote.create(null, nodes.paragraph.create(null, schema.text("Let me know if"))));
    expect(windowAt(EditorState.create({ doc: quoted, selection: TextSelection.atEnd(quoted) }))).toBeNull();
    const linked = nodes.doc.create(null, nodes.paragraph.create(null, schema.text("see example.com", [marks.link.create({ href: "https://example.com" })])));
    // a caret inside a link (links aren't inclusive at their end: test inside)
    expect(windowAt(EditorState.create({ doc: linked, selection: TextSelection.create(linked, 6) }))).toBeNull();
    const mono = nodes.doc.create(null, nodes.paragraph.create(null, schema.text("const x", [marks.font.create({ value: "mono" })])));
    expect(windowAt(EditorState.create({ doc: mono, selection: TextSelection.atEnd(mono) }))).toBeNull();
  });

  it("a hard break is a line end: the line after it must have text", () => {
    const doc = nodes.doc.create(null, nodes.paragraph.create(null, [schema.text("Hi Ana,"), nodes.hard_break.create(), schema.text("Let me")]));
    expect(windowAt(EditorState.create({ doc, selection: TextSelection.atEnd(doc) }))).toBe("Hi Ana,\nLet me");
    const empty = nodes.doc.create(null, nodes.paragraph.create(null, [schema.text("Hi Ana,"), nodes.hard_break.create()]));
    expect(windowAt(EditorState.create({ doc: empty, selection: TextSelection.atEnd(empty) }))).toBeNull();
  });

  it("bounded in a 10 MB paragraph and in a 200,000-line draft", () => {
    const huge = "word ".repeat(2_000_000);
    const one = stateOf(huge.trimEnd());
    let t0 = performance.now();
    const w = windowAt(one)!;
    expect(performance.now() - t0).toBeLessThan(5);
    expect(w.length).toBe(1000);
    // with text after the caret on a 10 MB line: gives up after 256 characters
    const mid = stateOf(huge, 5_000_001);
    t0 = performance.now();
    expect(windowAt(mid)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(5);
    // a caret at the end of the line, in the middle of 200,000 lines
    const lines = stateOf(Array.from({ length: 200_000 }, (_, i) => `line ${i} of the draft`).join("\n"));
    const at = lines.doc.child(100_000);
    let pos = 0;
    for (let i = 0; i <= 100_000; i++) pos += lines.doc.child(i).nodeSize;
    const s = lines.apply(lines.tr.setSelection(TextSelection.create(lines.doc, pos - 1)));
    t0 = performance.now();
    const w2 = windowAt(s)!;
    expect(performance.now() - t0).toBeLessThan(5);
    expect(w2.endsWith(at.textContent)).toBe(true);
    expect(w2.split("\n")).toHaveLength(5);
  });
});
