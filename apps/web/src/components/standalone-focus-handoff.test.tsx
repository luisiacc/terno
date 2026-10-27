// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import { setup, gate } from "./draft-presentation-r1-harness";

it.each(["stay", "move", "round trip"] as const)("transfers an expired draft to standalone while preserving focus choice: %s", async (scenario) => {
  const h = await setup("split", true);
  const { openCompose, composeFocusPending } = await import("~/lib/compose");
  const later = document.createElement("button"); document.body.append(later);
  let triggered = false;
  try {
    await act(async () => { h.drafts.expireDraftPresentation(7); });
    expect(h.drafts.useDrafts.getState().drafts[h.key]?.presentationExpired).toBe(true);
    gate.call.mockImplementation(async (method: string) => method === "drafts.sourceContext" ? null : {});
    h.other.focus();
    const off = h.drafts.useDrafts.subscribe((state, previous) => {
      if (!triggered && (state.drafts[h.key]?.presentationEpoch ?? 0) > (previous.drafts[h.key]?.presentationEpoch ?? 0)) {
        triggered = true;
        if (scenario !== "stay") { later.focus(); if (scenario === "round trip") h.other.focus(); }
      }
    });
    try {
      await act(async () => { await openCompose("forward", 7); });
      expect(triggered).toBe(true);
      for (let i = 0; i < 15; i++) await h.flush();
      if (scenario === "stay") {
        expect(h.app.getApp().compose?.key).toBe(h.key);
        expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-to"]'));
      } else {
        expect(document.activeElement).toBe(scenario === "move" ? later : h.other);
        expect(h.app.getApp().draftFocus).toBeNull();
        expect(composeFocusPending(7)).toBe(false);
      }
      expect(h.drafts.useDrafts.getState().drafts[h.key]?.bodyText).toBe("exact authored work");
    } finally { off(); }
  } finally { later.remove(); await h.cleanup(); }
});

it("does not let a standalone transfer replace a newer compose intent during invalidation", async () => {
  const h = await setup("split", true);
  const { openCompose } = await import("~/lib/compose");
  let newer: Promise<void> | undefined, triggered = false;
  try {
    await act(async () => h.drafts.expireDraftPresentation(7));
    gate.call.mockImplementation(async (method: string) => method === "drafts.sourceContext" ? null : {});
    h.other.focus();
    const off = h.drafts.useDrafts.subscribe((state, previous) => {
      if (!triggered && (state.drafts[h.key]?.presentationEpoch ?? 0) > (previous.drafts[h.key]?.presentationEpoch ?? 0)) {
        triggered = true; newer = openCompose("new", null);
      }
    });
    try {
      await act(async () => { await openCompose("forward", 7); if (newer) await newer; });
      expect(triggered).toBe(true);
      expect(h.app.getApp().compose?.key).toBeDefined();
      expect(h.app.getApp().compose?.key).not.toBe(h.key);
      for (let i = 0; i < 15; i++) await h.flush();
      expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-to"]'));
      expect(h.drafts.useDrafts.getState().drafts[h.key]?.bodyText).toBe("exact authored work");
    } finally { off(); }
  } finally { if (newer) await newer; await h.cleanup(); }
});

it.each(["stay", "move", "round trip"] as const)("preserves an unleased off-selection transfer's focus choice: %s", async (scenario) => {
  const h = await setup("split", true);
  const { openCompose } = await import("~/lib/compose");
  const later = document.createElement("button"); document.body.append(later);
  let triggered = false;
  try {
    await act(async () => { h.drafts.expireDraftPresentation(7); h.app.setApp({ selectedId: 8 }); });
    gate.call.mockImplementation(async (method: string) => method === "drafts.sourceContext" ? null : {});
    h.other.focus();
    const off = h.drafts.useDrafts.subscribe((state, previous) => {
      if (!triggered && (state.drafts[h.key]?.presentationEpoch ?? 0) > (previous.drafts[h.key]?.presentationEpoch ?? 0)) {
        triggered = true;
        if (scenario !== "stay") { later.focus(); if (scenario === "round trip") h.other.focus(); }
      }
    });
    try {
      await act(async () => { await openCompose("forward", 7); });
      expect(triggered).toBe(true);
      for (let i = 0; i < 15; i++) await h.flush();
      if (scenario === "stay") {
        expect(h.app.getApp().compose?.key).toBe(h.key);
        expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-to"]'));
      } else {
        expect(document.activeElement).toBe(scenario === "round trip" ? h.other : later);
        expect(h.app.getApp().draftFocus).toBeNull();
      }
    } finally { off(); }
  } finally { later.remove(); await h.cleanup(); }
});

it("notifies a deferred Reader when acquisition stops on a release-time focus choice", async () => {
  const h = await setup("split", true);
  const { openCompose, subscribeComposeFocus } = await import("~/lib/compose");
  const later = document.createElement("button"); document.body.append(later);
  const notices: boolean[] = [];
  const unsubscribe = subscribeComposeFocus((threadId, fallback) => { if (threadId === 7) notices.push(fallback); });
  let triggered = false;
  try {
    await act(async () => h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "collapsed" }));
    h.other.focus();
    await act(async () => {
      void openCompose("reply", 7);
      const off = h.app.useApp.subscribe((state, previous) => {
        if (!triggered && previous.draftFocus && !state.draftFocus) { triggered = true; off(); later.focus(); }
      });
      void openCompose("reply", 7); off();
    });
    expect(triggered).toBe(true);
    expect(notices).toEqual([false]);
    await h.flush(); expect(document.activeElement).toBe(later);
  } finally { unsubscribe(); later.remove(); await h.cleanup(); }
});
