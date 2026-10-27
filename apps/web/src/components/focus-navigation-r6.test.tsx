// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import { setup } from "./draft-presentation-r1-harness";

for (const fallback of [false, true]) it.each(["departure", "round trip", "same id", "ordinary"] as const)(`completion fallback ${fallback} declines placement after navigation: %s`, async (scenario) => {
  const h = await setup("split", true), { openCompose, finishComposeFocus, subscribeComposeFocus } = await import("~/lib/compose"), { pressRow } = await import("~/lib/select");
  let triggered = false;
  try {
    await act(async () => h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "collapsed" }));
    h.other.focus(); const captured: { seq: number | null } = { seq: null };
    const offCapture = h.app.useApp.subscribe((s) => { if (s.draftFocus?.key === h.key) captured.seq = s.draftFocus.seq; });
    try { await act(async () => { void openCompose("reply", 7); }); } finally { offCapture(); }
    expect(captured.seq).not.toBeNull();
    const off = subscribeComposeFocus(() => { if (!triggered) { triggered = true; if (scenario === "departure" || scenario === "round trip") { pressRow(8, { shift: false, meta: false, ctrl: false }); if (scenario === "round trip") pressRow(7, { shift: false, meta: false, ctrl: false }); } else if (scenario === "same id") pressRow(7, { shift: false, meta: false, ctrl: false }); } });
    try {
      let allowed = false; await act(async () => { allowed = finishComposeFocus(h.key, captured.seq!, fallback); });
      expect(triggered).toBe(true); expect(allowed).toBe(scenario === "ordinary");
    } finally { off(); }
  } finally { await h.cleanup(); }
});
