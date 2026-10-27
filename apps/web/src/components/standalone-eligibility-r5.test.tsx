// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import { setup, gate } from "./draft-presentation-r1-harness";

it.each(["edit", "leave"] as const)("a later %s cancels initially collapsed standalone focus", async (scenario) => {
  const h = await setup("split", true);
  const { openStoredDraft, composeFocusPending } = await import("~/lib/compose");
  const { newFields } = await import("~/lib/compose-fields");
  try {
    let key = "";
    await act(async () => {
      key = h.drafts.createDraft({ ...newFields(1), bodyText: "retained", uiState: "collapsed" });
      h.drafts.useDrafts.setState((s) => ({ drafts: { ...s.drafts, [key]: { ...s.drafts[key]!, id: 82, generation: "retained", revision: 4, status: "saved" } } }));
      h.drafts.expireDraftPresentation(7);
    });
    gate.call.mockResolvedValue(null); h.other.focus();
    await act(async () => { await openStoredDraft(key); });
    const seq = h.app.getApp().compose?.storedFocusSeq;
    expect(seq).toBeDefined(); expect(composeFocusPending(null, key, seq)).toBe(true);
    if (scenario === "edit") await act(async () => { h.drafts.editDraft(key, { bodyText: "later edit" }); });
    else await act(async () => { h.host.querySelector<HTMLElement>('[data-testid="compose-to"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(composeFocusPending(null, key, seq)).toBe(false);
    for (let i = 0; i < 5; i++) await h.flush();
    if (scenario === "edit") expect(document.activeElement).toBe(h.other);
    else expect(h.app.getApp().compose).toBeNull();
    expect(h.drafts.materialize(key)?.bodyText).toBe(scenario === "edit" ? "later edit" : "retained");
  } finally { await h.cleanup(); }
});
