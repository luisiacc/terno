/**
 * Plan 24: the category tabs as views of the sidebar's and the quick
 * filter's state, and what fits on their row. Node, the RPC client mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const html = { classList: { contains: () => false, toggle() {} }, dataset: {}, setAttribute() {}, removeAttribute() {}, style: { setProperty() {}, removeProperty() {} } };
  const g = globalThis as Record<string, unknown>;
  g.document = { documentElement: html, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, head: { appendChild() {} }, createElement: () => ({}) };
  g.window = globalThis;
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const store = new Map<string, string>();
  g.localStorage = { setItem: (k: string, v: string) => void store.set(k, v), getItem: (k: string) => store.get(k) ?? null, removeItem: (k: string) => void store.delete(k) };
  g.requestAnimationFrame = () => 0;
  return { handlers: {} as Record<string, (params: unknown) => Promise<unknown>>, writes: 0 };
});

vi.mock("~/rpc/connection", () => ({
  client: {
    call: (method: string, params: unknown) => fake.handlers[method]?.(params) ?? Promise.resolve({ items: [], nextCursor: null }),
    on: () => () => {},
  },
}));

const { fitTabs, openTab, selectedTab, tabsShown, createCategory } = await import("./tabs");
const { getApp, setApp, useApp } = await import("~/state/app");

const at = (o: Partial<ReturnType<typeof getApp>>) => setApp({ view: "inbox", accountId: null, categoryId: null, reviewCategoryId: null, query: "", listFilters: new Map(), selectedId: 4, checked: new Set(), scope: null, readerOpen: false, ...o });

beforeEach(() => {
  fake.handlers = {};
  at({});
});

describe("which tab (plan 24)", () => {
  it("All on the inbox, Unread when the inbox is filtered to unread, the category on its list", () => {
    expect(selectedTab(getApp())).toBe("all");
    at({ listFilters: new Map([["inbox||", "unread"]]) });
    expect(selectedTab(getApp())).toBe("unread");
    // another filter on the inbox is still All (the "Filtered by" line says which)
    at({ listFilters: new Map([["inbox||", "attachments"]]) });
    expect(selectedTab(getApp())).toBe("all");
    at({ view: "all", categoryId: 3 });
    expect(selectedTab(getApp())).toBe(3);
  });

  it("no tabs where there's nothing to slice: other folders, a search, Revisar", () => {
    for (const o of [{ view: "sent" as const }, { query: "factura" }, { view: "all" as const, reviewCategoryId: 3 }]) {
      at(o);
      expect(tabsShown(getApp())).toBe(false);
      expect(selectedTab(getApp())).toBeNull();
    }
    at({ view: "inbox", accountId: 2 });
    expect(tabsShown(getApp())).toBe(true);
  });
});

describe("opening a tab", () => {
  const changes = () => {
    let n = 0;
    const off = useApp.subscribe(() => void n++);
    return { get n() { return n; }, off };
  };

  it("a category is the sidebar's category: its list, one state change", () => {
    const c = changes();
    openTab(3);
    expect(getApp()).toMatchObject({ view: "all", categoryId: 3, selectedId: null, readerOpen: false });
    expect(c.n).toBe(1);
    c.off();
  });

  it("Unread inside the inbox is ⌘L: the filter, the cursor kept; All turns it off", () => {
    openTab("unread");
    expect(getApp().listFilters.get("inbox||")).toBe("unread");
    expect(getApp().selectedId).toBe(4);
    openTab("all");
    expect(getApp().listFilters.get("inbox||")).toBeUndefined();
  });

  it("Unread from a category: the inbox, filtered, in one state change (one list load); the account kept", () => {
    at({ view: "all", categoryId: 3, accountId: 2 });
    const c = changes();
    openTab("unread");
    expect(getApp()).toMatchObject({ view: "inbox", categoryId: null, accountId: 2 });
    expect(getApp().listFilters.get("inbox|2|")).toBe("unread");
    expect(c.n).toBe(1);
    c.off();
  });

  it("the tab already open changes nothing", () => {
    const c = changes();
    openTab("all");
    expect(c.n).toBe(0);
    c.off();
  });

  it("+ makes the category with the next color and opens it; a refusal is said, nothing opens", async () => {
    setApp({ categories: [{ id: 1, name: "A", color: "rose" }] as never });
    let asked: unknown;
    fake.handlers["categories.create"] = async (p) => ((asked = p), { id: 9, name: "Recibos" });
    expect(await createCategory("  Recibos ")).toBe(true);
    expect(asked).toMatchObject({ name: "Recibos" });
    expect(getApp().categoryId).toBe(9);
    expect(await createCategory("   ")).toBe(false);
    fake.handlers["categories.create"] = async () => {
      throw new Error("A category with that name exists");
    };
    at({});
    expect(await createCategory("A")).toBe(false);
    expect(getApp().categoryId).toBeNull();
  });
});

describe("what fits on the row", () => {
  const base = { pinned: 200, more: 60, gap: 4 };
  it("everything, when it fits (no More)", () => {
    expect(fitTabs({ ...base, widths: [80, 80, 80], available: 1000, selected: -1 })).toEqual({ visible: [0, 1, 2], overflow: [] });
  });
  it("in order while they fit, the rest behind More (whose width is reserved)", () => {
    // room for categories: 600 - 200 - 60 - 4 = 336 → three of 84 (80 + gap)... four would be 336: exactly fits
    expect(fitTabs({ ...base, widths: [80, 80, 80, 80, 80, 80], available: 600, selected: -1 })).toEqual({ visible: [0, 1, 2, 3], overflow: [4, 5] });
  });
  it("the selected category is never hidden: it takes the end of the row", () => {
    const r = fitTabs({ ...base, widths: [80, 80, 80, 80, 80, 80], available: 600, selected: 5 });
    expect(r.visible).toEqual([0, 1, 2, 5]);
    expect(r.overflow).toEqual([3, 4]);
  });
  it("a wide selected one displaces as many as it needs", () => {
    const r = fitTabs({ ...base, widths: [80, 80, 80, 80, 240], available: 600, selected: 4 });
    expect(r.visible).toEqual([0, 4]);
    expect(r.overflow).toEqual([1, 2, 3]);
  });
  it("room for nothing but the pinned tabs: all behind More, the selected one still shown", () => {
    expect(fitTabs({ ...base, widths: [80, 80], available: 250, selected: -1 })).toEqual({ visible: [], overflow: [0, 1] });
    expect(fitTabs({ ...base, widths: [80, 80], available: 250, selected: 1 }).visible).toEqual([1]);
  });
});
