// @vitest-environment jsdom
/**
 * Plan 188: the keys a screen reader user leans on. Arrows, Delete and Backspace stay with a focused control; a key that
 * moves the cursor brings focus along; Enter goes into the conversation; F6 moves between the panes; single keys can be
 * turned off. A hand-built shell (sidebar, list, main), the app's own keyboard handler.
 */
import type { ThreadSummary } from "@terno/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const gate = vi.hoisted(() => ({ acts: [] as string[] }));
vi.mock("~/rpc/connection", () => ({ client: { call: () => Promise.resolve({}), on: () => () => {} } }));
vi.mock("~/lib/actions", async (original) => ({ ...(await original<typeof import("~/lib/actions")>()), act: async (action: string) => void gate.acts.push(action) }));
vi.mock("~/components/thread-list", () => ({
  listScroller: {},
  focusSearch() {},
  closeEmptySearch() {},
  focusRows: () => document.querySelector<HTMLElement>("[role=listbox]")?.focus(),
  skipToList: () => document.querySelector<HTMLElement>("[role=listbox]")?.focus(),
}));
vi.mock("~/components/thread-menu", () => ({ openMenuForSelection() {}, openFocusedMenu: () => false }));
vi.mock("~/components/category-snackbar", () => ({ snackbarControls: { current: null } }));
vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }));
// jsdom lays nothing out: every pane here is on screen
Element.prototype.getClientRects = function () {
  return [new DOMRect(0, 0, 10, 10)] as unknown as DOMRectList;
};

const { installKeyboard } = await import("./keyboard");
const { getApp, setApp } = await import("~/state/app");
const { listKey, useList } = await import("~/state/list");
const { useAppearance } = await import("~/lib/appearance");
const { useSnack } = await import("~/lib/snack");
const { isMac } = await import("~/lib/select");

const row = (id: number): ThreadSummary => ({ id, subject: `Subject ${id}`, fromName: `Sender ${id}`, unread: false, starred: false, categoryIds: [], lastDate: 1000 - id }) as unknown as ThreadSummary;
let uninstall = () => {};

beforeEach(() => {
  gate.acts.length = 0;
  document.body.innerHTML = `
    <aside id="app-sidebar"><button data-testid="nav-inbox" aria-current="page">Inbox</button><button data-testid="nav-sent">Sent</button></aside>
    <section id="app-list"><div data-list-section><div role="listbox" tabindex="0" aria-label="Conversations"></div></div></section>
    <main><section data-testid="reader" tabindex="-1" aria-label="Conversation"><button data-testid="archive">Archive</button><button data-testid="message-toggle">Ana</button></section></main>`;
  useAppearance.setState({ layout: "split" });
  setApp({ view: "inbox", query: "", categoryId: null, accountId: null, reviewCategoryId: null, checked: new Set(), compose: null, selectedId: 1, readerOpen: false, dialog: null, menuOpen: false, settings: { characterKeys: true } as never });
  const items = [row(1), row(2), row(3)];
  useList.setState({ items, index: new Map(items.map((t, i) => [t.id, i])), key: listKey(), itemsKey: listKey(), nextCursor: null, loading: false, loadingMore: false });
  useSnack.setState({ current: null });
  uninstall = installKeyboard();
});
afterEach(() => uninstall());

const focus = (testId: string) => document.querySelector<HTMLElement>(`[data-testid=${testId}]`)!.focus();
const press = (key: string, mods: Partial<KeyboardEventInit> = {}) => {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods });
  (document.activeElement ?? document.body).dispatchEvent(e);
  return e;
};
const active = () => document.activeElement as HTMLElement;

describe("keys that belong to a focused control (plan 188)", () => {
  it("Delete and Backspace on a sidebar row trash nothing; on the list they do", async () => {
    focus("nav-sent");
    press("Delete");
    press("Backspace");
    await Promise.resolve();
    expect(gate.acts).toEqual([]);
    document.querySelector<HTMLElement>("[role=listbox]")!.focus();
    press("Delete");
    await Promise.resolve();
    expect(gate.acts).toEqual(["trash"]);
  });

  it("↓ on a sidebar row or a slider moves no cursor; on a toolbar button a click left focus on, and a message header, it does", () => {
    focus("nav-sent");
    expect(press("ArrowDown").defaultPrevented).toBe(false);
    document.body.insertAdjacentHTML("beforeend", `<div role="separator" tabindex="0" data-testid="edge"></div>`);
    focus("edge");
    expect(press("ArrowDown").defaultPrevented).toBe(false);
    expect(getApp().selectedId).toBe(1);
    focus("archive");
    press("ArrowDown");
    expect(getApp().selectedId).toBe(2);
    focus("message-toggle");
    press("ArrowDown");
    expect(getApp().selectedId).toBe(3);
  });
});

describe("focus follows the cursor (plan 188)", () => {
  it("j from a sidebar row moves the cursor and brings focus to the list", () => {
    focus("nav-sent");
    press("j");
    expect(getApp().selectedId).toBe(2);
    expect(active().getAttribute("role")).toBe("listbox");
  });

  it("Enter in Split opens the conversation and goes into it", () => {
    document.querySelector<HTMLElement>("[role=listbox]")!.focus();
    press("Enter");
    expect(active().dataset.testid).toBe("reader");
  });

  it("j from inside the conversation keeps focus there", () => {
    focus("reader");
    press("j");
    expect(getApp().selectedId).toBe(2);
    expect(active().dataset.testid).toBe("reader");
  });
});

describe("F6 between the panes (plan 188)", () => {
  it("sidebar → list → conversation → sidebar, and ⇧F6 back", () => {
    focus("nav-sent");
    expect(press("F6").defaultPrevented).toBe(true);
    expect(active().getAttribute("role")).toBe("listbox");
    press("F6");
    expect(active().dataset.testid).toBe("reader");
    press("F6");
    expect(active().dataset.testid).toBe("nav-inbox");
    press("F6", { shiftKey: true });
    expect(active().dataset.testid).toBe("reader");
  });

  it("never from a dialog: the key is left alone", () => {
    document.body.insertAdjacentHTML("beforeend", `<div role="dialog"><button data-testid="in-dialog">OK</button></div>`);
    focus("in-dialog");
    expect(press("F6").defaultPrevented).toBe(false);
    expect(active().dataset.testid).toBe("in-dialog");
  });
});

describe("single-key shortcuts off (plan 188, WCAG 2.1.4)", () => {
  it("e archives nothing and j moves nothing; ⌘⌫ still trashes and ↓ still moves", async () => {
    setApp({ settings: { characterKeys: false } as never });
    document.querySelector<HTMLElement>("[role=listbox]")!.focus();
    press("e");
    press("j");
    await Promise.resolve();
    expect(gate.acts).toEqual([]);
    expect(getApp().selectedId).toBe(1);
    press("Backspace", isMac ? { metaKey: true } : { ctrlKey: true });
    press("ArrowDown");
    await Promise.resolve();
    expect(gate.acts).toEqual(["trash"]);
    expect(getApp().selectedId).toBe(2);
  });
});
