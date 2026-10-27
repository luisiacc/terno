// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import type { ThreadDetail } from "@terno/core";
import { setup, gate, deferred } from "./draft-presentation-r1-harness";

it("does not let an older new-message publication cover a successor started by draft creation", async () => {
  const h = await setup("split", true), waiting = deferred<ThreadDetail>();
  const { openCompose, composeFocusPending } = await import("~/lib/compose");
  let newer: Promise<void> | undefined, triggered = false;
  try {
    gate.load.mockReturnValue(waiting.promise); h.other.focus();
    const off = h.drafts.useDrafts.subscribe((state, previous) => {
      if (!triggered && Object.keys(state.drafts).length > Object.keys(previous.drafts).length) {
        triggered = true; newer = openCompose("forward", 7);
      }
    });
    try {
      await act(async () => { await openCompose("new", null); });
      expect(triggered).toBe(true); expect(newer).toBeDefined();
      expect(h.app.getApp().compose).toBeNull();
      expect(composeFocusPending(7)).toBe(true);
      await act(async () => { gate.load.mockResolvedValue(h.detail); waiting.resolve(h.detail); await newer; });
      for (let i = 0; i < 5; i++) await h.flush();
      expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-to"]'));
    } finally { off(); }
  } finally { waiting.resolve(h.detail); if (newer) await newer; await h.cleanup(); }
});

it("opens a new message when draft creation has no successor", async () => {
  const h = await setup("split", true);
  const { openCompose } = await import("~/lib/compose");
  try {
    h.other.focus(); await act(async () => { await openCompose("new", null); });
    expect(h.app.getApp().compose?.key).toBeDefined();
    for (let i = 0; i < 15; i++) await h.flush();
    expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-to"]'));
  } finally { await h.cleanup(); }
});
