// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import type { ThreadDetail } from "@terno/core";
import { setup, gate, deferred } from "./draft-presentation-r1-harness";

it.each(["ownership", "round trip", "valid"] as const)("preserves reentrant Forward ownership during Reply replacement: %s", async (scenario) => {
  const h = await setup("split", true), waiting = deferred<ThreadDetail>();
  const { openCompose, composeFocusPending } = await import("~/lib/compose");
  const later = document.createElement("button"); document.body.append(later);
  let first: Promise<void> | undefined, second: Promise<void> | undefined, newer: Promise<void> | undefined;
  let triggered = false;
  try {
    await act(async () => h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "collapsed" }));
    h.other.focus(); gate.load.mockReturnValue(waiting.promise);
    await act(async () => {
      first = openCompose("reply", 7);
      expect(h.app.getApp().draftFocus).not.toBeNull();
      const off = h.app.useApp.subscribe((state, previous) => {
        if (!triggered && previous.draftFocus && !state.draftFocus) {
          triggered = true; off(); newer = openCompose("forward", 7);
        }
      });
      second = openCompose("reply", 7);
      off();
      await Promise.all([first, second]);
    });
    expect(triggered).toBe(true); expect(newer).toBeDefined();
    if (scenario === "ownership") expect(composeFocusPending(7)).toBe(true);
    if (scenario === "round trip") { later.focus(); h.other.focus(); }
    await act(async () => { gate.load.mockResolvedValue(h.detail); waiting.resolve(h.detail); await newer; });
    for (let i = 0; i < 5; i++) await h.flush();
    if (scenario === "round trip") {
      expect(document.activeElement).toBe(h.other);
      expect(h.app.getApp().draftFocus).toBeNull(); expect(composeFocusPending(7)).toBe(false);
    } else expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-to"]'));
  } finally { waiting.resolve(h.detail); if (newer) await newer; later.remove(); await h.cleanup(); }
});

it("does not reacquire focus when a release observer chooses another control", async () => {
  const h = await setup("split", true);
  const { openCompose, composeFocusPending } = await import("~/lib/compose");
  const later = document.createElement("button"); document.body.append(later);
  let triggered = false;
  try {
    await act(async () => h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "collapsed" }));
    h.other.focus();
    await act(async () => {
      void openCompose("reply", 7);
      expect(h.app.getApp().draftFocus).not.toBeNull();
      const off = h.app.useApp.subscribe((state, previous) => {
        if (!triggered && previous.draftFocus && !state.draftFocus) { triggered = true; off(); later.focus(); }
      });
      void openCompose("reply", 7); off();
    });
    expect(triggered).toBe(true);
    for (let i = 0; i < 4; i++) await h.flush();
    expect(document.activeElement).toBe(later);
    expect(composeFocusPending(7)).toBe(false); expect(h.app.getApp().draftFocus).toBeNull();
  } finally { later.remove(); await h.cleanup(); }
});
