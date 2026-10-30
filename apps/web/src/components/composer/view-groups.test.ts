// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fromPlainText, toEmailHtml, toPlainText } from "@terno/richtext";
import { EditorState, TextSelection, AllSelection } from "prosemirror-state";
import { EditorView, Decoration, DecorationSet } from "prosemirror-view";
import { history, undo, redo } from "prosemirror-history";
import { expect, it, vi } from "vitest";

const cjs = createRequire(import.meta.url)("prosemirror-view") as typeof import("prosemirror-view");

function setup(size: number | null = 2, View = EditorView) {
  const doc = fromPlainText("first\nsecond\n\nfourth\nfifth\nsixth");
  const mount = document.body.appendChild(document.createElement("div"));
  const view = new View(mount, {
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
    expect(view.dom.querySelectorAll(":scope > .ProseMirror-sibling-group")).toHaveLength(2);
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
it("keeps public mapping valid inside node-view update callbacks", () => {
  const { view, close } = setup();
  let calls = 0;
  try {
    view.setProps({ nodeViews: { paragraph(node) {
      const dom = document.createElement("p");
      return { dom, contentDOM: dom, update(next) {
        if (next.type !== node.type) return false;
        calls++;
        const mapped = view.domAtPos(15);
        expect(view.posAtDOM(mapped.node, mapped.offset)).toBe(15);
        return true;
      } };
    } } });
    view.dispatch(view.state.tr.insertText("!", view.state.doc.content.size - 1));
    expect(calls).toBeGreaterThan(0);
    matrix(view);
  } finally { close(); }
});

it("matches the CJS public package entry and immediate same-document transitions", () => {
  const { view, close } = setup(2, cjs.EditorView);
  try {
    matrix(view);
    expect(view.dom.querySelectorAll(".ProseMirror-sibling-group")).toHaveLength(2);
    view.setProps({ siblingGroups: () => null });
    expect(view.dom.children).toHaveLength(6);
    view.setProps({ siblingGroups: () => 2 });
    matrix(view);
    expect(view.dom.querySelectorAll(".ProseMirror-sibling-group")).toHaveLength(2);
  } finally { close(); }
});
it("keeps unchanged sibling elements during repeated split/join and repairs observed DOM edits", async () => {
  const { view, close } = setup();
  try {
    const last = view.dom.lastElementChild;
    for (let i = 0; i < 8; i++) {
      view.dispatch(view.state.tr.split(10));
      matrix(view);
      view.dispatch(view.state.tr.join(11));
      matrix(view);
    }
    expect(view.dom.lastElementChild).toBe(last);
    const paragraph = view.dom.querySelector(".ProseMirror-sibling-group p")!;
    paragraph.firstChild!.nodeValue = "edited";
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(view.state.doc.child(1).textContent).toBe("edited");
    matrix(view);
    const group = view.dom.querySelector(".ProseMirror-sibling-group")!;
    group.replaceWith(...group.childNodes);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(view.state.doc.child(1).textContent).toBe("edited");
    matrix(view);
  } finally { close(); }
});
it("bounds huge group topology and DOM writes on interior text edits", () => {
  const { view, close } = setup();
  try {
    const doc = fromPlainText(Array.from({ length: 4098 }, (_, i) => String(i)).join("\n"));
    view.setProps({ siblingGroups: () => 128 });
    view.updateState(EditorState.create({ doc }));
    expect(view.dom.querySelectorAll(":scope > .ProseMirror-sibling-group")).toHaveLength(32);
    const groups = [...view.dom.children];
    const observer = new MutationObserver(() => {});
    observer.observe(view.dom, { childList: true, subtree: true });
    view.dispatch(view.state.tr.insertText("x", 10000));
    expect([...view.dom.children]).toEqual(groups);
    expect(observer.takeRecords().filter(record => record.type === "childList")).toHaveLength(0);
    observer.disconnect();
  } finally { close(); }
});
it("protects the composing ancestor and applies deferred topology after compositionend", async () => {
  const { view, close } = setup();
  try {
    view.focus();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 9)));
    const text = view.dom.querySelector(".ProseMirror-sibling-group p")!.firstChild!;
    const ancestor = text.parentElement!.parentElement;
    view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    expect(view.composing).toBe(true);
    view.setProps({ siblingGroups: () => null });
    expect(text.parentElement!.parentElement).toBe(ancestor);
    view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(view.composing).toBe(false);
    expect(view.dom.querySelector(".ProseMirror-sibling-group")).toBeNull();
    matrix(view);
  } finally { close(); }
});
it("keeps mixed nested blocks, inline atoms and marks exact across grouping and reordering", async () => {
  const { schema } = await import("@terno/richtext");
  const { view, close } = setup();
  const p = (text: string) => schema.nodes.paragraph!.create(null, schema.text(text, [schema.marks.bold!.create()]));
  try {
    const doc = schema.nodes.doc!.create(null, [p("edge"), schema.nodes.blockquote!.create(null, [p("quoted"), p("wrapped ".repeat(30))]), schema.nodes.bullet_list!.create(null, [schema.nodes.list_item!.create(null, p("item"))]), schema.nodes.paragraph!.create(null, [schema.text("before"), schema.nodes.image!.create({ cid: "synthetic", alt: "local" }), schema.text("after")]), p("tail")]);
    const saved = [toPlainText(doc), toEmailHtml(doc)];
    view.updateState(EditorState.create({ doc, plugins: [history()] }));
    matrix(view);
    expect([toPlainText(view.state.doc), toEmailHtml(view.state.doc)]).toEqual(saved);
    expect(view.dom.querySelectorAll("img")).toHaveLength(1);
    view.setProps({ siblingGroups: () => null }); matrix(view);
    view.setProps({ siblingGroups: () => 3 }); matrix(view);
    expect(view.state.doc.eq(doc)).toBe(true);
    const first = doc.firstChild!;
    view.dispatch(view.state.tr.delete(0, first.nodeSize).insert(doc.content.size - first.nodeSize, first));
    matrix(view);
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(view.state.doc.eq(doc)).toBe(true);
  } finally { close(); }
});
for (const View of [EditorView, cjs.EditorView]) {
it("renders a changed outer node-decoration wrapper without losing visible content", () => {
  const { view, close } = setup(2, View);
  try {
    const before = view.state.doc;
    const decoration = DecorationSet.create(before, [Decoration.node(7, 15, { nodeName: "div", class: "node-decoration" })]);
    view.setProps({ decorations: () => decoration });
    expect(view.dom.querySelector(".node-decoration p")?.textContent).toBe("second");
    expect(view.dom.textContent).toBe(before.textContent);
    matrix(view);
    view.setProps({ decorations: () => DecorationSet.empty });
    expect(view.dom.querySelector(".node-decoration")).toBeNull();
    expect(view.dom.textContent).toBe(before.textContent);
    matrix(view);
  } finally { close(); }
});
it("keeps the active composition ancestor when a root widget divides its sibling range", () => {
  const { view, close } = setup(2, View);
  try {
    view.focus();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 27)));
    const text = view.dom.querySelectorAll("p")[4]!.firstChild!;
    const ancestor = text.parentElement!.parentElement;
    view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    const decorations = DecorationSet.create(view.state.doc, [Decoration.widget(25, () => document.createElement("span"))]);
    view.setProps({ decorations: () => decorations });
    expect(text.parentElement!.parentElement).toBe(ancestor);
    matrix(view);
  } finally { close(); }
});
it("restores direct root boundaries after a same-target composition ends", async () => {
  const { view, close } = setup(2, View);
  try {
    view.focus();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 9)));
    const paragraph = view.dom.querySelectorAll("p")[1]!;
    const ancestor = paragraph.parentElement;
    view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    view.dispatch(view.state.tr.delete(0, 7));
    expect(paragraph.parentElement).toBe(ancestor);
    view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(view.dom.firstElementChild).toBe(paragraph);
    matrix(view);
  } finally { close(); }
});

}
it("ships the same observer invalidation in source, ESM and CJS", () => {
  const require = createRequire(import.meta.url);
  const dist = dirname(require.resolve("prosemirror-view"));
  const files = [join(dist, "../src/domobserver.ts"), join(dist, "index.js"), join(dist, "index.cjs")];
  const predicates = files.map(file => {
    const code = readFileSync(file, "utf8");
    const match = code.match(/if \((view\.docView && [^\n]+?)\)\s*view\.updateState\(view\.state\)/);
    expect(match, file).not.toBeNull();
    return match![1]!.replace(/\s/g, "");
  });
  expect(predicates[0]).toBe(predicates[1]);
  expect(predicates[0]).toBe(predicates[2]);
});

for (const [entry, View] of [["ESM", EditorView], ["CJS", cjs.EditorView]] as const) {
  it(`${entry}: reconciles huge text edits without allocating a whole-root owner map`, () => {
    const { view, close } = setup(128, View);
    const doc = fromPlainText(Array.from({ length: 4098 }, (_, i) => `line ${i}`).join("\n"));
    view.updateState(EditorState.create({ doc, plugins: [history()] }));
    let ownerEntries = 0;
    const set = Map.prototype.set;
    const spy = vi.spyOn(Map.prototype, "set").mockImplementation(function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
      if (value && typeof value === "object" && "dom" in value && value.dom instanceof HTMLElement && value.dom.classList.contains("ProseMirror-sibling-group")) ownerEntries++;
      return set.call(this, key, value);
    });
    try {
      for (const end of [false, true]) view.dispatch(view.state.tr.insertText("x", end ? view.state.doc.content.size - 1 : 1));
      expect(view.state.doc.firstChild!.textContent).toBe("xline 0");
      expect(view.state.doc.lastChild!.textContent).toBe("line 4097x");
      const removed = (view.dom.querySelector(".ProseMirror-sibling-group p") as unknown as { pmViewDesc: { groupOwner?: unknown; parent?: unknown } }).pmViewDesc;
      const from = view.state.doc.firstChild!.nodeSize;
      view.dispatch(view.state.tr.delete(from, from + view.state.doc.child(1).nodeSize));
      expect(removed.parent).toBeUndefined();
      expect(removed.groupOwner, "destroyed descriptions release temporary ownership").toBeUndefined();
      expect(ownerEntries, "existing group ownership is already known before flattening").toBe(0);
      for (const paragraph of view.dom.querySelectorAll("p")) {
        const desc = (paragraph as unknown as { pmViewDesc: { groupOwner?: unknown } }).pmViewDesc;
        expect(desc.groupOwner, "temporary ownership must not survive reconciliation").toBeUndefined();
      }
    } finally { spy.mockRestore(); close(); }
  });
}
