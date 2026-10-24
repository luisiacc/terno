/**
 * Moves (drag and drop, "Mover a…") are exclusive: one transaction to move a
 * thread out of every other category, one to undo, and the undo restores
 * each source membership with its provenance (origin, batch, training
 * example) so an earlier batch's undo still works afterwards.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { beginMove, createCategory, movePhase, seedDataset, sqlDb } from "@terno/db";
import { demoRegistry } from "@terno/mail";
import { generateDataset } from "@terno/mock-data";
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
  seedDataset(sqlDb(backend.store), generateDataset({ threads: 300, accounts: 2, seed: 5, now: NOW }), { now: NOW });
  const a = createCategory(sqlDb(backend.store), "Origen", "rose").id;
  const b = createCategory(sqlDb(backend.store), "Destino", "cyan").id;
  // inbound threads (they have features to learn from), none in either category
  const threads = sqlDb(backend.store)
    .all<{ id: number }>("SELECT id FROM threads WHERE in_inbox = 1 AND last_from_email NOT LIKE '%luis%' AND id NOT IN (SELECT thread_id FROM thread_categories) ORDER BY id LIMIT 3")
    .map((r) => r.id);
  return { backend, client: new RpcClient(c), a, b, threads, dir };
}

type Row = { added_by: string; batch_id: number | null } | undefined;
const membership = (backend: Backend, t: number, cat: number): Row => sqlDb(backend.store).get("SELECT added_by, batch_id FROM thread_categories WHERE thread_id = ? AND category_id = ?", t, cat);
const example = (backend: Backend, t: number, cat: number) =>
  sqlDb(backend.store).get<{ label: number; source: string; batch_id: number | null; weight: number }>("SELECT label, source, batch_id, weight FROM cls_examples WHERE thread_id = ? AND category_id = ?", t, cat);

describe("moving threads between categories", () => {
  it("moves in one call and undoes in one call, restoring the source's provenance", async () => {
    const { backend, client, a, b, threads } = setup();
    const [t1, t2] = threads as [number, number];
    // a bulk add to A (its own batch), then a move of t1 from A to B
    const bulk = await client.call("categories.addThreads", { categoryId: a, threadIds: [t1, t2], source: "snackbar" });
    expect(bulk.batchId).not.toBeNull();
    const before = { row: membership(backend, t1, a), example: example(backend, t1, a) };
    expect(before.row).toEqual({ added_by: "bulk", batch_id: bulk.batchId });

    const move = await client.call("categories.moveThreads", { to: b, threadIds: [t1], source: "dnd" });
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

  it("leaves every other category, not only one: A+B dragged to C ends in C alone; undo puts it back in A and B", async () => {
    const { backend, client, a, b, threads } = setup();
    const c = createCategory(sqlDb(backend.store), "Tercera", "lime").id;
    const [t1, t2] = threads as [number, number];
    await client.call("categories.addThreads", { categoryId: a, threadIds: [t1, t2], source: "snackbar" });
    await client.call("categories.addThreads", { categoryId: b, threadIds: [t1], source: "picker" });
    const before = [membership(backend, t1, a), membership(backend, t1, b), membership(backend, t2, a)];
    const move = await client.call("categories.moveThreads", { to: c, threadIds: [t1, t2], source: "dnd" });
    expect(move.moved.sort()).toEqual([t1, t2].sort());
    const cats = (t: number) => sqlDb(backend.store).all<{ category_id: number }>("SELECT category_id FROM thread_categories WHERE thread_id = ? ORDER BY category_id", t).map((r) => r.category_id);
    expect([cats(t1), cats(t2)]).toEqual([[c], [c]]);
    // a removal example for each category t1 left
    expect([example(backend, t1, a)?.source, example(backend, t1, b)?.source, example(backend, t1, c)?.label]).toEqual(["removal", "removal", 1]);
    expect(await client.call("categorize.undo", { batchId: move.batchId })).toEqual({ removed: 2, restored: 2 });
    expect([membership(backend, t1, a), membership(backend, t1, b), membership(backend, t2, a)]).toEqual(before);
    expect(cats(t1)).toEqual([a, b].sort((x, y) => x - y));
    expect(example(backend, t1, c)).toBeUndefined();
    expect(example(backend, t1, b)).toMatchObject({ label: 1, source: "user" });
  });

  it("an undo is idempotent and keeps what the destination had before", async () => {
    const { backend, client, a, b, threads } = setup();
    const [t1, t2] = threads as [number, number];
    await client.call("categories.addThreads", { categoryId: a, threadIds: [t1, t2], source: "picker" });
    // t2 was already in B (from the picker): the move adds only t1 there, and the undo leaves t2 in B
    const pick = await client.call("categories.addThreads", { categoryId: b, threadIds: [t2], source: "picker" });
    const bRow = membership(backend, t2, b);
    const move = await client.call("categories.moveThreads", { to: b, threadIds: [t1, t2] });
    expect(move.addedIds).toEqual([t1]);
    expect(move.moved.sort()).toEqual([t1, t2].sort());
    await client.call("categorize.undo", { batchId: move.batchId });
    expect(membership(backend, t2, b)).toEqual(bRow);
    expect(membership(backend, t2, a)).toMatchObject({ added_by: "user" });
    expect(await client.call("categorize.undo", { batchId: move.batchId })).toEqual({ removed: 0, restored: 0 });
    expect(pick.batchId).not.toBeNull();
  });

  it("each slice is atomic: a failed one leaves its threads untouched, and the move and its undo resume exactly", async () => {
    const { backend, client, a, b, threads } = setup();
    const [t1] = threads as [number];
    await client.call("categories.addThreads", { categoryId: a, threadIds: [t1], source: "picker" });
    // make the step that takes the thread out of `a` fail inside the slice's transaction
    sqlDb(backend.store).exec("CREATE TRIGGER fail_removal BEFORE DELETE ON thread_categories BEGIN SELECT RAISE(ABORT, 'boom'); END");
    await expect(client.call("categories.moveThreads", { to: b, threadIds: [t1] })).rejects.toThrow();
    expect(membership(backend, t1, a)).toMatchObject({ added_by: "user" });
    expect(membership(backend, t1, b)).toBeUndefined();
    const batchId = sqlDb(backend.store).get<{ id: number }>("SELECT max(id) AS id FROM cat_batches")!.id;
    expect(movePhase(sqlDb(backend.store), batchId)).toBe("moving");
    sqlDb(backend.store).exec("DROP TRIGGER fail_removal");
    // the move picks up where it stopped
    await backend.finishMove(batchId);
    expect([membership(backend, t1, a), membership(backend, t1, b)?.batch_id]).toEqual([undefined, batchId]);
    // and the undo: if restoring fails, the destination keeps the thread too
    sqlDb(backend.store).exec("CREATE TRIGGER fail_restore BEFORE INSERT ON thread_categories BEGIN SELECT RAISE(ABORT, 'boom'); END");
    await expect(client.call("categorize.undo", { batchId })).rejects.toThrow();
    expect(membership(backend, t1, b)).toMatchObject({ batch_id: batchId });
    expect(membership(backend, t1, a)).toBeUndefined();
    sqlDb(backend.store).exec("DROP TRIGGER fail_restore");
    // retrying succeeds
    expect(await client.call("categorize.undo", { batchId })).toEqual({ removed: 1, restored: 1 });
    expect(membership(backend, t1, a)).toMatchObject({ added_by: "user" });
    expect(membership(backend, t1, b)).toBeUndefined();
  });

  it("a move recorded before the app quit is applied and trained on the next start", async () => {
    const { backend, a, b, threads, dir } = setup();
    const [t1, t2] = threads as [number, number];
    sqlDb(backend.store).run("INSERT INTO thread_categories (thread_id, category_id, added_by, added_at) VALUES (?, ?, 'user', 0), (?, ?, 'user', 0)", t1, a, t2, a);
    // recorded, nothing applied yet (the app quit)
    const m = beginMove(sqlDb(backend.store), { to: b, threadIds: [t1, t2], addedBy: "user", now: NOW, source: "dnd" });
    expect(movePhase(sqlDb(backend.store), m.batchId)).toBe("moving");
    expect(membership(backend, t1, b)).toBeUndefined();
    await backend.stop();
    const again = open(dir);
    try {
      await again.start();
      await expect.poll(() => movePhase(sqlDb(again.store), m.batchId)).toBe("done");
      for (const t of [t1, t2]) {
        expect([membership(again, t, a), membership(again, t, b)?.batch_id]).toEqual([undefined, m.batchId]);
        expect(example(again, t, b)).toMatchObject({ label: 1, source: "user", batch_id: m.batchId });
        expect(example(again, t, a)).toMatchObject({ label: -1, source: "removal" });
      }
    } finally {
      await again.stop();
    }
  });
});

describe("resuming a move at startup", () => {
  it("a resume that fails is logged and left for the next start, never an unhandled rejection", async () => {
    const { backend, a, b, threads, dir } = setup();
    const [t1] = threads as [number];
    const db = sqlDb(backend.store);
    db.run("INSERT INTO thread_categories (thread_id, category_id, added_by, added_at) VALUES (?, ?, 'user', 0)", t1, a);
    const m = beginMove(db, { to: b, threadIds: [t1], addedBy: "user", now: NOW, source: "dnd" });
    await backend.stop();
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRejection);
    const logs: string[] = [];
    const again = new Backend({ dbPath: join(dir, "unica.db"), version: "test", cipher: plaintextCipher, providers: demoRegistry, now: () => NOW, autoSync: false, log: (level, message) => logs.push(`${level} ${message}`) });
    try {
      // the training can't write: the resume fails
      sqlDb(again.store).exec("CREATE TRIGGER fail_training BEFORE INSERT ON cls_examples BEGIN SELECT RAISE(ABORT, 'disco lleno'); END");
      await again.start();
      await expect.poll(() => logs.some((l) => l.startsWith("warn") && l.includes(`move ${m.batchId}`))).toBe(true);
      await new Promise((r) => setTimeout(r, 50));
      expect(rejections).toEqual([]);
      expect(movePhase(sqlDb(again.store), m.batchId)).toBe("training");
    } finally {
      process.off("unhandledRejection", onRejection);
      await again.stop();
    }
  });
});
