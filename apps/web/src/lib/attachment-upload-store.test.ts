import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AttachmentRef } from "@terno/core";
import type { Draft } from "@terno/core/rpc";
import type { DraftInput, DraftRow, MailStore } from "@terno/store";
import { withAccounts, msg, ingest, threadOf } from "@terno/store/conformance";
import { openDatabase } from "@terno/db";
import { IdbMailStore } from "@terno/idb";
import { SqlMailStore } from "../../../../packages/db/src/sql-store";
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: { call: rpc } }));
const { acquireDraftHold, createDraft, editDraft, flushDraft, forgetDraft, setDraftTransport, useDrafts } = await import("./drafts");
const { openCompose } = await import("./compose");
const { replyFields } = await import("./compose-fields");
const { attachFiles } = await import("./attachments");
const { setApp } = await import("~/state/app");
const { useThreads } = await import("~/state/threads");
const { resetSnacks } = await import("./snack");
const apiDraft = (r: DraftRow): Draft => ({ id: r.id, generation: r.generation ?? "", revision: r.revision, format: 2, accountId: r.account_id, threadId: r.thread_id, mode: r.mode, to: JSON.parse(r.to_json), cc: JSON.parse(r.cc_json), bcc: JSON.parse(r.bcc_json), subject: r.subject, subjectEdited: !!r.subject_edited, bodyText: r.body_text, bodyHtml: r.body_html, attachments: JSON.parse(r.attachments_json), quotedText: r.quoted_text, includeQuote: !!r.include_quote, inReplyToMessageId: r.in_reply_to_message_id, forwardOfMessageId: r.forward_of_message_id, uiState: r.ui_state, updatedAt: r.updated_at });
afterEach(() => { for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key); rpc.mockReset(); resetSnacks(); });

for (const adapter of ["SQL", "IDB"] as const) it.each([99, 100])(`${adapter}: upload completion validates latest Forward union and cleans only unadopted refs (%i files)`, async (count) => {
  const dir = mkdtempSync(join(tmpdir(), "terno-forward-upload-")), name = crypto.randomUUID();
  const open = (): Promise<MailStore> => adapter === "SQL" ? Promise.resolve(new SqlMailStore(openDatabase(join(dir, "mail.db")), { instantSearch: false })) : IdbMailStore.open({ name, factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: () => new Promise((r) => setImmediate(r)) } });
  let store = await open();
  try {
    const [a] = await withAccounts(store, 1), accounts = await store.accounts.list(), account = accounts[0]!;
    await ingest(store, [msg({ accountId: a!, providerMsgId: "source", attachments: [{ filename: "source-empty", mime: "text/plain", size: 0, bytes: new Uint8Array() }] })]);
    const tid = await threadOf(store, "source"), detail = (await store.threads.get(tid))!, key = createDraft(replyFields("reply", detail, account));
    useThreads.setState({ details: new Map([[tid, detail]]) });
    setApp({ accounts, selectedId: tid, checked: new Set(), scope: null, draftShown: { threadId: tid, key } });
    const errors: unknown[] = [], staged: AttachmentRef[] = [];
    setDraftTransport(async (_method, p) => { try { const row = await store.drafts.save(p as DraftInput, 1); return row ? apiDraft(row) : null; } catch (e) { errors.push(e); throw e; } });
    editDraft(key, { bodyText: "authored body" }); await flushDraft(key);
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>((r) => { release = r; }), waiting = new Promise<void>((r) => { reached = r; });
    rpc.mockImplementation(async (method: string, p: { accountId: number; assetId: string; filename: string; mime: string; size: number }) => {
      if (method === "attachments.info") return store.attachments.info(p.accountId, p.assetId);
      if (method === "attachments.create") {
        const ref = await store.attachments.create({ ...p, now: 1 }); staged.push(ref);
        if (staged.length === 1) { reached(); await gate; }
        return ref;
      }
      if (method === "attachments.seal") { await store.attachments.seal(p.accountId, p.assetId); return { ok: true }; }
      if (method === "attachments.discard") { await store.attachments.discard(p.accountId, p.assetId); return { ok: true }; }
      throw new Error(`Unexpected fixture RPC ${method}`);
    });
    const pending = attachFiles(key, Array.from({ length: count }, (_, i) => new File([], `authored-${i}.txt`, { type: "text/plain" })));
    await waiting;
    expect(acquireDraftHold()).toBeNull();
    await openCompose("forward", tid);
    expect(useDrafts.getState().drafts[key]!.attachments).toHaveLength(1);
    editDraft(key, { bodyText: "typed during upload and conversion" });
    release(); await pending;
    const hold = acquireDraftHold(); expect(hold).toBeTypeOf("function"); hold!();
    const d = useDrafts.getState().drafts[key]!;
    expect(d).toMatchObject({ mode: "forward", bodyText: "typed during upload and conversion" });
    expect(d.attachments).toHaveLength(count === 99 ? 100 : 1);
    expect(errors).toEqual([]);
    if (count === 100) for (const ref of staged) await expect(store.attachments.info(a!, ref.assetId)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    else for (const ref of staged) expect(await store.attachments.info(a!, ref.assetId)).toEqual(ref);
    const original = detail.messages[0]!.attachments[0]!;
    expect(await store.attachments.info(a!, original.assetId!)).toMatchObject({ filename: "source-empty", size: 0 });
    await flushDraft(key);
    await store.close(); store = await open();
    const saved = (await store.drafts.list())[0]!;
    expect(saved).toMatchObject({ mode: "forward", body_text: "typed during upload and conversion" });
    expect(JSON.parse(saved.attachments_json)).toHaveLength(count === 99 ? 100 : 1);
  } finally { for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key); await store.close(); rmSync(dir, { recursive: true, force: true }); }
});
