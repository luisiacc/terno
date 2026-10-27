// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import { setup, gate, deferred } from "./draft-presentation-r1-harness";

it.each(["hold round trip", "hold during collapse", "ordinary"] as const)("collapse move respects transient hold: %s", async (scenario) => {
  const h = await setup("split", true), save = deferred<void>(); let release: (() => void) | null = null, off = () => {};
  try {
    h.drafts.setDraftTransport(async (_method, p) => { await save.promise; return { ...(p as object), id: 81, generation: "stable", revision: 5, updatedAt: 0 }; });
    await act(async () => h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "open" }));
    let observedHold = false;
    off = h.drafts.useDrafts.subscribe((state, previous) => { if (scenario === "hold during collapse" && !observedHold && previous.drafts[h.key]?.uiState === "open" && state.drafts[h.key]?.uiState === "collapsed") { observedHold = true; const done = h.drafts.acquireDraftHold(); expect(done).not.toBeNull(); done!(); } });
    const body = h.host.querySelector<HTMLElement>('[data-testid="compose-body"]') ?? h.host.querySelector<HTMLElement>('[data-testid="compose-body-loading"]'); expect(body).not.toBeNull(); body!.focus();
    await act(async () => body!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    if (scenario === "hold round trip") { await act(async () => { release = h.drafts.acquireDraftHold(); expect(release).not.toBeNull(); expect(h.drafts.draftEditsHeld()).toBe(true); (release as () => void)(); release = null; }); }
    off();
    if (scenario === "hold during collapse") expect(observedHold).toBe(true);
    await h.flush();
    if (scenario === "ordinary") expect(document.activeElement).toBe(h.host.querySelector('[data-testid="draft-collapsed"]'));
    else expect(document.activeElement).not.toBe(h.host.querySelector('[data-testid="draft-collapsed"]'));
    expect(h.drafts.useDrafts.getState().drafts[h.key]).toMatchObject({ id: 81, generation: "stable", bodyText: "exact authored work" });
  } finally { off(); if (release) (release as () => void)(); save.resolve(); await act(async () => { await h.drafts.flushDraft(h.key); }); h.drafts.setDraftTransport((method, p) => gate.call(method, p)); await h.cleanup(); }
});
