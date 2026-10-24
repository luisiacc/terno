/**
 * addToCategory's optimistic unread count: kept when the add succeeds,
 * reverted and re-read from the backend when it fails. Node, with the RPC
 * client mocked and a minimal fake <html>.
 */
import type { ThreadSummary } from "@terno/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const html = { classList: { contains: () => false, toggle() {} }, dataset: {}, setAttribute() {}, removeAttribute() {}, style: { setProperty() {}, removeProperty() {} } };
  const g = globalThis as Record<string, unknown>;
  g.document = { documentElement: html, querySelector: () => null, head: { appendChild() {} }, createElement: () => ({}) };
  g.window = globalThis;
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  g.localStorage = { setItem() {}, getItem: () => null };
  g.requestAnimationFrame = () => 0;
  return { handlers: {} as Record<string, (params: unknown) => Promise<unknown>>, calls: [] as string[] };
});

vi.mock("~/rpc/connection", () => ({
  client: {
    call: (method: string, params: unknown) => {
      fake.calls.push(method);
      const h = fake.handlers[method];
      return h ? h(params) : Promise.resolve({});
    },
  },
}));
vi.mock("sonner", () => ({ toast: Object.assign(() => {}, { error: vi.fn() }) }));

const { addToCategory } = await import("./categorize");
const { getApp, setApp, EMPTY_COUNTS } = await import("~/state/app");
const { useList } = await import("~/state/list");

const CAT = 7;
const row = (id: number, unread: boolean): ThreadSummary => ({ id, unread, categoryIds: [] }) as unknown as ThreadSummary;

beforeEach(() => {
  fake.calls.length = 0;
  fake.handlers = {};
  const items = [row(1, true), row(2, true), row(3, false)];
  useList.setState({ items, index: new Map(items.map((t, i) => [t.id, i])) });
  setApp({ counts: { ...EMPTY_COUNTS, categoryUnread: { [CAT]: 4 } } });
});

describe("addToCategory: unread counts", () => {
  it("bumps the category's unread count in the same frame", async () => {
    fake.handlers["categories.addThreads"] = async () => ({ added: 2, addedIds: [1, 2], batchId: 1 });
    const done = addToCategory(CAT, [1, 2, 3]);
    expect(getApp().counts.categoryUnread[CAT]).toBe(6);
    await done;
    expect(getApp().counts.categoryUnread[CAT]).toBe(6);
  });

  it("a rejected add takes the bump back and re-reads the real counts", async () => {
    let release!: () => void;
    const countsAsked = new Promise<void>((r) => (release = r));
    fake.handlers["categories.addThreads"] = async () => {
      throw new Error("refused");
    };
    fake.handlers["counts.get"] = async () => {
      release();
      return { ...EMPTY_COUNTS, categoryUnread: { [CAT]: 4 } };
    };
    await addToCategory(CAT, [1, 2]);
    // reverted at once, before the backend answers
    expect(getApp().counts.categoryUnread[CAT]).toBe(4);
    await countsAsked;
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.calls).toContain("counts.get");
    expect(getApp().counts.categoryUnread[CAT]).toBe(4);
  });

  it("if the counts can't be re-read either, the reverted value stands", async () => {
    fake.handlers["categories.addThreads"] = async () => {
      throw new Error("refused");
    };
    fake.handlers["counts.get"] = async () => {
      throw new Error("offline");
    };
    await addToCategory(CAT, [1]);
    await new Promise((r) => setTimeout(r, 0));
    expect(getApp().counts.categoryUnread[CAT]).toBe(4);
  });
});
