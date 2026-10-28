import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Account, AttachmentRef, ThreadDetail } from "@terno/core";
import type { DraftInput } from "@terno/store";
const { rpc, sourceContext, threadGet, clientCall } = vi.hoisted(() => ({ rpc: vi.fn(), sourceContext: vi.fn(), threadGet: vi.fn(), clientCall: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: { call: clientCall } }));
const { attachFiles, attachmentUploading } = await import("./attachments");
const { openCompose: compose, supersedeCompose } = await import("./compose");
const { convertFields, newFields, replyFields } = await import("./compose-fields");
const { acquireDraftHold, attachBody, createDraft, draftWorkPending, editDraft, fieldsOf, flushDraft, forgetDraft, markDraftMissing, setDraftTransport: applyDraftTransport, useDrafts } = await import("./drafts");
const { getApp, setApp, useApp } = await import("~/state/app");
const { invalidateThreads, useThreads } = await import("~/state/threads");
const { resetSnacks, useSnack } = await import("./snack");
const account = { id: 1, email: "me@test.com" } as Account;
const ref: AttachmentRef = { assetId: "source", filename: "source.bin", mime: "application/octet-stream", size: 0 };
const violations: unknown[] = [], releases: (() => void)[] = [], disposals: (() => void)[] = [];
const work = new Map<Promise<unknown>, string>(), transports = new Set<Promise<unknown>>();
let cleanupFailed = false;
let previousApp: ReturnType<typeof getApp>, previousThreads: ReturnType<typeof useThreads.getState>;
function checked<T>(check: () => T): T {
  try { return check(); } catch (error) { violations.push(error); throw error; }
}
function own<T>(promise: Promise<T>, label: string): Promise<T> {
  work.set(promise, label);
  void promise.then(() => work.delete(promise), () => work.delete(promise));
  return promise;
}
function openCompose(...args: Parameters<typeof compose>) { return own(compose(...args), "compose"); }
function setDraftTransport(call: Parameters<typeof applyDraftTransport>[0]) {
  applyDraftTransport((method, params) => {
    checked(() => {
      expect(method).toBe("drafts.save");
      expect(params).toMatchObject({ accountId: expect.any(Number), to: expect.any(Array), cc: expect.any(Array), bcc: expect.any(Array), bodyText: expect.any(String), bodyHtml: expect.any(String), attachments: expect.any(Array), showSourceContext: expect.any(Boolean) });
    });
    const pending = call(method, params);
    transports.add(pending);
    void pending.then(() => transports.delete(pending), () => transports.delete(pending));
    return pending;
  });
}
async function bounded<T>(pending: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: pending ${[...work.values()].join(", ")}; transports ${transports.size}`)), 5000); })]); }
  finally { clearTimeout(timer); }
}
async function drain() {
  for (const release of releases) release();
  try {
    await bounded((async () => {
      await Promise.all(work.keys());
      await Promise.all(Object.keys(useDrafts.getState().drafts).map(flushDraft));
      await Promise.all(transports);
    })(), "fixture drain");
  } catch (error) { cleanupFailed = true; throw error; }
}
function later(change: () => void, settled: () => boolean) {
  let count = 0, during = false;
  const pending = own(new Promise<void>((resolve, reject) => {
    setTimeout(() => {
      count++; during = !settled();
      try { change(); resolve(); } catch (error) { reject(error); }
    }, 0);
  }), "late callback");
  return { pending, assert: () => { expect(count).toBe(1); expect(during).toBe(true); } };
}
beforeEach(() => {
  expect(draftWorkPending()).toBe(false);
  previousApp = getApp(); previousThreads = useThreads.getState(); cleanupFailed = false;
  violations.length = 0; releases.length = 0; disposals.length = 0;
  sourceContext.mockResolvedValue({ threadId: 7, accountId: 1 });
  clientCall.mockImplementation((method: string, params: unknown) => checked(() => {
    if (method === "drafts.sourceContext") { expect(params).toEqual({ messageId: 3 }); return sourceContext(method, params); }
    if (method === "threads.get") { expect(params).toEqual({ threadId: 7 }); return threadGet(method, params); }
    if (method === "attachments.info") expect(params).toEqual({ accountId: 1, assetId: "source" });
    else if (method === "attachments.create") expect(params).toEqual({ accountId: 1, filename: "upload.bin", mime: "application/octet-stream", size: 1 });
    else if (method === "attachments.append") expect(params).toEqual({ accountId: 1, assetId: "staged", index: 0, dataBase64: "/w==" });
    else if (method === "attachments.seal" || method === "attachments.discard") expect(params).toEqual({ accountId: 1, assetId: "staged" });
    else throw new Error(`Unexpected fixture RPC ${method}`);
    return rpc(method, params);
  }));
});
function thread(parts: AttachmentRef[] = [ref]): ThreadDetail {
  return { thread: { id: 7, accountId: 1, subject: "source", snippet: "", lastDate: 0, fromName: "Sender", fromEmail: "sender@test.com", messageCount: 1, unread: false, starred: false, hasAttachments: true, categoryIds: [], inInbox: true, inTrash: false, inSpam: false }, messages: [{ id: 3, threadId: 7, replyTo: [], snippet: "", bodyHtml: null, bodyState: "full", isRead: true, isStarred: false, hasAttachments: true, rfcMessageId: null, references: [], listId: null, accountId: 1, attachmentState: "complete", isSent: false, from: { name: "Sender", email: "sender@test.com" }, to: [], cc: [], subject: "source", date: 0, bodyText: "source", attachments: parts.map((a, id) => ({ id, ...a })) }] };
}
function setup(signature = "") {
  setApp({ accounts: [{ ...account, signature }], selectedId: 7, checked: new Set(), scope: null, draftShown: null, draftFocus: null, compose: null, dialog: null, fatal: null });
  let revision = 0;
  setDraftTransport(async (_method, p) => ({ ...(p as DraftInput), id: 9, generation: "first", revision: ++revision, updatedAt: 0 }));
}
afterEach(async () => {
  if (cleanupFailed) throw new Error("Fixture cleanup incomplete; dependent teardown skipped");
  await drain();
  for (const dispose of disposals) dispose();
  supersedeCompose();
  for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key);
  useApp.setState(previousApp, true); useThreads.setState(previousThreads, true);
  rpc.mockReset(); sourceContext.mockReset(); threadGet.mockReset(); clientCall.mockReset(); resetSnacks();
  expect(draftWorkPending()).toBe(false);
  expect(violations).toEqual([]);
});

it("deduplicates repeated source IDs for fresh and authored Forward while retaining exact authored metadata", async () => {
  setup(); const detail = thread([ref, ref]); useThreads.setState({ details: new Map([[7, detail]]) });
  rpc.mockResolvedValue(ref);
  await openCompose("forward", 7);
  const d = Object.values(useDrafts.getState().drafts)[0]!;
  expect(d.attachments).toEqual([{ ...ref, contentId: null }]);
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(clientCall.mock.calls).toEqual([["attachments.info", { accountId: 1, assetId: "source" }], ["drafts.sourceContext", { messageId: 3 }]]);
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
  const key = kind === "fresh" ? null : createDraft({ ...replyFields("reply", detail, account), showSourceContext: false });
  if (kind === "authored") editDraft(key!, { bodyText: "keep", bodyHtml: "<div>keep</div>" });
  const before = key ? fieldsOf(useDrafts.getState().drafts[key]!) : undefined;
  await openCompose("forward", 7);
  if (key) expect(fieldsOf(useDrafts.getState().drafts[key]!)).toEqual(before);
  else expect(Object.values(useDrafts.getState().drafts)).toEqual([]);
  expect(useSnack.getState().current?.message).toBe("This message is too large. Remove an attachment or shorten the message.");
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
    if (method === "attachments.seal") { reached(); await gate; return { ok: true as const }; }
    if (method === "attachments.append" || method === "attachments.discard") return { ok: true };
    return checked(() => { throw new Error(`Unexpected upload RPC ${method}`); });
  });
  releases.push(release);
  const pending = own(attachFiles(key, [new File([new Uint8Array([255])], "upload.bin")]), "upload");
  const reachedGate = Promise.race([waiting, pending.then(() => { throw new Error("Upload settled before seal gate"); })]);
  return { work: pending, waiting: reachedGate, release, staged };
}

it("overlapping first autosave and mounted-editor typing are retained when an upload is adopted", async () => {
  setup(); const key = createDraft(newFields(1));
  let text = "";
  const reader = attachBody(key, () => ({ text, html: `<div>${text}</div>` }));
  disposals.push(() => reader.dispose());
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
  let settled = false, callback: ReturnType<typeof later> | undefined;
  threadGet.mockResolvedValue({ ...detail, messages: [{ ...detail.messages[0]!, attachmentState: "pending" }] });
  rpc.mockImplementation(async (method: string) => {
    checked(() => { expect(method).toBe("attachments.info"); expect(callback).toBeUndefined(); });
    callback = later(() => {
      if (scenario === "body") editDraft(key, { bodyText: "late body", bodyHtml: "<div>late body</div>" });
      if (scenario === "recipients") editDraft(key, { bccText: "late@test.com" });
      if (scenario === "account") editDraft(key, { accountId: 2 });
      if (scenario === "recovery") markDraftMissing(key);
      if (scenario === "signature") setApp({ accounts: [{ ...account, signature: "changed signature" }] });
      if (scenario === "navigation") setApp({ selectedId: 8 });
      if (scenario === "source") invalidateThreads([7]);
      expected = fieldsOf(useDrafts.getState().drafts[key]!);
    }, () => settled);
    return ref;
  });
  try { await openCompose("forward", 7); } finally { settled = true; }
  expect(callback).toBeDefined(); await callback!.pending; callback!.assert();
  if (scenario === "source") expect(threadGet).toHaveBeenCalledWith("threads.get", { threadId: 7 });
  expect(fieldsOf(useDrafts.getState().drafts[key]!)).toEqual(expected);
  expect(useDrafts.getState().drafts[key]!.mode).toBe("reply");
});

it("upload final budget cannot overwrite newer coalesced editor content or publish stale files", async () => {
  setup(); const key = createDraft(newFields(1));
  let text = "";
  const reader = attachBody(key, () => ({ text, html: `<div>${text}</div>` }));
  disposals.push(() => reader.dispose());
  const u = gatedUpload(key); await u.waiting;
  text = "a".repeat(40_000); reader.changed();
  let settled = false;
  const callback = later(() => { text = "b".repeat(40_000); reader.changed(); }, () => settled);
  u.release(); try { await u.work; } finally { settled = true; }
  await callback.pending; callback.assert();
  expect(useDrafts.getState().drafts[key]!.bodyText).toBe(text);
  expect(useDrafts.getState().drafts[key]!.attachments).toBeUndefined();
  expect(rpc).toHaveBeenCalledWith("attachments.discard", { accountId: 1, assetId: "staged" });
  reader.dispose();
});

it("a pending Forward retains its accepted intent and defers a shutdown hold until source admission settles", async () => {
  setup(); useThreads.setState({ details: new Map([[7, thread()]]) });
  let finish!: (a: AttachmentRef) => void, reached!: () => void;
  const waiting = new Promise<void>((r) => { reached = r; });
  const gate = new Promise<AttachmentRef>((r) => { finish = r; });
  releases.push(() => finish(ref));
  rpc.mockImplementation((method: string) => { checked(() => expect(method).toBe("attachments.info")); reached(); return gate; });
  const pending = openCompose("forward", 7); await Promise.race([waiting, pending.then(() => { throw new Error("Forward settled before info gate"); })]);
  expect(acquireDraftHold()).toBeNull(); finish(ref); await pending;
  expect(Object.values(useDrafts.getState().drafts)[0]).toMatchObject({ mode: "forward", attachments: [{ ...ref, contentId: null }] });
  const release = acquireDraftHold(); try { expect(release).toBeTypeOf("function"); } finally { release?.(); }
  expect(sourceContext.mock.calls).toEqual([["drafts.sourceContext", { messageId: 3 }]]);
});

it.each(["fresh", "untouched", "authored"])("control: small combined Forward budget (%s)", async (kind) => {
  setup("x".repeat(10_000));
  const large = { ...ref, size: 18 * 1024 * 1024 }, detail = thread([large]);
  useThreads.setState({ details: new Map([[7, detail]]) }); rpc.mockResolvedValue(large);
  const key = kind === "fresh" ? null : createDraft({ ...replyFields("reply", detail, account), showSourceContext: false });
  if (kind === "authored") editDraft(key!, { bodyText: "keep", bodyHtml: "<div>keep</div>" });
  await openCompose("forward", 7);
  const d = key ? useDrafts.getState().drafts[key]! : Object.values(useDrafts.getState().drafts)[0]!;
  expect(d).toMatchObject({ mode: "forward", attachments: [{ ...large, contentId: null }] });
  if (kind === "authored") expect(d).toMatchObject({ bodyText: "keep", bodyHtml: "<div>keep</div>" });
});

it("control: long-budget conversion without a late change", async () => {
  setup(); const detail = thread(); detail.messages[0]!.bodyText = "&".repeat(40_000);
  useThreads.setState({ details: new Map([[7, detail]]) }); rpc.mockResolvedValue(ref);
  const key = createDraft({ ...replyFields("reply", detail, account), showSourceContext: false });
  editDraft(key, { bodyText: "preserved", bodyHtml: "<div>preserved</div>" });
  await openCompose("forward", 7);
  expect(useDrafts.getState().drafts[key]).toMatchObject({ mode: "forward", bodyText: "preserved", bodyHtml: "<div>preserved</div>", attachments: [{ ...ref, contentId: null }] });
});

it("control: pending Forward final source context", async () => {
  setup(); useThreads.setState({ details: new Map([[7, thread()]]) }); rpc.mockResolvedValue(ref);
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; }), waiting = new Promise<void>((resolve) => { reached = resolve; });
  releases.push(release);
  sourceContext.mockImplementation(async () => { const result = { threadId: 7, accountId: 1 }; reached(); await gate; return result; });
  const pending = openCompose("forward", 7);
  await Promise.race([waiting, pending.then(() => { throw new Error("Forward settled before source gate"); })]);
  expect(acquireDraftHold()).toBeNull(); release(); await pending;
  expect(Object.values(useDrafts.getState().drafts)[0]).toMatchObject({ mode: "forward", attachments: [{ ...ref, contentId: null }] });
  const hold = acquireDraftHold(); try { expect(hold).toBeTypeOf("function"); } finally { hold?.(); }
  expect(sourceContext.mock.calls).toEqual([["drafts.sourceContext", { messageId: 3 }]]);
});
