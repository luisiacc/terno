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
const { createDraft, editDraft, fieldsOf, flushDraft, forgetDraft, fromServer, setDraftTransport, useDrafts } = await import("./drafts");
const { openCompose } = await import("./compose");
const { replyFields } = await import("./compose-fields");
const { setApp, getApp } = await import("~/state/app");
const { useThreads } = await import("~/state/threads");
const { registerUndo, resetSnacks, runUndo, useSnack } = await import("./snack");
const apiDraft = (r: DraftRow): Draft => ({ id: r.id, generation: r.generation ?? "", revision: r.revision, format: 2, accountId: r.account_id, threadId: r.thread_id, mode: r.mode, to: JSON.parse(r.to_json), cc: JSON.parse(r.cc_json), bcc: JSON.parse(r.bcc_json), subject: r.subject, subjectEdited: !!r.subject_edited, bodyText: r.body_text, bodyHtml: r.body_html, attachments: JSON.parse(r.attachments_json), quotedText: r.quoted_text, includeQuote: !!r.include_quote, inReplyToMessageId: r.in_reply_to_message_id, forwardOfMessageId: r.forward_of_message_id, uiState: r.ui_state, updatedAt: r.updated_at });
afterEach(() => { for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key); rpc.mockReset(); resetSnacks(); });

for (const adapter of ["SQL", "IDB"] as const) {
  it.each([99, 100])(`${adapter}: Forward admits exactly 100 refs and refuses 101 before mutation; later autosave survives reopen (%i authored)`, async (count) => {
    const dir = mkdtempSync(join(tmpdir(), "terno-forward-capacity-")), name = crypto.randomUUID();
    const open = (): Promise<MailStore> => adapter === "SQL" ? Promise.resolve(new SqlMailStore(openDatabase(join(dir, "mail.db")), { instantSearch: false })) : IdbMailStore.open({ name, factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: () => new Promise((r) => setImmediate(r)) } });
    let store = await open();
    try {
      const [a] = await withAccounts(store, 1), accounts = await store.accounts.list(), account = accounts[0]!;
      await ingest(store, [msg({ accountId: a!, providerMsgId: "source", attachments: [{ filename: "source-empty.txt", mime: "text/plain", size: 0, bytes: new Uint8Array() }] })]);
      const detail = (await store.threads.get(await threadOf(store, "source")))!;
      const refs: AttachmentRef[] = [];
      rpc.mockImplementation(async (_method: string, p: { accountId: number; assetId: string }) => store.attachments.info(p.accountId, p.assetId));
      for (let i = 0; i < count; i++) {
        const ref = await store.attachments.create({ accountId: a!, filename: `authored-${i}.txt`, mime: "text/plain", size: 0, now: 0 });
        await store.attachments.seal(a!, ref.assetId); refs.push(ref);
      }
      const key = createDraft(replyFields("reply", detail, account));
      useThreads.setState({ details: new Map([[detail.thread.id, detail]]) });
      setApp({ accounts, selectedId: detail.thread.id, checked: new Set(), scope: null, draftShown: { threadId: detail.thread.id, key }, draftFocus: null });
      const errors: unknown[] = [];
      setDraftTransport(async (_method, p) => { try { const row = await store.drafts.save(p as DraftInput, 1); return row ? apiDraft(row) : null; } catch (error) { errors.push(error); throw error; } });
      editDraft(key, { bodyText: "saved authored body", bodyHtml: "<div>saved <b>authored</b> body</div>", attachments: refs, subject: "manual subject", subjectEdited: true, bccText: "private@test.com" });
      await flushDraft(key);
      const before = fieldsOf(useDrafts.getState().drafts[key]!);
      const previousUndo = registerUndo(() => {});
      await openCompose("forward", detail.thread.id);
      const after = useDrafts.getState().drafts[key]!;
      if (count === 100) {
        expect(fieldsOf(after)).toEqual(before);
        expect(useSnack.getState().undo).toBe(previousUndo);
        expect(getApp().draftFocus).toBeNull();
        expect(useSnack.getState().current?.message).toBe("This message is too large. Remove an attachment or shorten the message.");
      } else {
        expect(after).toMatchObject({ mode: "forward", bodyText: before.bodyText, bodyHtml: before.bodyHtml, bccText: before.bccText, subject: before.subject });
        expect(after.attachments).toHaveLength(100);
        await runUndo(useSnack.getState().undo!);
        expect(fieldsOf(useDrafts.getState().drafts[key]!)).toEqual(before);
        await openCompose("forward", detail.thread.id);
      }
      editDraft(key, { bodyText: "later work must survive" }); await flushDraft(key);
      expect(errors).toEqual([]);
      await store.close(); store = await open();
      const row = (await store.drafts.list())[0]!;
      expect(row).toMatchObject({ body_text: "later work must survive", mode: count === 99 ? "forward" : "reply" });
      expect(JSON.parse(row.attachments_json)).toHaveLength(100);
      forgetDraft(key);
      const reloaded = fromServer(apiDraft(row));
      useDrafts.setState({ drafts: { [reloaded.key]: reloaded } });
      editDraft(reloaded.key, { bodyText: "editing the reloaded maximum" }); await flushDraft(reloaded.key);
      expect(errors).toEqual([]);
      expect((await store.drafts.list())[0]!.body_text).toBe("editing the reloaded maximum");
    } finally { for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key); await store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it(`${adapter}: two individually supported 10-MiB files cannot become a 20-MiB Forward`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "terno-forward-bytes-")), name = crypto.randomUUID();
    const store: MailStore = adapter === "SQL" ? new SqlMailStore(openDatabase(join(dir, "mail.db")), { instantSearch: false }) : await IdbMailStore.open({ name, factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: () => new Promise((r) => setImmediate(r)) } });
    try {
      const [a] = await withAccounts(store, 1), accounts = await store.accounts.list(), account = accounts[0]!;
      await ingest(store, [msg({ accountId: a!, providerMsgId: "bytes", attachments: [{ filename: "source.bin", mime: "application/octet-stream", size: 10 * 1024 * 1024, bytes: new Uint8Array(10 * 1024 * 1024) }] })]);
      const detail = (await store.threads.get(await threadOf(store, "bytes")))!;
      const authored = await store.attachments.create({ accountId: a!, filename: "authored.bin", mime: "application/octet-stream", size: 10 * 1024 * 1024, now: 0 });
      for (let offset = 0, index = 0; offset < authored.size; offset += 49152, index++) await store.attachments.append(a!, authored.assetId, index, Buffer.alloc(Math.min(49152, authored.size - offset)).toString("base64"));
      await store.attachments.seal(a!, authored.assetId);
      const key = createDraft(replyFields("reply", detail, account));
      useThreads.setState({ details: new Map([[detail.thread.id, detail]]) });
      setApp({ accounts, selectedId: detail.thread.id, checked: new Set(), scope: null, draftShown: null });
      setDraftTransport(async (_method, p) => { const row = await store.drafts.save(p as DraftInput, 1); return row ? apiDraft(row) : null; });
      rpc.mockImplementation(async (_method: string, p: { accountId: number; assetId: string }) => store.attachments.info(p.accountId, p.assetId));
      editDraft(key, { bodyText: "preserved", attachments: [authored] }); await flushDraft(key);
      const before = fieldsOf(useDrafts.getState().drafts[key]!);
      await openCompose("forward", detail.thread.id);
      expect(fieldsOf(useDrafts.getState().drafts[key]!)).toEqual(before);
      editDraft(key, { bodyText: "still savable" }); await flushDraft(key);
      expect((await store.drafts.list())[0]!.body_text).toBe("still savable");
    } finally { for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key); await store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}
