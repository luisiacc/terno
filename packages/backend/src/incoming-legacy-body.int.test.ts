import { writeFileSync } from "node:fs";
import { watchLoop } from "../../db/src/test/timing";
import { nodePlatform, openDatabase, SqlMailStore } from "@terno/db";
import { sqlAssets } from "../../db/src/attachments";
import { createAsset, appendAsset, sealAsset } from "@terno/store";
import { upgradeNodeLegacyBodies } from "./legacy-body-worker";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { Db, MIGRATIONS, createAccount, ingestMessages, nodeSqliteDriver, registerFunctions } from "@terno/db";
import { msg } from "../../store/src/conformance/fixtures";
import { Backend, plaintextCipher } from "./backend";

for (const version of [36, 37]) it(`opens SQL${version} large cached bodies without materializing old body columns on the parent`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "terno-legacy-body-")), path = join(directory, "mail.db");
  const text = `${"alpha e\u0301 😀\r\n".repeat(90000)} boundaryneedle acrossboundary `;
  const html = `<p>${"Exact &amp; complete. ".repeat(90000)}</p>`;
  const legacy = new Db(nodeSqliteDriver, path);
  let threadId = 0;
  try {
    registerFunctions(legacy);
    for (const migration of MIGRATIONS) if (migration.version <= 37) legacy.tx(() => { legacy.exec(migration.sql); legacy.exec(`PRAGMA user_version=${migration.version}`); });
    const account = createAccount(legacy, { kind: "gmail", email: "synthetic@example.test", displayName: "Synthetic", color: "brown" }, 1);
    legacy.exec("ALTER TABLE messages ADD COLUMN unsubscribe TEXT");
    const result = ingestMessages(legacy, [msg({ accountId: account.id, providerMsgId: "legacy", bodyText: text, bodyHtml: html, bodyState: "full" })], 1);
    legacy.exec("ALTER TABLE messages DROP COLUMN unsubscribe");
    threadId = [...result.touchedThreads][0]!;
    if (version === 36) legacy.exec("DROP INDEX threads_unread_tab; DROP INDEX threads_tab_date; DROP INDEX threads_tab_id; DROP INDEX threads_waiting_inbox_tab; ALTER TABLE threads DROP COLUMN tab; ALTER TABLE messages DROP COLUMN category; DELETE FROM settings WHERE key='tabs_backfill'; PRAGMA user_version=36");
  } finally { legacy.close(); }
  let largest = 0;
  const inspect = (value: unknown): void => {
    if (typeof value === "string") largest = Math.max(largest, value.length);
    else if (value && typeof value === "object" && !ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer)) for (const child of Object.values(value)) inspect(child);
  };
  const open = nodeSqliteDriver.open.bind(nodeSqliteDriver);
  const driverSpy = vi.spyOn(nodeSqliteDriver, "open").mockImplementation((file, options) => {
    const connection = open(file, options), prepare = connection.prepare.bind(connection);
    connection.prepare = (sql) => {
      const statement = prepare(sql), get = statement.get.bind(statement), all = statement.all.bind(statement);
      statement.get = (...parameters) => { const row = get(...parameters); inspect(row); return row; };
      statement.all = (...parameters) => { const rows = all(...parameters); inspect(rows); return rows; };
      return statement;
    };
    return connection;
  });
  const unexpected: string[] = [];
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { unexpected.push("Unexpected legacy migration route"); throw new Error("Unexpected legacy migration route"); });
  const baseline = process.memoryUsage(); let peakRss = baseline.rss, samples = 0;
  const memory = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage.rss()); samples++; }, 5);
  const loop = watchLoop(15), began = performance.now();
  const backend = new Backend({ dbPath: path, cipher: plaintextCipher, version: "test", autoSync: false, instantSearch: false, iconTransport: null, providers: { create() { throw new Error("Unexpected legacy provider creation"); }, async verifyImap() { throw new Error("Unexpected legacy provider verification"); }, async connectGmail() { throw new Error("Unexpected legacy consent"); } } });
  try {
    await backend.ready;
    const timing = loop.stop(); clearInterval(memory);
    writeFileSync(join(directory, `native-legacy-opening-v${version}.json`), JSON.stringify({ wallMs: performance.now() - began, timing, baselineRss: baseline.rss, sampledPeakProcessRss: peakRss, samples, fixtureStringCodeUnits: text.length + html.length, hostIsolateHeapUsed: process.memoryUsage().heapUsed, hostIsolateArrayBuffers: process.memoryUsage().arrayBuffers }, null, 2));
    const detail = (await backend.store.threads.get(threadId))!;
    expect(detail.messages[0]!.bodyText === text).toBe(true);
    expect(detail.messages[0]!.bodyHtml === html).toBe(true);
    expect((await backend.store.threads.searchText({ query: '"boundaryneedle acrossboundary"', limit: 10, now: 1 })).items.map((t) => t.id)).toEqual([threadId]);
    expect((await backend.store.filters.preview({ match: "all", conditions: [{ field: "body", op: "endsWith", value: "boundaryneedle acrossboundary" }], actions: [{ type: "star" }] }, 1, 10)).count).toBe(1);
    expect(unexpected).toEqual([]);
    expect(largest, "legacy conversion must read the complete old columns only on its dedicated owner").toBeLessThanOrEqual(32768);
  } finally { clearInterval(memory); loop.stop(); await backend.stop(); driverSpy.mockRestore(); fetchSpy.mockRestore(); rmSync(directory, { recursive: true, force: true }); }
});

for (const phase of ["prepared", "committed"] as const) it(`resumes exact legacy responsibility after interrupted ${phase} acknowledgement and physical retirement`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "terno-legacy-resume-")), path = join(directory, "mail.db");
  const text = "😀e\u0301\r\nlegacy exact boundary ".repeat(9000), html = `<p>${text}</p>`;
  let messageId = 0, accountId = 0, threadId = 0;
  const old = new Db(nodeSqliteDriver, path);
  try {
    registerFunctions(old);
    for (const migration of MIGRATIONS) if (migration.version <= 37) old.tx(() => { old.exec(migration.sql); old.exec(`PRAGMA user_version=${migration.version}`); });
    accountId = createAccount(old, { kind: "imap", email: "synthetic@example.test", displayName: "Synthetic", color: "brown" }, 1).id;
    const repo = sqlAssets(old);
    const asset = old.tx(() => { const asset = createAsset(repo, () => crypto.randomUUID(), { accountId, filename: "exact.bin", mime: "application/octet-stream", size: 3, now: 1 }); appendAsset(repo, accountId, asset.assetId!, 0, "AP+A"); sealAsset(repo, accountId, asset.assetId!); return asset; });
    old.exec("ALTER TABLE messages ADD COLUMN unsubscribe TEXT");
    const result = ingestMessages(old, [msg({ accountId, providerMsgId: "INBOX:7:42", bodyText: text, bodyHtml: html, bodyState: "partial", isStarred: true, attachments: [{ filename: "exact.bin", mime: "application/octet-stream", size: 3, assetId: asset.assetId! }] })], 1);
    old.exec("ALTER TABLE messages DROP COLUMN unsubscribe");
    messageId = result.inserted[0]!; threadId = [...result.touchedThreads][0]!;
    old.run("INSERT INTO capture_repairs(account_id,key,message_id,locator,reason,state,revision,bytes) VALUES(?,?,?,?,'mime-depth','blocked',7,100)", accountId, "synthetic-key", messageId, JSON.stringify({ kind: "imap", mailbox: "INBOX", uidvalidity: "7", uid: 42 }));
  } finally { old.close(); }
  const abort = new AbortController();
  let events = 0;
  try {
    await expect(upgradeNodeLegacyBodies(path, abort.signal, async (progress) => {
      if (progress.phase !== phase) return;
      events++;
      // While the exclusive actor waits for acknowledgement, a separate native writer cannot enter.
      const competitor = nodeSqliteDriver.open(path, { readonly: false });
      try { expect(() => competitor.exec("BEGIN IMMEDIATE")).toThrow(); } finally { competitor.close(); }
      abort.abort(new DOMException("Synthetic opening cancellation", "AbortError"));
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(events).toBe(1);
    // The awaited API includes native Worker.terminate(): the same file is writable now, without retries.
    const inspect = new Db(nodeSqliteDriver, path);
    try {
      inspect.tx(() => inspect.run("UPDATE accounts SET display_name=display_name WHERE id=?", accountId));
      expect(inspect.get<{ n: number }>("SELECT count(*) n FROM body_heads")!.n).toBe(phase === "committed" ? 1 : 0);
      if (phase === "prepared") expect(inspect.get<{ body_text: string }>("SELECT body_text FROM message_bodies WHERE message_id=?", messageId)!.body_text === text).toBe(true);
      expect(inspect.get<{ revision: number }>("SELECT revision FROM capture_repairs WHERE message_id=?", messageId)!.revision).toBe(7);
    } finally { inspect.close(); }
    await upgradeNodeLegacyBodies(path, new AbortController().signal);
    const store = new SqlMailStore(openDatabase(path), { platform: nodePlatform, instantSearch: false });
    try {
      const message = (await store.threads.get(threadId))!.messages[0]!;
      expect(message.bodyText === text).toBe(true); expect(message.bodyHtml === html).toBe(true); expect(message.isStarred).toBe(true);
      expect(await store.attachments.read(accountId, message.attachments[0]!.assetId!, 0)).toBe("AP+A");
      expect(store.db.get<{ n: number }>("SELECT count(*) n FROM body_heads")!.n).toBe(1);
      expect(store.db.get<{ n: number }>("SELECT count(*) n FROM body_captures WHERE owned=0")!.n).toBe(0);
      expect(store.db.get<{ revision: number }>("SELECT revision FROM capture_repairs WHERE message_id=?", messageId)!.revision).toBe(7);
      expect(store.db.get<{ body_state: string }>("SELECT body_state FROM messages WHERE id=?", messageId)!.body_state).toBe("partial");
    } finally { await store.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
