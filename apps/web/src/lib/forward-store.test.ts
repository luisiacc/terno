// Forward's files against a real store, SQL and IndexedDB.
import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttachmentRef } from "@terno/core";
import type { Draft } from "@terno/core/rpc";
import { openDatabase } from "@terno/db";
import { IdbMailStore } from "@terno/idb";
import type { DraftInput, DraftRow, MailStore } from "@terno/store";
import { ingest, msg, threadOf, withAccounts } from "@terno/store/conformance";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqlMailStore } from "../../../../packages/db/src/sql-store";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: { call: rpc } }));
const { createDraft, editDraft, fieldsOf, flushDraft, forgetDraft, setDraftTransport, useDrafts, fromServer } = await import("./drafts");
const { openCompose } = await import("./compose");
const { replyFields } = await import("./compose-fields");
const { setApp, getApp } = await import("~/state/app");
const { useThreads } = await import("~/state/threads");
const { resetSnacks, registerUndo, runUndo, useSnack } = await import("./snack");
const { resetForwardFiles, useForwardFiles } = await import("./forward-files");

describe("files captured later", () => {
  const apiDraft = (r: DraftRow): Draft => ({ id: r.id, generation: r.generation ?? "", revision: r.revision, format: 2, accountId: r.account_id, threadId: r.thread_id, mode: r.mode, to: JSON.parse(r.to_json), cc: JSON.parse(r.cc_json), bcc: JSON.parse(r.bcc_json), subject: r.subject, subjectEdited: !!r.subject_edited, bodyText: r.body_text, bodyHtml: r.body_html, attachments: JSON.parse(r.attachments_json), quotedText: r.quoted_text, includeQuote: !!r.include_quote, inReplyToMessageId: r.in_reply_to_message_id, forwardOfMessageId: r.forward_of_message_id, uiState: r.ui_state, updatedAt: r.updated_at });
  afterEach(() => { resetForwardFiles(); for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key); rpc.mockReset(); resetSnacks(); });

  for (const adapter of ["SQL", "IDB"] as const) {
    // plan 60: Forward opens at once; the files it couldn't have yet join it when captured, and queue exactly
    it(`${adapter}: pending original capture opens Forward at once keeping the work; captured files join it and queue exact binary and empty files`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "terno-forward-capture-")), name = crypto.randomUUID();
      const open = (): Promise<MailStore> => adapter === "SQL" ? Promise.resolve(new SqlMailStore(openDatabase(join(dir, "mail.db")), { instantSearch: false })) : IdbMailStore.open({ name, factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: () => new Promise((r) => setImmediate(r)) } });
      let store = await open();
      try {
        const { account } = await store.accounts.create({ kind: "imap", email: "capture@test.com", displayName: "Capture", color: "brown", now: 0 });
        const accounts = await store.accounts.list();
        await ingest(store, [msg({ accountId: account.id, providerMsgId: "header", bodyState: "none", bodyText: null, bodyHtml: null, hasAttachments: true, attachments: undefined })]);
        const tid = await threadOf(store, "header");
        let detail = (await store.threads.get(tid))!;
        useThreads.setState({ details: new Map([[tid, detail]]) });
        setApp({ accounts, selectedId: tid, checked: new Set(), scope: null, draftShown: null, draftFocus: null });
        setDraftTransport(async (_method, p) => { const row = await store.drafts.save(p as DraftInput, 1); return row ? apiDraft(row) : null; });
        let retried = false;
        rpc.mockImplementation(async (method: string, p: { accountId: number; assetId: string; messageId: number; threadId: number }) => {
          if (method === "attachments.info") return store.attachments.info(p.accountId, p.assetId);
          if (method === "drafts.sourceContext") return store.drafts.sourceContext(p.messageId);
          if (method === "attachments.retry") { await store.attachments.retry(p.accountId, p.messageId); retried = true; return { ok: true }; }
          if (method === "threads.get") return store.threads.get(p.threadId);
          throw new Error("Unexpected fixture RPC");
        });
        const key = createDraft(replyFields("reply", detail, account));
        editDraft(key, { bodyText: "my work", bodyHtml: "<div>my <b>work</b></div>", subject: "my subject", subjectEdited: true, bccText: "private@test.com" });
        await flushDraft(key);
        const before = fieldsOf(useDrafts.getState().drafts[key]!);
        await openCompose("forward", tid);
        // at once: a forward keeping what was written, no files yet, and the original asked for again
        expect(useDrafts.getState().drafts[key]).toMatchObject({ mode: "forward", bodyText: before.bodyText, bodyHtml: before.bodyHtml, subject: "my subject", bccText: "private@test.com", attachments: [] });
        await vi.waitFor(() => expect(retried).toBe(true));
        expect(useForwardFiles.getState()[key]).toEqual({ status: "fetching", names: [] });
        // the capture lands, and the open conversation refetches it: the files join and are saved with the draft
        const messageId = detail.messages[0]!.id;
        await store.sync.setBody(messageId, "source", null, { now: 2, classifier: null, attachments: [{ filename: "exact.bin", mime: "application/octet-stream", size: 3, bytes: new Uint8Array([0, 255, 128]) }, { filename: "empty.txt", mime: "text/plain", size: 0, bytes: new Uint8Array() }] });
        detail = (await store.threads.get(tid))!;
        useThreads.setState({ details: new Map([[tid, detail]]) });
        await vi.waitFor(() => expect(useDrafts.getState().drafts[key]!.attachments).toHaveLength(2));
        await vi.waitFor(() => expect(useForwardFiles.getState()[key]).toBeUndefined());
        await flushDraft(key);
        const d = useDrafts.getState().drafts[key]!;
        expect(d).toMatchObject({ mode: "forward", bodyText: "my work", bodyHtml: "<div>my <b>work</b></div>" });
        await store.close(); store = await open();
        expect(JSON.parse((await store.drafts.list())[0]!.attachments_json)).toHaveLength(2);
        const queued = await store.compose.queueSend({ accountId: account.id, to: [{ name: "", email: "recipient@test.com" }], cc: [], bcc: [], subject: d.subject, bodyText: d.bodyText, attachments: d.attachments, draftId: d.id!, draftRevision: d.revision, draftGeneration: d.generation, recordReply: false, now: 3 });
        expect(JSON.parse((await store.ops.get(queued.opId))!.payload_json).attachments).toHaveLength(2);
        expect(await store.attachments.read(account.id, d.attachments![0]!.assetId, 0)).toBe("AP+A");
        expect(await store.attachments.info(account.id, d.attachments![1]!.assetId)).toMatchObject({ size: 0 });
        expect(await store.attachments.read(account.id, d.attachments![1]!.assetId, 0)).toBeNull();
      } finally { resetForwardFiles(); for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key); await store.close(); rmSync(dir, { recursive: true, force: true }); }
    });

    it(`${adapter}: capture projection distinguishes legacy full pending, explicit empty complete and unavailable through reopen`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "terno-capture-state-")), name = crypto.randomUUID();
      const open = (): Promise<MailStore> => adapter === "SQL" ? Promise.resolve(new SqlMailStore(openDatabase(join(dir, "mail.db")), { instantSearch: false })) : IdbMailStore.open({ name, factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: () => new Promise((r) => setImmediate(r)) } });
      let store = await open();
      try {
        const { account } = await store.accounts.create({ kind: "imap", email: "state@test.com", displayName: "State", color: "brown", now: 0 });
        for (const [providerMsgId, attachments] of [["legacy", undefined], ["empty", []], ["unavailable", [{ filename: "missing.bin", mime: "application/octet-stream", size: 3 }]]] as const) {
          await ingest(store, [msg({ accountId: account.id, providerMsgId, bodyState: "full", hasAttachments: true, attachments: attachments === undefined ? undefined : [...attachments] })]);
        }
        await store.close(); store = await open();
        for (const [id, state] of [["legacy", "pending"], ["empty", "complete"], ["unavailable", "unavailable"]] as const) {
          const detail = (await store.threads.get(await threadOf(store, id)))!;
          expect(detail.messages[0]).toMatchObject({ bodyState: "full", attachmentState: state });
        }
      } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
    });
  }
});

describe("the 100-file limit", () => {
  const apiDraft = (r: DraftRow): Draft => ({ id: r.id, generation: r.generation ?? "", revision: r.revision, format: 2, accountId: r.account_id, threadId: r.thread_id, mode: r.mode, to: JSON.parse(r.to_json), cc: JSON.parse(r.cc_json), bcc: JSON.parse(r.bcc_json), subject: r.subject, subjectEdited: !!r.subject_edited, bodyText: r.body_text, bodyHtml: r.body_html, attachments: JSON.parse(r.attachments_json), quotedText: r.quoted_text, includeQuote: !!r.include_quote, replyContext: r.reply_context_json ? JSON.parse(r.reply_context_json) : null, showSourceContext: r.show_source_context === 1, presentationThreadId: r.presentation_thread_id ?? null, inReplyToMessageId: r.in_reply_to_message_id, forwardOfMessageId: r.forward_of_message_id, uiState: r.ui_state, updatedAt: r.updated_at });
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
        rpc.mockImplementation(async (method: string, p: { accountId: number; assetId: string; messageId: number }) => {
          if (method === "drafts.sourceContext") {
            expect(p.messageId).toBe(detail.messages[0]!.id);
            return { threadId: detail.thread.id, accountId: detail.thread.accountId };
          }
          return store.attachments.info(p.accountId, p.assetId);
        });
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

  }
});
