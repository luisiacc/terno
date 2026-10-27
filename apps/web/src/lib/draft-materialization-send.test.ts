import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { Account } from "@terno/core";
import { getApp, setApp, useApp } from "~/state/app";
import { contract, type Draft } from "@terno/core/rpc";
import { openDatabase, SqlMailStore } from "@terno/db";
import type { DraftRow } from "@terno/store";
import { withAccounts } from "@terno/store/conformance";
const rpc = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: { call: rpc.call } }));
const { sendDraft } = await import("./compose");
const { attachBody, createDraft, draftsSaved, editDraft, flushDraft, forgetDraft, setDraftTransport, useDrafts } = await import("./drafts");
const { newFields } = await import("./compose-fields");
const { whenDraftsSaved } = await import("~/web/reload");
const apiDraft = (r: DraftRow): Draft => ({
  id: r.id, generation: r.generation ?? "", revision: r.revision, format: 2, accountId: r.account_id, threadId: r.thread_id, mode: r.mode,
  to: JSON.parse(r.to_json), cc: JSON.parse(r.cc_json), bcc: JSON.parse(r.bcc_json), subject: r.subject, subjectEdited: !!r.subject_edited,
  bodyText: r.body_text, bodyHtml: r.body_html, attachments: JSON.parse(r.attachments_json), quotedText: r.quoted_text, includeQuote: !!r.include_quote,
  inReplyToMessageId: r.in_reply_to_message_id, forwardOfMessageId: r.forward_of_message_id, uiState: r.ui_state, updatedAt: r.updated_at,
});
it.each([false, true])("failed Send materialization retains the source (persistent=%s)", async (persistent) => {
 const dir=mkdtempSync(join(tmpdir(),"terno-r5-source-")), store=new SqlMailStore(openDatabase(join(dir,"mail.db")));
 const previousApp = getApp();
 let source: ReturnType<typeof attachBody>|undefined;
 let key: string|undefined;
 try {
  const [accountId]=await withAccounts(store);
  setApp({ accounts: await store.accounts.list(), accountId: accountId! });
  rpc.call.mockClear();
  setDraftTransport(async (_m,p) => { const row=await store.drafts.save(contract["drafts.save"].params.parse(p),0); return row ? apiDraft(row) : null; });
  key=createDraft({...newFields(accountId!),toText:"ana@example.test",bodyText:"previous saved body"});
  editDraft(key,{}); await flushDraft(key);
  let reads=0;
  source=attachBody(key,()=>{ reads++; if(persistent || reads===1)throw new Error("one failed materialization"); return {text:"latest authored body",html:"<div><b>latest authored body</b></div>"}; });
  source.changed();
  expect(await sendDraft(key)).toBe(false);
  expect(useDrafts.getState().drafts[key]!.sending).toBe(false);
  expect(rpc.call).not.toHaveBeenCalled();
  let bodyAtAdmission: string | undefined;
  const go=vi.fn(async () => { bodyAtAdmission = (await store.drafts.list())[0]?.body_text; });
  const admitted=await whenDraftsSaved(go);
  const saved=await draftsSaved();
  const row=(await store.drafts.list())[0]!;
  if (persistent) {
   expect(admitted).toBe(false);
   expect(saved).toBe(false);
   expect(go).not.toHaveBeenCalled();
   expect(row.body_text).toBe("previous saved body");
  } else {
   expect(admitted).toBe(true);
   expect(saved).toBe(true);
   expect(go).toHaveBeenCalledOnce();
   expect(bodyAtAdmission).toBe("latest authored body");
   expect(reads).toBeGreaterThan(1);
   expect(row.body_text).toBe("latest authored body");
   expect(row.body_html).toBe("<div><b>latest authored body</b></div>");
  }
 }finally{try{if(key)forgetDraft(key);source?.dispose();await store.close();rmSync(dir,{recursive:true,force:true});}finally{useApp.setState(previousApp, true);}}
});

it("does not automatically reread after a failed Send materialization", async () => {
  vi.useFakeTimers();
  const previousApp = getApp();
  let key: string | undefined, source: ReturnType<typeof attachBody> | undefined;
  const reader = vi.fn(() => { throw new Error("read failed"); });
  try {
    setApp({ accounts: [{ id: 1, email: "me@example.test" } as Account], accountId: 1 });
    rpc.call.mockClear();
    key = createDraft({ ...newFields(1), toText: "ana@example.test" });
    source = attachBody(key, reader);
    source.changed();
    expect(await sendDraft(key)).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(rpc.call).not.toHaveBeenCalled();
  } finally { try { if (key) forgetDraft(key); source?.dispose(); } finally { useApp.setState(previousApp, true); vi.useRealTimers(); } }
});

it("explains an unstable Send read and leaves the newer body unsent", async () => {
  vi.useFakeTimers();
  const previousApp = getApp();
  const { useSnack, dismissSnack } = await import("./snack");
  let key: string | undefined, source: ReturnType<typeof attachBody> | undefined, replacement: ReturnType<typeof attachBody> | undefined;
  let body = "earlier", reads = 0;
  try {
    setApp({ accounts: [{ id: 1, email: "me@example.test" } as Account], accountId: 1 });
    rpc.call.mockClear();
    key = createDraft({ ...newFields(1), toText: "ana@example.test" });
    source = attachBody(key, () => {
      reads++;
      const captured = body;
      if (reads === 1) { body = "newer"; replacement = attachBody(key!, () => ({ text: body, html: `<p>${body}</p>` })); }
      return { text: captured, html: `<p>${captured}</p>` };
    });
    source.changed();
    expect(await sendDraft(key)).toBe(false);
    expect(useSnack.getState().current?.message).toContain("Your draft changed while it was being read. Your changes are still here. Try again.");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads).toBe(1);
    expect(rpc.call).not.toHaveBeenCalled();
    expect(body).toBe("newer");
  } finally { try { if (key) forgetDraft(key); source?.dispose(); replacement?.dispose(); dismissSnack(); } finally { useApp.setState(previousApp, true); vi.useRealTimers(); } }
});
