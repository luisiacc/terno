// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import { setup } from "./draft-presentation-r1-harness";

it.each(["restored account", "publication restored", "ordinary"] as const)("standalone retains transition history: %s", async (scenario) => {
  const h = await setup("split", true), { openStoredDraft, composeFocusPending } = await import("~/lib/compose"), { newFields } = await import("~/lib/compose-fields");
  let key = "", triggered = false, restored = false, published = false;
  try {
    await act(async () => { key = h.drafts.createDraft({ ...newFields(1), bodyText: "saved original", bodyHtml: "<p>saved original</p>" }); h.drafts.useDrafts.setState((s) => ({ drafts: { ...s.drafts, [key]: { ...s.drafts[key]!, id: 82, generation: "stable-standalone", revision: 5, status: "saved" } } })); });
    h.other.focus(); const revision = h.app.getSelectionWriteRevision();
    const restorer = h.app.useApp.subscribe((s, prev) => { if (scenario !== "ordinary" && !restored && prev.accountId === 1 && s.accountId === 2) { restored = true; h.app.setApp({ accountId: 1 }); } });
    const publish = h.app.useApp.subscribe((s) => { if (scenario === "publication restored" && !published && s.compose?.key === key) { published = true; h.app.setApp({ accountId: 2 }); } });
    const off = h.drafts.useDrafts.subscribe((s, prev) => { if (!triggered && (s.drafts[key]?.presentationEpoch ?? 0) > (prev.drafts[key]?.presentationEpoch ?? 0)) { triggered = true; if (scenario === "restored account") h.app.setApp({ accountId: 2 }); } });
    try {
      await act(async () => { await openStoredDraft(key); });
      expect(triggered).toBe(true); expect(restored).toBe(scenario !== "ordinary");
      expect(h.app.getApp()).toMatchObject({ accountId: 1, selectedId: 7 });
      expect(h.app.getSelectionWriteRevision()).toBe(revision + 1);
      expect(h.drafts.materialize(key)).toMatchObject({ id: 82, generation: "stable-standalone", revision: 5, bodyText: "saved original", bodyHtml: "<p>saved original</p>" });
      if (scenario === "ordinary") expect(h.app.getApp().compose?.key).toBe(key);
      else { expect(h.app.getApp().compose).toBeNull(); expect(h.app.getApp().draftFocus).toBeNull(); expect(composeFocusPending(null)).toBe(false); }
    } finally { off(); publish(); restorer(); }
  } finally { await h.cleanup(); }
});
