import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Draft } from "@terno/core/rpc";
import type { DraftInput, DraftRow, MailStore } from "@terno/store";
import { withAccounts, msg, ingest, threadOf } from "@terno/store/conformance";
import { openDatabase } from "@terno/db";
import { IdbMailStore } from "@terno/idb";
import { SqlMailStore } from "../../../../packages/db/src/sql-store";

const { attachmentRpc } = vi.hoisted(() => ({ attachmentRpc: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: { call: attachmentRpc } }));
const { attachBody, copyDraft, draftsSaved, materialize, resumeDraft, retryDraft, createDraft, editDraft, flushDraft, fromServer, forgetDraft, setDraftTransport, useDrafts } = await import("./drafts");

const { openCompose } = await import("./compose");
const { convertFields, replyFields } = await import("./compose-fields");
const { setApp } = await import("~/state/app");
const { useThreads } = await import("~/state/threads");
const { useSnack } = await import("./snack");

const apiDraft = (r: DraftRow): Draft => ({
  id: r.id, generation: r.generation ?? "", revision: r.revision, format: 2, accountId: r.account_id, threadId: r.thread_id, mode: r.mode,
  to: JSON.parse(r.to_json), cc: JSON.parse(r.cc_json), bcc: JSON.parse(r.bcc_json), subject: r.subject, subjectEdited: !!r.subject_edited,
  bodyText: r.body_text, bodyHtml: r.body_html, attachments: JSON.parse(r.attachments_json), quotedText: r.quoted_text, includeQuote: !!r.include_quote,
  inReplyToMessageId: r.in_reply_to_message_id, forwardOfMessageId: r.forward_of_message_id, uiState: r.ui_state, updatedAt: r.updated_at,
});
afterEach(() => { for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key); attachmentRpc.mockReset(); });

for (const adapter of ["SQL", "IDB"] as const) {
  it.each(["binary", "empty", "unavailable", "none"])(`${adapter}: From-B Forward refusal preserves exact work and subsequent autosave/reload (%s)`, async (kind) => {
    const dir = mkdtempSync(join(tmpdir(), "terno-convert-attachment-"));
    const name = crypto.randomUUID();
    const open = (): Promise<MailStore> => adapter === "SQL" ? Promise.resolve(new SqlMailStore(openDatabase(join(dir, "mail.db")), { instantSearch: false })) : IdbMailStore.open({ name, factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: () => new Promise((r) => setImmediate(r)) } });
    let store = await open();
    try {
      const [a, b] = await withAccounts(store);
      attachmentRpc.mockImplementation(async (method: string, p: { accountId: number; assetId: string }) => {
        if (method === "attachments.info") return store.attachments.info(p.accountId, p.assetId);
        throw new Error("Unexpected fixture RPC");
      });
      const accounts = await store.accounts.list(), account = accounts.find((x) => x.id === a)!;
      const bytes = kind === "empty" ? new Uint8Array() : new Uint8Array([0, 255, 128]);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "source", attachments: kind === "none" ? [] : [{ filename: "source.bin", mime: "application/octet-stream", size: bytes.length, ...(kind === "unavailable" ? {} : { bytes }) }] })]);
      const detail = (await store.threads.get(await threadOf(store, "source")))!;
      const fields = replyFields("reply", detail, account);
      const key = createDraft(fields);
      useThreads.setState({ details: new Map([[detail.thread.id, detail]]) });
      setApp({ accounts, selectedId: detail.thread.id, checked: new Set(), scope: null, draftShown: { threadId: detail.thread.id, key } });
      const errors: unknown[] = [];
      let acknowledge!: () => void;
      const acknowledged = new Promise<void>((r) => { acknowledge = r; });
      setDraftTransport(async (_method, params) => {
        try { const row = await store.drafts.save(params as DraftInput, Date.now()); acknowledge(); return row ? apiDraft(row) : null; }
        catch (e) { errors.push(e); throw e; }
      });
      editDraft(key, { accountId: b!, bodyText: "exact authored work", bodyHtml: "<div>exact authored <b>work</b></div>", subject: "my subject", subjectEdited: true, bccText: "manual@test.com" });
      const before = useDrafts.getState().drafts[key]!;
      await openCompose("forward", detail.thread.id);
      if (kind !== "none") {
        expect(useDrafts.getState().drafts[key]).toEqual(before);
        expect(useSnack.getState().current?.message).toBe(kind === "unavailable" ? "The original files are not ready. Wait for the download or choose Retry, then try Forward again." : `To forward these attachments, choose ${account.email} in From.`);
        if (kind !== "unavailable") expect(convertFields({ ...fields, accountId: b! }, "forward", detail, account)).toEqual({ ...fields, accountId: b! });
      } else expect(useDrafts.getState().drafts[key]!.mode).toBe("forward");
      await acknowledged;
      await flushDraft(key);
      editDraft(key, { bodyText: "later work stays savable", bodyHtml: "<div>later work stays <b>savable</b></div>" });
      await flushDraft(key);
      expect(errors).toEqual([]);
      await store.close(); store = await open();
      expect((await store.drafts.list())[0]).toMatchObject({ account_id: b, mode: kind === "none" ? "forward" : "reply", subject: "my subject", body_text: "later work stays savable", body_html: "<div>later work stays <b>savable</b></div>", attachments_json: "[]" });
      if (kind === "binary" || kind === "empty") {
        editDraft(key, { accountId: a! });
        // Immediate Forward must acknowledge the empty account change before adding source refs.
        await openCompose("forward", detail.thread.id);
        await flushDraft(key);
        expect(errors).toEqual([]);
        expect((await store.drafts.list())[0]).toMatchObject({ account_id: a, mode: "forward", body_text: "later work stays savable" });
      }
      const ref = detail.messages[0]!.attachments[0];
      if (ref?.assetId) {
        expect(await store.attachments.info(a!, ref.assetId)).toMatchObject({ size: bytes.length });
        expect(await store.attachments.read(a!, ref.assetId, 0)).toBe(kind === "empty" ? null : "AP+A");
      }
    } finally { for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key); await store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it(`${adapter}: removal keeps From locked through the real autosave acknowledgement, then switching and later edits survive reopen`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "terno-draft-attachment-"));
    const name = crypto.randomUUID();
    const open = (): Promise<MailStore> => adapter === "SQL" ? Promise.resolve(new SqlMailStore(openDatabase(join(dir, "mail.db")), { instantSearch: false })) : IdbMailStore.open({ name, factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: () => new Promise((r) => setImmediate(r)) } });
    let store = await open();
    try {
      const [a, b] = await withAccounts(store);
      const ref = await store.attachments.create({ accountId: a!, filename: "old.bin", mime: "application/octet-stream", size: 3, now: 0 });
      await store.attachments.append(a!, ref.assetId, 0, "AP+A"); await store.attachments.seal(a!, ref.assetId);
      const saved = (await store.drafts.save({ accountId: a!, to: [], cc: [], subject: "saved", bodyText: "old", attachments: [ref] }, 0))!;
      const d = fromServer(apiDraft(saved));
      useDrafts.setState({ drafts: { [d.key]: d } });
      let acknowledge!: () => void;
      const acknowledged = new Promise<void>((r) => { acknowledge = r; });
      const errors: unknown[] = [];
      setDraftTransport(async (method, params) => {
        expect(method).toBe("drafts.save");
        try {
          const row = await store.drafts.save(params as DraftInput, Date.now());
          acknowledge(); return row ? apiDraft(row) : null;
        } catch (error) { errors.push(error); throw error; }
      });
      editDraft(d.key, { attachments: [] });
      editDraft(d.key, { accountId: b! });
      editDraft(d.key, { bodyText: "typed while removal saves" });
      expect(useDrafts.getState().drafts[d.key]!.accountId).toBe(a);
      // Exercise the actual 800 ms debounce against the public store, not a fake saved response.
      await acknowledged;
      await flushDraft(d.key);
      editDraft(d.key, { accountId: b! });
      editDraft(d.key, { bodyText: "later edit from the other account" });
      await flushDraft(d.key);
      expect(errors).toEqual([]);
      await store.close(); store = await open();
      const reloaded = (await store.drafts.list())[0]!;
      expect(reloaded).toMatchObject({ account_id: b, body_text: "later edit from the other account", attachments_json: "[]" });
      expect(await store.attachments.read(a!, ref.assetId, 0)).toBe("AP+A");
    } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const adapter of ["SQL", "IDB"] as const) {
  it.each(["delete", "send"] as const)(`${adapter}: terminal %s retains current rich work and exact files through explicit copy and reopen`, async (terminal) => {
    const dir = mkdtempSync(join(tmpdir(), "terno-recovery-store-"));
    const name = crypto.randomUUID();
    const open = (): Promise<MailStore> => adapter === "SQL" ? Promise.resolve(new SqlMailStore(openDatabase(join(dir, "mail.db")), { instantSearch: false })) : IdbMailStore.open({ name, factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
    let store = await open();
    let body: ReturnType<typeof attachBody> | undefined;
    try {
      const [a] = await withAccounts(store);
      const ref = await store.attachments.create({ accountId: a!, filename: "exact.bin", mime: "application/octet-stream", size: 3, now: 0 });
      await store.attachments.append(a!, ref.assetId, 0, "AP+A"); await store.attachments.seal(a!, ref.assetId);
      const saved = (await store.drafts.save({ accountId: a!, to: [], cc: [], subject: "old", bodyText: "old" }, 0))!;
      const d = fromServer(apiDraft(saved)); useDrafts.setState({ drafts: { [d.key]: d } });
      if (terminal === "delete") await store.drafts.delete(saved.id);
      else await store.compose.queueSend({ accountId: a!, to: [], cc: [], bcc: [], subject: "old", bodyText: "old", draftId: saved.id, draftGeneration: saved.generation, draftRevision: 1, recordReply: false, now: 1 });
      let release!: () => void; let reached!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const waiting = new Promise<void>((r) => { reached = r; });
      const ids: (number | undefined)[] = [];
      setDraftTransport(async (method, params) => {
        if (method === "drafts.delete") { await store.drafts.delete((params as { id: number }).id); return { ok: true }; }
        const input = params as DraftInput; ids.push(input.id);
        if (input.id === saved.id) { reached(); await gate; }
        const result = await store.drafts.save(input, 2); return result ? apiDraft(result) : null;
      });
      editDraft(d.key, { bodyText: "submitted" });
      const flushing = flushDraft(d.key); await waiting;
      let text = "latest bold";
      body = attachBody(d.key, () => ({ html: `<div><b>${text}</b></div>`, text })); body.changed();
      editDraft(d.key, { toText: '"Pérez, Ana" <ana@example.com>, bob@', subject: "latest", attachments: [ref], quotedText: "> exact quote", includeQuote: true });
      release(); await flushing;
      expect(useDrafts.getState().drafts[d.key]).toMatchObject({ recovery: { state: "missing" }, bodyText: text, canonical: true });
      retryDraft(d.key); resumeDraft(d.key); await flushDraft(d.key);
      expect(ids).toEqual([saved.id]); expect(await draftsSaved()).toBe(false);
      text += " plus"; body.changed();
      const version = useDrafts.getState().drafts[d.key]!.bodyVersion;
      await copyDraft(d.key); await flushDraft(d.key);
      const current = materialize(d.key)!;
      expect(current).toMatchObject({ key: d.key, bodyText: text, bodyVersion: version, canonical: true, toText: '"Pérez, Ana" <ana@example.com>, bob@' });
      expect(current.recovery).toBeUndefined(); expect(current.id).not.toBe(saved.id);
      body.dispose(); body = undefined;
      await store.close(); store = await open();
      const reloaded = (await store.drafts.list())[0]!;
      expect(reloaded).toMatchObject({ id: current.id, body_text: text, body_html: `<div><b>${text}</b></div>`, quoted_text: "> exact quote" });
      expect(apiDraft(reloaded).to).toEqual([{ name: "Pérez, Ana", email: "ana@example.com" }, { name: "", email: "bob@" }]);
      expect(await store.attachments.read(a!, ref.assetId, 0)).toBe("AP+A");
      expect((await store.ops.recent(10)).filter((o) => o.kind === "send")).toHaveLength(terminal === "send" ? 1 : 0);
    } finally { body?.dispose(); await store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}
