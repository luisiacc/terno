// @vitest-environment jsdom
/** Plan 188: F6's order, from the dock and over a full message (Codex review). */
import { beforeEach, expect, it, vi } from "vitest";

const dock = vi.hoisted(() => ({ from: null as HTMLElement | null }));
vi.mock("~/components/snack-dock", () => ({
  inDock: (el: Element | null) => !!el?.closest("[data-dock]"),
  dockCameFrom: () => dock.from,
  focusDock: () => {
    const b = document.querySelector<HTMLElement>("[data-dock] button");
    b?.focus();
    return !!b && document.activeElement === b;
  },
}));
vi.mock("~/components/thread-list", () => ({
  focusRows: () => document.querySelector<HTMLElement>("[role=listbox]")?.focus(),
  skipToList: () => document.querySelector<HTMLElement>("[role=listbox]")?.focus(),
}));
vi.mock("~/rpc/connection", () => ({ client: { call: () => Promise.resolve({}), on: () => () => {} } }));
vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }));
// jsdom lays nothing out: on screen unless display:none
Element.prototype.getClientRects = function (this: Element) {
  return ((this as HTMLElement).style?.display === "none" || this.closest("[hidden]") ? [] : [new DOMRect(0, 0, 10, 10)]) as unknown as DOMRectList;
};

const { movePane } = await import("./pane-focus");
const { useSnack } = await import("~/lib/snack");
const { useList } = await import("~/state/list");

beforeEach(() => {
  document.body.innerHTML = `
    <aside id="app-sidebar"><button aria-current="page" data-testid="inbox">Inbox</button></aside>
    <section id="app-list"><div data-list-section><div role="listbox" tabindex="0"></div></div></section>
    <main><section data-testid="reader">x</section></main>
    <section data-dock><button data-testid="undo">Undo</button></section>`;
  useList.setState({ items: [{ id: 1 }] as never });
  useSnack.setState({ current: null });
  dock.from = null;
});

const id = () => (document.activeElement as HTMLElement).dataset.testid ?? (document.activeElement as HTMLElement).getAttribute("role");

it("a snack is F6's first stop; F6 goes on from where focus came; ⇧F6 from it is the plain reverse", () => {
  const reader = document.querySelector<HTMLElement>("[data-testid=reader]")!;
  reader.tabIndex = -1;
  reader.focus();
  useSnack.setState({ current: { seq: 1 } as never });
  expect(movePane(1)).toBe(true);
  expect(id()).toBe("undo");
  dock.from = reader;
  // forward: after the conversation (it came from there) is the sidebar
  expect(movePane(1)).toBe(true);
  expect(id()).toBe("inbox");
  document.querySelector<HTMLElement>("[data-testid=undo]")!.focus();
  // back: the conversation, the pane before the dock
  expect(movePane(-1)).toBe(true);
  expect(id()).toBe("reader");
});

it("over a full message the inert conversation is passed over for what's on screen in the main pane", () => {
  document.querySelector("main")!.innerHTML = `<div inert><section data-testid="reader" tabindex="-1">x</section></div><section data-testid="full-message"><button data-testid="back">Back</button></section>`;
  document.querySelector<HTMLElement>("[role=listbox]")!.focus();
  expect(movePane(1)).toBe(true);
  expect(id()).toBe("back");
});
