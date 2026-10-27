// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import type { ThreadDetail } from "@terno/core";
import { setup, gate, deferred } from "./draft-presentation-r1-harness";

it.each(["successor", "ordinary"] as const)("collapse exit respects a later request: %s", async (scenario) => {
  const h = await setup("split", true), waiting = deferred<ThreadDetail>(), save = deferred<void>(), { openCompose, composeFocusPending } = await import("~/lib/compose");
  let newer: Promise<void> | undefined, triggered = false;
  try {
    await act(async () => h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "open" }));
    h.drafts.setDraftTransport(async (_method, params) => { await save.promise; return { ...(params as object), id: 81, generation: "stable", revision: 5, updatedAt: 0 }; });
    gate.load.mockReturnValue(waiting.promise);
    const off = h.drafts.useDrafts.subscribe((state, previous) => {
      if (!triggered && previous.drafts[h.key]?.uiState === "open" && state.drafts[h.key]?.uiState === "collapsed") { triggered = true; if (scenario === "successor") newer = openCompose("forward", 7); }
    });
    try {
      const body = h.host.querySelector<HTMLElement>('[data-testid="compose-body"]') ?? h.host.querySelector<HTMLElement>('[data-testid="compose-body-loading"]'); expect(body).not.toBeNull(); body!.focus();
      await act(async () => body!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
      expect(triggered).toBe(true);
      if (scenario === "successor") { expect(newer).toBeDefined(); expect(composeFocusPending(7)).toBe(true); }
      await h.flush();
      if (scenario === "successor") {
        expect(composeFocusPending(7)).toBe(true);
        await act(async () => { gate.load.mockResolvedValue(h.detail); waiting.resolve(h.detail); await newer; });
        for (let i = 0; i < 5; i++) await h.flush();
        expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-to"]'));
        expect(h.drafts.materialize(h.key)).toMatchObject({ id: 81, generation: "stable", mode: "forward", bodyText: "exact authored work" });
      } else expect(document.activeElement).toBe(h.host.querySelector('[data-testid="draft-collapsed"]'));
    } finally { off(); }
  } finally { waiting.resolve(h.detail); if (newer) await newer; save.resolve(); await h.drafts.flushDraft(h.key); h.drafts.setDraftTransport((method, params) => gate.call(method, params)); await h.cleanup(); }
});
