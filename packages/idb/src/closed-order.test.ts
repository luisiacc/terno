/**
 * Plan 210 (Codex code review): the closing-time order in memory. Pages and a thread's newest closing follow every change
 * (a closing, an Undo, a move to another thread); unread, it holds at most a bounded set of changes, and past it rebuilds.
 */
import { describe, expect, it } from "vitest";
import { ClosedOrder } from "./closed-order";
import type { R } from "./mail";
import { MemDb, type Table } from "./mem";

function setup() {
  const db = new MemDb([{ name: "dated_items", key: ["id"], indexes: { fk_thread_id: ["thread_id"] } }], []);
  const order = new ClosedOrder(db, "dated_items", (r) => r.state !== "open");
  const rows = db.table<R>("dated_items") as Table<R>;
  const put = (id: number, thread: number, state: string, closedAt: number | null) => db.tx(() => void rows.put({ id, thread_id: thread, state, closed_at: closedAt } as R));
  const ids = (after: { at: number; id: number } | null = null, limit = 50) => order.page(rows, { since: 0, after, limit }).map((r) => r.id);
  return { order, rows, put, ids, pending: () => (order as unknown as { pending: Set<number> }).pending.size };
}

describe("ClosedOrder", () => {
  it("pages newest first by closing then id, strictly after a key, and follows a closing, an Undo and a move", () => {
    const { order, rows, put, ids } = setup();
    put(1, 10, "done", 100);
    put(2, 10, "done", 300);
    put(3, 20, "open", null);
    put(4, 30, "settled", 300);
    expect(ids()).toEqual([4, 2, 1]);
    expect(ids({ at: 300, id: 4 })).toEqual([2, 1]);
    expect(ids({ at: 300, id: 2 })).toEqual([1]);
    expect(order.newest(rows, [10, 20, 30], 0)).toEqual(new Map([[10, { at: 300, id: 2 }], [30, { at: 300, id: 4 }]]));
    // a closing, an Undo, a move to another thread (a merge)
    put(3, 20, "done", 400);
    put(2, 10, "open", null);
    put(4, 10, "settled", 300);
    expect(ids()).toEqual([3, 4, 1]);
    expect(order.newest(rows, [10, 20, 30], 0)).toEqual(new Map([[10, { at: 300, id: 4 }], [20, { at: 400, id: 3 }]]));
    expect(order.newest(rows, [10], 350)).toEqual(new Map());
  });

  it("unread, it holds a bounded set of changes, then rebuilds from the rows", () => {
    const { put, ids, pending } = setup();
    ids();
    for (let i = 1; i <= 1000; i++) put(i, i, "done", i);
    expect(pending()).toBe(0);
    expect(ids(null, 3)).toEqual([1000, 999, 998]);
  });
});
