// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import { setup } from "./draft-presentation-r1-harness";

it("a successful public inline lease completion retires the exact lease", async () => {
  const h = await setup("split", true), { openCompose, composeFocusPending, finishComposeFocus, subscribeComposeFocus } = await import("~/lib/compose");
  let focusSeq: number | undefined, notifications = 0;
  try {
    await act(async () => { h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "open" }); h.other.focus(); });
    const before = h.drafts.useDrafts.getState().drafts[h.key]!;
    const offApp = h.app.useApp.subscribe((state) => { if (state.draftFocus?.key === h.key) focusSeq = state.draftFocus.seq; });
    const offLease = subscribeComposeFocus((thread, fallback) => { expect(thread).toBe(7); expect(fallback).toBe(false); notifications++; });
    try {
      await act(async () => { await openCompose("reply", 7); });
      expect(focusSeq).toBeDefined(); expect(composeFocusPending(7, h.key, focusSeq)).toBe(true);
      let completed = false;
      await act(async () => { completed = finishComposeFocus(h.key, focusSeq!, false); });
      expect(completed).toBe(true); expect(composeFocusPending(7, h.key, focusSeq)).toBe(false); expect(notifications).toBe(1);
      expect(h.drafts.useDrafts.getState().drafts[h.key]!.bodyText).toBe(before.bodyText);
      expect(h.drafts.useDrafts.getState().drafts[h.key]!.toText).toBe(before.toText);
    } finally { offApp(); offLease(); }
  } finally { await h.cleanup(); }
});

