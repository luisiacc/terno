import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { openDatabase, SqlMailStore } from "@terno/db";
import { IdbMailStore } from "@terno/idb";
import { withAccounts, ingest, msg, threadOf } from "@terno/store/conformance";
import type { DraftInput, DraftRow } from "@terno/store";
import type { Draft } from "@terno/core/rpc";
vi.mock("~/rpc/connection", () => ({ client: {} }));
const { attachBody, copyDraft, createDraft, editDraft, fieldsOf, flushDraft, forgetDraft, markDraftMissing, setDraftTransport, shownDraftKey, useDrafts } = await import("./drafts");
const { newFields } = await import("./compose-fields");
const apiDraft = (r: DraftRow): Draft => ({ id: r.id, generation: r.generation ?? "", revision: r.revision, format: 2, accountId: r.account_id, threadId: r.thread_id, mode: r.mode, to: JSON.parse(r.to_json), cc: JSON.parse(r.cc_json), bcc: JSON.parse(r.bcc_json), subject: r.subject, subjectEdited: !!r.subject_edited, bodyText: r.body_text, bodyHtml: r.body_html, attachments: JSON.parse(r.attachments_json), quotedText: r.quoted_text, includeQuote: !!r.include_quote, inReplyToMessageId: r.in_reply_to_message_id, forwardOfMessageId: r.forward_of_message_id, uiState: r.ui_state, updatedAt: r.updated_at });

for (const adapter of ["SQL", "IDB exact", "IDB instant"] as const) it.each([false, true])(`${adapter}: normalized copy retains its live inline presentation (cross-account %s)`, async (crossAccount) => {
  const dir = mkdtempSync(join(tmpdir(), "terno-r2-presentation-"));
  const store = adapter === "SQL" ? new SqlMailStore(openDatabase(join(dir, "mail.db"))) : await IdbMailStore.open({ name: crypto.randomUUID(), factory: indexedDB, instantSearch: adapter === "IDB instant", platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
  let key: string | undefined;
  try {
    const [a, b] = await withAccounts(store);
    await ingest(store, [msg({ accountId: a!, providerMsgId: "first", rfcMessageId: "first@example.test" }), msg({ accountId: a!, providerMsgId: "second", references: ["first@example.test"] })]);
    const threadId = await threadOf(store, "first"), original = (await store.threads.get(threadId))!.messages.find((m) => m.rfcMessageId === "first@example.test")!;
    setDraftTransport(async (_method, p) => { const row = await store.drafts.save(p as DraftInput, 0); return row ? apiDraft(row) : null; });
    key = createDraft({ ...newFields(a!), threadId, mode: "reply", inReplyToMessageId: original.id });
    editDraft(key, { bodyText: "exact authored work", bodyHtml: "<div><b>exact authored work</b></div>", toText: '"Pérez, Ana" <ana@example.test>, bob@' }); await flushDraft(key);
    const old = useDrafts.getState().drafts[key]!; await store.drafts.delete(old.id!, old.generation);
    if (crossAccount) editDraft(key, { accountId: b! }); else await store.sync.remove([original.id]);
    expect((await store.threads.get(threadId))!.messages.length).toBe(crossAccount ? 2 : 1);
    markDraftMissing(key); expect(shownDraftKey(useDrafts.getState().drafts, threadId, null)).toBe(key);
    await copyDraft(key);
    const live = useDrafts.getState().drafts[key]!;
    expect(live).toMatchObject({ mode: crossAccount ? "reply" : "new", recovery: undefined, bodyText: "exact authored work", toText: '"Pérez, Ana" <ana@example.test>, bob@' });
    expect(shownDraftKey(useDrafts.getState().drafts, threadId, null)).toBe(key);
    expect(fieldsOf(live)).not.toHaveProperty("presentationThreadId");
    const saved = (await store.drafts.list())[0]!;
    expect(saved).toMatchObject({ thread_id: crossAccount ? null : threadId, mode: crossAccount ? "reply" : "new", in_reply_to_message_id: crossAccount ? original.id : null, body_html: "<div><b>exact authored work</b></div>" });
    editDraft(key, { threadId: null });
    expect(shownDraftKey(useDrafts.getState().drafts, threadId, { threadId, key })).toBeNull();
  } finally { if (key) forgetDraft(key); await store.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const adapter of ["SQL", "IDB exact", "IDB instant"] as const) it(`${adapter}: copy resolves a reused durable thread without moving its live editor`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-r3-presentation-")), name = crypto.randomUUID();
  const open = async () => adapter === "SQL" ? new SqlMailStore(openDatabase(join(dir, "mail.db"))) : await IdbMailStore.open({ name, factory: indexedDB, instantSearch: adapter === "IDB instant", platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
  let store = await open(), key: string | undefined;
  let body: ReturnType<typeof attachBody> | undefined;
  try {
    const [a] = await withAccounts(store);
    await ingest(store, [msg({ accountId: a!, providerMsgId: "first", rfcMessageId: "first@example.test" }), msg({ accountId: a!, providerMsgId: "source", rfcMessageId: "source@example.test" })]);
    const stale = await threadOf(store, "source"), original = (await store.threads.get(stale))!.messages[0]!;
    setDraftTransport(async (_method, p) => { const row = await store.drafts.save(p as DraftInput, 0); return row ? apiDraft(row) : null; });
    key = createDraft({ ...newFields(a!), threadId: stale, mode: "reply", inReplyToMessageId: original.id });
    editDraft(key, { bodyText: "saved", toText: '"Pérez, Ana" <ana@example.test>, bob@', quotedText: "> exact quote", includeQuote: true }); await flushDraft(key);
    const old = useDrafts.getState().drafts[key]!;
    await ingest(store, [msg({ accountId: a!, providerMsgId: "bridge", references: ["first@example.test", "source@example.test"] })]);
    await store.close(); store = await open();
    await ingest(store, [msg({ accountId: a!, providerMsgId: "unrelated", rfcMessageId: "unrelated@example.test" })]);
    expect(await threadOf(store, "unrelated")).toBe(stale);
    const merged = await threadOf(store, "bridge");
    await store.drafts.delete(old.id!, old.generation); markDraftMissing(key);
    body = attachBody(key, () => ({ text: "latest exact work", html: "<div><b>latest exact work</b></div>" })); body.changed();
    const version = useDrafts.getState().drafts[key]!.bodyVersion;
    await copyDraft(key);
    const live = useDrafts.getState().drafts[key]!;
    expect(live).toMatchObject({ threadId: merged, inReplyToMessageId: original.id, bodyVersion: version, canonical: true, bodyHtml: "<div><b>latest exact work</b></div>", toText: '"Pérez, Ana" <ana@example.test>, bob@', quotedText: "> exact quote", recovery: undefined });
    expect(shownDraftKey(useDrafts.getState().drafts, stale, null)).toBe(key);
    await store.close(); store = await open();
    expect((await store.drafts.list())[0]).toMatchObject({ thread_id: merged, in_reply_to_message_id: original.id, body_text: "latest exact work" });
  } finally { body?.dispose(); if (key) forgetDraft(key); await store.close(); rmSync(dir, { recursive: true, force: true }); }
});
