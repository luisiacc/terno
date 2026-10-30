// @vitest-environment jsdom
import { fromPlainText } from "@terno/richtext";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { expect, it, vi } from "vitest";
import { acceptGhost, ghostKey, ghostPlugin } from "./ghost";

it("reads the caret's live computed typography before writing the fitting layer", () => {
  const mount = document.body.appendChild(document.createElement("div"));
  let frame: FrameRequestCallback | undefined;
  const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((f) => { frame = f; return 1; });
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  const plugin = ghostPlugin(() => undefined);
  const doc = fromPlainText("Could you take a");
  const view = new EditorView(mount, {
    state: EditorState.create({ doc, selection: TextSelection.atEnd(doc), plugins: [plugin] }),
    handleScrollToSelection: () => true,
    dispatchTransaction(tr) { view.updateState(view.state.apply(tr)); },
  });
  const layer = mount.querySelector<HTMLElement>(".rt-ghost-layer")!;
  const initialStyle = layer.style.cssText;
  const readsAfterWrite: string[] = [];
  const values: Record<string, string> = { lineHeight: "20px", fontFamily: "sans-serif", fontSize: "16px", fontWeight: "400", fontStyle: "normal", letterSpacing: "normal" };
  const computed = vi.spyOn(window, "getComputedStyle").mockImplementation(() => new Proxy({} as CSSStyleDeclaration, {
    get(_target, key: string) {
      if (layer.style.cssText !== initialStyle) readsAfterWrite.push(key);
      return values[key];
    },
  }));
  const rect = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => ({ left: 0, top: 0, right: 500, bottom: 20, width: 500, height: 20, x: 0, y: 0, toJSON() {} }));
  const coords = vi.spyOn(view, "coordsAtPos").mockReturnValue({ left: 120, right: 120, top: 0, bottom: 16 });
  try {
    view.dispatch(view.state.tr.setMeta(ghostKey, { set: { text: " look at this", pos: view.state.selection.from } }));
    expect(acceptGhost(view)).toBe(false);
    frame!(0);
    expect(layer.dataset.ghost).toBe(" look at this");
    expect(view.state.doc).toBe(doc);
    expect(layer.style.fontFamily).toBe("sans-serif");
    expect(layer.style.textIndent).toBe("120px");
    expect(readsAfterWrite).toEqual([]);
  } finally {
    computed.mockRestore(); rect.mockRestore(); coords.mockRestore();
    view.destroy(); mount.remove(); raf.mockRestore(); cancel.mockRestore();
  }
});
