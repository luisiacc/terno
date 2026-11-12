import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach } from "vitest";
import type { IncomingMessage } from "../ingest";
import { openDatabase } from "../index";
import { createAccount } from "../repos";
import type { Db } from "../sqlite";

const opened: { db: Db; dir: string }[] = [];
afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// walking every migration is most of a fresh open (58 ms against 15 ms), and migrations.test.ts is what tests it
let migrated: { dir: string; path: string } | undefined;
afterAll(() => {
  if (migrated) rmSync(migrated.dir, { recursive: true, force: true });
  migrated = undefined;
});

/** Puts a copy of an empty, migrated and closed database (so no WAL) at `path`. */
export function copyMigrated(path: string): string {
  if (!migrated) {
    const dir = mkdtempSync(join(tmpdir(), "terno-migrated-"));
    migrated = { dir, path: join(dir, "migrated.db") };
    openDatabase(migrated.path).close();
  }
  copyFileSync(migrated.path, path);
  return path;
}

/** A fresh, migrated database on a temp file (WAL, like production). */
export function testDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), "terno-test-"));
  const db = openDatabase(copyMigrated(join(dir, "test.db")));
  opened.push({ db, dir });
  return db;
}

export function withAccounts(db: Db, n = 2): number[] {
  return Array.from({ length: n }, (_, i) =>
    createAccount(db, { kind: i % 2 ? "imap" : "gmail", email: `me${i}@example.com`, displayName: `Account ${i}`, color: "brown" }).id,
  );
}

let counter = 0;
export function msg(over: Partial<IncomingMessage> & { accountId: number }): IncomingMessage {
  counter++;
  return {
    providerMsgId: `p${counter}`,
    providerThreadId: null,
    rfcMessageId: `m${counter}@test`,
    inReplyTo: null,
    references: [],
    from: { name: "Ana Pérez", email: "ana@example.com" },
    to: [{ name: "Me", email: "me@example.com" }],
    cc: [],
    bcc: [],
    subject: `Subject ${counter}`,
    date: 1_700_000_000_000 + counter * 1000,
    snippet: "",
    bodyText: `body ${counter}`,
    bodyHtml: null,
    bodyState: "full",
    listId: null,
    isRead: false,
    isStarred: false,
    inInbox: true,
    isSent: false,
    isDraft: false,
    isTrash: false,
    isSpam: false,
    hasAttachments: false,
    size: 100,
    ...over,
  };
}

export function threadOf(db: Db, providerMsgId: string): number {
  return db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE provider_msg_id = ?", providerMsgId)!.thread_id;
}

export function ftsIntegrity(db: Db): void {
  // rank=1 makes SQLite compare the index against the external content (the view)
  db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1)");
}
