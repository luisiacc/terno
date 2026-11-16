// @vitest-environment jsdom
import type { ThreadSummary, TodayList } from "@terno/core";
import { expect, it, vi } from "vitest";

/**
 * Plan 161 (the owner): Today holds the open row only while it's one of its rows; a newsletter opened from the digest isn't.
 * Plan 210 (iteration 2): held by the row's own id, never its conversation's: the row the feed has open.
 */
type Params = { held?: string[] };
const calls: Params[] = [];
let answer: (p: Params) => Promise<TodayList> = async () => list([]);
vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
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
const { installToday, useFeedRow, useToday } = await import("~/state/today");
installToday();

const thread = (id: number) => ({ id, accountId: 1, subject: `t${id}`, snippet: "", fromName: "A", fromEmail: "a@x.test", lastDate: 1e9 - id, messageCount: 1, unread: false, starred: false, hasAttachments: false, categoryIds: [], inInbox: true, inSpam: false, inTrash: false }) as unknown as ThreadSummary;
function list(ids: number[]): TodayList {
  return { sections: [{ kind: "today", items: ids.map((id) => ({ id: `waiting:${id}`, thread: thread(id), why: { kind: "waiting" } })) }], digest: null, now: 1e9, counts: { missed: 0, today: 0, waiting: ids.length } } as unknown as TodayList;
}
const shown = () => useToday.getState().rows.map((r) => r.threadId);
const open = (id: number) => {
  useFeedRow.setState({ opened: `waiting:${id}` });
  setApp({ selectedId: id });
};

it("a thread opened from outside Today's rows (the digest's newsletter) isn't held, so the feed doesn't gain it", async () => {
  answer = async () => list([10, 11]);
  setApp({ today: true, view: "all", selectedId: null, checked: new Set() });
  await vi.waitFor(() => expect(shown()).toEqual([10, 11]));
  setApp({ selectedId: 99 });
  calls.length = 0;
  await reloadList({ keepSelection: true });
  expect(calls.at(-1)!.held).toEqual([]);
  expect(shown()).toEqual([10, 11]);
  expect(getApp().selectedId).toBe(99);
  // a row of the feed is still held while it's open: replied to, it stays where it was
  open(11);
  answer = async () => list([10]);
  await reloadList({ keepSelection: true });
  expect(calls.at(-1)!.held).toEqual(["waiting:11"]);
  expect(shown()).toEqual([10, 11]);
  expect(useList.getState().items.map((t) => t.id)).toEqual([10, 11]);
});

it("a row opened while a refresh was on its way is asked for again, held, rather than lost (Codex review)", async () => {
  answer = async () => list([10, 11, 12]);
  open(10);
  await reloadList({ keepSelection: true });
  await vi.waitFor(() => expect(shown()).toEqual([10, 11, 12]));
  calls.length = 0;
  // 12 no longer needs you; the refresh asked while 10 was open
  let release!: () => void;
  answer = () => new Promise((r) => (release = () => r(list([10, 11]))));
  const first = reloadList({ keepSelection: true });
  open(12);
  answer = async () => list([10, 11]);
  release();
  await first;
  await vi.waitFor(() => expect(shown()).toEqual([10, 11, 12]));
  expect(calls.map((c) => c.held)).toEqual([["waiting:10"], ["waiting:12"]]);
});
