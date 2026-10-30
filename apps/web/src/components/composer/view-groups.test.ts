// @vitest-environment jsdom
import { fromPlainText, toEmailHtml, toPlainText } from "@terno/richtext";
import { EditorState, TextSelection, AllSelection } from "prosemirror-state";
import { EditorView, Decoration, DecorationSet } from "prosemirror-view";
import { history, undo, redo } from "prosemirror-history";
import { expect, it } from "vitest";

function setup(size: number | null = 2) {
  const doc = fromPlainText("first\nsecond\n\nfourth\nfifth\nsixth");
  const mount = document.body.appendChild(document.createElement("div"));
  const view = new EditorView(mount, {
    state: EditorState.create({ doc, plugins: [history()] }),
    siblingGroups: () => size,
    handleScrollToSelection: () => true,
    dispatchTransaction(tr) { view.updateState(view.state.apply(tr)); },
  });
  return { view, close() { view.destroy(); mount.remove(); } };
}
function matrix(view: EditorView) {
  for (let pos = 0; pos <= view.state.doc.content.size; pos++) {
    for (const side of [-1, 0, 1]) {
      const dom = view.domAtPos(pos, side);
      for (const bias of [-1, 1]) expect(view.posAtDOM(dom.node, dom.offset, bias), `${pos}/${side}/${bias}`).toBe(pos);
    }
  }
}
it("supports real sibling ancestors and exact boundary7 round trips", () => {
  const { view, close } = setup();
  try {
    expect(view.dom.querySelectorAll(":scope > .ProseMirror-sibling-group")).toHaveLength(3);
    const dom = view.domAtPos(7);
    expect(view.posAtDOM(dom.node, dom.offset)).toBe(7);
    matrix(view);
  } finally { close(); }
});
it("leaves the default public topology unchanged", () => {
  const { view, close } = setup(null);
  try { expect(view.dom.children).toHaveLength(6); matrix(view); } finally { close(); }
});
it("preserves exact model/text/HTML, native backward selection and history across topology changes", () => {
  const { view, close } = setup();
  try {
    const original = view.state.doc;
    const saved = [toPlainText(original), toEmailHtml(original)];
    view.focus();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(original, 24, 2)));
    expect(view.posAtDOM(document.getSelection()!.anchorNode!, document.getSelection()!.anchorOffset)).toBe(24);
    expect(view.posAtDOM(document.getSelection()!.focusNode!, document.getSelection()!.focusOffset)).toBe(2);
    view.dispatch(view.state.tr.insertText("new", 8));
    matrix(view);
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(view.state.doc.eq(original)).toBe(true);
    expect([toPlainText(view.state.doc), toEmailHtml(view.state.doc)]).toEqual(saved);
    expect(redo(view.state, view.dispatch)).toBe(true);
    view.setProps({ siblingGroups: () => 3 });
    view.dispatch(view.state.tr.insertText("!", 1));
    matrix(view);
    view.setProps({ siblingGroups: () => null });
    view.dispatch(view.state.tr.insertText("?", 1));
    expect(view.dom.querySelector(".ProseMirror-sibling-group")).toBeNull();
    matrix(view);
    view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
    expect(document.getSelection()!.toString()).toBe(view.dom.textContent);
  } finally { close(); }
});
it("keeps zero-size widgets and decoration order at group edges", () => {
  const { view, close } = setup();
  try {
    const deco = DecorationSet.create(view.state.doc, [-1, 1].map(side => Decoration.widget(7, () => document.createElement("span"), { side })));
    view.setProps({ decorations: () => deco });
    matrix(view);
  } finally { close(); }
});
