import { expect, it } from "vitest";
import { SqlMailStore } from "./sql-store";
import { ingestMessages } from "./ingest";
import { noteSentMail, noteSentMailPrepared } from "./facts";
import { prepareRecipientCorrespondents } from "./recipient-fts-preparation";
import { ftsIntegrity, testDb, msg } from "./test/helpers";

const yieldNow = () => new Promise<void>((resolve) => setImmediate(resolve));

it("keeps every recipient occurrence and exact recipient phrases searchable immediately", async () => {
  const db = testDb(), store = new SqlMailStore(db, { platform: { yield: yieldNow } });
  const { account } = await store.accounts.create({ kind: "imap", email: "synthetic@example.test", displayName: "Synthetic", color: "indigo", providerConfig: { appendToSent: false }, now: 1 });
  const to = [{ name: "Éxample Name", email: "same+tag@example.test" }, { name: "名字 One", email: "one@example.test" }];
  const cc = [{ name: "Éxample Name", email: "same+tag@example.test" }, { name: "Greek Ελληνικά", email: "two@example.test" }];
  const bcc = [...Array.from({ length: 65 }, (_, i) => ({ name: `Filler ${i}`, email: `filler${i}@example.test` })), { name: "Last Boundary", email: "three@example.test" }];
  const queued = await store.compose.queueSend({ accountId: account.id, to, cc, bcc, subject: "Synthetic", bodyText: "Exact", recordReply: false, now: 2 });
  const payload = JSON.parse((await store.ops.get(queued.opId))!.payload_json);
  expect({ to: payload.to, cc: payload.cc, bcc: payload.bcc }).toEqual({ to, cc, bcc });
  for (const query of ['to:"example name"', 'to:"same tag example test"', 'to:"last boundary"', 'to:greek', 'to:ελ']) expect((await store.threads.searchText({ query, accountId: account.id, now: 3, limit: 10 })).items).toHaveLength(1);
  expect((await store.threads.searchText({ query: 'to:"boundary last"', accountId: account.id, now: 3, limit: 10 })).items).toHaveLength(0);
  ftsIntegrity(db);
});

it("rolls back draft, operation, recipient evidence and search index together", async () => {
  const db = testDb(), store = new SqlMailStore(db, { platform: { yield: yieldNow } });
  const { account } = await store.accounts.create({ kind: "imap", email: "synthetic@example.test", displayName: "Synthetic", color: "indigo", providerConfig: { appendToSent: false }, now: 1 });
  const to = Array.from({ length: 80 }, (_, i) => ({ name: "Rollback Probe", email: `rollback${i}@example.test` }));
  const draft = (await store.drafts.save({ accountId: account.id, to, cc: [], bcc: [], subject: "Atomic", bodyText: "Exact" }, 1))!;
  let armed = true; db.onBeforeCommit(() => { if (armed) { armed = false; throw new Error("Synthetic rollback"); } });
  await expect(store.compose.queueSend({ accountId: account.id, to, cc: [], bcc: [], subject: "Atomic", bodyText: "Exact", draftId: draft.id, draftGeneration: draft.generation, draftRevision: draft.revision, recordReply: false, now: 2 })).rejects.toThrow("Synthetic rollback");
  expect((await store.drafts.list()).find((entry) => entry.id === draft.id)).toEqual(draft);
  expect(await store.recipientReceipts.list(account.id)).toEqual([]);
  expect((await store.ops.recent(100)).filter((entry) => entry.kind === "send")).toEqual([]);
  expect((await store.threads.searchText({ query: 'to:"rollback probe"', accountId: account.id, now: 3, limit: 10 })).items).toEqual([]);
  ftsIntegrity(db);
});

it("does not consume a draft edited while recipient preparation yields", async () => {
  const db = testDb(); let store: SqlMailStore, change: (() => Promise<void>) | undefined, yields = 0;
  store = new SqlMailStore(db, { platform: { yield: async () => { yields++; const pending = yields === 3 ? change : undefined; if (pending) { change = undefined; await pending(); } else await yieldNow(); } } });
  const { account } = await store.accounts.create({ kind: "imap", email: "synthetic@example.test", displayName: "Synthetic", color: "indigo", providerConfig: { appendToSent: false }, now: 1 });
  const to = Array.from({ length: 80 }, (_, i) => ({ name: "Synthetic", email: `r${i}@example.test` }));
  const draft = (await store.drafts.save({ accountId: account.id, to, cc: [], bcc: [], subject: "Original", bodyText: "Original" }, 1))!;
  yields = 0;
  change = async () => { await store.drafts.save({ id: draft.id, generation: draft.generation, baseRevision: draft.revision, accountId: account.id, to, cc: [], bcc: [], subject: "Edited", bodyText: "Still here" }, 2); };
  await expect(store.compose.queueSend({ accountId: account.id, to, cc: [], bcc: [], subject: "Original", bodyText: "Original", draftId: draft.id, draftGeneration: draft.generation, draftRevision: draft.revision, recordReply: false, now: 3 })).rejects.toMatchObject({ code: "STALE" });
  expect((await store.drafts.list()).find((entry) => entry.id === draft.id)).toMatchObject({ subject: "Edited", body_text: "Still here" });
  expect(await store.recipientReceipts.list(account.id)).toEqual([]);
  expect((await store.ops.recent(100)).filter((entry) => entry.kind === "send")).toEqual([]);
  ftsIntegrity(db);
});

it("queues a send without rereading its large operation payload for unrelated flag binding", async () => {
  const db = testDb(), store = new SqlMailStore(db, { platform: { yield: yieldNow } });
  const { account } = await store.accounts.create({ kind: "imap", email: "synthetic@example.test", displayName: "Synthetic", color: "indigo", providerConfig: { appendToSent: false }, now: 1 });
  const get = db.get.bind(db); let wideReads = 0;
  db.get = ((sql: string, ...params: Parameters<typeof db.get> extends [string, ...infer P] ? P : never) => { if (/^SELECT \* FROM ops WHERE id = \?/i.test(sql.trim())) wideReads++; return get(sql, ...params); }) as typeof db.get;
  await store.compose.queueSend({ accountId: account.id, to: [{ name: "Synthetic", email: "recipient@example.test" }], cc: [], bcc: [], subject: "Synthetic", bodyText: "Exact", recordReply: false, now: 2 });
  expect(wideReads).toBe(0);
});


it("staged FTS has the same tokens, positions, phrase matches and ranking as the original recipient text", async () => {
  const db = testDb(), store = new SqlMailStore(db, { platform: { yield: yieldNow } });
  const { account } = await store.accounts.create({ kind: "imap", email: "synthetic@example.test", displayName: "Synthetic", color: "indigo", providerConfig: { appendToSent: false }, now: 1 });
  const names = ["Éxample niñO 名字 ภาษาไทย Ελληνικά ςΣ ﬀ Ⅳ ① à\u0301", "İıẞK ﬁ Œ ø æ ǅ 𝔸 🏳️‍🌈 foo+tag", "a\u0301b\u034fcd ab.cd A_B 0️⃣ Test", "a\0b it's can't € 𐐀 𞤀 a-b c_d"];
  const addresses = Array.from({ length: 80 }, (_, index) => ({ name: names[index % names.length]!, email: `r${index}@example.test` }));
  const queued = await store.compose.queueSend({ accountId: account.id, to: addresses, cc: addresses.slice(0, 4), bcc: addresses.slice(-4), subject: "Synthetic", bodyText: "Exact", recordReply: false, now: 2 });
  const id = (JSON.parse((await store.ops.get(queued.opId))!.target_json) as { messageIds: number[] }).messageIds[0]!;
  const row = db.get<{ subject: string; from_name: string; from_email: string; recipients_text: string; body_text: string }>("SELECT m.subject,m.from_name,m.from_email,m.recipients_text,b.body_text FROM messages m JOIN message_bodies b ON b.message_id=m.id WHERE m.id=?", id)!;
  db.exec(`CREATE VIRTUAL TABLE temp.recipient_reference USING fts5(subject,from_text,recipients,body,tokenize='unicode61 remove_diacritics 2',prefix='2 3'); CREATE VIRTUAL TABLE temp.recipient_reference_vocab USING fts5vocab(recipient_reference,'instance'); CREATE VIRTUAL TABLE temp.recipient_live_vocab USING fts5vocab(main,messages_fts,'instance');`);
  db.run("INSERT INTO temp.recipient_reference(rowid,subject,from_text,recipients,body) VALUES(?,?,?,?,?)", id, row.subject, `${row.from_name} ${row.from_email}`, row.recipients_text, row.body_text);
  const entries = (table: string) => db.all(`SELECT term,col,offset FROM temp.${table} WHERE doc=? ORDER BY col,offset`, id);
  expect(entries("recipient_live_vocab")).toEqual(entries("recipient_reference_vocab"));
  for (const term of ['recipients : "example nino"', 'recipients : "foo tag"', 'recipients : "r79 example test"', 'recipients : "ελληνικά"', 'recipients : "exam"*']) {
    const actual = db.get<{ score: number }>("SELECT bm25(messages_fts) AS score FROM messages_fts WHERE messages_fts MATCH ? AND rowid=?", term, id);
    const reference = db.get<{ score: number }>("SELECT bm25(recipient_reference) AS score FROM temp.recipient_reference WHERE recipient_reference MATCH ? AND rowid=?", term, id);
    expect(actual).toEqual(reference);
  }
  expect(db.get<{ n: number }>("SELECT count(*) AS n FROM recipient_fts_stage")?.n).toBe(0);
  expect(db.get<{ n: number }>("SELECT count(*) AS n FROM sqlite_temp_master WHERE name LIKE 'terno_recipient_%'")?.n).toBe(0);
  ftsIntegrity(db);
});

it("batched outgoing correspondents preserve duplicate, alias, automatic and sender-fact behavior", async () => {
  const baseline = testDb(), candidate = testDb();
  for (const db of [baseline, candidate]) {
    db.run("INSERT INTO accounts(id,kind,email,display_name,provider_config,created_at) VALUES(1,'imap','me@example.test','Synthetic','{}',1)");
    const messages = Array.from({ length: 205 }, (_, index) => msg({ accountId: 1, providerMsgId: `tagged-${index}`, rfcMessageId: `tagged-${index}@example.test`, from: { name: "Support", email: `support+tag${index}@example.test` }, to: [{ name: "", email: "me@example.test" }], subject: `Thread ${index}`, date: 100 + index }));
    ingestMessages(db, messages, 1);
  }
  const addresses = [{ name: "", email: "Support+first@example.test" }, { name: "", email: "SUPPORT+second@example.test" }, { name: "", email: "noreply@example.test" }, { name: "", email: "support+tag0@other.test" }, ...Array.from({ length: 80 }, (_, index) => ({ name: "", email: `fresh${index}@example.test` }))];
  const prepared = (await prepareRecipientCorrespondents({ to: addresses, cc: addresses.slice(0, 3), bcc: [] }, yieldNow))!;
  const expected = noteSentMail(baseline, "me@example.test", [...addresses, ...addresses.slice(0, 3)]);
  const actual = noteSentMailPrepared(candidate, "me@example.test", prepared);
  expect(actual).toBe(expected);
  for (const sql of ["SELECT email,own,written FROM correspondents ORDER BY email", "SELECT id,person,waiting_since FROM threads ORDER BY id", "SELECT key,value_json FROM settings WHERE key LIKE 'facts%' ORDER BY key"]) expect(candidate.all(sql)).toEqual(baseline.all(sql));
});
