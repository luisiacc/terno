import { generateDataset } from "@terno/mock-data";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "./index";
import { deleteMessages, ingestMessages, setMessageBody } from "./ingest";
import { removeAccount } from "./repos";
import { findRuleMatches } from "./rules";
import { searchThreads } from "./search";
import { seedDataset } from "./seed";
import { ftsIntegrity, msg, testDb, withAccounts } from "./test/helpers";
import { writeLegacyCopy } from "./test/legacy";

const hits = (db: ReturnType<typeof testDb>, q: string) => searchThreads(db, { query: q, limit: 50 }).items.length;

describe("bodies live in message_bodies; the FTS index follows both tables", () => {
  it("indexes a message once with the body it arrives with, and messages without a body by their headers", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    const r = ingestMessages(db, [msg({ accountId: a!, subject: "Hola", bodyText: "Adjunto el presupuesto" }), msg({ accountId: a!, subject: "Sin cuerpo", bodyText: null, bodyHtml: null, bodyState: "none" })]);
    expect(db.all("SELECT message_id FROM message_bodies")).toEqual([{ message_id: r.inserted[0] }]);
    expect(hits(db, "presupuesto")).toBe(1);
    expect(hits(db, "cuerpo")).toBe(1);
    ftsIntegrity(db);
  });

  it("an HTML-only body is stored but indexes as empty text", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    const [id] = ingestMessages(db, [msg({ accountId: a!, bodyText: null, bodyHtml: "<p>solo html</p>" })]).inserted;
    expect(db.get("SELECT body_text, body_html FROM message_bodies WHERE message_id = ?", id!)).toEqual({ body_text: null, body_html: "<p>solo html</p>" });
    expect(hits(db, "html")).toBe(0);
    ftsIntegrity(db);
  });

  it("a body arriving, changing and going away reindexes its message and forgets old words", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    const [id] = ingestMessages(db, [msg({ accountId: a!, subject: "Hola", bodyText: null, bodyState: "none" })]).inserted;
    setMessageBody(db, id!, "Adjunto el presupuesto final", "<p>Adjunto</p>", "full");
    expect(hits(db, "presupuesto")).toBe(1);
    setMessageBody(db, id!, "Cambio de planes", null, "full");
    expect([hits(db, "presupuesto"), hits(db, "planes")]).toEqual([0, 1]);
    ftsIntegrity(db);
    setMessageBody(db, id!, null, null, "full");
    expect(hits(db, "planes")).toBe(0);
    expect(db.get("SELECT 1 FROM message_bodies WHERE message_id = ?", id!)).toBeUndefined();
    ftsIntegrity(db);
    // a body for a message that doesn't exist is ignored, not orphaned
    setMessageBody(db, 987_654, "huérfano", null, "full");
    expect(db.get("SELECT 1 FROM message_bodies WHERE message_id = 987654")).toBeUndefined();
  });

  it("subject, sender and recipient edits still reindex, with the body kept", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    const [id] = ingestMessages(db, [msg({ accountId: a!, subject: "Viejo asunto", bodyText: "cuerpo intacto" })]).inserted;
    db.run("UPDATE messages SET subject = 'Nuevo titular', from_name = 'Lucía', recipients_text = 'equipo@x.mx' WHERE id = ?", id!);
    expect([hits(db, "subject:titular"), hits(db, "subject:viejo"), hits(db, "from:lucia"), hits(db, "to:equipo"), hits(db, "intacto")]).toEqual([1, 0, 1, 1, 1]);
    ftsIntegrity(db);
  });

  it("deletes remove the exact indexed row and the body, also through account cascades", () => {
    const db = testDb();
    const [a, b] = withAccounts(db);
    const r = ingestMessages(db, [msg({ accountId: a!, bodyText: "uno dos" }), msg({ accountId: a!, bodyText: null, bodyState: "none" }), msg({ accountId: b!, bodyText: "tres" })]);
    deleteMessages(db, [r.inserted[0]!, r.inserted[1]!]);
    expect(db.all("SELECT message_id FROM message_bodies")).toEqual([{ message_id: r.inserted[2] }]);
    ftsIntegrity(db);
    // a raw account delete cascades to threads and messages: the triggers still run
    db.run("DELETE FROM accounts WHERE id = ?", b!);
    expect(db.get("SELECT count(*) AS c FROM message_bodies")).toEqual({ c: 0 });
    expect(hits(db, "tres")).toBe(0);
    ftsIntegrity(db);
    removeAccount(db, a!);
    ftsIntegrity(db);
  });

  it("rules that FTS5 can't decide alone read the body table", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    const [id] = ingestMessages(db, [msg({ accountId: a!, bodyText: "Hola equipo, saludos cordiales" })]).inserted;
    const rule = (op: "equals" | "endsWith", value: string) => ({ match: "all" as const, conditions: [{ field: "body" as const, op, value }], actions: [{ type: "star" as const }] });
    expect(findRuleMatches(db, rule("equals", "hola equipo, saludos cordiales"), 0).messageIds).toEqual([id]);
    const long = Array.from({ length: 40 }, (_, i) => `palabra${i}`).join(" ");
    const [other] = ingestMessages(db, [msg({ accountId: a!, bodyText: `inicio ${long}` })]).inserted;
    expect(findRuleMatches(db, rule("endsWith", long), 0).messageIds).toEqual([other]);
  });
});

describe("migration v6: message bodies", () => {
  it("moves every body out of messages, keeps the index without rebuilding it, and leaves search and rules unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "terno-mig6-"));
    const source = openDatabase(join(dir, "source.db"));
    seedDataset(source, generateDataset({ threads: 400, accounts: 2, seed: 6, now: Date.UTC(2026, 9, 22) }), { now: Date.UTC(2026, 9, 22) });
    // one message without any body, as IMAP envelopes arrive
    const bare = source.get<{ id: number }>("SELECT min(id) AS id FROM messages")!.id;
    source.run("DELETE FROM message_bodies WHERE message_id = ?", bare);
    source.run("UPDATE messages SET body_state = 'none' WHERE id = ?", bare);
    const queries = ["factura", '"darse de baja"', "reunión -uber", "from:crew@morningbrew.com"];
    const before = queries.map((q) => searchThreads(source, { query: q, limit: 500 }).items.map((t) => t.id));
    const bodies = source.all("SELECT message_id, body_text, body_html FROM message_bodies ORDER BY message_id");
    writeLegacyCopy(source, join(dir, "v5.db"), 5);
    source.close();

    const db = openDatabase(join(dir, "v5.db"));
    try {
      expect(db.get<{ user_version: number }>("PRAGMA user_version")!.user_version).toBeGreaterThanOrEqual(6);
      expect(db.all("SELECT name FROM pragma_table_info('messages') WHERE name LIKE 'body%' ORDER BY name")).toEqual([{ name: "body_state" }, { name: "body_tail_norm" }]);
      expect(db.all("SELECT message_id, body_text, body_html FROM message_bodies ORDER BY message_id")).toEqual(bodies);
      ftsIntegrity(db);
      expect(queries.map((q) => searchThreads(db, { query: q, limit: 500 }).items.map((t) => t.id))).toEqual(before);
      // the migrated index keeps working with the new triggers
      setMessageBody(db, bare, "zzqqmigrado", null, "full");
      expect(hits(db, "zzqqmigrado")).toBe(1);
      ftsIntegrity(db);
    } finally {
      db.close();
    }
  });
});
