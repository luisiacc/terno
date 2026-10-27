// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import type { ThreadDetail } from "@terno/core";
import { setup, gate, deferred } from "./draft-presentation-r1-harness";

it.each(["successor", "later control", "ordinary"] as const)("collapsed button respects a choice made during its open notification: %s", async (scenario) => {
  const h = await setup("split", true), waiting = deferred<ThreadDetail>();
  const { openCompose, composeFocusPending } = await import("~/lib/compose");
  const later = document.createElement("button"); document.body.append(later);
  let newer: Promise<void> | undefined, triggered = false;
  try {
    await act(async () => h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "collapsed" }));
    const button = h.host.querySelector<HTMLButtonElement>('[data-testid="draft-collapsed"]')!;
    expect(button).not.toBeNull(); button.focus();
    gate.load.mockReturnValue(waiting.promise);
    const off = h.drafts.useDrafts.subscribe((state, previous) => {
      if (!triggered && previous.drafts[h.key]?.uiState === "collapsed" && state.drafts[h.key]?.uiState === "open") {
        triggered = true;
        if (scenario === "successor") newer = openCompose("forward", 7);
        if (scenario === "later control") later.focus();
      }
    });
    try {
      await act(async () => button.click());
      expect(triggered).toBe(true);
      if (scenario === "successor") { expect(newer).toBeDefined(); expect(composeFocusPending(7)).toBe(true); }
      await h.flush();
      if (scenario === "successor") {
        expect(composeFocusPending(7)).toBe(true);
        expect(document.activeElement?.closest('[data-testid="composer"]')).toBeNull();
        await act(async () => { gate.load.mockResolvedValue(h.detail); waiting.resolve(h.detail); await newer; });
        for (let i = 0; i < 5; i++) await h.flush();
        expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-to"]'));
        expect(h.drafts.materialize(h.key)).toMatchObject({ id: 81, generation: "stable", mode: "forward" });
      } else if (scenario === "later control") expect(document.activeElement).toBe(later);
      else expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]'));
      expect(h.drafts.materialize(h.key)?.bodyText).toContain("exact authored work");
    } finally { off(); }
  } finally { waiting.resolve(h.detail); if (newer) await newer; later.remove(); await h.cleanup(); }
});
