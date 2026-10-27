import { afterEach, expect, it, vi } from "vitest";
import type { Account, AttachmentRef, ThreadDetail } from "@terno/core";
import type { DraftInput } from "@terno/store";
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: { call: rpc } }));
const { attachFiles, attachmentUploading } = await import("./attachments");
const { openCompose } = await import("./compose");
const { convertFields, newFields, replyFields } = await import("./compose-fields");
const { acquireDraftHold, attachBody, createDraft, editDraft, fieldsOf, flushDraft, forgetDraft, markDraftMissing, setDraftTransport, useDrafts } = await import("./drafts");
const { setApp } = await import("~/state/app");
const { invalidateThreads, useThreads } = await import("~/state/threads");
const { resetSnacks } = await import("./snack");
const account = { id: 1, email: "me@test.com" } as Account;
const ref: AttachmentRef = { assetId: "source", filename: "source.bin", mime: "application/octet-stream", size: 0 };
function thread(parts: AttachmentRef[] = [ref]): ThreadDetail {
  return { thread: { id: 7, accountId: 1, subject: "source", snippet: "", lastDate: 0, fromName: "Sender", fromEmail: "sender@test.com", messageCount: 1, unread: false, starred: false, hasAttachments: true, categoryIds: [], inInbox: true, inTrash: false, inSpam: false }, messages: [{ id: 3, threadId: 7, replyTo: [], snippet: "", bodyHtml: null, bodyState: "full", isRead: true, isStarred: false, hasAttachments: true, rfcMessageId: null, references: [], listId: null, accountId: 1, attachmentState: "complete", isSent: false, from: { name: "Sender", email: "sender@test.com" }, to: [], cc: [], subject: "source", date: 0, bodyText: "source", attachments: parts.map((a, id) => ({ id, ...a })) }] };
}
function setup(signature = "") {
  setApp({ accounts: [{ ...account, signature }], selectedId: 7, checked: new Set(), scope: null, draftShown: null, draftFocus: null });
  let revision = 0;
  setDraftTransport(async (_method, p) => ({ ...(p as DraftInput), id: 9, generation: "first", revision: ++revision, updatedAt: 0 }));
}
afterEach(() => { for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key); rpc.mockReset(); resetSnacks(); });

it("deduplicates repeated source IDs for fresh and authored Forward while retaining exact authored metadata", async () => {
  setup(); const detail = thread([ref, ref]); useThreads.setState({ details: new Map([[7, detail]]) });
  rpc.mockResolvedValue(ref);
  await openCompose("forward", 7);
  const d = Object.values(useDrafts.getState().drafts)[0]!;
  expect(d.attachments).toEqual([{ ...ref, contentId: null }]);
  expect(rpc).toHaveBeenCalledTimes(1);
  const before = { ...replyFields("reply", detail, account), bodyText: "authored", attachments: [ref] };
  expect(convertFields(before, "forward", detail, account).attachments).toEqual([ref]);
});

it("a conflicting duplicate source occurrence is refused instead of hidden by deduplication", async () => {
  setup(); useThreads.setState({ details: new Map([[7, thread([ref, { ...ref, filename: "different" }])]]) }); rpc.mockResolvedValue(ref);
  await openCompose("forward", 7);
  expect(Object.values(useDrafts.getState().drafts)).toEqual([]);
});

it.each(["fresh", "untouched", "authored"])("%s Forward checks the actual combined message including signature before any mutation", async (kind) => {
  setup("x".repeat(10_000));
  const large = { ...ref, size: 18 * 1024 * 1024 }, detail = thread([large]);
  detail.messages[0]!.bodyText = "a".repeat(265_000);
  useThreads.setState({ details: new Map([[7, detail]]) }); rpc.mockResolvedValue(large);
  const key = kind === "fresh" ? null : createDraft(replyFields("reply", detail, account));
  if (kind === "authored") editDraft(key!, { bodyText: "keep", bodyHtml: "<div>keep</div>" });
  const before = key ? fieldsOf(useDrafts.getState().drafts[key]!) : undefined;
  await openCompose("forward", 7);
  if (key) expect(fieldsOf(useDrafts.getState().drafts[key]!)).toEqual(before);
  else expect(Object.values(useDrafts.getState().drafts)).toEqual([]);
});

it("upload preflight includes existing files, HTML, quote and signature before creating an asset", async () => {
  setup("x".repeat(10_000));
  const key = createDraft({ ...newFields(1), attachments: [{ ...ref, size: 18 * 1024 * 1024 }], bodyText: "a".repeat(265_000), bodyHtml: "<div>keep</div>", quotedText: "quote", includeQuote: true });
  const before = fieldsOf(useDrafts.getState().drafts[key]!);
  await attachFiles(key, [new File([], "new.txt")]);
  expect(fieldsOf(useDrafts.getState().drafts[key]!)).toEqual(before);
  expect(rpc).not.toHaveBeenCalled();
});

function gatedUpload(key: string) {
  const staged = { ...ref, assetId: "staged", filename: "upload.bin", size: 1 };
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>((r) => { release = r; }), waiting = new Promise<void>((r) => { reached = r; });
  rpc.mockImplementation(async (method: string) => {
    if (method === "attachments.create") return staged;
    if (method === "attachments.seal") { reached(); await gate; }
    return { ok: true };
  });
  const work = attachFiles(key, [new File([new Uint8Array([255])], "upload.bin")]);
  return { work, waiting, release, staged };
}

it("overlapping first autosave and mounted-editor typing are retained when an upload is adopted", async () => {
  setup(); const key = createDraft(newFields(1));
  let text = "";
  const reader = attachBody(key, () => ({ text, html: `<div>${text}</div>` }));
  const u = gatedUpload(key); await u.waiting;
  text = "written during upload"; reader.changed();
  await flushDraft(key);
  expect(useDrafts.getState().drafts[key]!.id).toBe(9);
  u.release(); await u.work;
  expect(useDrafts.getState().drafts[key]).toMatchObject({ bodyText: text, attachments: [u.staged], generation: "first", status: "saved" });
  expect(rpc).not.toHaveBeenCalledWith("attachments.discard", expect.anything());
  reader.dispose();
});

it.each(["account ABA", "missing", "sending", "replacement", "account removed"])("a pending upload fences %s even if the transition later clears", async (scenario) => {
  setup(); const key = createDraft(newFields(1));
  if (scenario === "replacement") { editDraft(key, { bodyText: "saved" }); await flushDraft(key); }
  const u = gatedUpload(key); await u.waiting;
  if (scenario === "account ABA") { editDraft(key, { accountId: 2 }); editDraft(key, { accountId: 1 }); }
  if (scenario === "missing") { markDraftMissing(key); useDrafts.setState((s) => ({ drafts: { ...s.drafts, [key]: { ...s.drafts[key]!, recovery: undefined } } })); }
  if (scenario === "sending") { useDrafts.setState((s) => ({ drafts: { ...s.drafts, [key]: { ...s.drafts[key]!, sending: true } } })); useDrafts.setState((s) => ({ drafts: { ...s.drafts, [key]: { ...s.drafts[key]!, sending: false } } })); }
  if (scenario === "replacement") { await flushDraft(key); useDrafts.setState((s) => ({ drafts: { ...s.drafts, [key]: { ...s.drafts[key]!, id: 8, generation: "replacement" } } })); }
  if (scenario === "account removed") setApp({ accounts: [] });
  u.release(); await u.work;
  expect(useDrafts.getState().drafts[key]!.attachments).toBeUndefined();
  expect(rpc).toHaveBeenCalledWith("attachments.discard", { accountId: 1, assetId: "staged" });
  expect(attachmentUploading(key)).toBe(false);
});

it.each(["refused", "missing"])("an adopted upload is retained after a %s save acknowledgement", async (outcome) => {
  setup(); const key = createDraft(newFields(1));
  const u = gatedUpload(key); await u.waiting;
  setDraftTransport(async () => { if (outcome === "refused") throw { code: "BAD_REQUEST" }; return null; });
  u.release(); await u.work;
  expect(useDrafts.getState().drafts[key]).toMatchObject({ attachments: [u.staged], status: "error" });
  expect(rpc).not.toHaveBeenCalledWith("attachments.discard", expect.anything());
});

it("unpublished cleanup never discards a staged ID another live draft already references", async () => {
  setup(); const key = createDraft(newFields(1));
  const u = gatedUpload(key); await u.waiting;
  const other = createDraft({ ...newFields(1), attachments: [u.staged], bodyText: "independent work" });
  editDraft(key, { accountId: 2 }); u.release(); await u.work;
  expect(useDrafts.getState().drafts[other]!.attachments).toEqual([u.staged]);
  expect(rpc).not.toHaveBeenCalledWith("attachments.discard", expect.anything());
});

it("two simultaneous uploads to one key admit only the explicit first selection", async () => {
  setup(); const key = createDraft(newFields(1));
  const u = gatedUpload(key); await u.waiting;
  await attachFiles(key, [new File([], "second.txt")]);
  u.release(); await u.work;
  expect(useDrafts.getState().drafts[key]!.attachments).toEqual([u.staged]);
  expect(rpc.mock.calls.filter(([method]) => method === "attachments.create")).toHaveLength(1);
});

it.each(["body", "recipients", "account", "recovery", "signature", "navigation", "source"])("conversion cannot publish a budget checked before a late %s change", async (scenario) => {
  setup();
  const detail = thread(); detail.messages[0]!.bodyText = "&".repeat(40_000);
  useThreads.setState({ details: new Map([[7, detail]]) });
  const key = createDraft(replyFields("reply", detail, account));
  editDraft(key, { bodyText: "preserved", bodyHtml: "<div>preserved</div>" });
  let expected = fieldsOf(useDrafts.getState().drafts[key]!);
  rpc.mockImplementation(async (method: string) => {
    if (method === "threads.get") return { ...detail, messages: [{ ...detail.messages[0]!, attachmentState: "pending" }] };
    setTimeout(() => {
      if (scenario === "body") editDraft(key, { bodyText: "late body", bodyHtml: "<div>late body</div>" });
      if (scenario === "recipients") editDraft(key, { bccText: "late@test.com" });
      if (scenario === "account") editDraft(key, { accountId: 2 });
      if (scenario === "recovery") markDraftMissing(key);
      if (scenario === "signature") setApp({ accounts: [{ ...account, signature: "changed signature" }] });
      if (scenario === "navigation") setApp({ selectedId: 8 });
      if (scenario === "source") invalidateThreads([7]);
      expected = fieldsOf(useDrafts.getState().drafts[key]!);
    }, 0);
    return ref;
  });
  await openCompose("forward", 7);
  expect(fieldsOf(useDrafts.getState().drafts[key]!)).toEqual(expected);
  expect(useDrafts.getState().drafts[key]!.mode).toBe("reply");
});

it("upload final budget cannot overwrite newer coalesced editor content or publish stale files", async () => {
  setup(); const key = createDraft(newFields(1));
  let text = "";
  const reader = attachBody(key, () => ({ text, html: `<div>${text}</div>` }));
  const u = gatedUpload(key); await u.waiting;
  text = "a".repeat(40_000); reader.changed();
  setTimeout(() => { text = "b".repeat(40_000); reader.changed(); }, 0);
  u.release(); await u.work;
  expect(useDrafts.getState().drafts[key]!.bodyText).toBe(text);
  expect(useDrafts.getState().drafts[key]!.attachments).toBeUndefined();
  expect(rpc).toHaveBeenCalledWith("attachments.discard", { accountId: 1, assetId: "staged" });
  reader.dispose();
});

it("a pending Forward retains its accepted intent and defers a shutdown hold until source admission settles", async () => {
  setup(); useThreads.setState({ details: new Map([[7, thread()]]) });
  let finish!: (a: AttachmentRef) => void, reached!: () => void;
  const waiting = new Promise<void>((r) => { reached = r; });
  rpc.mockImplementation(() => { reached(); return new Promise<AttachmentRef>((r) => { finish = r; }); });
  const pending = openCompose("forward", 7); await waiting;
  expect(acquireDraftHold()).toBeNull(); finish(ref); await pending;
  expect(Object.values(useDrafts.getState().drafts)[0]).toMatchObject({ mode: "forward", attachments: [{ ...ref, contentId: null }] });
  const release = acquireDraftHold(); expect(release).toBeTypeOf("function"); release!();
});
