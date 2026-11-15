// @vitest-environment jsdom
/**
 * Plan 210 (Codex code review): What matters' history pages through the list. A page is published with the rows it
 * brings, never before (one the list drops changes nothing), and a reload that waited while a page went deeper asks again,
 * as deep, so the depth loaded is never lost.
 */
import { beforeEach, expect, it, vi } from "vitest";
import type { ThreadSummary, TodayHistoryItem } from "@terno/core";

const rpc = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: { call: rpc.call, on: () => () => {}, connectionVersion: 1 } }));
vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }));
localStorage.setItem("terno.wm.look", "brief");
const { setApp } = await import("~/state/app");
const { useList, loadMore, reloadList } = await import("~/state/list");
const { useToday } = await import("~/state/today");

const thread = (id: number) => ({ id, lastDate: 1000 - id, subject: `S ${id}`, fromName: "A", categoryIds: [], unread: false }) as unknown as ThreadSummary;
const line = (id: number): TodayHistoryItem => ({ thread: thread(id), key: { at: 10_000 - id, src: 0, id }, outcome: "done", kind: "pay", text: `Pay ${id}` });
const answer = (lines: number[], next: number | null) => ({ sections: [{ kind: "needsYou", items: [{ thread: thread(1), why: { kind: "waiting", wrote: true } }] }], digest: null, now: 0, held: [], history: { items: lines.map(line), next: next === null ? null : line(next).key } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
const ids = () => useList.getState().items.map((t) => t.id);

beforeEach(async () => {
  rpc.call.mockReset();
  rpc.call.mockImplementation(async (method: string) => (method === "today.list" ? answer([10, 11], 11) : { items: [], next: null }));
  setApp({ today: true, view: "all", accountId: null, query: "", selectedId: null, checked: new Set(), scope: null, dialog: null });
  await reloadList();
});

it("a page the list drops (a newer answer came) publishes nothing; one it takes is published with its rows", async () => {
  expect(ids()).toEqual([1, 10, 11]);
  const late = deferred<{ items: TodayHistoryItem[]; next: null }>();
  rpc.call.mockImplementation((method: string) => (method === "today.history" ? late.promise : Promise.resolve(answer([10, 11], 11))));
  const more = loadMore();
  // the list moves on (another view) before the page answers
  setApp({ today: false, view: "inbox" });
  late.resolve({ items: [line(12)], next: null });
  await more;
  expect(useToday.getState().history.has(12)).toBe(false);
  setApp({ today: true, view: "all" });
  await reloadList();
  rpc.call.mockImplementation(async (method: string) => (method === "today.history" ? { items: [line(12)], next: null } : answer([10, 11], 11)));
  await loadMore();
  expect(ids()).toEqual([1, 10, 11, 12]);
  expect(useToday.getState().history.get(12)?.text).toBe("Pay 12");
  expect(useToday.getState().kinds.get(12)).toBe("history");
});

it("a reload that waited while a page went deeper asks again, down to the deepest line", async () => {
  const slow = deferred<ReturnType<typeof answer>>();
  const throughs: unknown[] = [];
  rpc.call.mockImplementation((method: string, params: { history?: { through: unknown } }) => {
    if (method === "today.history") return Promise.resolve({ items: [line(12), line(13)], next: null });
    throughs.push(params.history?.through ?? null);
    return throughs.length === 1 ? slow.promise : Promise.resolve(answer([10, 11, 12, 13], null));
  });
  const reload = reloadList({ keepSelection: true });
  await loadMore();
  expect(ids()).toEqual([1, 10, 11, 12, 13]);
  // the reload's answer was asked down to line 11, before the page came
  slow.resolve(answer([10, 11], 11));
  await reload;
  await vi.waitFor(() => expect(throughs).toHaveLength(2));
  expect(throughs[0]).toEqual(line(11).key);
  expect(throughs[1]).toEqual(line(13).key);
  await vi.waitFor(() => expect(ids()).toEqual([1, 10, 11, 12, 13]));
});

it("Codex code review, round 2: a page still on its way when a reload lands is dropped (its rows could bring back what the reload took away); the next page continues from the reload", async () => {
  const late = deferred<{ items: TodayHistoryItem[]; next: null }>();
  rpc.call.mockImplementation((method: string) => (method === "today.history" ? late.promise : Promise.resolve(answer([10], 10))));
  const more = loadMore();
  // line 11 left the history meanwhile (its item reopened, or it went to Spam): the reload says so first
  await reloadList({ keepSelection: true });
  expect(ids()).toEqual([1, 10]);
  late.resolve({ items: [line(11), line(12)], next: null });
  await more;
  expect(ids()).toEqual([1, 10]);
  expect(useToday.getState().history.has(11)).toBe(false);
  expect(useList.getState().loadingMore).toBe(false);
  rpc.call.mockImplementation(async (method: string, params: { after?: unknown }) => (method === "today.history" ? { items: params.after ? [line(12)] : [], next: null } : answer([10], 10)));
  await loadMore();
  expect(ids()).toEqual([1, 10, 12]);
});
