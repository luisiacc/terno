// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import type { ThreadSummary } from "@terno/core";
import { setup } from "./draft-presentation-r1-harness";

it.each([["split", "fresh", true], ["split", "fresh", false], ["split", "saved", true], ["split", "saved", false], ["list", "fresh", true], ["list", "fresh", false], ["list", "saved", true], ["list", "saved", false]] as const)("%s %s Reply preserves pre-effect selection intent (key=%s)", async (layout, kind, key) => {
  const h = await setup(layout, true);
  const { useList } = await import("~/state/list");
  const list = useList.getState(); let hits = 0, published: string | undefined;
  try {
    if (kind === "fresh") await act(async () => { h.drafts.forgetDraft(h.key); });
    const row = { id: 7, lastDate: 1, categoryIds: [], unread: false } as unknown as ThreadSummary;
    await act(async () => { useList.setState({ items: [row], index: new Map([[7, 0]]), nextCursor: null }); });
    const button = h.host.querySelector<HTMLButtonElement>('[data-testid="action-reply"]')!; expect(button).not.toBeNull();
    await act(async () => { button.focus(); }); expect(document.activeElement).toBe(button);
    const before = h.app.getSelectionWriteRevision();
    const off = h.app.useApp.subscribe((state, previous) => {
      if (!hits && state.draftFocus && state.draftFocus !== previous.draftFocus) {
        hits++; published = state.draftFocus.key;
        if (key) button.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true, cancelable: true }));
      }
    });
    try { await act(async () => { button.click(); await Promise.resolve(); }); }
    finally { off(); }
    expect(hits).toBe(1); expect(h.app.getApp().selectedId).toBe(7);
    expect(h.app.getSelectionWriteRevision()).toBe(before + 1 + (key ? 1 : 0));
    expect(published).toBeDefined();
    if (kind === "saved") { expect(published).toBe(h.key); expect(h.drafts.useDrafts.getState().drafts[h.key]!.bodyText).toBe("exact authored work"); }
    for (let i = 0; i < 4; i++) await h.flush();
    if (key) expect(document.activeElement).toBe(button);
    else expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]'));
  } finally { await act(async () => { useList.setState(list, true); }); await h.cleanup(); }
});

it.each(["passive same selection", "ownerless"] as const)("keeps %s focus eligible", async (scenario) => {
  const h = await setup("split", true), { openCompose, focusDraft } = await import("~/lib/compose");
  try {
    h.other.focus();
    if (scenario === "ownerless") {
      await act(async () => { h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "open" }); });
      await act(async () => focusDraft(h.key, "body"));
    } else {
      const revision = h.app.getSelectionWriteRevision(); let hit = false;
      const off = h.app.useApp.subscribe((state, previous) => {
        if (!hit && state.draftFocus && state.draftFocus !== previous.draftFocus) { hit = true; h.app.setListAutoSelection(7); }
      });
      try { await act(async () => { await openCompose("reply", 7); }); } finally { off(); }
      expect(hit).toBe(true); expect(h.app.getSelectionWriteRevision()).toBe(revision + 1);
    }
    for (let i = 0; i < 4; i++) await h.flush();
    expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]'));
  } finally { await h.cleanup(); }
});

it("a later deliberate Reply still focuses after a stale pre-effect request", async () => {
  const h = await setup("split", true), { useList } = await import("~/state/list"), list = useList.getState(); let hit = false;
  try {
    const row = { id: 7, lastDate: 1, categoryIds: [], unread: false } as unknown as ThreadSummary;
    await act(async () => { useList.setState({ items: [row], index: new Map([[7, 0]]), nextCursor: null }); });
    const button = h.host.querySelector<HTMLButtonElement>('[data-testid="action-reply"]')!;
    await act(async () => { button.focus(); });
    const off = h.app.useApp.subscribe((state, previous) => {
      if (!hit && state.draftFocus && state.draftFocus !== previous.draftFocus) { hit = true; button.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true, cancelable: true })); }
    });
    try { await act(async () => { button.click(); await Promise.resolve(); }); } finally { off(); }
    expect(hit).toBe(true);
    for (let i = 0; i < 4; i++) await h.flush();
    const firstFocus = document.activeElement;
    await act(async () => { button.focus(); button.click(); await Promise.resolve(); });
    for (let i = 0; i < 4; i++) await h.flush();
    expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]'));
    expect(firstFocus).toBe(button);
  } finally { await act(async () => { useList.setState(list, true); }); await h.cleanup(); }
});


it("retires the stale published lease once without Reader fallback", async () => {
  const h = await setup("split", true), { useList } = await import("~/state/list"), { composeFocusPending, subscribeComposeFocus } = await import("~/lib/compose"), list = useList.getState();
  const notifications: Array<[number, boolean]> = []; let triggered = false;
  try {
    const row = { id: 7, lastDate: 1, categoryIds: [], unread: false } as unknown as ThreadSummary;
    await act(async () => { useList.setState({ items: [row], index: new Map([[7, 0]]), nextCursor: null }); });
    const button = h.host.querySelector<HTMLButtonElement>('[data-testid="action-reply"]')!;
    await act(async () => { button.focus(); });
    const stop = subscribeComposeFocus((thread, fallback) => { notifications.push([thread, fallback]); });
    const off = h.app.useApp.subscribe((state, previous) => {
      if (!triggered && state.draftFocus && state.draftFocus !== previous.draftFocus) { triggered = true; button.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true, cancelable: true })); }
    });
    try {
      await act(async () => { button.click(); await Promise.resolve(); });
      expect(triggered).toBe(true);
      for (let i = 0; i < 4; i++) await h.flush();
      expect(h.app.getApp().draftFocus).toBeNull(); expect(composeFocusPending(7)).toBe(false);
      expect(notifications).toEqual([[7, false]]); expect(document.activeElement).toBe(button);
    } finally { off(); stop(); }
  } finally { await act(async () => { useList.setState(list, true); }); await h.cleanup(); }
});
