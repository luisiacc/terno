import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { Db, MIGRATIONS, nodePlatform, nodeSqliteDriver, classifyOpenError, SCHEMA_VERSION, prepareUpgrade, createAccount, ingestMessages, registerFunctions } from "@terno/db";
import { msg } from "../../store/src/conformance/fixtures";
import { watchLoop } from "../../db/src/test/timing";
import { nodeStore, openNodeMailbox } from "./backend";

it("admits a backed-up Plan95 mailbox through exact legacy conversion before exposing store commands", async () => {
  const directory = mkdtempSync(join(tmpdir(), "terno-prepared-node-open-")), path = join(directory, "mail.db");
  const text = "😀e\u0301\r\ncomplete legacy phrase ".repeat(9000), html = `<p>${text}</p>`;
  const old = new Db(nodeSqliteDriver, path);
  let threadId = 0;
  try {
    registerFunctions(old);
    for (const migration of MIGRATIONS) if (migration.version <= 38) old.tx(() => { old.exec(migration.sql); old.exec(`PRAGMA user_version=${migration.version}`); });
    const account = createAccount(old, { kind: "gmail", email: "synthetic@example.test", displayName: "Synthetic", color: "indigo" }, 1);
    threadId = [...ingestMessages(old, [msg({ accountId: account.id, providerMsgId: "legacy", bodyText: text, bodyHtml: html, bodyState: "full" })], 1).touchedThreads][0]!;
  } finally { old.close(); }
  let largest = 0;
  const inspect = (row: unknown): void => { if (typeof row === "string") largest = Math.max(largest, row.length); else if (row && typeof row === "object" && !ArrayBuffer.isView(row) && !(row instanceof ArrayBuffer)) for (const value of Object.values(row)) inspect(value); };
  const open = nodeSqliteDriver.open.bind(nodeSqliteDriver);
  const spy = vi.spyOn(nodeSqliteDriver, "open").mockImplementation((file, options) => { const connection = open(file, options), prepare = connection.prepare.bind(connection); connection.prepare = (sql) => { const stmt = prepare(sql), get = stmt.get.bind(stmt), all = stmt.all.bind(stmt); stmt.get = (...params) => { const row = get(...params); inspect(row); return row; }; stmt.all = (...params) => { const rows = all(...params); inspect(rows); return rows; }; return stmt; }; return connection; });
  let db: Db | undefined, store: ReturnType<typeof nodeStore> | undefined;
  const monitor = watchLoop(15), began = performance.now();
  try {
    const backup = await prepareUpgrade(path, { backupsDir: join(directory, "backups"), appVersion: "test" });
    expect(backup.backup).not.toBeNull();
    db = await openNodeMailbox(path);
    store = nodeStore(db, { platform: nodePlatform, instantSearch: false });
    const timing = monitor.stop();
    writeFileSync("/tmp/terno-w11-s48/r4/native-plan95-opening.json", JSON.stringify({ wallMs: performance.now() - began, timing, fixtureCodeUnits: text.length + html.length }));
    const message = (await store.threads.get(threadId))!.messages[0]!;
    expect(message.bodyText === text && message.bodyHtml === html).toBe(true);
    expect((await store.threads.searchText({ query: '"complete legacy phrase"', now: 1, limit: 10 })).items.map((t) => t.id)).toEqual([threadId]);
    expect(largest, "the verified-backup entry path must not read complete old TEXT on its host").toBeLessThanOrEqual(32768);
  } finally { monitor.stop(); if (store) await store.close(); else if (db?.isOpen) db.close(); spy.mockRestore(); rmSync(directory, { recursive: true, force: true }); }
});


for (const mode of ["corrupt", "migration"] as const) it(`preserves Plan95 classified ${mode} failure through native body-opening admission`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "terno-node-open-error-")), path = join(directory, "mail.db");
  if (mode === "corrupt") writeFileSync(path, new Uint8Array(128).fill(7));
  else {
    const old = new Db(nodeSqliteDriver, path);
    try { registerFunctions(old); for (const migration of MIGRATIONS) if (migration.version <= 38) old.tx(() => { old.exec(migration.sql); old.exec(`PRAGMA user_version=${migration.version}`); }); old.exec("CREATE TABLE body_parts(synthetic_collision INTEGER)"); }
    finally { old.close(); }
  }
  try {
    const error = await openNodeMailbox(path).then((db) => { db.close(); return undefined; }, (error: unknown) => error);
    expect(classifyOpenError(error)).toMatchObject({ kind: "failed", reason: mode, step: mode === "migration" ? SCHEMA_VERSION : null });
    if (mode === "migration") { const old = new Db(nodeSqliteDriver, path, { readonly: true }); try { expect(old.get<{ user_version: number }>("PRAGMA user_version")!.user_version).toBe(38); } finally { old.close(); } }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
