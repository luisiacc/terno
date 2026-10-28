import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Draft } from "@terno/core/rpc";
import type { DraftInput, DraftRow, MailStore } from "@terno/store";
import { msg, ingest, threadOf } from "@terno/store/conformance";
import { openDatabase } from "@terno/db";
import { IdbMailStore } from "@terno/idb";
import { SqlMailStore } from "../../../../packages/db/src/sql-store";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: { call: rpc } }));
const { createDraft, editDraft, fieldsOf, flushDraft, forgetDraft, setDraftTransport, useDrafts } = await import("./drafts");
const { openCompose } = await import("./compose");
const { replyFields } = await import("./compose-fields");
const { setApp, getApp } = await import("~/state/app");
const { useThreads } = await import("~/state/threads");
const { resetSnacks } = await import("./snack");
const { resetForwardFiles, useForwardFiles } = await import("./forward-files");
const apiDraft = (r: DraftRow): Draft => ({ id: r.id, generation: r.generation ?? "", revision: r.revision, format: 2, accountId: r.account_id, threadId: r.thread_id, mode: r.mode, to: JSON.parse(r.to_json), cc: JSON.parse(r.cc_json), bcc: JSON.parse(r.bcc_json), subject: r.subject, subjectEdited: !!r.subject_edited, bodyText: r.body_text, bodyHtml: r.body_html, attachments: JSON.parse(r.attachments_json), quotedText: r.quoted_text, includeQuote: !!r.include_quote, inReplyToMessageId: r.in_reply_to_message_id, forwardOfMessageId: r.forward_of_message_id, uiState: r.ui_state, updatedAt: r.updated_at });
afterEach(() => { resetForwardFiles(); for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key); rpc.mockReset(); resetSnacks(); });

for (const adapter of ["SQL", "IDB"] as const) {
  // plan 60: Forward opens at once; the files it couldn't have yet join it when captured, and queue exactly
  it(`${adapter}: pending original capture opens Forward at once keeping the work; captured files join it and queue exact binary and empty files`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "terno-forward-capture-")), name = crypto.randomUUID();
    const open = (): Promise<MailStore> => adapter === "SQL" ? Promise.resolve(new SqlMailStore(openDatabase(join(dir, "mail.db")), { instantSearch: false })) : IdbMailStore.open({ name, factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: () => new Promise((r) => setImmediate(r)) } });
    let store = await open();
    try {
      const { account } = await store.accounts.create({ kind: "imap", email: "capture@test.com", displayName: "Capture", color: "indigo", now: 0 });
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
      const { account } = await store.accounts.create({ kind: "imap", email: "state@test.com", displayName: "State", color: "indigo", now: 0 });
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
