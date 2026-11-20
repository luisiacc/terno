// @vitest-environment jsdom
/**
 * Plan 225: what the reader shows is read after the dwell, however it came to be open: once per showing, only while the
 * window can be seen, and never over a read state the user set by hand.
 */
import type { ThreadSummary } from "@terno/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const acts = vi.hoisted(() => [] as { action: string; ids: number[] }[]);
vi.mock("~/lib/actions", () => ({ act: (action: string, ids: number[]) => (acts.push({ action, ids }), Promise.resolve()) }));
vi.mock("~/rpc/connection", () => ({ client: { call: () => Promise.resolve({}), on: () => () => {} } }));

const { READ_DWELL, showThread } = await import("./read-on-show");
const { readSetByHand } = await import("./read-by-hand");
const { setApp, setListAutoSelection, setAppOpened } = await import("~/state/app");
const { useList } = await import("~/state/list");
const { useThreads } = await import("~/state/threads");

const row = (id: number, unread = true) => ({ id, unread }) as unknown as ThreadSummary;
const list = (...rows: ThreadSummary[]) => useList.setState({ items: rows, index: new Map(rows.map((r, i) => [r.id, i])) });
let hiddenNow = false;
const visibility = (hidden: boolean) => {
  hiddenNow = hidden;
  document.dispatchEvent(new Event("visibilitychange"));
};

beforeEach(() => {
  vi.useFakeTimers();
  acts.length = 0;
  hiddenNow = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hiddenNow });
  list(row(1), row(2), row(3, false));
  useThreads.setState({ details: new Map() });
  setApp({ selectedId: null });
});
afterEach(() => vi.useRealTimers());

describe("what the reader shows is read (plan 225)", () => {
  it("after the dwell, not before, whoever opened it: the user, the first load, the app going on after Archive", () => {
    for (const open of [(id: number) => setApp({ selectedId: id }), setListAutoSelection, setAppOpened]) {
      acts.length = 0;
      open(1);
      const end = showThread(1);
      vi.advanceTimersByTime(READ_DWELL - 1);
      expect(acts).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(acts).toEqual([{ action: "markRead", ids: [1] }]);
      end();
    }
  });

  it("a showing that ends inside the dwell (j held, the reader gone) reads nothing, nor does a selection moved on", () => {
    setApp({ selectedId: 1 });
    showThread(1)();
    vi.advanceTimersByTime(READ_DWELL);
    showThread(1);
    setApp({ selectedId: 2 });
    vi.advanceTimersByTime(READ_DWELL);
    expect(acts).toEqual([]);
  });

  it("Mark as unread inside a showing is the user's: before the dwell (shown read or unread), and after it", () => {
    // shown read, marked unread by hand before the dwell
    setApp({ selectedId: 3 });
    const a = showThread(3);
    readSetByHand([3]);
    list(row(1), row(2), row(3, true));
    vi.advanceTimersByTime(READ_DWELL * 3);
    expect(acts).toEqual([]);
    a();

    // shown unread (partly read), Mark as unread by hand before the dwell: it stays so (Codex review, round 2)
    setApp({ selectedId: 2 });
    const b = showThread(2);
    readSetByHand([2]);
    vi.advanceTimersByTime(READ_DWELL * 3);
    expect(acts).toEqual([]);
    b();

    // read by the dwell, then marked unread: nothing more this showing
    setApp({ selectedId: 1 });
    showThread(1);
    vi.advanceTimersByTime(READ_DWELL);
    expect(acts).toEqual([{ action: "markRead", ids: [1] }]);
    readSetByHand([1]);
    list(row(1, true), row(2), row(3));
    vi.advanceTimersByTime(READ_DWELL * 3);
    expect(acts).toHaveLength(1);
  });

  it("another conversation set by hand leaves this showing's read alone", () => {
    setApp({ selectedId: 1 });
    showThread(1);
    readSetByHand([2]);
    vi.advanceTimersByTime(READ_DWELL);
    expect(acts).toEqual([{ action: "markRead", ids: [1] }]);
  });

  it("reads the conversation as it is at the dwell: a cached copy that said read, refreshed unread meanwhile (Codex review, round 2)", () => {
    useThreads.setState({ details: new Map([[7, { thread: row(7, false), messages: [] } as never]]) });
    setApp({ selectedId: 7 });
    showThread(7);
    vi.advanceTimersByTime(READ_DWELL - 100);
    useThreads.setState({ details: new Map([[7, { thread: row(7, true), messages: [] } as never]]) });
    vi.advanceTimersByTime(100);
    expect(acts).toEqual([{ action: "markRead", ids: [7] }]);
  });

  it("counts only while the window can be seen: a launch in the background reads nothing until it's seen for the dwell", () => {
    setApp({ selectedId: 1 });
    hiddenNow = true;
    showThread(1);
    vi.advanceTimersByTime(READ_DWELL * 3);
    expect(acts).toEqual([]);
    visibility(false);
    vi.advanceTimersByTime(READ_DWELL - 100);
    // hidden inside the dwell: it starts over once seen again
    visibility(true);
    vi.advanceTimersByTime(READ_DWELL);
    visibility(false);
    vi.advanceTimersByTime(READ_DWELL - 1);
    expect(acts).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(acts).toEqual([{ action: "markRead", ids: [1] }]);
    // read: nothing more on the next time it's seen
    visibility(true);
    visibility(false);
    vi.advanceTimersByTime(READ_DWELL);
    expect(acts).toHaveLength(1);
  });

  it("off the list, the conversation the reader holds is read (a reload on one)", () => {
    useThreads.setState({ details: new Map([[7, { thread: row(7), messages: [] } as never]]) });
    setApp({ selectedId: 7 });
    showThread(7);
    vi.advanceTimersByTime(READ_DWELL);
    expect(acts).toEqual([{ action: "markRead", ids: [7] }]);
  });
});
