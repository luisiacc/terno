import { CategorizerModel } from "@terno/core";
import type { FolderCountCursor, FolderExportCursor, FolderExportTarget, FolderPlace } from "@terno/store";
import { beforeAll, describe, expect, it } from "vitest";
import { sqliteDriver } from "./index";
import { refreshFolders } from "./folders";
import { SqlMailStore } from "./sql-store";
import type { IncomingMessage } from "./ingest";
import { msg, testDb, withAccounts } from "./test/helpers";

beforeAll(() => {
  console.log(JSON.stringify({ workerVersion: process.version, workerExecPath: process.execPath, driver: sqliteDriver().id }));
});

function fixture() {
  const db = testDb();
  const [gmail, imap, other] = withAccounts(db, 3);
  const store = new SqlMailStore(db, { instantSearch: false });
  const ingest = async (messages: IncomingMessage[]) => (await store.sync.ingest(messages, { applyFilters: false, now: 0, classifier: null })).inserted;
  const thread = (id: number) => db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE id=?", id)!.thread_id;
  return { db, store, ingest, thread, gmail: gmail!, imap: imap!, other: other! };
}
const folder = (key: string) => ({ key, path: [key], selectable: true });
const loc = (mailbox: string, uidvalidity: number, uid: number) => ({ mailbox, uidvalidity, uid, flags: [] });

async function count(store: SqlMailStore, accountId: number, keys: FolderPlace[], limit: number) {
  let total = 0, after: FolderCountCursor | null = null;
  for (let i = 0; i < 100; i++) {
    const result = await store.folders.count(accountId, keys, after, limit);
    total += result.messages;
    if (!result.next) return total;
    after = result.next;
  }
  throw new Error("synthetic count did not finish");
}
async function exported(store: SqlMailStore, target: FolderExportTarget, limit: number) {
  const ids: number[] = [];
  let after: FolderExportCursor | null = null;
  for (let i = 0; i < 100; i++) {
    const result = await store.folderExport.ids(target, after, limit);
    ids.push(...result.messages.map((m) => m.id));
    if (!result.next) return ids;
    after = result.next;
  }
  throw new Error("synthetic export did not finish");
}

describe("numbered SQL portability", () => {
  it("rootRefs: public roots, features and category training keep exact inbound roots", async () => {
    const { db, store, ingest, thread, gmail, other } = fixture();
    const ids = await ingest([
      msg({ accountId: gmail, providerThreadId: "root", date: 1, isSent: true }),
      msg({ accountId: gmail, providerThreadId: "root", date: 2, from: { name: "Me", email: "me0@example.com" } }),
      msg({ accountId: gmail, providerThreadId: "root", date: 3, bodyText: "chosen body" }),
      msg({ accountId: gmail, providerThreadId: "root", date: 3, bodyText: "later tie" }),
      msg({ accountId: other, providerThreadId: "root", date: 0 }),
      msg({ accountId: gmail, providerThreadId: "sent-only", isSent: true }),
    ]);
    const t = thread(ids[0]!);
    expect(await store.similar.roots([])).toEqual([]);
    expect(await store.similar.roots([t, t, thread(ids[5]!), 999999])).toEqual([ids[2]]);
    expect(await store.similar.roots([thread(ids[4]!)])).toEqual([ids[4]]);
    expect((await store.categorize.threadFeatures([t])).size).toBe(1);
    const category = await store.categories.create("Synthetic", "brown");
    await store.categories.add({ categoryId: category.id, threadIds: [t], addedBy: "user", now: 0 });
    expect(db.all("SELECT thread_id FROM cls_examples")).toEqual([{ thread_id: t }]);
    expect(db.get("SELECT body_text FROM message_bodies WHERE message_id=?", ids[2]!)).toEqual({ body_text: "chosen body" });
  });

  it("MEMBERSHIP: exported refresh derives labels, own generations and pending aliases", async () => {
    const { db, store, ingest, thread, gmail, imap, other } = fixture();
    await store.folders.replace(imap, [{ ...folder("Work"), except: [9] }, { ...folder("Job"), aliases: [{ mailbox: "Old", uidvalidity: 7 }] }]);
    const ids = await ingest([
      msg({ accountId: gmail, gmailLabels: ["Label_A", "Label_A"] }),
      msg({ accountId: imap, locations: [loc("Old", 7, 1)] }),
      msg({ accountId: imap, locations: [loc("Old", 8, 1)] }),
      msg({ accountId: other, gmailLabels: ["Label_A"] }),
      msg({ accountId: imap, locations: [loc("Work", 7, 1)] }),
      msg({ accountId: imap, locations: [loc("Work", 9, 1)] }),
    ]);
    db.run("UPDATE messages SET gmail_labels=? WHERE id=?", "malformed", ids[2]!);
    db.run("DELETE FROM thread_folders");
    refreshFolders(db, ids.map(thread));
    expect(db.all("SELECT thread_id, folder FROM thread_folders ORDER BY thread_id, folder")).toEqual([
      { thread_id: thread(ids[0]!), folder: "Label_A" }, { thread_id: thread(ids[1]!), folder: "Job" }, { thread_id: thread(ids[3]!), folder: "Label_A" }, { thread_id: thread(ids[4]!), folder: "Work" },
    ]);
    refreshFolders(db, []);
  });

  it("count places: generations, overlap and nullable wildcard remain account-bound", async () => {
    const { store, ingest, imap, other } = fixture();
    await store.folders.replace(imap, [folder("Work"), folder("Job")]);
    await ingest([
      msg({ accountId: imap, locations: [loc("Work", 7, 1), loc("Job", 3, 1)] }),
      msg({ accountId: imap, locations: [loc("Work", 9, 1)] }),
      msg({ accountId: other, locations: [loc("Work", 7, 1)] }),
    ]);
    expect(await count(store, imap, [{ mailbox: "Work", except: [9] }], 1)).toBe(1);
    expect(await count(store, imap, [{ mailbox: "Work", uidvalidity: 9 }, "Job", "Work"], 2)).toBe(2);
    expect(await count(store, imap, [], 1)).toBe(0);
  });

  it("count thread list: label memberships deduplicate overlapping folders", async () => {
    const { store, ingest, gmail, other } = fixture();
    await ingest([msg({ accountId: gmail, gmailLabels: ["Label_A", "Label_B"] }), msg({ accountId: other, gmailLabels: ["Label_A"] })]);
    expect(await count(store, gmail, ["Label_A", "Label_B"], 1)).toBe(1);
  });

  it("countThread same-date: explicit public resume reaches the message seek", async () => {
    const { store, ingest, thread, gmail } = fixture();
    const ids = await ingest([0, 1, 2].map(() => msg({ accountId: gmail, providerThreadId: "count", date: 10, gmailLabels: ["Label_A"] })));
    const result = await store.folders.count(gmail, ["Label_A"], { key: 0, places: false, after: [thread(ids[0]!), 10, ids[0]!] }, 1);
    expect(result.messages).toBe(1);
    expect(result.next?.after).toEqual([thread(ids[0]!), 10, ids[1]]);
  });

  it("countThread later/start: bounded start and resume retain labels and dates", async () => {
    const { db, store, ingest, gmail } = fixture();
    const ids = await ingest([10, 10, 20, 30].map((date) => msg({ accountId: gmail, providerThreadId: "count", date, gmailLabels: ["Label_A", "Label_B"] })));
    db.run("UPDATE messages SET gmail_labels=NULL WHERE id=?", ids[2]!);
    expect(await count(store, gmail, ["Label_A", "Label_B"], 1)).toBe(3);
    expect(await count(store, gmail, ["Label_A"], 20)).toBe(3);
  });

  it("MESSAGE_LABELS: bounded real-store backfill includes only (lo,hi]", async () => {
    const { db, store, ingest, thread, gmail } = fixture();
    const ids = await ingest([0, 1, 2].map(() => msg({ accountId: gmail, gmailLabels: ["Label_A", "Label_A"] })));
    db.run("DELETE FROM thread_folders");
    db.run("INSERT INTO folder_backfill(after_message_id) VALUES (?)", ids[0]!);
    await store.folders.rebuild(5);
    expect(db.all("SELECT thread_id, folder FROM thread_folders")).toEqual([{ thread_id: thread(ids[1]!), folder: "Label_A" }]);
    expect(db.get("SELECT after_message_id FROM folder_backfill")).toEqual({ after_message_id: ids[1] });
  });

  it.each(["folder", "view"] as const)("export %s later/FIRST: predicate bindings and the unused slot stay distinct", async (kind) => {
    const { store, ingest, gmail } = fixture();
    const ids = await ingest([10, 10, 20].map((date) => msg({ accountId: gmail, providerThreadId: "export", date, gmailLabels: ["Label_A"] })));
    const target = kind === "folder" ? { accountId: gmail, folder: "Label_A" } : { accountId: gmail, view: "inbox" as const };
    expect(await exported(store, target, 1)).toEqual(ids);
  });

  it.each(["folder", "view"] as const)("export %s same-date: resume preserves id tie order and full capacity", async (kind) => {
    const { store, ingest, thread, gmail } = fixture();
    const ids = await ingest([0, 1, 2, 3].map(() => msg({ accountId: gmail, providerThreadId: "export", date: 10, gmailLabels: ["Label_A"] })));
    const target = kind === "folder" ? { accountId: gmail, folder: "Label_A" } : { accountId: gmail, view: "inbox" as const };
    const result = await store.folderExport.ids(target, { thread: thread(ids[0]!), message: { date: 10, id: ids[0]! } }, 1);
    expect(result.messages.map((m) => m.id)).toEqual([ids[1]]);
    expect(result.next?.message).toEqual({ date: 10, id: ids[1] });
  });

  it("export optional fragments: independent alias and exclusion arrays select exact generations", async () => {
    const { store, ingest, imap, other } = fixture();
    await store.folders.replace(imap, [{ ...folder("Job"), aliases: [{ mailbox: "Old", uidvalidity: 7 }] }]);
    const ids = await ingest([
      msg({ accountId: imap, locations: [loc("Job", 9, 1)] }),
      msg({ accountId: imap, locations: [loc("Job", 7, 1)] }),
      msg({ accountId: imap, locations: [loc("Old", 7, 1)] }),
      msg({ accountId: imap, locations: [loc("Old", 8, 1)] }),
      msg({ accountId: other, locations: [loc("Job", 7, 1)] }),
    ]);
    for (const aliases of [undefined, [], [{ mailbox: "Old", uidvalidity: 7 }]]) {
      for (const except of [undefined, [], [9]]) {
        const expected = [ids[0], ids[1], ...(aliases?.length ? [ids[2]] : [])].filter((id) => !except?.length || id !== ids[0]);
        expect(await exported(store, { accountId: imap, folder: "Job", ...(aliases && { aliases }), ...(except && { except }) }, 1)).toEqual(expected);
      }
    }
  });

  it("export label guards and every standard view retain sparse flags, dates and account scope", async () => {
    const { db, store, ingest, gmail, other } = fixture();
    const ids = await ingest([
      msg({ accountId: gmail, providerThreadId: "flags", date: 10, gmailLabels: ["Label_A"] }),
      msg({ accountId: gmail, providerThreadId: "flags", date: 10, inInbox: false, isSent: true, gmailLabels: ["Label_AA"] }),
      msg({ accountId: gmail, providerThreadId: "flags", date: 10, isSpam: true, gmailLabels: ["Label_A"] }),
      msg({ accountId: gmail, providerThreadId: "flags", date: 20, isTrash: true, gmailLabels: ["Label_A"] }),
      msg({ accountId: gmail, providerThreadId: "flags", date: 20, isDraft: true, gmailLabels: ["Label_A"] }),
      msg({ accountId: gmail, providerThreadId: "flags", date: 30, gmailLabels: ["Label_A"] }),
      msg({ accountId: gmail, providerThreadId: "flags", date: 30, gmailLabels: ["Label_A"] }),
      msg({ accountId: other, gmailLabels: ["Label_A"] }),
    ]);
    db.run("UPDATE messages SET gmail_labels=NULL WHERE id=?", ids[5]!);
    db.run("UPDATE messages SET gmail_labels=? WHERE id=?", "[]", ids[6]!);
    for (const limit of [1, 20]) {
      expect(await exported(store, { accountId: gmail, folder: "Label_A" }, limit)).toEqual([ids[0]]);
      for (const [view, expected] of [
        ["inbox", [ids[0]!, ids[5]!, ids[6]!]], ["sent", [ids[1]!]], ["archive", [ids[1]!]], ["spam", [ids[2]!]], ["trash", [ids[3]!]],
      ] as const) expect(await exported(store, { accountId: gmail, view }, limit)).toEqual(expected);
    }
  });

  it("export reads preserve ordered headers, exact body bytes and sealed attachment ownership", async () => {
    const { store, ingest, gmail } = fixture();
    const bytes = new Uint8Array([1, 2, 3]);
    const ids = await ingest([msg({ accountId: gmail, gmailLabels: ["Label_A"], rfcMessageId: "<SOURCE@test>", references: ["parent@test"], bodyText: "héllo", bodyHtml: "<p>héllo</p>", attachments: [{ filename: "data.bin", mime: "application/octet-stream", size: 3, bytes }] })]);
    expect(await exported(store, { accountId: gmail, folder: "Label_A" }, 1)).toEqual(ids);
    const messages = await store.folderExport.messages(ids);
    expect(messages[0]).toMatchObject({ id: ids[0], accountId: gmail, rfcMessageId: "source@test", references: ["parent@test"], hasText: true, hasHtml: true });
    expect(await store.folderExport.body(ids[0]!, "text", 0, 100)).toEqual({ text: "héllo", next: null });
    expect(await store.folderExport.body(ids[0]!, "html", 0, 100)).toEqual({ text: "<p>héllo</p>", next: null });
    expect(await store.attachments.read(gmail, messages[0]!.attachments[0]!.assetId!, 0)).toBe("AQID");
  });

  it("history ineligible roots: missing, sent-only, archived, draft, spam and trash never become candidates", async () => {
    const { store, ingest, thread, gmail } = fixture();
    const ids = await ingest([
      msg({ accountId: gmail, isSent: true }), msg({ accountId: gmail, inInbox: false }),
      msg({ accountId: gmail, isDraft: true }), msg({ accountId: gmail, isSpam: true }), msg({ accountId: gmail, isTrash: true }),
    ]);
    for (const t of [999999, ...ids.map(thread)]) expect(await store.categorize.aiCandidate(t)).toBe(false);
  });

  it("history: public AI eligibility and recording honor each intervening decision", async () => {
    const { db, store, ingest, thread, gmail, other } = fixture();
    const ids = await ingest([msg({ accountId: gmail }), msg({ accountId: other })]);
    const t = thread(ids[0]!), foreign = thread(ids[1]!);
    const category = await store.categories.create("Synthetic", "brown");
    expect(await store.categorize.aiCandidate(t)).toBe(true);
    const suggestion = { threadId: t, categoryId: category.id, p: 0.9, explain: [], sender: "ana@example.com", encoded: new Uint32Array(), model: new CategorizerModel({ decayRef: 0 }), now: 0 };
    db.run("INSERT INTO thread_categories(thread_id,category_id,added_by,added_at) VALUES (?,?,'user',0)", foreign, category.id);
    expect(await store.categorize.recordAiSuggestion(suggestion)).toBe(true);
    expect(await store.categorize.aiCandidate(t)).toBe(false);
    db.run("DELETE FROM cls_decisions WHERE thread_id=?", t);
    for (const table of ["thread_categories", "cls_decisions", "cls_examples"] as const) {
      expect(await store.categorize.aiCandidate(t)).toBe(true);
      if (table === "thread_categories") db.run("INSERT INTO thread_categories(thread_id,category_id,added_by,added_at) VALUES (?,?,'user',0)", t, category.id);
      else if (table === "cls_decisions") db.run("INSERT INTO cls_decisions(thread_id,category_id,kind,p,explain_json,at) VALUES (?,?,'suggest',0.9,'[]',0)", t, category.id);
      else db.run("INSERT INTO cls_examples(thread_id,category_id,label,source,weight,at,features) VALUES (?,?,1,'user',1,0,x'')", t, category.id);
      expect(await store.categorize.aiCandidate(t)).toBe(false);
      expect(await store.categorize.recordAiSuggestion(suggestion)).toBe(false);
      db.run(`DELETE FROM ${table} WHERE thread_id=?`, t);
    }
  });
});
