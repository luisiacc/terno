/**
 * The sidebar's "+" (plan 24, plan 67). Node, the RPC client mocked.
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
  return { handlers: {} as Record<string, (params: unknown) => Promise<unknown>> };
});

vi.mock("~/rpc/connection", () => ({
  client: {
    call: (method: string, params: unknown) => fake.handlers[method]?.(params) ?? Promise.resolve({ items: [], nextCursor: null }),
    on: () => () => {},
  },
}));

const { createCategory } = await import("./new-category");
const { getApp, setApp } = await import("~/state/app");

const at = (o: Partial<ReturnType<typeof getApp>>) => setApp({ view: "inbox", accountId: null, categoryId: null, reviewCategoryId: null, query: "", listFilters: new Map(), selectedId: 4, checked: new Set(), scope: null, readerOpen: false, ...o });

beforeEach(() => {
  fake.handlers = {};
  at({});
});

describe("a new category", () => {
  it("is made with the next color and opened; a refusal is said, nothing opens", async () => {
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

  it("plan 67 (Codex R2): opens for all accounts, from inside one", async () => {
    setApp({ categories: [] as never });
    fake.handlers["categories.create"] = async () => ({ id: 9, name: "Recibos" });
    at({ view: "sent", accountId: 2 });
    expect(await createCategory("Recibos")).toBe(true);
    expect([getApp().categoryId, getApp().accountId]).toEqual([9, null]);
  });
});
