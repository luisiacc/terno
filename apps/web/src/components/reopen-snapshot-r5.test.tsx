// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import { setup } from "./draft-presentation-r1-harness";

it.each(["saved", "unsaved", "saving", "open"] as const)("same-mode open preserves valid %s UI delta", async (scenario) => {
  const h = await setup("split", true), { openCompose } = await import("~/lib/compose");
  try {
    await act(async () => {
      h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: scenario === "open" ? "open" : "collapsed" });
      h.drafts.useDrafts.setState((s) => ({ drafts: { ...s.drafts, [h.key]: { ...s.drafts[h.key]!, ...(scenario === "unsaved" ? { id: null } : {}), ...(scenario === "saving" ? { status: "saving" as const } : {}) } } }));
    });
    const before = h.drafts.materialize(h.key)!; h.other.focus();
    await act(async () => { await openCompose("reply", 7); });
    const after = h.drafts.materialize(h.key)!;
    expect(after.uiState).toBe("open");
    expect(after.localRev).toBe(before.localRev + (scenario !== "open" && before.id !== null ? 1 : 0));
    if (scenario === "saving") expect(after.status).toBe("saving");
    for (let i = 0; i < 5; i++) await h.flush();
    expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]'));
  } finally { await h.cleanup(); }
});
