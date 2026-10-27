// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import { setup } from "./draft-presentation-r1-harness";

for (const fallback of [false, true]) it.each(["ownerless", "hold", "hold roundtrip", "ordinary"] as const)(`completion fallback ${fallback} rejects later %s`, async (scenario) => {
  const h = await setup("split", true), { openCompose, focusDraft, finishComposeFocus, subscribeComposeFocus } = await import("~/lib/compose");
  let release: (() => void) | null = null, triggered = false, nextSeq: number | undefined;
  try {
    await act(async () => h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "collapsed" }));
    h.other.focus(); const captured: { seq: number | null } = { seq: null };
    const capture = h.app.useApp.subscribe((s) => { if (s.draftFocus?.key === h.key) captured.seq = s.draftFocus.seq; });
    try { await act(async () => { await openCompose("reply", 7); }); } finally { capture(); }
    expect(captured.seq).not.toBeNull();
    const old = captured.seq!;
    const off = subscribeComposeFocus(() => {
      if (triggered) return; triggered = true;
      if (scenario === "ownerless") { focusDraft(h.key, "to"); nextSeq = h.app.getApp().draftFocus?.seq; }
      if (scenario === "hold" || scenario === "hold roundtrip") { release = h.drafts.acquireDraftHold(); if (scenario === "hold roundtrip") { expect(release).not.toBeNull(); (release as () => void)(); release = null; } }
    });
    try {
      let allowed = false; await act(async () => { allowed = finishComposeFocus(h.key, old, fallback); if (scenario === "ownerless") expect(h.app.getApp().draftFocus).toMatchObject({ key: h.key, seq: nextSeq, target: "to" }); });
      expect(triggered).toBe(true);
      if (scenario === "ownerless") expect(nextSeq).toBeGreaterThan(old);
      if (scenario === "hold") { expect(release).not.toBeNull(); expect(h.drafts.draftEditsHeld()).toBe(true); }
      expect(allowed).toBe(scenario === "ordinary");
    } finally { off(); if (release) await act(async () => (release as () => void)()); }
  } finally { await h.cleanup(); }
});
