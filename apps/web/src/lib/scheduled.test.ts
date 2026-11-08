// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import type { ScheduledInfo } from "@terno/core/rpc";

const mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: { call: mocks.call, on: vi.fn() } }));
const compose = vi.hoisted(() => ({ openStoredDraft: vi.fn(async () => {}) }));
vi.mock("~/lib/compose", () => compose);

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

it("the hold's end (plan 158): Undo goes and the spinner stays; a result already waiting behind the Undo takes the dock instead", async () => {
  const { heldSendSnack } = await import("./scheduled");
  const { resetSnacks, snack, useSnack } = await import("./snack");
  vi.useFakeTimers();
  try {
    resetSnacks();
    heldSendSnack(7, null, 5000);
    expect(useSnack.getState().current).toMatchObject({ tone: "loading", duration: 5000, action: { label: expect.any(String) } });
    expect(useSnack.getState().undo).not.toBeNull();
    vi.advanceTimersByTime(5000);
    expect(useSnack.getState().current).toMatchObject({ tone: "loading" });
    expect(useSnack.getState().current?.action).toBeUndefined();
    expect(useSnack.getState().undo).toBeNull();

    resetSnacks();
    heldSendSnack(8, null, 5000);
    snack.success("Message sent", { background: true });
    expect(useSnack.getState().current?.tone).toBe("loading");
    vi.advanceTimersByTime(5000);
    expect(useSnack.getState().current?.message).toBe("Message sent");
  } finally {
    vi.useRealTimers();
    resetSnacks();
  }
});

it("Undo send waiting on the backend: the draft comes back opened only if nothing newer took its place (series review)", async () => {
  const { heldSendSnack } = await import("./scheduled");
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
    heldSendSnack(draftId, null, 5000, pinned);
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
