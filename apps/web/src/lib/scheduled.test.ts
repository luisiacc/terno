import { expect, it, vi } from "vitest";
import type { ScheduledInfo } from "@terno/core/rpc";

const mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: { call: mocks.call, on: vi.fn() } }));

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
