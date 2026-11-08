import type { ThreadSummary, TodayList } from "@terno/core";
import { expect, it, vi } from "vitest";

/** Plan 161 (the owner): Today holds the open row only while it's one of its rows; a newsletter opened from the digest isn't. */
type Params = { heldIds?: number[] };
const calls: Params[] = [];
let answer: (p: Params) => Promise<TodayList> = async () => list([]);
vi.mock("~/rpc/connection", () => ({
  client: {
    connectionVersion: 0,
    on: () => () => {},
    call: (method: string, params: Params) => {
      if (method !== "today.list") return new Promise(() => {});
      calls.push(params);
      return answer(params);
    },
  },
}));

const { getApp, setApp } = await import("~/state/app");
const { useList, reloadList } = await import("~/state/list");

const thread = (id: number) => ({ id, accountId: 1, subject: `t${id}`, snippet: "", fromName: "A", fromEmail: "a@x.test", lastDate: 1e9 - id, messageCount: 1, unread: false, starred: false, hasAttachments: false, categoryIds: [], inInbox: true, inSpam: false, inTrash: false }) as unknown as ThreadSummary;
function list(ids: number[], held: number[] = []): TodayList {
  // as the backend: only what the sections don't already hold
  return { sections: [{ kind: "needsYou", items: ids.map((id) => ({ thread: thread(id), why: { kind: "waiting" } })), more: 0 }], digest: null, now: 1e9, held: held.filter((id) => !ids.includes(id)).map(thread) } as unknown as TodayList;
}
const shown = () => useList.getState().items.map((t) => t.id);

it("a thread opened from outside Today's rows (the digest's newsletter) isn't held, so the list doesn't gain it", async () => {
  answer = async (p) => list([10, 11], p.heldIds ?? []);
  setApp({ today: true, view: "all", selectedId: null, checked: new Set() });
  await vi.waitFor(() => expect(shown()).toEqual([10, 11]));
  setApp({ selectedId: 99 });
  calls.length = 0;
  await reloadList({ keepSelection: true });
  expect(calls.at(-1)!.heldIds).toEqual([]);
  expect(shown()).toEqual([10, 11]);
  expect(getApp().selectedId).toBe(99);
  // a row of the list is still held while it's open: replied to, it stays where it was
  setApp({ selectedId: 11 });
  answer = async (p) => list([10], p.heldIds ?? []);
  await reloadList({ keepSelection: true });
  expect(calls.at(-1)!.heldIds).toEqual([11]);
  expect(shown()).toEqual([10, 11]);
});

it("a row opened while a refresh was on its way is asked for again, held, rather than lost (Codex review)", async () => {
  answer = async (p) => list([10, 11, 12], p.heldIds ?? []);
  setApp({ selectedId: 10 });
  await reloadList({ keepSelection: true });
  await vi.waitFor(() => expect(shown()).toEqual([10, 11, 12]));
  calls.length = 0;
  // 12 no longer needs you; the refresh asked while 10 was open
  let release!: () => void;
  answer = (p) => new Promise((r) => (release = () => r(list([10, 11], p.heldIds ?? []))));
  const first = reloadList({ keepSelection: true });
  setApp({ selectedId: 12 });
  answer = async (p) => list([10, 11], p.heldIds ?? []);
  release();
  await first;
  await vi.waitFor(() => expect(shown()).toEqual([10, 11, 12]));
  expect(calls.map((c) => c.heldIds)).toEqual([[10], [12]]);
});
