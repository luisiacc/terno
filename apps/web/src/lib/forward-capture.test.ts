import { afterEach, expect, it, vi } from "vitest";
import type { Account, MessageDetail, ThreadDetail } from "@terno/core";
import type { DraftInput } from "@terno/store";
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: { call: (method: string, params: unknown) => method === "drafts.sourceContext" ? Promise.resolve({ threadId: 7, accountId: 1 }) : rpc(method, params) } }));
const { openCompose } = await import("./compose");
const { replyFields } = await import("./compose-fields");
const { createDraft, editDraft, fieldsOf, forgetDraft, setDraftTransport, useDrafts } = await import("./drafts");
const { getApp, setApp } = await import("~/state/app");
const { invalidateThreads, useThreads } = await import("~/state/threads");
const { registerUndo, resetSnacks, useSnack } = await import("./snack");
const { resetForwardFiles, useForwardFiles } = await import("./forward-files");
const account = { id: 1, email: "source@test.com" } as Account;
const ref = { assetId: "source-asset", filename: "empty.txt", mime: "text/plain", size: 0 };
function thread(patch: Partial<MessageDetail> = {}): ThreadDetail {
  return { thread: { id: 7, accountId: 1, subject: "source" }, messages: [{ id: 3, accountId: 1, isSent: false, from: { name: "Sender", email: "sender@test.com" }, to: [], cc: [], subject: "source", date: 0, bodyText: "source", hasAttachments: true, attachmentState: "complete", attachments: [{ id: 1, ...ref }], ...patch }] } as ThreadDetail;
}
function setup(detail: ThreadDetail) {
  useThreads.setState({ details: new Map([[7, detail]]) });
  setApp({ accounts: [account], selectedId: 7, checked: new Set(), scope: null, draftShown: null, draftFocus: null });
  setDraftTransport(async (_method, p) => ({ ...(p as DraftInput), id: 9, generation: "generation", revision: 1, updatedAt: 0 }));
}
afterEach(() => { resetForwardFiles(); for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key); rpc.mockReset(); vi.unstubAllGlobals(); resetSnacks(); });

// plan 60: files that aren't on the device never stop a forward; it opens and asks for them again
it.each(["pending", "unavailable", undefined] as const)("%s capture opens the Forward at once and asks for the original's files again", async (attachmentState) => {
  const detail = thread({ attachmentState, bodyState: "full", attachments: [] });
  setup(detail);
  rpc.mockImplementation(async (method: string) => method === "threads.get" ? detail : { ok: true });
  await openCompose("forward", 7);
  const [draft] = Object.values(useDrafts.getState().drafts);
  expect(draft).toMatchObject({ mode: "forward", forwardOfMessageId: 3, attachments: [] });
  expect(useForwardFiles.getState()[draft!.key]).toEqual({ status: "fetching", names: [] });
  await vi.waitFor(() => expect(rpc).toHaveBeenCalledWith("attachments.retry", { accountId: 1, messageId: 3 }));
});

it("complete zero-part capture opens an ordinary Forward without attachment I/O", async () => {
  setup(thread({ attachmentState: "complete", hasAttachments: false, attachments: [] }));
  await openCompose("forward", 7);
  expect(Object.values(useDrafts.getState().drafts)[0]).toMatchObject({ mode: "forward", attachments: [] });
  expect(rpc).not.toHaveBeenCalled();
});

it.each(["missing", "wrong metadata", "unsealed empty"])("%s original file stays out, and the Forward opens without it", async (scenario) => {
  const detail = thread(); setup(detail);
  const key = createDraft(replyFields("reply", detail, account));
  editDraft(key, { bodyText: "keep", bccText: "private@test.com" });
  const before = fieldsOf(useDrafts.getState().drafts[key]!);
  rpc.mockImplementation(async (method: string) => {
    if (method === "threads.get") return detail;
    if (method === "attachments.retry") return { ok: true };
    if (scenario !== "wrong metadata") throw new Error("unavailable");
    return { ...ref, filename: "different" };
  });
  await openCompose("forward", 7);
  // what was written stays; only the file that couldn't be confirmed is missing (and asked for)
  expect(useDrafts.getState().drafts[key]).toMatchObject({ mode: "forward", bodyText: before.bodyText, bccText: before.bccText, attachments: [] });
  await vi.waitFor(() => expect(useForwardFiles.getState()[key]).toEqual({ status: "fetching", names: ["empty.txt"] }));
  expect(useSnack.getState().current?.message).toBe("Converted to a forward");
});

it("source account removed during asset validation cannot create a Forward", async () => {
  setup(thread());
  rpc.mockImplementation(async () => { setApp({ accounts: [] }); return ref; });
  await openCompose("forward", 7);
  expect(Object.values(useDrafts.getState().drafts)).toEqual([]);
});

it.each(["edit", "account", "discard", "navigation", "intent", "recovery", "sending", "capture", "focus"])("asset validation fences late %s without overwriting work or Undo", async (scenario) => {
  const detail = thread(); setup(detail);
  const key = createDraft(replyFields("reply", detail, account));
  editDraft(key, { bodyText: "keep" });
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>((r) => { release = r; }), waiting = new Promise<void>((r) => { reached = r; });
  rpc.mockImplementation(async (method: string) => { if (method === "threads.get") return thread({ attachmentState: "pending" }); reached(); await gate; return ref; });
  const document = { activeElement: {} }; vi.stubGlobal("document", document);
  const undo = registerUndo(() => {});
  const opening = openCompose("forward", 7); await waiting;
  if (scenario === "edit") editDraft(key, { bodyText: "later" });
  if (scenario === "account") editDraft(key, { accountId: 2 });
  if (scenario === "discard") forgetDraft(key);
  if (scenario === "navigation") setApp({ selectedId: 8 });
  if (scenario === "intent") await openCompose("reply", 7);
  if (scenario === "recovery" || scenario === "sending") useDrafts.setState((s) => ({ drafts: { ...s.drafts, [key]: { ...s.drafts[key]!, ...(scenario === "recovery" ? { recovery: { state: "missing" as const } } : { sending: true }) } } }));
  if (scenario === "capture") invalidateThreads([7]);
  if (scenario === "focus") document.activeElement = {};
  const before = useDrafts.getState().drafts[key];
  release(); await opening;
  if (scenario === "focus") { expect(useDrafts.getState().drafts[key]!.mode).toBe("forward"); expect(getApp().draftFocus).toBeNull(); }
  else { expect(useDrafts.getState().drafts[key]).toEqual(before); expect(useSnack.getState().undo).toBe(undo); }
});

it("files captured by the retry join the Forward once, bound to its original after navigation", async () => {
  const detail = thread({ attachmentState: "pending", attachments: [] }); setup(detail);
  rpc.mockImplementation(async (method: string) => method === "threads.get" ? thread() : method === "attachments.info" ? ref : { ok: true });
  await openCompose("forward", 7);
  const [draft] = Object.values(useDrafts.getState().drafts);
  setApp({ selectedId: 8 });
  await vi.waitFor(() => expect(useDrafts.getState().drafts[draft!.key]!.attachments).toEqual([{ ...ref, contentId: null }]));
  await vi.waitFor(() => expect(useForwardFiles.getState()[draft!.key]).toBeUndefined());
  expect(rpc.mock.calls.filter(([method]) => method === "attachments.retry")).toEqual([["attachments.retry", { accountId: 1, messageId: 3 }]]);
  expect(getApp().selectedId).toBe(8);
});
