import type { ThreadSummary } from "@terno/core";
import { beforeEach, expect, it, vi } from "vitest";

/** Plan 177: the Inbox's top with Pinned in front of Reminders, published only with the page it came with. */

type Params = { cursor?: unknown; limit?: number; accountId?: number; dueOnly?: boolean };
const calls: { method: string; params: Params }[] = [];
let answer: (params: Params, method: string) => Promise<unknown> = async () => ({});
vi.mock("~/rpc/connection", () => ({
  client: {
    call: (method: string, params: Params) => {
      calls.push({ method, params });
      return answer(params, method);
    },
  },
}));

const { setApp, getApp } = await import("~/state/app");
const { useList, inboxTop, reloadList } = await import("~/state/list");
const { usePins } = await import("~/state/pins");
const { useReminders } = await import("~/state/reminders");

const row = (id: number) => ({ id, lastDate: 1e9 - id, unread: false, starred: false, hasAttachments: false, categoryIds: [] }) as unknown as ThreadSummary;
const ids = () => useList.getState().items.map((t) => t.id);

/** the Inbox's mail 1…12, pins 7 then 5 (newest first), due reminders on 5 and 9 */
function mailbox(over: Partial<Record<string, (p: Params) => Promise<unknown>>> = {}) {
  answer = (p, method) => {
    const own = over[method];
    if (own) return own(p);
    if (method === "pins.threads") return Promise.resolve({ items: [row(7), row(5)] });
    if (method === "reminders.threads") return Promise.resolve({ items: [row(5), row(9)] });
    if (method === "threads.list") return Promise.resolve({ items: Array.from({ length: 12 }, (_, i) => row(i + 1)), nextCursor: null });
    return Promise.resolve({});
  };
}

beforeEach(() => {
  calls.length = 0;
  usePins.setState({ ids: new Set([5, 7]), loaded: true });
  useReminders.setState({ byThread: new Map(), due: 2, loaded: true });
});

it("Pinned leads, newest pin first; then the due reminders that aren't pinned; each row once", async () => {
  mailbox();
  setApp({ query: "", view: "inbox", accountId: null, categoryId: null, reviewCategoryId: null, folder: null, selectedId: null, checked: new Set() });
  await reloadList({ keepSelection: true });
  expect(ids().slice(0, 4)).toEqual([7, 5, 9, 1]);
  expect(ids().filter((id) => id === 5 || id === 7 || id === 9)).toHaveLength(3);
  expect({ ids: inboxTop.ids, pinned: inboxTop.pinned }).toEqual({ ids: [7, 5, 9], pinned: 2 });
});

it("nothing pinned: no pins asked for, and the top is the reminders' alone", async () => {
  usePins.setState({ ids: new Set(), loaded: true });
  mailbox();
  await reloadList({ keepSelection: true });
  expect(calls.some((c) => c.method === "pins.threads")).toBe(false);
  expect({ ids: inboxTop.ids, pinned: inboxTop.pinned }).toEqual({ ids: [5, 9], pinned: 0 });
});

it("a slow answer for one account never sets the top of the account shown since (Codex review of the plan, 3)", async () => {
  let release: (v: unknown) => void = () => {};
  mailbox({ "pins.threads": (p) => (p.accountId === 1 ? new Promise((r) => (release = r)) : Promise.resolve({ items: [] })) });
  setApp({ accountId: 1 });
  await vi.waitFor(() => expect(calls.some((c) => c.method === "pins.threads" && c.params.accountId === 1)).toBe(true));
  setApp({ accountId: 2 });
  await vi.waitFor(() => expect(useList.getState().itemsKey).toContain(",2,"));
  expect(inboxTop.pinned).toBe(0);
  release({ items: [row(7), row(5)] });
  await new Promise((r) => setTimeout(r, 10));
  // account 2 has nothing pinned: its top is its due reminders alone
  expect(inboxTop.pinned).toBe(0);
  expect(inboxTop.ids).toEqual([5, 9]);
  setApp({ accountId: null });
  await vi.waitFor(() => expect(useList.getState().itemsKey).toContain(",null,"));
});

it("outside the plain Inbox there is no top: Archive's rows come as they are", async () => {
  mailbox();
  setApp({ view: "archive" });
  await vi.waitFor(() => expect(useList.getState().itemsKey).toContain('"archive"'));
  expect(inboxTop.ids).toEqual([]);
  expect(calls.some((c) => c.method === "pins.threads")).toBe(false);
  setApp({ view: "inbox" });
  await vi.waitFor(() => expect(useList.getState().itemsKey).toContain('"inbox"'));
});

it("the open row the Reminders part held stays there once its reminder ended; an unpinned open row goes to its place (Codex review of the plan, 2)", async () => {
  mailbox();
  await reloadList({ keepSelection: true });
  expect(ids().slice(0, 3)).toEqual([7, 5, 9]);
  // 9 is open and its reminder ended: it stays under Reminders while open
  setApp({ selectedId: 9 });
  mailbox({ "reminders.threads": () => Promise.resolve({ items: [row(5)] }) });
  await reloadList({ keepSelection: true });
  expect(ids().slice(0, 3)).toEqual([7, 5, 9]);
  expect(inboxTop.pinned).toBe(2);
  // 7 is open and unpinned: it isn't held, it goes to its date's place
  setApp({ selectedId: 7 });
  usePins.setState({ ids: new Set([5]), loaded: true });
  mailbox({ "pins.threads": () => Promise.resolve({ items: [row(5)] }), "reminders.threads": () => Promise.resolve({ items: [] }) });
  await reloadList({ keepSelection: true });
  expect(ids()[0]).toBe(5);
  expect(inboxTop).toMatchObject({ pinned: 1 });
  expect(ids().indexOf(7)).toBe(6);
  expect(getApp().selectedId).toBe(7);
});
