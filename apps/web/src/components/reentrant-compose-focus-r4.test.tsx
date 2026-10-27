// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import { setup } from "./draft-presentation-r1-harness";

it.each([false, true])("keeps the latest control when Reply publication changes focus: %s", async (move) => {
  const h = await setup("split", true);
  const { openCompose, composeFocusPending } = await import("~/lib/compose");
  const later = document.createElement("button"); document.body.append(later);
  let triggered = false;
  try {
    await act(async () => { h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "collapsed" }); });
    h.other.focus();
    const unsubscribe = h.drafts.useDrafts.subscribe((state, previous) => {
      if (!triggered && previous.drafts[h.key]?.uiState === "collapsed" && state.drafts[h.key]?.uiState === "open") {
        triggered = true; if (move) later.focus();
      }
    });
    try {
      await act(async () => { await openCompose("reply", 7); });
      expect(triggered).toBe(true);
      for (let i = 0; i < 4; i++) await h.flush();
      if (move) {
        expect(document.activeElement).toBe(later);
        expect(h.app.getApp().draftFocus).toBeNull();
        expect(composeFocusPending(7)).toBe(false);
      } else {
        expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]'));
      }
    } finally { unsubscribe(); }
  } finally { later.remove(); await h.cleanup(); }
});

it("keeps a later control when source validation resumes into draft-open notification", async () => {
  const h = await setup("split", true);
  const { openCompose, composeFocusPending } = await import("~/lib/compose");
  const { gate, deferred } = await import("./draft-presentation-r1-harness");
  const waiting = deferred<{ threadId: number; accountId: number }>();
  const later = document.createElement("button"); document.body.append(later);
  let triggered = false, opening: Promise<void> | undefined;
  try {
    await act(async () => { h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: true, uiState: "collapsed" }); });
    gate.call.mockImplementation((method: string) => method === "drafts.sourceContext" ? waiting.promise : Promise.resolve({}));
    h.other.focus();
    const off = h.drafts.useDrafts.subscribe((state, previous) => {
      if (!triggered && previous.drafts[h.key]?.uiState === "collapsed" && state.drafts[h.key]?.uiState === "open") { triggered = true; later.focus(); }
    });
    try {
      await act(async () => { opening = openCompose("reply", 7); });
      expect(gate.call).toHaveBeenCalledWith("drafts.sourceContext", { messageId: 3 });
      await act(async () => { waiting.resolve({ threadId: 7, accountId: 1 }); await opening; });
      expect(triggered).toBe(true);
      for (let i = 0; i < 4; i++) await h.flush();
      expect(document.activeElement).toBe(later);
      expect(h.app.getApp().draftFocus).toBeNull(); expect(composeFocusPending(7)).toBe(false);
    } finally { off(); }
  } finally { waiting.resolve({ threadId: 7, accountId: 1 }); if (opening) await opening; later.remove(); await h.cleanup(); }
});
