// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import type { ThreadDetail } from "@terno/core";
import { setup, gate, deferred } from "./draft-presentation-r1-harness";

it.each(["ordinary", "successor", "completed successor"] as const)("exact lease completion permits only a current placement: %s", async (scenario) => {
  const h = await setup("split", true), waiting = deferred<ThreadDetail>();
  const { openCompose, finishComposeFocus, subscribeComposeFocus, composeFocusPending } = await import("~/lib/compose");
  let newer: Promise<void> | undefined, triggered = false;
  try {
    await act(async () => h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "collapsed" }));
    h.other.focus(); gate.load.mockReturnValue(waiting.promise);
    const captured: { request: ReturnType<typeof h.app.getApp>["draftFocus"] } = { request: null };
    const capture = h.app.useApp.subscribe((state) => { if (state.draftFocus?.key === h.key) captured.request = state.draftFocus; });
    try { await act(async () => { void openCompose("reply", 7); }); } finally { capture(); }
    expect(captured.request).not.toBeNull();
    const sequence = captured.request!.seq;
    const off = subscribeComposeFocus(() => { if (scenario !== "ordinary" && !triggered) { triggered = true; newer = openCompose(scenario === "successor" ? "forward" : "reply", 7); if (scenario === "completed successor") { const latest = h.app.getApp().draftFocus; expect(latest).not.toBeNull(); expect(finishComposeFocus(h.key, latest!.seq, false)).toBe(true); } } });
    try {
      let allowed = false;
      await act(async () => { allowed = finishComposeFocus(h.key, sequence, false); });
      expect(allowed).toBe(scenario === "ordinary");
      if (scenario !== "ordinary") { expect(triggered).toBe(true); expect(composeFocusPending(7)).toBe(scenario === "successor"); }
      expect(finishComposeFocus(h.key, sequence, false)).toBe(false);
    } finally { off(); }
  } finally { waiting.resolve(h.detail); if (newer) await newer; await h.cleanup(); }
});
