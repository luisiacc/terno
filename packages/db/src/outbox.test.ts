import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./index";
import { ingestMessages } from "./ingest";
import { beginSearchBuild, searchChanges, searchHead } from "./outbox";
import { msg, testDb, withAccounts } from "./test/helpers";

const logRows = (db: ReturnType<typeof testDb>) => db.get<{ c: number }>("SELECT count(*) AS c FROM search_outbox")!.c;

describe("search outbox (SQL)", () => {
  it("collects dirty ids only inside the transaction and leaves search_dirty empty after commit", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    ingestMessages(db, [msg({ accountId: a! })]);
    expect(db.get("SELECT count(*) AS c FROM search_dirty")).toEqual({ c: 0 });
    expect(searchHead(db).seq).toBe(1);
  });

  it("a rolled-back transaction leaves neither its changes nor a batch", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    const head = searchHead(db);
    expect(() =>
      db.tx(() => {
        ingestMessages(db, [msg({ accountId: a! })]);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(searchHead(db)).toEqual(head);
    expect(db.get("SELECT count(*) AS c FROM search_dirty")).toEqual({ c: 0 });
    // a savepoint rolled back inside a committed transaction takes its marks with it
    db.tx(() => {
      try {
        db.tx(() => {
          ingestMessages(db, [msg({ accountId: a!, providerMsgId: "gone" })]);
          throw new Error("inner");
        });
      } catch {
        /* the outer transaction goes on */
      }
      ingestMessages(db, [msg({ accountId: a!, providerMsgId: "kept" })]);
    });
    const changes = searchChanges(db, head, searchHead(db), 10).flatMap((b) => b.changes);
    expect(changes.filter((c) => c.kind === "upsertMessage")).toHaveLength(1);
  });

  it("a write outside any transaction is batched by the next one (and on open)", () => {
    const dir = mkdtempSync(join(tmpdir(), "unica-outbox-"));
    let db = openDatabase(join(dir, "o.db"));
    const [a] = withAccounts(db);
    const [id] = ingestMessages(db, [msg({ accountId: a! })]).inserted;
    const head = searchHead(db);
    db.run("UPDATE messages SET subject = 'editado a mano' WHERE id = ?", id!);
    expect(searchHead(db)).toEqual(head);
    db.close();
    db = openDatabase(join(dir, "o.db"));
    expect(searchHead(db).seq).toBe(head.seq + 1);
    expect(searchChanges(db, head, searchHead(db), 1)[0]!.changes).toEqual([{ kind: "upsertMessage", doc: expect.objectContaining({ messageId: id, subject: "editado a mano" }) }]);
    db.close();
  });

  it("prunes the oldest batches past the size cap, never the newest nor past an active build; a consumer behind them must rebuild", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unica-outbox-"));
    const db = openDatabase(join(dir, "p.db"), { searchLogBytes: 4_000 });
    const [a] = withAccounts(db);
    const start = searchHead(db);
    for (let i = 0; i < 20; i++) ingestMessages(db, [msg({ accountId: a!, bodyText: "x".repeat(500) })]);
    expect(logRows(db)).toBeLessThan(20);
    expect(() => searchChanges(db, start, searchHead(db), 100)).toThrow(expect.objectContaining({ reason: "gap" }));
    const build = beginSearchBuild(db);
    for (let i = 0; i < 20; i++) ingestMessages(db, [msg({ accountId: a!, bodyText: "y".repeat(500) })]);
    // everything since the build started is still there
    expect(searchChanges(db, build.from, searchHead(db), 100)).toHaveLength(20);
    await build.release();
    ingestMessages(db, [msg({ accountId: a!, bodyText: "z".repeat(500) })]);
    expect(logRows(db)).toBeLessThan(21);
    expect(db.get<{ bytes: number }>("SELECT bytes FROM search_state")!.bytes).toBe(db.get<{ b: number }>("SELECT total(bytes) AS b FROM search_outbox")!.b);
    db.close();
  });

  it("leases don't survive a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "unica-outbox-"));
    let db = openDatabase(join(dir, "l.db"));
    beginSearchBuild(db);
    expect(db.get("SELECT count(*) AS c FROM search_leases")).toEqual({ c: 1 });
    db.close();
    db = openDatabase(join(dir, "l.db"));
    expect(db.get("SELECT count(*) AS c FROM search_leases")).toEqual({ c: 0 });
    db.close();
  });
});
