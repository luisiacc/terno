/**
 * Plan 112: the first start after an update that migrated, against a real IMAP server (imapkit).
 *
 * The migration itself runs at open, before the backend syncs anything, each step in one transaction, so new mail
 * can't land in the middle of one. What an upgrade leaves for later (here v41's tally of Archive and Spam unread)
 * runs in slices beside sync: mail keeps arriving (IDLE and the poll) while it is unfinished, and every count ends
 * exact, whatever arrived, changed or moved meanwhile.
 */
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { Db, nodeSqliteDriver, sqlDb } from "@terno/db";
import { createRegistry } from "@terno/mail";
import imapkit from "imapkit";
import { afterEach, expect, it } from "vitest";
import { writeLegacyCopy } from "../../db/src/test/legacy";
import { Backend, plaintextCipher } from "./backend";
import { bounded, deferred, rawIdleMail } from "./test/imap-idle-fixture";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

/** the schema before v41, whose tally of Archive and Spam unread the backend fills a slice at a time */
const BEFORE = 40;

const mail = (subject: string) => ({ raw: rawIdleMail(subject, `Body of ${subject}`) });

async function until(check: () => Promise<boolean> | boolean, label: string, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Every derived tally next to what the threads say now: equal when nothing was lost or counted twice. */
function tallies(db: Db) {
  const slot = "CASE WHEN unread_count > 0 AND in_trash = 0 THEN CASE WHEN in_spam = 1 THEN 2 WHEN in_inbox = 0 THEN 1 END END";
  return {
    viewUnread: db.all("SELECT account_id, view, n FROM view_unread ORDER BY account_id, view"),
    viewTruth: db.all(`SELECT account_id, slot AS view, count(*) AS n FROM (SELECT account_id, ${slot} AS slot FROM threads) WHERE slot IS NOT NULL GROUP BY account_id, slot ORDER BY account_id, slot`),
    folderUnread: db.all("SELECT account_id, folder, n FROM folder_unread WHERE n > 0 ORDER BY account_id, folder"),
    folderTruth: db.all("SELECT account_id, folder, count(*) AS n FROM thread_folders WHERE unread = 1 GROUP BY account_id, folder ORDER BY account_id, folder"),
  };
}

it("after an update that migrated, mail keeps syncing while the upgrade's background work runs, and every count ends exact", { timeout: 120_000 }, async () => {
  const server = imapkit({
    plugins: ["IDLE", "MOVE", "UIDPLUS", "SPECIAL-USE", "ENABLE", "CONDSTORE"],
    storage: { INBOX: {}, "": { separator: "/", folders: { Sent: { "special-use": "\\Sent" }, Archive: { "special-use": "\\Archive" }, Trash: { "special-use": "\\Trash" }, Junk: { "special-use": "\\Junk" } } } },
  });
  const port = await bounded(server.start(0, "127.0.0.1"), "fixture listen");
  cleanups.push(async () => void (await bounded(server.stop(), "fixture stop")));
  // enough conversations for several of the tally's slices (250 threads each), half of them unread
  for (let i = 0; i < 400; i++) server.control.addMessage("INBOX", { ...mail(`inbox ${i}`), flags: i % 2 ? ["\\Seen"] : [] });
  for (let i = 0; i < 500; i++) server.control.addMessage("Archive", { ...mail(`archive ${i}`), flags: i % 2 ? ["\\Seen"] : [] });
  for (let i = 0; i < 100; i++) server.control.addMessage("Junk", mail(`junk ${i}`));

  const dir = mkdtempSync(join(tmpdir(), "terno-p112-sync-"));
  const dbPath = join(dir, "terno.db");
  const registry = createRegistry({ imap: { allowInsecure: true } });
  let backend: Backend | null = null;
  let client: RpcClient | null = null;
  const open = (autoSync: boolean) => {
    backend = new Backend({ dbPath, version: "test", cipher: plaintextCipher, providers: registry, autoSync, syncIntervalMs: 500 });
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId: "p112", origin: "renderer" });
    client = new RpcClient(c);
    return { backend, client };
  };
  const close = async () => {
    client?.close();
    if (backend) await bounded(backend.stop(), "backend stop");
    backend = null;
  };
  cleanups.push(async () => {
    await close();
    rmSync(dir, { recursive: true, force: true });
  });

  // the old Terno: the account and its mail, synced
  const first = open(false);
  const account = await first.client.call("accounts.addImap", {
    email: "synthetic@example.test", displayName: "Synthetic",
    imap: { host: "127.0.0.1", port, secure: false, user: "testuser" },
    smtp: { host: "127.0.0.1", port: 1, secure: false, user: "testuser" }, password: "testpass", verify: false,
  });
  await first.backend.syncAccount(account.id);
  expect(sqlDb(first.backend.store).get<{ n: number }>("SELECT count(*) AS n FROM threads")!.n).toBe(1000);
  await close();

  // as that Terno's schema left it on disk (v40), then the update's first start: the migration runs at open
  const current = new Db(nodeSqliteDriver, dbPath);
  writeLegacyCopy(current, join(dir, "old.db"), BEFORE);
  current.close();
  for (const f of ["", "-wal", "-shm"]) rmSync(`${dbPath}${f}`, { force: true });
  renameSync(join(dir, "old.db"), dbPath);

  const next = open(true);
  await next.backend.store.ready;
  const db = sqlDb(next.backend.store);
  expect(db.get<{ user_version: number }>("PRAGMA user_version")!.user_version).toBeGreaterThan(BEFORE);
  expect(db.get("SELECT 1 FROM view_unread_backfill")).toBeDefined();
  // the tally takes its first slice, then waits until the mail below has synced
  const rebuild = next.backend.store.folders.rebuild.bind(next.backend.store.folders);
  const midway = deferred<void>();
  const held = deferred<void>();
  let slices = 0;
  next.backend.store.folders.rebuild = async (limit) => {
    if (++slices === 2) {
      midway.resolve();
      await held.promise;
    }
    return rebuild(limit);
  };
  void next.backend.start();
  await bounded(midway.promise, "the tally's second slice", 20_000);
  const cursor = db.get<{ after_id: number }>("SELECT after_id FROM view_unread_backfill")!.after_id;
  expect(cursor).toBeGreaterThan(0);

  // meanwhile, on the server: new unread mail in each place, old mail read and unread on both sides of the tally's
  // cursor, and an unread conversation moved to the archive by another app (plan 114)
  server.control.addMessage("INBOX", mail("new in inbox"));
  server.control.addMessage("Archive", mail("new in archive"));
  server.control.addMessage("Junk", mail("new in junk"));
  const archived = server.control.listMessages("Archive") as { uid: number; flags: string[] }[];
  const unreadArchived = archived.filter((m) => !m.flags.includes("\\Seen"));
  server.control.setFlags("Archive", [unreadArchived[0]!.uid, unreadArchived.at(-2)!.uid], ["\\Seen"], "add");
  server.control.setFlags("Archive", [archived.find((m) => m.flags.includes("\\Seen"))!.uid], ["\\Seen"], "remove");
  const inbox = server.control.listMessages("INBOX") as { uid: number; flags: string[] }[];
  // the first unread in the inbox is "inbox 0"
  server.control.moveMessages("INBOX", [inbox.find((m) => !m.flags.includes("\\Seen"))!.uid], "Archive");

  // it syncs (push and the poll) while the tally is still unfinished
  const subjects = () => new Set(db.all<{ subject: string }>("SELECT subject FROM messages WHERE subject LIKE 'new in %'").map((r) => r.subject));
  await until(() => subjects().size === 3, "new mail synced during the tally");
  await until(() => db.get<{ n: number }>("SELECT count(*) AS n FROM threads WHERE unread_count = 0 AND in_inbox = 0 AND in_spam = 0 AND in_trash = 0")!.n === 251, "the archive's flags synced");
  await until(() => db.get<{ in_inbox: number }>("SELECT t.in_inbox FROM threads t JOIN messages m ON m.thread_id = t.id WHERE m.subject = 'inbox 0'")?.in_inbox === 0, "the move synced");
  expect(db.get("SELECT 1 FROM view_unread_backfill"), "the tally is still midway").toBeDefined();
  expect(slices).toBe(2);

  held.resolve();
  await until(() => db.get("SELECT 1 FROM view_unread_backfill") === undefined, "the tally finished");
  const t = tallies(db);
  expect(t.viewUnread).toEqual(t.viewTruth);
  expect(t.folderUnread).toEqual(t.folderTruth);
  // Archive: 250 unread, 2 read meanwhile, 1 unread again, 1 new and 1 moved in; Spam: 100 and 1 new
  expect(t.viewUnread).toEqual([{ account_id: account.id, view: 1, n: 250 - 2 + 1 + 1 + 1 }, { account_id: account.id, view: 2, n: 101 }]);
});
