/**
 * Plan 86 (migration v37): a mailbox from before has no categories and no tabs. The migration marks a backfill
 * (with a Gmail account) that the backend's runner drives slice by slice; a close mid-way resumes from its
 * progress, and until a thread is done it stays in the Inbox.
 */
import { ingest, msg, threadOf, withAccounts } from "@terno/store/conformance";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import { openDatabase } from "./index";
import { MIGRATIONS, runMigration, SCHEMA_VERSION } from "./migrations";
import { sqlDb, SqlMailStore } from "./sql-store";
import { requestTabRefresh } from "./tabs";

const dirs: string[] = [];
const opened: SqlMailStore[] = [];
afterEach(async () => {
  for (const s of opened.splice(0)) if (s.isOpen) await s.close();
});
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const open = (path: string) => {
  const s = new SqlMailStore(openDatabase(path));
  opened.push(s);
  return s;
};

it("a mailbox from before gets its tabs once, in slices that resume after a close", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-tabs-"));
  dirs.push(dir);
  const path = join(dir, "s.db");
  let store = open(path);
  const [gmail, imap] = await withAccounts(store, 2);
  const promos = Array.from({ length: 5 }, (_, i) => msg({ accountId: gmail!, providerMsgId: `promo${i}`, from: { name: "", email: `deals${i}@shop.com` }, gmailLabels: ["INBOX", "CATEGORY_PROMOTIONS"] }));
  await ingest(store, [...promos, msg({ accountId: gmail!, providerMsgId: "person", gmailLabels: ["INBOX", "CATEGORY_PERSONAL"] }), msg({ accountId: imap!, providerMsgId: "imap" })]);
  const person = await threadOf(store, "person");
  const tabbed = await Promise.all(promos.map((m) => threadOf(store, m.providerMsgId!)));
  expect((await store.threads.list({ view: "inbox", limit: 20 })).items).toHaveLength(2);
  // what v37 found: no category, no tab, the backfill marked
  const db = sqlDb(store);
  db.run("UPDATE messages SET category = NULL");
  db.run("UPDATE threads SET tab = 0");
  db.run(`INSERT INTO settings (key, value_json) VALUES ('tabs_backfill', '{"phase":"messages","after":0}')`);
  expect((await store.threads.list({ view: "inbox", limit: 20 })).items).toHaveLength(7);
  expect(await store.tabs.idle()).toBe(false);
  // a move the user makes meanwhile is theirs: the backfill never overwrites it
  await store.threads.act({ threadIds: [tabbed[0]!], action: "toPrimary", signal: null, now: 1 });
  for (let i = 0; i < 3; i++) await store.tabs.backfill({ limit: 2 });
  await store.close();

  store = open(path);
  let slices = 0;
  while ((await store.tabs.backfill({ limit: 2 })).more) slices++;
  expect(slices).toBeGreaterThan(0);
  expect(await store.tabs.idle()).toBe(true);
  const inbox = (await store.threads.list({ view: "inbox", limit: 20 })).items.map((t) => t.id);
  expect(inbox).toEqual(expect.arrayContaining([person, tabbed[0]!]));
  expect(inbox).toHaveLength(3);
  expect((await store.threads.list({ view: "inbox", accountId: gmail!, tab: "promotions", limit: 20 })).items.map((t) => t.id).sort()).toEqual(tabbed.slice(1).sort());
  expect(sqlDb(store).get<{ c: number }>("SELECT count(*) AS c FROM messages WHERE gmail_labels IS NOT NULL AND category IS NULL")!.c).toBe(0);
});

it("a slice stops once it has read its share of messages, mid-window, and the next goes on from there", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-tabs-"));
  dirs.push(dir);
  const store = open(join(dir, "s.db"));
  const [gmail] = await withAccounts(store, 1);
  // four conversations of three promotions each
  for (let t = 0; t < 4; t++) await ingest(store, [0, 1, 2].map((i) => msg({ accountId: gmail!, providerMsgId: `t${t}m${i}`, providerThreadId: `gt${t}`, from: { name: "", email: `deals${t}@shop.com` }, gmailLabels: ["INBOX", "CATEGORY_PROMOTIONS"] })));
  const db = sqlDb(store);
  const threads = db.all<{ id: number }>("SELECT id FROM threads ORDER BY id").map((r) => r.id);
  db.run("UPDATE threads SET tab = 0");
  db.run(`INSERT INTO settings (key, value_json) VALUES ('tabs_backfill', '{"phase":"threads","after":0}')`);
  const tabs = () => threads.map((id) => db.get<{ tab: number }>("SELECT tab FROM threads WHERE id = ?", id)!.tab);
  // slices of 2 messages: each reads one conversation (3 messages), never the whole window
  for (let slice = 1; slice <= threads.length; slice++) {
    const r = await store.tabs.backfill({ limit: 2 });
    expect(tabs().filter((t) => t === 1)).toHaveLength(slice);
    expect(r.more).toBe(slice < threads.length);
  }
  expect(await store.tabs.idle()).toBe(true);
});

// with no pass under way, and with one in its threads phase already past every thread (Codex critique: it starts again)
it.each([["no pass under way", null], ["a pass past every thread", '{"phase":"threads","after":1000000}']] as const)("v78 (plan 256): a mailbox from before learns which Inbox conversations are only your own mail, in the tabs' slices (%s)", async (_, job) => {
  const dir = mkdtempSync(join(tmpdir(), "terno-tabs-"));
  dirs.push(dir);
  const path = join(dir, "s.db");
  let store = open(path);
  const [gmail] = await withAccounts(store, 1);
  await ingest(store, [
    msg({ accountId: gmail!, providerMsgId: "note", from: { name: "", email: "me0@example.com" }, isSent: true, gmailLabels: ["SENT", "INBOX"] }),
    msg({ accountId: gmail!, providerMsgId: "person", gmailLabels: ["INBOX", "CATEGORY_PERSONAL"] }),
  ]);
  const note = await threadOf(store, "note");
  const person = await threadOf(store, "person");
  // what v77 was: no column; then v78 alone, as an upgrade runs it (rewinding user_version would run every later step again)
  const db = sqlDb(store);
  db.run("ALTER TABLE threads DROP COLUMN only_yours");
  db.run("DELETE FROM settings WHERE key = 'tabs_backfill'");
  if (job) db.run("INSERT INTO settings (key, value_json) VALUES ('tabs_backfill', ?)", job);
  runMigration(db, MIGRATIONS.find((m) => m.version === 78)!);
  db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  await store.close();

  store = open(path);
  // the upgrade only adds the column and asks for the pass: offered as before until the pass reaches it
  expect((await store.threads.summaries([note]))[0]!.onlyYours).toBeUndefined();
  expect(JSON.parse(sqlDb(store).get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'tabs_backfill'")!.value_json)).toEqual({ phase: "threads", after: 0 });
  while ((await store.tabs.backfill({ limit: 50 })).more);
  expect(await store.tabs.idle()).toBe(true);
  const rows = new Map((await store.threads.summaries([note, person])).map((t) => [t.id, t.onlyYours]));
  expect([rows.get(note), rows.get(person)]).toEqual([true, undefined]);
});

it("a refresh asked during a threads pass starts it again; one in its messages phase goes on (plan 256)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-tabs-"));
  dirs.push(dir);
  const store = open(join(dir, "s.db"));
  await withAccounts(store, 1);
  const db = sqlDb(store);
  sqlDb(store).run("UPDATE accounts SET kind = 'gmail'");
  const job = () => JSON.parse(db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'tabs_backfill'")!.value_json) as unknown;
  db.run(`INSERT OR REPLACE INTO settings (key, value_json) VALUES ('tabs_backfill', '{"phase":"threads","after":40}')`);
  requestTabRefresh(db);
  expect(job()).toEqual({ phase: "threads", after: 0 });
  db.run(`INSERT OR REPLACE INTO settings (key, value_json) VALUES ('tabs_backfill', '{"phase":"messages","after":40}')`);
  requestTabRefresh(db);
  expect(job()).toEqual({ phase: "messages", after: 40 });
});

it("a slice stopped by its budget never skips a lower thread: two accounts' threads interleaved (plan 256, Codex code review)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-tabs-"));
  dirs.push(dir);
  const store = open(join(dir, "s.db"));
  const [a, b] = await withAccounts(store, 2);
  sqlDb(store).run("UPDATE accounts SET kind = 'gmail'");
  // notes to yourself, the two accounts' threads one after the other, each of three messages
  for (let t = 0; t < 6; t++) await ingest(store, [0, 1, 2].map((i) => msg({ accountId: (t % 2 ? b : a)!, providerMsgId: `n${t}m${i}`, providerThreadId: `gn${t}`, from: { name: "", email: "me0@example.com" }, isSent: true, gmailLabels: ["SENT", "INBOX"] })));
  const db = sqlDb(store);
  db.run("UPDATE threads SET only_yours = 0");
  db.run(`INSERT OR REPLACE INTO settings (key, value_json) VALUES ('tabs_backfill', '{"phase":"threads","after":0}')`);
  // the planner's statistics (as a mailbox's PRAGMA optimize leaves them) may walk the threads account by account
  // (accounts first, then each one's threads in the window: 1, 3 before 2, 4), and a slice's budget of 4 messages
  // stops it after 3, its window's second thread of the first account
  db.run("ANALYZE");
  while ((await store.tabs.backfill({ limit: 4 })).more);
  expect(db.all<{ only_yours: number }>("SELECT only_yours FROM threads ORDER BY id").map((r) => r.only_yours)).toEqual([1, 1, 1, 1, 1, 1]);
});
