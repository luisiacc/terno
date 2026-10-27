// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import { setup } from "./draft-presentation-r1-harness";

it.each(["round trip", "same id", "later destination", "publication destination", "ordinary"] as const)("standalone invalidation respects intervening selection: %s", async (scenario) => {
  const h = await setup("split", true), { openStoredDraft, showNewDraft, composeFocusPending } = await import("~/lib/compose"), { pressRow } = await import("~/lib/select"), { newFields } = await import("~/lib/compose-fields");
  let d = "", e = "", triggered = false;
  try {
    await act(async () => { d = h.drafts.createDraft({ ...newFields(1), bodyText: "original standalone" }); e = h.drafts.createDraft({ ...newFields(1), bodyText: "later standalone" }); h.drafts.useDrafts.setState((s) => ({ drafts: { ...s.drafts, [d]: { ...s.drafts[d]!, id: 82, generation: "standalone", revision: 5, status: "saved" } } })); });
    h.other.focus();
    const off = h.drafts.useDrafts.subscribe((state, previous) => {
      if (!triggered && (state.drafts[d]?.presentationEpoch ?? 0) > (previous.drafts[d]?.presentationEpoch ?? 0)) {
        triggered = true;
        if (scenario === "round trip") { pressRow(8, { shift: false, meta: false, ctrl: false }); pressRow(7, { shift: false, meta: false, ctrl: false }); }
        else if (scenario === "same id") pressRow(7, { shift: false, meta: false, ctrl: false });
        else if (scenario === "later destination") showNewDraft(e);
      }
    });
    const offApp = h.app.useApp.subscribe((state) => { if (scenario === "publication destination" && state.compose?.key === d) showNewDraft(e); });
    try {
      await act(async () => { await openStoredDraft(d); });
      expect(triggered).toBe(true);
      expect(h.drafts.materialize(d)).toMatchObject({ id: 82, generation: "standalone", revision: 5, bodyText: "original standalone" }); expect(h.drafts.materialize(e)?.bodyText).toBe("later standalone");
      if (scenario === "ordinary") expect(h.app.getApp().compose?.key).toBe(d);
      else { expect(h.app.getApp().compose?.key ?? null).toBe(scenario === "later destination" || scenario === "publication destination" ? e : null); expect(h.app.getApp().draftFocus).toBeNull(); expect(composeFocusPending(null)).toBe(false); }
    } finally { off(); offApp(); }
  } finally { await h.cleanup(); }
});
