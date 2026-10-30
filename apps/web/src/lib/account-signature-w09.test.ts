// @vitest-environment jsdom
import type { Account, ThreadDetail } from "@terno/core";
import type { Draft } from "@terno/core/rpc";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: rpc }));
vi.mock("~/state/threads", () => ({ invalidateThreads: vi.fn(), loadThread: vi.fn() }));
const { sendDraft } = await import("./compose");
const { createDraft, editDraft, flushDraft, forgetDraft, fromServer, setDraftTransport, useDrafts } = await import("./drafts");
const { newFields, replyFields } = await import("./compose-fields");
const { setApp } = await import("~/state/app");

const a = { id: 1, email: "a@example.test", signature: "Signature A" } as Account;
const b = { id: 2, email: "b@example.test", signature: "Signature B" } as Account;
const detail = { thread: { id: 7, subject: "Source" }, messages: [{ id: 3, isSent: false, from: { name: "Sender", email: "sender@example.test" }, to: [{ name: "", email: a.email }], cc: [], subject: "Source", date: 0, bodyText: "Original source", snippet: "", attachments: [] }] } as unknown as ThreadDetail;

beforeEach(() => { useDrafts.setState({ drafts: {} }); setApp({ accounts: [a, b] }); rpc.call.mockReset(); });
afterEach(() => { for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key); setDraftTransport(async () => null); });

it.each(["new", "reply", "replyAll", "forward"] as const)("%s keeps authored fields across switches, save/reopen and actual Send", async (mode) => {
  const source = structuredClone(detail);
  const fields = mode === "new" ? newFields(1) : replyFields(mode, detail, a, { forwardRefs: [] });
  const originalQuote = fields.quotedText;
  const key = createDraft({ ...fields, toText: "to@example.test", ccText: "cc@example.test", bccText: "bcc@example.test", auto: { to: [], cc: [], bcc: [] }, bodyText: "Authored Signature A", bodyHtml: "<p>Authored <strong>Signature A</strong></p>" });
  let saved!: Draft;
  setDraftTransport(async (_method, params) => { saved = { ...(params as object), id: 42, generation: "generation", revision: 1, updatedAt: 0 } as Draft; return saved; });
  for (const accountId of [2, 1, 2]) {
    expect(editDraft(key, { accountId })).toBe(true);
    expect(useDrafts.getState().drafts[key]).toMatchObject({ accountId, toText: "to@example.test", ccText: "cc@example.test", bccText: "bcc@example.test", bodyText: "Authored Signature A", bodyHtml: "<p>Authored <strong>Signature A</strong></p>", quotedText: originalQuote });
  }
  await flushDraft(key);
  expect(saved).toMatchObject({ accountId: 2, bodyText: "Authored Signature A", bodyHtml: "<p>Authored <strong>Signature A</strong></p>", quotedText: originalQuote, mode });
  const reopened = fromServer(saved);
  expect(reopened).toMatchObject({ accountId: 2, toText: "to@example.test", ccText: "cc@example.test", bccText: "bcc@example.test", bodyText: "Authored Signature A", bodyHtml: "<p>Authored <strong>Signature A</strong></p>", quotedText: originalQuote, auto: { to: [], cc: [], bcc: [] }, inReplyToMessageId: fields.inReplyToMessageId, forwardOfMessageId: fields.forwardOfMessageId });
  forgetDraft(key);
  useDrafts.setState({ drafts: { [reopened.key]: reopened } });
  rpc.call.mockResolvedValue({ opId: "queued", threadId: 7 });
  expect(await sendDraft(reopened.key)).toBe(true);
  const sent = rpc.call.mock.calls.find(([method]) => method === "compose.send")![1];
  expect(sent).toMatchObject({ accountId: 2, to: [{ name: "", email: "to@example.test" }], cc: [{ name: "", email: "cc@example.test" }], bcc: [{ name: "", email: "bcc@example.test" }] });
  expect(sent.bodyText).toBe(`Authored Signature A\n\n-- \nSignature B${originalQuote ? `\n\n${originalQuote}` : ""}`);
  const doc = new DOMParser().parseFromString(sent.bodyHtml, "text/html");
  const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const lines = originalQuote.split("\n");
  const quoteHtml = mode === "new" ? "" : mode === "forward"
    ? `<div><br></div>${lines.map((line) => `<div>${escape(line) || "<br>"}</div>`).join("")}`
    : `<div><br></div><div>${escape(lines[0]!)}</div><blockquote style="margin:0 0 0 0.8ex;border-left:2px solid #ccc;padding-left:1ex"><div>Original source</div></blockquote>`;
  expect(doc.body.innerHTML).toBe(`<div>Authored <b>Signature A</b></div><div><br></div><div>-- <br>Signature B</div>${quoteHtml}`);
  expect(detail).toEqual(source);
});

it("empty selected signature does not erase signature-like authored text", async () => {
  setApp({ accounts: [a, { ...b, signature: "  " }] });
  const key = createDraft({ ...newFields(1), toText: "to@example.test", bodyText: "Signature A is authored", bodyHtml: "<p>Signature A is authored</p>" });
  editDraft(key, { accountId: 2 });
  setDraftTransport(async (_method, params) => ({ ...(params as object), id: 43, generation: "g", revision: 1, updatedAt: 0 }));
  rpc.call.mockResolvedValue({ opId: "queued", threadId: 7 });
  expect(await sendDraft(key)).toBe(true);
  const sent = rpc.call.mock.calls.find(([method]) => method === "compose.send")![1];
  expect(sent).toMatchObject({ accountId: 2, bodyText: "Signature A is authored" });
  expect(new DOMParser().parseFromString(sent.bodyHtml, "text/html").body.innerHTML).toBe("<div>Signature A is authored</div>");
});
