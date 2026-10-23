/**
 * ⌥-drag moves: one transaction to move, one to undo, and the undo restores
 * the source membership with its provenance (origin, batch, training example)
 * so an earlier batch's undo still works afterwards.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@unica/core/rpc";
import { beginMove, createCategory, movePhase, seedDataset } from "@unica/db";
import { demoRegistry } from "@unica/mail";
import { generateDataset } from "@unica/mock-data";
import { afterEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const NOW = Date.UTC(2026, 9, 22, 12);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const open = (dir: string) => new Backend({ dbPath: join(dir, "unica.db"), version: "test", cipher: plaintextCipher, providers: demoRegistry, now: () => NOW, autoSync: false });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "unica-move-"));
  const backend = open(dir);
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "renderer", origin: "renderer" });
  cleanups.push(async () => {
    await backend.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  seedDataset(backend.db, generateDataset({ threads: 300, accounts: 2, seed: 5, now: NOW }), { now: NOW });
  const a = createCategory(backend.db, "Origen", "rose").id;
  const b = createCategory(backend.db, "Destino", "cyan").id;
  // inbound threads (they have features to learn from), none in either category
  const threads = backend.db
    .all<{ id: number }>("SELECT id FROM threads WHERE in_inbox = 1 AND last_from_email NOT LIKE '%luis%' AND id NOT IN (SELECT thread_id FROM thread_categories) ORDER BY id LIMIT 3")
    .map((r) => r.id);
  return { backend, client: new RpcClient(c), a, b, threads, dir };
}

type Row = { added_by: string; batch_id: number | null } | undefined;
const membership = (backend: Backend, t: number, cat: number): Row => backend.db.get("SELECT added_by, batch_id FROM thread_categories WHERE thread_id = ? AND category_id = ?", t, cat);
const example = (backend: Backend, t: number, cat: number) =>
  backend.db.get<{ label: number; source: string; batch_id: number | null; weight: number }>("SELECT label, source, batch_id, weight FROM cls_examples WHERE thread_id = ? AND category_id = ?", t, cat);

describe("moving threads between categories", () => {
  it("moves in one call and undoes in one call, restoring the source's provenance", async () => {
    const { backend, client, a, b, threads } = setup();
    const [t1, t2] = threads as [number, number];
    // a bulk add to A (its own batch), then a move of t1 from A to B
    const bulk = await client.call("categories.addThreads", { categoryId: a, threadIds: [t1, t2], source: "snackbar" });
    expect(bulk.batchId).not.toBeNull();
    const before = { row: membership(backend, t1, a), example: example(backend, t1, a) };
    expect(before.row).toEqual({ added_by: "bulk", batch_id: bulk.batchId });

    const move = await client.call("categories.moveThreads", { from: a, to: b, threadIds: [t1], source: "dnd" });
    expect(move).toMatchObject({ addedIds: [t1], moved: [t1] });
    expect(membership(backend, t1, a)).toBeUndefined();
    expect(membership(backend, t1, b)).toMatchObject({ added_by: "user", batch_id: move.batchId });
    expect(example(backend, t1, a)).toMatchObject({ label: -1, source: "removal" });

    const undo = await client.call("categorize.undo", { batchId: move.batchId });
    expect(undo).toEqual({ removed: 1, restored: 1 });
    expect(membership(backend, t1, b)).toBeUndefined();
    // exactly as before the move: same origin, same batch, same training example
    expect(membership(backend, t1, a)).toEqual(before.row);
    expect(example(backend, t1, a)).toEqual(before.example);
    expect(example(backend, t1, b)).toBeUndefined();

    // the original bulk add can still be undone, and it takes t1 with it
    await client.call("categorize.undo", { batchId: bulk.batchId! });
    expect(membership(backend, t1, a)).toBeUndefined();
    expect(membership(backend, t2, a)).toBeUndefined();
    expect(example(backend, t1, a)).toBeUndefined();
  });

  it("an undo is idempotent and keeps what the destination had before", async () => {
    const { backend, client, a, b, threads } = setup();
    const [t1, t2] = threads as [number, number];
    await client.call("categories.addThreads", { categoryId: a, threadIds: [t1, t2], source: "picker" });
    // t2 was already in B (from the picker): the move adds only t1 there, and the undo leaves t2 in B
    const pick = await client.call("categories.addThreads", { categoryId: b, threadIds: [t2], source: "picker" });
    const bRow = membership(backend, t2, b);
    const move = await client.call("categories.moveThreads", { from: a, to: b, threadIds: [t1, t2] });
    expect(move.addedIds).toEqual([t1]);
    expect(move.moved.sort()).toEqual([t1, t2].sort());
    await client.call("categorize.undo", { batchId: move.batchId });
    expect(membership(backend, t2, b)).toEqual(bRow);
    expect(membership(backend, t2, a)).toMatchObject({ added_by: "user" });
    expect(await client.call("categorize.undo", { batchId: move.batchId })).toEqual({ removed: 0, restored: 0 });
    expect(pick.batchId).not.toBeNull();
  });

  it("is atomic: a move that fails half-way leaves both categories untouched", async () => {
    const { backend, client, a, b, threads } = setup();
    const [t1] = threads as [number];
    await client.call("categories.addThreads", { categoryId: a, threadIds: [t1], source: "picker" });
    // make the removal step fail inside the move's transaction
    backend.db.exec("CREATE TRIGGER fail_removal BEFORE DELETE ON thread_categories BEGIN SELECT RAISE(ABORT, 'boom'); END");
    await expect(client.call("categories.moveThreads", { from: a, to: b, threadIds: [t1] })).rejects.toThrow();
    expect(membership(backend, t1, a)).toMatchObject({ added_by: "user" });
    expect(membership(backend, t1, b)).toBeUndefined();
    backend.db.exec("DROP TRIGGER fail_removal");
    // and the undo: if restoring fails, the destination keeps the threads too
    const move = await client.call("categories.moveThreads", { from: a, to: b, threadIds: [t1] });
    backend.db.exec("CREATE TRIGGER fail_restore BEFORE INSERT ON thread_categories BEGIN SELECT RAISE(ABORT, 'boom'); END");
    await expect(client.call("categorize.undo", { batchId: move.batchId })).rejects.toThrow();
    expect(membership(backend, t1, b)).toMatchObject({ batch_id: move.batchId });
    expect(membership(backend, t1, a)).toBeUndefined();
    backend.db.exec("DROP TRIGGER fail_restore");
    // retrying succeeds
    expect(await client.call("categorize.undo", { batchId: move.batchId })).toEqual({ removed: 1, restored: 1 });
    expect(membership(backend, t1, a)).toMatchObject({ added_by: "user" });
  });

  it("a move interrupted after its memberships committed finishes its training on the next start", async () => {
    const { backend, a, b, threads, dir } = setup();
    const [t1, t2] = threads as [number, number];
    backend.db.run("INSERT INTO thread_categories (thread_id, category_id, added_by, added_at) VALUES (?, ?, 'user', 0), (?, ?, 'user', 0)", t1, a, t2, a);
    // the commit happened, the sliced training never ran (the app quit)
    const m = beginMove(backend.db, { from: a, to: b, threadIds: [t1, t2], addedBy: "user", now: NOW, source: "dnd" });
    expect(movePhase(backend.db, m.batchId)).toBe("training");
    expect([membership(backend, t1, a), membership(backend, t1, b)?.batch_id]).toEqual([undefined, m.batchId]);
    expect(example(backend, t1, b)).toBeUndefined();
    await backend.stop();
    const again = open(dir);
    try {
      again.start();
      await expect.poll(() => movePhase(again.db, m.batchId)).toBe("done");
      for (const t of [t1, t2]) {
        expect(example(again, t, b)).toMatchObject({ label: 1, source: "user", batch_id: m.batchId });
        expect(example(again, t, a)).toMatchObject({ label: -1, source: "removal" });
      }
    } finally {
      await again.stop();
    }
  });
});
