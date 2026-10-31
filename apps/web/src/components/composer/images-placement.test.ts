import { fromPlainText, schema, toPlainText } from "@terno/richtext";
import { history, undo, redo } from "prosemirror-history";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { expect, it } from "vitest";
import { addPlaceholders, dropPlaceholders, placeImages, placeholderKey, placeholderPlugin } from "./images";

function editor() {
  const doc = fromPlainText("One two");
  const view = { state: EditorState.create({ doc, plugins: [placeholderPlugin, history()], selection: TextSelection.atEnd(doc) }), isDestroyed: false,
    dispatch(tr: Transaction) { view.state = view.state.apply(tr); } };
  return view as unknown as EditorView;
}
const pending = (id: string) => ({ id, url: `blob:${id}`, width: null });
const image = (id: string) => ({ id, node: schema.nodes.image.create({ cid: id, alt: id, width: 80 }) });
const text = (view: EditorView) => toPlainText(view.state.doc);

it("reversed staging completion preserves independent drop anchors, later typing and exact undo", () => {
  const view = editor();
  addPlaceholders(view, 4, [pending("a.png"), pending("c.jpg")]);
  addPlaceholders(view, 8, [pending("d.gif")]);
  view.dispatch(view.state.tr.insertText(" later"));
  placeImages(view, [image("d.gif")]);
  placeImages(view, [image("a.png"), image("c.jpg")]);
  expect(text(view)).toBe("One[image: a.png][image: c.jpg] two[image: d.gif] later");
  expect(placeholderKey.getState(view.state)!.find()).toEqual([]);
  expect(view.state.selection.eq(TextSelection.atEnd(view.state.doc))).toBe(true);
  expect(undo(view.state, view.dispatch.bind(view))).toBe(true);
  expect(text(view)).toBe("One two[image: d.gif] later");
  expect(redo(view.state, view.dispatch.bind(view))).toBe(true);
  expect(text(view)).toBe("One[image: a.png][image: c.jpg] two[image: d.gif] later");
});

it("a deleted anchor falls back to the end, and cancelled placeholders leave the document untouched", () => {
  const view = editor();
  addPlaceholders(view, 4, [pending("deleted")]);
  const tr = view.state.tr.delete(3, 6);
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, 1)));
  expect(placeholderKey.getState(view.state)!.find()).toEqual([]);
  placeImages(view, [image("deleted")]);
  expect(text(view)).toBe("Onwo[image: deleted]");
  const doc = view.state.doc;
  addPlaceholders(view, 1, [pending("cancelled")]);
  dropPlaceholders(view, ["cancelled"]);
  expect(view.state.doc).toBe(doc);
  expect(placeholderKey.getState(view.state)!.find()).toEqual([]);
});
