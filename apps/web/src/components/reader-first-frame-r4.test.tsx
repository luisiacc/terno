// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import type { ThreadDetail } from "@terno/core";
import { setup, gate, deferred } from "./draft-presentation-r1-harness";

it.each([false, true])("preserves an outside choice before Reader's first frame (round trip: %s)", async (roundTrip) => {
  const h = await setup("list"), waiting = deferred<ThreadDetail>();
  const { composeFocusPending } = await import("~/lib/compose");
  const later = document.createElement("button"); document.body.append(later);
  try {
    await act(async () => { h.drafts.forgetDraft(h.key); h.app.setApp({ selectedId: 7, readerOpen: false }); });
    h.other.focus(); gate.load.mockReturnValue(waiting.promise);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true })));
    expect(h.host.querySelector('[data-testid="reader"]')).not.toBeNull();
    expect(composeFocusPending(7)).toBe(true);
    later.focus(); if (roundTrip) h.other.focus();
    await h.flush();
    expect(document.activeElement).toBe(roundTrip ? h.other : later);
    await act(async () => { h.useThreads.setState({ details: new Map([[7, h.detail]]) }); waiting.resolve(h.detail); });
    for (let i = 0; i < 3; i++) await h.flush();
    expect(document.activeElement).toBe(roundTrip ? h.other : later);
    expect(composeFocusPending(7)).toBe(false); expect(h.app.getApp().draftFocus).toBeNull();
  } finally { waiting.resolve(h.detail); later.remove(); await h.cleanup(); }
});

it("focuses Reader on an ordinary list-page open", async () => {
  const h = await setup("list"), { openThread } = await import("~/lib/page");
  try {
    await act(async () => { h.app.setApp({ selectedId: 7, readerOpen: false }); openThread(7); });
    await h.flush();
    expect(document.activeElement).toBe(h.host.querySelector('[data-testid="reader"]'));
  } finally { await h.cleanup(); }
});
