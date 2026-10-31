import { generateDataset } from "@terno/mock-data";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { rebuildFolders } from "./folders";
import { openDatabase } from "./index";
import { seedDataset } from "./seed";
import { writeLegacyCopy } from "./test/legacy";

it("v23 backfill attempts each distinct membership once per slice and rolls progress back with writes across restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-folder-upgrade-"));
  let db = openDatabase(join(dir, "source.db"));
  try {
    seedDataset(db, generateDataset({ threads: 100, accounts: 1, seed: 9, now: 0 }));
    const labels = Array.from({ length: 20 }, (_, i) => `Label_${i}`);
    db.run("UPDATE messages SET thread_id = (SELECT min(id) FROM threads), gmail_labels = ?, is_trash = 0, is_spam = 0", JSON.stringify(labels));
    db.run("DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id LIMIT 51)");
    db.run("UPDATE messages SET gmail_labels = ? WHERE id = (SELECT max(id) FROM messages)", JSON.stringify([...labels, "Label_late"]));
    const identities = db.all("SELECT id, provider_msg_id FROM messages ORDER BY id");
    const path = join(dir, "v23.db");
    writeLegacyCopy(db, path, 23);
    db.close();
    db = openDatabase(path);
    db.exec("CREATE TABLE attempts (n INTEGER NOT NULL); INSERT INTO attempts VALUES (0); CREATE TRIGGER count_attempt BEFORE INSERT ON thread_folders BEGIN UPDATE attempts SET n = n + 1; END");
    let fail = true;
    db.onBeforeCommit(() => { if (fail) throw new Error("interrupted commit"); });
    expect(() => rebuildFolders(db, 250)).toThrow("interrupted commit");
    expect(db.get("SELECT after_message_id FROM folder_backfill")).toEqual({ after_message_id: 0 });
    expect(db.get("SELECT count(*) AS n FROM thread_folders")).toEqual({ n: 0 });
    expect(db.get("SELECT n FROM attempts")).toEqual({ n: 0 });
    expect(db.all("SELECT * FROM folder_unread")).toEqual([]);
    fail = false;
    expect(rebuildFolders(db, 250).touched).toHaveLength(1);
    expect(db.get("SELECT n FROM attempts")).toEqual({ n: 20 });
    const progress = db.get("SELECT after_message_id FROM folder_backfill");
    expect(progress).toEqual({ after_message_id: 50 });
    db.close();
    db = openDatabase(path);
    expect(db.get("SELECT after_message_id FROM folder_backfill")).toEqual(progress);
    expect(rebuildFolders(db, 250)).toEqual({ more: false, touched: [1] });
    expect(db.get("SELECT n FROM attempts")).toEqual({ n: 41 });
    expect(db.get("SELECT count(*) AS n FROM thread_folders")).toEqual({ n: 21 });
    expect(db.all("SELECT folder FROM thread_folders ORDER BY folder")).toEqual([...labels, "Label_late"].sort().map((folder) => ({ folder })));
    expect(db.all("SELECT id, provider_msg_id FROM messages ORDER BY id")).toEqual(identities);
    expect(db.all("SELECT * FROM folder_backfill")).toEqual([]);
    expect(db.all("SELECT account_id, folder, count(*) AS n FROM thread_folders WHERE unread = 1 GROUP BY account_id, folder ORDER BY folder")).toEqual(db.all("SELECT account_id, folder, n FROM folder_unread ORDER BY folder"));
  } finally { if (db.isOpen) db.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("backfill deduplicates by thread and label, preserving the same label on different threads", () => {
  const db = openDatabase(":memory:");
  try {
    seedDataset(db, generateDataset({ threads: 3, accounts: 1, seed: 9, now: 0 }));
    db.run("UPDATE messages SET gmail_labels = ?, is_trash = 0, is_spam = 0", '["Label_shared", "Label_shared"]');
    db.exec("DELETE FROM thread_folders; INSERT INTO folder_backfill VALUES (0)");
    const expected = db.all("SELECT DISTINCT thread_id FROM messages ORDER BY thread_id");
    while (rebuildFolders(db, 250).more);
    expect(db.all("SELECT thread_id FROM thread_folders WHERE folder = 'Label_shared' ORDER BY thread_id")).toEqual(expected);
    expect(db.all("SELECT account_id, folder, count(*) AS n FROM thread_folders WHERE unread = 1 GROUP BY account_id, folder")).toEqual(db.all("SELECT account_id, folder, n FROM folder_unread"));
  } finally { db.close(); }
});
