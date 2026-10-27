// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import { setup } from "./draft-presentation-r1-harness";

it.each(["round trip", "ordinary"] as const)("stored navigation preserves nested selection choice: %s", async (scenario) => {
  const h = await setup("split", true), { openStoredDraft, composeFocusPending } = await import("~/lib/compose"), { pressRow } = await import("~/lib/select");
  let triggered = false;
  try {
    h.other.focus();
    const off = h.app.useApp.subscribe((state, previous) => {
      if (!triggered && state.checked !== previous.checked && state.readerOpen && state.selectedId === 7) {
        triggered = true;
        if (scenario === "round trip") {
          pressRow(8, { shift: false, meta: false, ctrl: false });
          pressRow(7, { shift: false, meta: false, ctrl: false });
        }
      }
    });
    try {
      await act(async () => { await openStoredDraft(h.key); });
      expect(triggered).toBe(true);
      if (scenario === "round trip") {
        expect(h.app.getApp().draftFocus).toBeNull();
        expect(composeFocusPending(7)).toBe(false);
      } else {
        for (let i = 0; i < 5; i++) await h.flush();
        expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]'));
      }
      expect(h.drafts.materialize(h.key)?.bodyText).toBe("exact authored work");
    } finally { off(); }
  } finally { await h.cleanup(); }
});
