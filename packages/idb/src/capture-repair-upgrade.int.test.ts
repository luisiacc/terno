import "fake-indexeddb/auto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDBFactory } from "fake-indexeddb";
import { upgradeLegacyBodies, openDatabase, SqlMailStore } from "../../db/src/index";
import { IdbMailStore } from "./store";
import { upgradeLegacyIdbBodies } from "./body-upgrade";
import { databaseName } from "./schema";
import type { MailStore } from "@terno/store";
import { expect, it } from "vitest";
const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
async function seed(store: MailStore) {
  const { account } = await store.accounts.create({ kind: "gmail", email: "synthetic@example.test", displayName: "Synthetic", color: "blue", now: 1 });
  await store.sync.ingest([{ accountId: account.id, providerMsgId: "cached", providerThreadId: null, rfcMessageId: "cached@example.test", inReplyTo: null, references: [], from: { name: "", email: "sender@example.test" }, to: [], cc: [], bcc: [], subject: "Cached", date: 1, snippet: "Exact", bodyText: "Exact cached body", bodyHtml: null, bodyState: "full", listId: null, isRead: true, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 5 }], { applyFilters: false, now: 1, classifier: null });
  return { account, before: (await store.debug.snapshot()).messages };
}
it("SQL35 upgrades capture schema without changing cached mail, cursor or account incarnation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-capture-upgrade-")), path = join(dir, "synthetic.db");
  let store: MailStore = new SqlMailStore(openDatabase(path), { platform, instantSearch: false });
  try {
    const { account, before } = await seed(store);
    const reminder={threadId:before[0]!.threadId,dueAt:1000,kind:"always" as const,setAt:1};
    await store.reminders.put([reminder],100);
    await store.accounts.setCursor(account.id, { historyId: "100" }); await store.close();
    // Remove only migration36's additions (and the later migrations', plan 86's v37, plan 94's v38 and plan 96's v39) to create the exact prior schema shape with populated data.
    const legacy = new DatabaseSync(path);
    legacy.exec("DROP TRIGGER IF EXISTS body_fact_body_heads_insert; DROP TRIGGER IF EXISTS body_fact_body_heads_update; DROP TRIGGER IF EXISTS body_fact_body_heads_delete; DROP TRIGGER IF EXISTS body_fact_filters_insert; DROP TRIGGER IF EXISTS body_fact_filters_update; DROP TRIGGER IF EXISTS body_fact_filters_delete; DROP TRIGGER IF EXISTS body_fact_accounts_insert; DROP TRIGGER IF EXISTS body_fact_accounts_update; DROP TRIGGER IF EXISTS body_fact_accounts_delete; DROP TRIGGER IF EXISTS body_fact_secrets_insert; DROP TRIGGER IF EXISTS body_fact_secrets_update; DROP TRIGGER IF EXISTS body_fact_secrets_delete; DROP TRIGGER IF EXISTS body_fact_message_locations_insert; DROP TRIGGER IF EXISTS body_fact_message_locations_update; DROP TRIGGER IF EXISTS body_fact_message_locations_delete; DROP TRIGGER IF EXISTS body_fact_imap_identity_holds_insert; DROP TRIGGER IF EXISTS body_fact_imap_identity_holds_update; DROP TRIGGER IF EXISTS body_fact_imap_identity_holds_delete; DROP TABLE body_protocol;");
    // Remove the later committed v41-v43 schema before rebuilding the exact SQL35 fixture.
    legacy.exec("DROP TRIGGER threads_view_unread_ai; DROP TRIGGER threads_view_unread_ad; DROP TRIGGER threads_view_unread_au; DROP TABLE view_unread; DROP TABLE view_unread_backfill; DROP TABLE folder_aliases; ALTER TABLE folders DROP COLUMN except_json");
    // plan 133's v50, plan 134's v49
    legacy.exec("DROP TABLE writing_generations; DROP TABLE writing_profiles; DROP INDEX messages_sent_date; DROP INDEX cls_examples_evidence");
    // plans 131 and 132's v48
    legacy.exec("DROP TABLE ai_summaries; DROP TABLE ai_new_mail");
    // plan 127's v47
    legacy.exec("DROP INDEX ops_folder_moves");
    // plan 116's v44
    legacy.exec("DROP TABLE forward_recipients; DROP TABLE forwards; DROP TABLE forward_eligible; ALTER TABLE categories DROP COLUMN forward_json; ALTER TABLE filters DROP COLUMN forward_json");
    legacy.exec("ALTER TABLE messages DROP COLUMN unsubscribe");
    legacy.exec("DROP TABLE scheduled_sends; DROP INDEX threads_unread_tab; DROP INDEX threads_tab_date; DROP INDEX threads_tab_id; DROP INDEX threads_waiting_inbox_tab; ALTER TABLE threads DROP COLUMN tab; ALTER TABLE messages DROP COLUMN category; DELETE FROM settings WHERE key = 'tabs_backfill'");
    legacy.exec("DROP TRIGGER body_revision_changed; DROP TRIGGER body_head_added; DROP TRIGGER body_head_changed; DROP TRIGGER body_head_removed; DROP TABLE body_heads; DROP TABLE body_parts; DROP TABLE body_captures; ALTER TABLE message_bodies DROP COLUMN capture_id; ALTER TABLE message_bodies DROP COLUMN body_preview; ALTER TABLE message_bodies DROP COLUMN body_revision; DELETE FROM settings WHERE key='body_parts_upgrade'; DROP TRIGGER capture_repair_location_removed; DROP TRIGGER capture_repair_location_changed; DROP TABLE capture_repairs; DROP TABLE capture_repair_usage; PRAGMA user_version=35"); legacy.close();
    const upgraded = openDatabase(path);
    await upgradeLegacyBodies(upgraded, platform.yield, async () => {}, () => {});
    store = new SqlMailStore(upgraded, { platform, instantSearch: false });
    expect((await store.debug.snapshot()).messages).toEqual(before);
    expect(await store.reminders.list()).toEqual([reminder]);
    expect((await store.accounts.config<{ cursor: unknown }>(account.id))!.config.cursor).toEqual({ historyId: "100" });
    await store.captureRepairs.block(account.id, { kind: "gmail", providerId: "p" }, "mime-parts", 0);
    expect((await store.captureRepairs.list(account.id)).items).toHaveLength(1);
    const replacement = await store.accounts.create({ kind: "gmail", email: "other@example.test", displayName: "Other", color: "blue", now: 1 }); expect(replacement.account.id).toBeGreaterThan(account.id);
  } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
});
function request<T>(value: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); }); }
function done(tx: IDBTransaction): Promise<void> { return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error); }); }
it("native fake-IDB21 upgrades capture schema while retaining populated mail and account HWM", async () => {
  const factory = new IDBFactory(), original = crypto.randomUUID(), name = crypto.randomUUID();
  let store = await IdbMailStore.open({ factory, name: original, platform, instantSearch: false });
  const { account, before } = await seed(store);
  const reminder={threadId:before[0]!.threadId,dueAt:1000,kind:"always" as const,setAt:1}; await store.reminders.put([reminder],100);
  await store.accounts.setCursor(account.id, { historyId: "100" }); await store.close();
  const source = await request(factory.open(databaseName(original)));
  const names = [...source.objectStoreNames].filter((n) => n !== "capture_repairs" && !n.startsWith("body_"));
  const read = source.transaction(names, "readonly"), readDone = done(read);
  const images = await Promise.all(names.map(async (name) => {
    const table = read.objectStore(name);
    const [keys, values] = await Promise.all([request(table.getAllKeys()), request(table.getAll())]);
    return { name, keys, values, indexes: [...table.indexNames].map((index) => { const i = table.index(index); return { name: index, keyPath: i.keyPath, unique: i.unique, multiEntry: i.multiEntry }; }) };
  })); await readDone; source.close();
  const opening = factory.open(databaseName(name), 21);
  opening.onupgradeneeded = () => { for (const image of images) { const table = opening.result.createObjectStore(image.name); for (const index of image.indexes) table.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry }); } };
  const legacy = await request(opening), write = legacy.transaction(names, "readwrite"), written = done(write);
  for (const image of images) image.values.forEach((value, i) => write.objectStore(image.name).put(value, image.keys[i]));
  await written; legacy.close();
  store = await IdbMailStore.open({ factory, name, platform, instantSearch: false, legacyUpgrade: (name) => upgradeLegacyIdbBodies(factory, name, platform.yield, async () => {}, () => {}).then(() => {}) });
  try {
    expect((await store.debug.snapshot()).messages).toEqual(before);
    expect(await store.reminders.list()).toEqual([reminder]);
    expect((await store.accounts.config<{ cursor: unknown }>(account.id))!.config.cursor).toEqual({ historyId: "100" });
    await store.captureRepairs.block(account.id, { kind: "gmail", providerId: "p" }, "mime-parts", 0);
    expect((await store.captureRepairs.list(account.id)).items).toHaveLength(1);
    const replacement = await store.accounts.create({ kind: "gmail", email: "other@example.test", displayName: "Other", color: "blue", now: 1 }); expect(replacement.account.id).toBeGreaterThan(account.id);
  } finally { await store.close(); }
});
