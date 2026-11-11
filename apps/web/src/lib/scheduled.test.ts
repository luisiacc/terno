// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import type { ScheduledInfo } from "@terno/core/rpc";

const mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: { call: mocks.call, on: vi.fn() } }));
const compose = vi.hoisted(() => ({ openStoredDraft: vi.fn(async () => {}) }));
vi.mock("~/lib/compose", () => compose);
const sound = vi.hoisted(() => ({ playSendSound: vi.fn(), primeSendSound: vi.fn() }));
vi.mock("~/lib/sounds", () => sound);

const { applyScheduled, useScheduled } = await import("./scheduled");
const { useDrafts } = await import("./drafts");

const item = (draftId: number): ScheduledInfo => ({ draftId, sendAt: 1, accountId: 1, threadId: null, mode: "new", to: [], subject: "Budget", error: null, retryAt: null });
const stored = (id: number) => ({ id, generation: "g", accountId: 1, threadId: null, format: 2, mode: "new", to: [], cc: [], bcc: [], subject: "Budget", subjectEdited: false, bodyText: "x", bodyHtml: "", attachments: [], quotedText: "", includeQuote: false, inReplyToMessageId: null, forwardOfMessageId: null, uiState: "collapsed", revision: 1, updatedAt: 1 });

it("a draft no longer scheduled (unscheduled in another window, given back) is loaded here, even when its drafts event came first", async () => {
  mocks.call.mockImplementation(async (method: string) => (method === "drafts.list" ? [stored(5)] : { ok: true }));
  applyScheduled({ items: [item(5)], failed: [] });
  expect(useScheduled.getState().byDraft.has(5)).toBe(true);
  // the drafts event came while it was still scheduled here: skipped
  const { loadDrafts } = await import("./drafts");
  await loadDrafts();
  expect(Object.values(useDrafts.getState().drafts).some((d) => d.id === 5)).toBe(false);
  // the snapshot without it brings it in
  applyScheduled({ items: [], failed: [] });
  await vi.waitFor(() => expect(Object.values(useDrafts.getState().drafts).some((d) => d.id === 5)).toBe(true));
});

it("plan 182 (Codex critique #4): a hold that couldn't go (listed now, or given back) has nothing coming: its card goes", async () => {
  const { holdSend, heldById, resetHeldSends } = await import("./held-sends");
  const add = (draftId: number) => holdSend({ draftId, accountId: 1, threadId: 3, mode: "reply", subject: "Budget", to: [], cc: [], bodyHtml: null, bodyText: "x", attachments: [], goesAt: Date.now() + 5000, cancel: async () => true });
  try {
    add(31);
    add(32);
    applyScheduled({ items: [{ ...item(31), error: "Offline" }], failed: [{ id: "f", draftId: 32, subject: "Budget", message: "Gone", at: 1 }] });
    expect(heldById(31)).toBeUndefined();
    expect(heldById(32)).toBeUndefined();
  } finally {
    resetHeldSends();
  }
});

it("Undo send waiting on the backend: the draft comes back opened only if nothing newer took its place (series review)", async () => {
  const { cancelHeldSend } = await import("./scheduled");
  const { holdSend } = await import("./held-sends");
  const { resetSnacks, runUndo, useSnack } = await import("./snack");
  const { pinning, usePinned } = await import("./pinned-draft-state");
  const { setApp } = await import("~/state/app");
  const pin = vi.fn(() => true);
  pinning.pin = pin;
  /** Undo asked for, the backend's answer held while `meanwhile` happens */
  const undoWhile = async (draftId: number, meanwhile: () => void, pinned = false) => {
    let answer!: () => void;
    mocks.call.mockImplementation((method: string) => method === "scheduled.cancel" ? new Promise((r) => (answer = () => r({ ok: true }))) : Promise.resolve(method === "drafts.list" ? [stored(draftId)] : { ok: true }));
    resetSnacks();
    holdSend({ draftId, accountId: 1, threadId: null, mode: "new", subject: "Budget", to: [], cc: [], bodyHtml: null, bodyText: "x", attachments: [], goesAt: Date.now() + 5000, cancel: (cancelled) => cancelHeldSend(draftId, pinned, cancelled) });
    const undoing = runUndo(useSnack.getState().undo!);
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    meanwhile();
    answer();
    await undoing;
  };
  try {
    // nothing else since: back in the composer
    await undoWhile(11, () => {});
    expect(compose.openStoredDraft).toHaveBeenCalledTimes(1);
    // another message opened meanwhile: it keeps the composer, and the draft is said to be in Drafts
    compose.openStoredDraft.mockClear();
    setApp({ compose: null });
    await undoWhile(12, () => setApp({ compose: { key: "newer", seq: 1 } }));
    expect(compose.openStoredDraft).not.toHaveBeenCalled();
    expect(useSnack.getState().current?.message).toBe("Not sent. It’s back in your drafts.");
    expect(Object.values(useDrafts.getState().drafts).some((d) => d.id === 12)).toBe(true);
    // writing somewhere else meanwhile: the same
    const field = document.createElement("textarea");
    document.body.append(field);
    await undoWhile(13, () => field.focus());
    expect(compose.openStoredDraft).not.toHaveBeenCalled();
    field.remove();
    // from the pinned card, with another draft pinned since: that one stays pinned
    await undoWhile(14, () => usePinned.setState({ key: "newer-pinned" }), true);
    expect(pin).not.toHaveBeenCalled();
    expect(compose.openStoredDraft).not.toHaveBeenCalled();
    // and with nothing pinned since, back on the card
    await undoWhile(15, () => {}, true);
    expect(pin).toHaveBeenCalledTimes(1);
  } finally {
    resetSnacks();
    usePinned.setState({ key: null });
  }
});

it("plan 170 (Codex critique #4): a scheduled message's Send now is a send, so it sounds; a new time or a failure doesn't", async () => {
  const { rescheduleScheduled } = await import("./scheduled");
  mocks.call.mockImplementation(async () => ({ ok: true }));
  await rescheduleScheduled(5, 1000);
  expect(sound.playSendSound).not.toHaveBeenCalled();
  await rescheduleScheduled(5, 1, true);
  expect(sound.primeSendSound).toHaveBeenCalledOnce();
  expect(sound.playSendSound).toHaveBeenCalledOnce();
  mocks.call.mockImplementation(async () => { throw new Error("offline"); });
  await rescheduleScheduled(5, 1, true);
  expect(sound.playSendSound).toHaveBeenCalledOnce();
});
