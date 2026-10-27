// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import type { ThreadSummary } from "@terno/core";
import { setup } from "./draft-presentation-r1-harness";

it.each([["split", true], ["split", false], ["list", true], ["list", false]] as const)("%s queued Reply respects clamped selection intent (move=%s)", async (layout, move) => {
  const h = await setup(layout, true);
  const { openCompose } = await import("~/lib/compose"), { useList } = await import("~/state/list");
  const previous = useList.getState();
  try {
    const row = { id: 7, lastDate: 1, categoryIds: [], unread: false } as unknown as ThreadSummary;
    await act(async () => { useList.setState({ items: [row], index: new Map([[7, 0]]), nextCursor: null }); });
    h.other.focus();
    await act(async () => { await openCompose("reply", 7); });
    expect(h.app.getApp().selectedId).toBe(7);
    const revision = h.app.getSelectionWriteRevision();
    if (move) await act(async () => { h.other.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true, cancelable: true })); });
    expect(h.app.getSelectionWriteRevision()).toBe(revision + (move ? 1 : 0));
    for (let i = 0; i < 4; i++) await h.flush();
    if (move) {
      expect(document.activeElement).toBe(h.other);
      await act(async () => { await openCompose("reply", 7); });
      for (let i = 0; i < 4; i++) await h.flush();
    }
    expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]'));
  } finally { await act(async () => { useList.setState(previous, true); }); await h.cleanup(); }
});

