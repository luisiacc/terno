import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
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

/** A fresh, migrated database on a temp file (WAL, like production). */
export function testDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), "unica-test-"));
  const db = openDatabase(join(dir, "test.db"));
  opened.push({ db, dir });
  return db;
}

export function withAccounts(db: Db, n = 2): number[] {
  return Array.from({ length: n }, (_, i) =>
    createAccount(db, { kind: i % 2 ? "imap" : "gmail", email: `me${i}@example.com`, displayName: `Account ${i}`, color: "indigo" }).id,
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
