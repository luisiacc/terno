import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Draft } from "@terno/core/rpc";
import type { DraftInput, DraftRow, MailStore } from "@terno/store";
import { withAccounts } from "@terno/store/conformance";
import { openDatabase } from "@terno/db";
import { IdbMailStore } from "@terno/idb";
import { SqlMailStore } from "../../../../packages/db/src/sql-store";

vi.mock("~/rpc/connection", () => ({ client: { call: () => Promise.reject(new Error("not in tests")) } }));
const { editDraft, flushDraft, fromServer, forgetDraft, setDraftTransport, useDrafts } = await import("./drafts");

const apiDraft = (r: DraftRow): Draft => ({
  id: r.id, revision: r.revision, format: 2, accountId: r.account_id, threadId: r.thread_id, mode: r.mode,
  to: JSON.parse(r.to_json), cc: JSON.parse(r.cc_json), bcc: JSON.parse(r.bcc_json), subject: r.subject, subjectEdited: !!r.subject_edited,
  bodyText: r.body_text, bodyHtml: r.body_html, attachments: JSON.parse(r.attachments_json), quotedText: r.quoted_text, includeQuote: !!r.include_quote,
  inReplyToMessageId: r.in_reply_to_message_id, forwardOfMessageId: r.forward_of_message_id, uiState: r.ui_state, updatedAt: r.updated_at,
});
afterEach(() => { for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key); });

for (const adapter of ["SQL", "IDB"] as const) {
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
