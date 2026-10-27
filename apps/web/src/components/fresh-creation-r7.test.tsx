// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import { setup } from "./draft-presentation-r1-harness";

it.each(["replace", "ordinary"] as const)("fresh Reply respects creation publication: %s", async (scenario) => {
  const h = await setup("split", true), { openCompose, composeFocusPending } = await import("~/lib/compose");
  let created = "", triggered = false;
  try {
    await act(async () => h.drafts.forgetDraft(h.key)); h.other.focus();
    expect(h.drafts.shownDraftKey(h.drafts.useDrafts.getState().drafts, 7, null)).toBeNull();
    const off = h.drafts.useDrafts.subscribe((s, prev) => {
      const key = Object.keys(s.drafts).find((k) => !prev.drafts[k]);
      if (!triggered && key) { triggered = true; created = key; if (scenario === "replace") h.drafts.editDraft(key, { inReplyToMessageId: 4, threadId: null, showSourceContext: false, bodyText: "later work", bodyHtml: "<p>later work</p>", toText: "later@example.test" }); }
    });
    try {
      await act(async () => { await openCompose("reply", 7); });
      expect(triggered).toBe(true); expect(created).not.toBe("");
      if (scenario === "replace") { expect(h.drafts.materialize(created)).toMatchObject({ inReplyToMessageId: 4, bodyText: "later work", bodyHtml: "<p>later work</p>", toText: "later@example.test" }); expect(h.app.getApp().draftFocus).toBeNull(); expect(composeFocusPending(7)).toBe(false); }
      else { for (let i = 0; i < 5; i++) await h.flush(); expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]')); }
    } finally { off(); }
  } finally { await h.cleanup(); }
});
