/**
 * Plan 60: a forward opens whatever the state of its original’s files, and the
 * missing ones are asked for again (three tries) and join the draft as they come.
 */
import { afterEach, expect, it, vi } from "vitest";
import type { Account, AttachmentRef, MessageDetail, ThreadDetail } from "@terno/core";
import type { DraftInput } from "@terno/store";
import { t } from "@terno/i18n";
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: { call: (method: string, params: unknown) => method === "drafts.sourceContext" ? Promise.resolve({ threadId: 7, accountId: 1 }) : rpc(method, params) } }));
const { openCompose } = await import("./compose");
const { replyFields } = await import("./compose-fields");
const { createDraft, editDraft, forgetDraft, setDraftTransport, useDrafts } = await import("./drafts");
const { setApp } = await import("~/state/app");
const { useThreads } = await import("~/state/threads");
const { resetSnacks } = await import("./snack");
const { FORWARD_FILE_DELAYS, forwardFilesHeld, resetForwardFiles, retryForwardFiles, useForwardFiles } = await import("./forward-files");

const account = { id: 1, email: "source@test.com" } as Account;
const other = { id: 2, email: "other@test.com" } as Account;
const ref: AttachmentRef = { assetId: "asset-1", filename: "report.pdf", mime: "application/pdf", size: 10, contentId: null };
function thread(patch: Partial<MessageDetail> = {}): ThreadDetail {
  return { thread: { id: 7, accountId: 1, subject: "source" }, messages: [{ id: 3, accountId: 1, isSent: false, from: { name: "Sender", email: "sender@test.com" }, to: [], cc: [], subject: "source", date: 0, bodyText: "source", hasAttachments: true, attachmentState: "pending", attachments: [], ...patch }] } as ThreadDetail;
}
const captured = (r: AttachmentRef = ref) => thread({ attachmentState: "complete", attachments: [{ id: 1, ...r }] });
const notCaptured = (r: AttachmentRef = ref) => thread({ attachmentState: "unavailable", attachments: [{ id: 1, filename: r.filename, mime: r.mime, size: r.size }] });

/** the backend: what threads.get answers (changeable), every info confirming */
function backend(initial: ThreadDetail) {
  let current = initial;
  rpc.mockImplementation(async (method: string, p: { assetId?: string }) => {
    if (method === "threads.get") return current;
    if (method === "attachments.info") return { ...ref, assetId: p.assetId! };
    return { ok: true };
  });
  useThreads.setState({ details: new Map([[7, initial]]) });
  setApp({ accounts: [account, other], selectedId: 7, checked: new Set(), scope: null, draftShown: null, draftFocus: null });
  setDraftTransport(async (_method, p) => ({ ...(p as DraftInput), id: 9, generation: "generation", revision: 1, updatedAt: 0 }));
  return { set: (d: ThreadDetail) => { current = d; } };
}
const retries = () => rpc.mock.calls.filter(([method]) => method === "attachments.retry").length;
const theDraft = () => Object.values(useDrafts.getState().drafts)[0]!;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

afterEach(() => { vi.useRealTimers(); resetForwardFiles(); for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key); rpc.mockReset(); resetSnacks(); });

it("tries three times on the schedule, then offers Try again, which tries three more", async () => {
  vi.useFakeTimers();
  backend(notCaptured());
  await openCompose("forward", 7);
  const key = theDraft().key;
  await vi.advanceTimersByTimeAsync(0);
  expect(retries()).toBe(1);
  expect(useForwardFiles.getState()[key]).toEqual({ status: "fetching", names: ["report.pdf"] });
  await vi.advanceTimersByTimeAsync(FORWARD_FILE_DELAYS[1] - 1);
  expect(retries()).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(retries()).toBe(2);
  await vi.advanceTimersByTimeAsync(FORWARD_FILE_DELAYS[2]);
  expect(retries()).toBe(3);
  await flush();
  expect(useForwardFiles.getState()[key]).toEqual({ status: "failed", names: ["report.pdf"] });
  // nothing more on its own: idle means idle
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(retries()).toBe(3);
  retryForwardFiles(key);
  await vi.waitFor(() => expect(retries()).toBe(4));
  await flush();
  expect(useForwardFiles.getState()[key]?.status).toBe("fetching");
});

it("a file captured meanwhile (the open conversation refetched) joins without waiting for the next try", async () => {
  vi.useFakeTimers();
  backend(notCaptured());
  await openCompose("forward", 7);
  const key = theDraft().key;
  await vi.waitFor(() => expect(retries()).toBe(1));
  await flush();
  useThreads.setState({ details: new Map([[7, captured()]]) });
  await vi.waitFor(() => expect(useDrafts.getState().drafts[key]!.attachments).toEqual([ref]));
  await vi.waitFor(() => expect(useForwardFiles.getState()[key]).toBeUndefined());
  // done: no second try
  await vi.advanceTimersByTimeAsync(60_000);
  expect(retries()).toBe(1);
});

it("a file the user removed never comes back, even on Forward again", async () => {
  const server = backend(notCaptured());
  await openCompose("forward", 7);
  const key = theDraft().key;
  server.set(captured());
  await vi.waitFor(() => expect(useDrafts.getState().drafts[key]!.attachments).toEqual([ref]));
  editDraft(key, { attachments: [] });
  useThreads.setState({ details: new Map([[7, { ...captured() }]]) });
  await openCompose("forward", 7);
  await flush();
  expect(useDrafts.getState().drafts[key]!.attachments).toEqual([]);
});

it("a discarded draft stops the tries and forgets the status", async () => {
  vi.useFakeTimers();
  backend(notCaptured());
  await openCompose("forward", 7);
  const key = theDraft().key;
  await vi.waitFor(() => expect(retries()).toBe(1));
  forgetDraft(key);
  expect(useForwardFiles.getState()[key]).toBeUndefined();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(retries()).toBe(1);
});

it("on another From it waits, says which account brings the files, and goes on once From is that account", async () => {
  backend(notCaptured());
  const key = createDraft({ ...replyFields("reply", thread(), account), accountId: 2 });
  editDraft(key, { bodyText: "mine" });
  await openCompose("forward", 7);
  expect(useDrafts.getState().drafts[key]).toMatchObject({ mode: "forward", accountId: 2 });
  await vi.waitFor(() => expect(useForwardFiles.getState()[key]).toEqual({ status: "account", account: "source@test.com" }));
  expect(retries()).toBe(0);
  editDraft(key, { accountId: 1 });
  await vi.waitFor(() => expect(retries()).toBe(1));
  expect(useForwardFiles.getState()[key]).toEqual({ status: "fetching", names: ["report.pdf"] });
});

it("files too large for one message say so and stop", async () => {
  const big = { ...ref, size: 30 * 1024 * 1024 };
  const server = backend(notCaptured(big));
  rpc.mockImplementation(async (method: string) => method === "threads.get" ? captured(big) : method === "attachments.info" ? big : { ok: true });
  server.set(captured(big));
  await openCompose("forward", 7);
  const key = theDraft().key;
  await vi.waitFor(() => expect(useForwardFiles.getState()[key]).toEqual({ status: "tooLarge" }));
  expect(useDrafts.getState().drafts[key]!.attachments).toEqual([]);
});

it("a send in flight holds the files back; a send that didn't go lets them join", async () => {
  vi.useFakeTimers();
  backend(notCaptured());
  await openCompose("forward", 7);
  const key = theDraft().key;
  await vi.waitFor(() => expect(retries()).toBe(1));
  await flush();
  useDrafts.setState((s) => ({ drafts: { ...s.drafts, [key]: { ...s.drafts[key]!, sending: true } } }));
  useThreads.setState({ details: new Map([[7, captured()]]) });
  await flush();
  expect(useDrafts.getState().drafts[key]!.attachments).toEqual([]);
  useDrafts.setState((s) => ({ drafts: { ...s.drafts, [key]: { ...s.drafts[key]!, sending: false } } }));
  await vi.waitFor(() => expect(useDrafts.getState().drafts[key]!.attachments).toEqual([ref]));
});

it("two drafts forwarding the same original share one capture retry", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  backend(notCaptured());
  rpc.mockImplementation(async (method: string) => { if (method === "threads.get") return notCaptured(); if (method === "attachments.retry") await gate; return { ok: true }; });
  await openCompose("forward", 7);
  const first = theDraft().key;
  const second = createDraft({ ...replyFields("forward", thread(), account) });
  const { fetchForwardFiles } = await import("./forward-files");
  fetchForwardFiles(second, { threadId: 7, messageId: 3, accountId: 1 });
  await vi.waitFor(() => expect(retries()).toBe(1));
  await flush();
  expect(retries()).toBe(1);
  release();
  expect(first).not.toBe(second);
});

// Codex review: tries that ran out keep nothing alive (no watchers, no thread held); the status stays until the draft goes
it("after the last try nothing keeps watching, and a discarded draft leaves nothing behind", async () => {
  vi.useFakeTimers();
  backend(notCaptured());
  await openCompose("forward", 7);
  const key = theDraft().key;
  await vi.advanceTimersByTimeAsync(FORWARD_FILE_DELAYS[1] + FORWARD_FILE_DELAYS[2] + 1);
  await flush();
  expect(useForwardFiles.getState()[key]?.status).toBe("failed");
  expect(forwardFilesHeld()).toEqual({ sessions: 0, sources: 1, offered: 1, watching: true });
  forgetDraft(key);
  expect(useForwardFiles.getState()[key]).toBeUndefined();
  expect(forwardFilesHeld()).toEqual({ sessions: 0, sources: 0, offered: 0, watching: false });
});

it("forwards opened and finished again and again keep nothing once their drafts go", async () => {
  backend(captured());
  for (let i = 0; i < 5; i++) {
    await openCompose("forward", 7);
    const key = theDraft().key;
    await vi.waitFor(() => expect(forwardFilesHeld().sessions).toBe(0));
    forgetDraft(key);
  }
  expect(forwardFilesHeld()).toEqual({ sessions: 0, sources: 0, offered: 0, watching: false });
});

it("a forward of an original with no files never asks for its account in From", async () => {
  backend(thread({ attachmentState: "complete", hasAttachments: false, attachments: [] }));
  const key = createDraft({ ...replyFields("reply", thread(), account), accountId: 2 });
  editDraft(key, { bodyText: "mine" });
  await openCompose("forward", 7);
  expect(useDrafts.getState().drafts[key]).toMatchObject({ mode: "forward", accountId: 2 });
  await vi.waitFor(() => expect(forwardFilesHeld().sessions).toBe(0));
  expect(useForwardFiles.getState()[key]).toBeUndefined();
  expect(retries()).toBe(0);
});

it("the size note goes when the draft stops being that forward", async () => {
  const big = { ...ref, size: 30 * 1024 * 1024 };
  // not on the device at open; the retry brings it, too large to join
  backend(notCaptured(big));
  rpc.mockImplementation(async (method: string) => method === "threads.get" ? captured(big) : method === "attachments.info" ? big : { ok: true });
  await openCompose("forward", 7);
  const key = theDraft().key;
  await vi.waitFor(() => expect(useForwardFiles.getState()[key]).toEqual({ status: "tooLarge" }));
  editDraft(key, { mode: "reply", forwardOfMessageId: null, inReplyToMessageId: 3 });
  expect(useForwardFiles.getState()[key]).toBeUndefined();
});

it("names the files in English and Spanish", async () => {
  expect(t("compose.forwardFiles.failed", { count: 1, names: "report.pdf" })).toBe("Couldn’t get report.pdf, so this forward won’t include it.");
  expect(t("compose.forwardFiles.failed", { count: 2, names: "a.pdf and b.pdf" })).toBe("Couldn’t get a.pdf and b.pdf, so this forward won’t include them.");
});
