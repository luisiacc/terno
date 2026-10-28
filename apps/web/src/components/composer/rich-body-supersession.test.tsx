// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contract } from "@terno/core/rpc";
import { openDatabase, SqlMailStore } from "@terno/db";
import { withAccounts } from "@terno/store/conformance";
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }));
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect();
const { RichBody } = await import("./rich");
const { controllerFor } = await import("./controller");
const { createDraft, editDraft, flushDraft, forgetDraft, materialize, setDraftTransport, useDrafts } = await import("~/lib/drafts");
const { newFields } = await import("~/lib/compose-fields");

it("real RichBody preserves accepted body before synchronization and later edited persistence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-rich-supersession-"));
  const store = new SqlMailStore(openDatabase(join(dir, "mail.db")));
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  let key: string | undefined, off = () => {};
  // New standalone draft: no source projection is involved; DTO comes from the actual row.
  setDraftTransport(async (_method, params) => {
    const row = await store.drafts.save(contract["drafts.save"].params.parse(params), Date.now());
    if (!row) return null;
    return { id: row.id, generation: row.generation, revision: row.revision, format: 2, accountId: row.account_id, threadId: row.thread_id, mode: row.mode, to: JSON.parse(row.to_json), cc: JSON.parse(row.cc_json), bcc: JSON.parse(row.bcc_json), subject: row.subject, subjectEdited: !!row.subject_edited, bodyText: row.body_text, bodyHtml: row.body_html, attachments: JSON.parse(row.attachments_json), quotedText: row.quoted_text, includeQuote: !!row.include_quote, inReplyToMessageId: row.in_reply_to_message_id, forwardOfMessageId: row.forward_of_message_id, showSourceContext: false, uiState: row.ui_state, updatedAt: row.updated_at };
  });
  try {
    const [accountId] = await withAccounts(store);
    key = createDraft({ ...newFields(accountId!), bodyText: "initial editor", bodyHtml: "<p>initial editor</p>" }); editDraft(key, {}); await flushDraft(key);
    await act(async () => root.render(<RichBody draftKey={key!} placeholder="Body" />));
    const controller = controllerFor(key)!; expect(controller).not.toBeNull();
    const before = useDrafts.getState().drafts[key]!;
    await act(async () => controller.run("quote"));
    expect(controller.dom.querySelector("blockquote")).not.toBeNull();
    let accepted = false;
    off = useDrafts.subscribe((state, previous) => {
      if (state.drafts[key!]?.bodyHtml === previous.drafts[key!]?.bodyHtml) return;
      off(); accepted = editDraft(key!, { bodyText: "replacement body", bodyHtml: "<p><b>replacement body</b></p>" });
      expect(useDrafts.getState().drafts[key!]).toMatchObject({ bodyText: "replacement body", bodyVersion: before.bodyVersion + 1 });
      expect(controller.dom.textContent).toContain("initial editor");
    });
    await act(async () => {
      expect(() => materialize(key!)).toThrow("Your draft changed while it was being read. Your changes are still here. Try again.");
      expect(accepted).toBe(true);
      expect.soft(materialize(key!)).toMatchObject({ bodyText: "replacement body", bodyHtml: "<p><b>replacement body</b></p>" });
    });
    expect.soft(controller.dom.textContent).toContain("replacement body");
    await act(async () => { controller.run("quote"); await flushDraft(key!); });
    expect.soft((await store.drafts.list())[0]?.body_text).toContain("replacement body");
    expect.soft((await store.drafts.list())[0]?.body_html).toContain("blockquote");
  } finally { off(); await act(async () => root.unmount()); if (key) forgetDraft(key); host.remove(); setDraftTransport(async () => null); await store.close(); rmSync(dir, { recursive: true, force: true }); }
});
