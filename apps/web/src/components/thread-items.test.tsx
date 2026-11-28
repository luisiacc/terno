// @vitest-environment jsdom
import type { DatedRow, ThreadDetail } from "@terno/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.hoisted(() => Object.assign(globalThis, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }));
const listeners = vi.hoisted(() => new Map<string, () => void>());
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn(), on: vi.fn((name: string, fn: () => void) => (listeners.set(name, fn), () => listeners.delete(name))), connectionVersion: 1 } }));

const { client } = await import("~/rpc/connection");
const { useApp } = await import("~/state/app");
const { useToday, useFeedRow, useReaderChoice } = await import("~/state/today");
const { readerItemCount, useReaderItems } = await import("./thread-items");
type Model = ReturnType<typeof useReaderItems>;

/** Plan 210 (iteration 3, Codex revision 10): the reader model's reads, as the reader holds them. */
const NOW = Date.now();
const dated = (id: number, threadId: number, text: string, dueAt: number): DatedRow =>
  ({ id, threadId, messageId: 1, item: 0, kind: "respond", text, quote: "", senderKey: "s", dueDay: new Date(dueAt).toISOString().slice(0, 10), dueAt, timed: false, dated: true, actAt: NOW - 1, deferredUntil: null, arrivedAt: NOW - 1, state: "open", closedReason: null, closedAt: null, fromScan: false, revision: 1, model: null, provider: null, createdAt: NOW - 1 }) as DatedRow;
const detail = (id: number) => ({ thread: { id, inTrash: false, inSpam: false }, messages: [] }) as unknown as ThreadDetail;
const DAY = 86_400_000;

let seen: Model | null = null;
function Probe({ id }: { id: number }) {
  seen = useReaderItems(detail(id));
  return null;
}

let root: ReturnType<typeof createRoot> | null = null;
async function render(id: number) {
  if (!root) {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () => root!.render(<Probe id={id} />));
}

/** Answers held until the test lets each go, in any order. */
const pending: { threadId: number; resolve: (rows: DatedRow[]) => void }[] = [];
beforeEach(() => {
  pending.length = 0;
  vi.mocked(client.call).mockImplementation(((method: string, args: { threadId: number }) =>
    method === "dated.ofThread" ? new Promise((resolve) => pending.push({ threadId: args.threadId, resolve: (rows) => resolve({ rows }) })) : Promise.resolve({})) as never);
  useApp.setState({ devAi: null, today: false, settings: { dated: { enabled: true }, followups: { enabled: false } } } as never);
  useToday.setState({ rows: [] });
  useFeedRow.setState({ opened: null, cursor: null, moves: 0 });
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  seen = null;
});

const answer = async (i: number, rows: DatedRow[]) => act(async () => pending[i]!.resolve(rows));

describe("the reader's items, read (plan 210, iteration 3)", () => {
  it("nothing is drawn until this conversation's read answers, then the soonest leads with no row of the feed open", async () => {
    await render(7);
    expect(seen!.ready).toBe(false);
    await answer(0, [dated(1, 7, "Send Jess your draft", NOW + 2 * DAY), dated(2, 7, "Board meeting", NOW + DAY)]);
    expect(seen!.ready).toBe(true);
    expect(seen!.top?.key).toBe("dated:2");
    expect(seen!.others.map((o) => o.key)).toEqual(["dated:1"]);
  });

  it("an older read answering last is dropped: what's shown is the latest", async () => {
    await render(7);
    await answer(0, [dated(1, 7, "Send Jess your draft", NOW + 2 * DAY), dated(2, 7, "Board meeting", NOW + DAY)]);
    // What matters changed twice: two reads on their way, the first answering last (with the meeting since done)
    await act(async () => listeners.get("todayChanged")!());
    await act(async () => listeners.get("todayChanged")!());
    await answer(2, [dated(1, 7, "Send Jess your draft", NOW + 2 * DAY)]);
    await answer(1, [dated(1, 7, "Send Jess your draft", NOW + 2 * DAY), dated(2, 7, "Board meeting", NOW + DAY)]);
    expect(seen!.top?.key).toBe("dated:1");
    expect(seen!.others).toEqual([]);
  });

  it("a conversation left before its read answers never shows its items in the next", async () => {
    await render(7);
    await render(8);
    await answer(0, [dated(1, 7, "Send Jess your draft", NOW + DAY)]);
    expect(seen!.ready).toBe(false);
    expect(seen!.top).toBeNull();
    await answer(1, [dated(5, 8, "Pay the rent", NOW + DAY)]);
    expect(seen!.top?.key).toBe("dated:5");
  });

  it("a history line's closed item opened beside an open sibling: nothing is drawn until its own read answers (Codex code review of iteration 3)", async () => {
    await render(7);
    await answer(0, [dated(2, 7, "Board meeting", NOW + DAY)]);
    expect(seen!.top?.key).toBe("dated:2");
    // the history line of a closed item of the same conversation opens: its read asks for it (`include`)
    await act(async () => {
      useApp.setState({ today: true });
      useToday.setState({ rows: [{ id: "history:dated:3", threadId: 7, line: { item: { source: "dated", id: 3 } } } as never] });
      useFeedRow.setState({ opened: "history:dated:3" });
    });
    expect(vi.mocked(client.call).mock.calls.at(-1)).toEqual(["dated.ofThread", { threadId: 7, include: 3 }]);
    // the sibling's answer isn't this item's: no line (and no Done of the sibling's) until the item's own read answers
    expect(seen!.ready).toBe(false);
    await answer(1, [dated(2, 7, "Board meeting", NOW + DAY), { ...dated(3, 7, "Pay the rent", NOW - DAY), state: "done", closedAt: NOW - 1 }]);
    expect(seen!.ready).toBe(true);
    expect([seen!.top?.key, seen!.top?.open]).toEqual(["dated:3", false]);
  });

  it("an item with no row in the feed (another mailbox) is chosen here: it leads, the other under it", async () => {
    await render(7);
    await answer(0, [dated(1, 7, "Send Jess your draft", NOW + 2 * DAY), dated(2, 7, "Board meeting", NOW + DAY)]);
    await act(async () => seen!.choose(seen!.others[0]!));
    expect(seen!.top?.key).toBe("dated:1");
    expect(seen!.others.map((o) => o.key)).toEqual(["dated:2"]);
    expect(useFeedRow.getState().opened).toBeNull();
  });

  it("a choice with no feed row is shared while it leads: the keys and the palette act on it, until the conversation is left (Codex code review of iteration 3)", async () => {
    await render(7);
    await answer(0, [dated(1, 7, "Send Jess your draft", NOW + 2 * DAY), dated(2, 7, "Board meeting", NOW + DAY)]);
    // the soonest leads by itself: nothing chosen, so the feed's row is what the keys act on
    expect(useReaderChoice.getState().held).toBeNull();
    await act(async () => seen!.choose(seen!.others[0]!));
    expect(useReaderChoice.getState().held).toMatchObject({ threadId: 7, item: { key: "dated:1" } });
    await render(8);
    expect(useReaderChoice.getState().held).toBeNull();
  });

  it("plan 296: hidden, a choice leaves the keys and the reader's Later closes; an item the feed opens shows until hidden there", async () => {
    const { setFollowupsShown } = await import("~/lib/followups-shown");
    const { openReaderLater } = await import("~/lib/today-task");
    await render(7);
    await answer(0, [dated(1, 7, "Send Jess your draft", NOW + 2 * DAY), dated(2, 7, "Board meeting", NOW + DAY)]);
    expect(seen!.shown).toBe(true);
    await act(async () => seen!.choose(seen!.others[0]!));
    await act(async () => openReaderLater());
    await act(async () => seen!.setShown(false));
    expect(seen!.shown).toBe(false);
    expect(useReaderChoice.getState()).toMatchObject({ held: null, later: false });
    expect(useApp.getState().menuOpen).toBe(false);
    // What matters opens one of its items: shown for it, and hidden there again by hand; another row asks again
    await act(async () => {
      useApp.setState({ today: true });
      useToday.setState({ rows: [{ id: "dated:2", threadId: 7, task: { kind: "dated", item: { id: 2 } } }, { id: "dated:1", threadId: 7, task: { kind: "dated", item: { id: 1 } } }] as never });
      useFeedRow.setState({ opened: "dated:2" });
    });
    expect(seen!.shown).toBe(true);
    await act(async () => seen!.setShown(false));
    expect(seen!.shown).toBe(false);
    await act(async () => useFeedRow.setState({ opened: "dated:1" }));
    expect(seen!.shown).toBe(true);
    // Show: the reader's choice again, for every conversation
    await act(async () => seen!.setShown(true));
    await act(async () => useFeedRow.setState({ opened: null }));
    expect(seen!.shown).toBe(true);
    setFollowupsShown(true);
  });
});

describe("plan 296: the reader's count of what the items card draws", () => {
  const item = { key: "a" } as never;
  const waitingRow = (task: unknown) => ({ id: "w", task }) as never;
  const model = (m: Partial<Model>): Model => ({ ready: true, top: null, others: [], targeted: false, chose: false, waiting: null, waitingRow: null, choose() {}, chooseWaiting() {}, shown: true, setShown() {}, ...m });
  it("nothing until it's read; then the lead and its Also line", () => {
    expect(readerItemCount(model({ ready: false, top: item, others: [item] }))).toBe(0);
    expect(readerItemCount(model({}))).toBe(0);
    expect(readerItemCount(model({ top: item, others: [item, item] }))).toBe(3);
  });
  it("a person waiting: counted where its line is drawn, never with no task to show", () => {
    expect(readerItemCount(model({ waiting: "top", waitingRow: waitingRow({ kind: "waiting" }), others: [item] }))).toBe(2);
    expect(readerItemCount(model({ waiting: "top", waitingRow: waitingRow(null) }))).toBe(0);
    expect(readerItemCount(model({ waiting: "also", top: item, waitingRow: waitingRow({ kind: "waiting" }) }))).toBe(2);
    expect(readerItemCount(model({ waiting: "also", top: item, waitingRow: waitingRow(null) }))).toBe(1);
  });
});
