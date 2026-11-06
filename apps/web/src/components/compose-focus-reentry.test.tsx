// @vitest-environment jsdom
// Who owns focus when something else happens during compose's own publication: a successor, a later control, a hold.
import type { ThreadDetail, ThreadSummary } from "@terno/core";
import { StrictMode, act } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { deferred, gate, setup } from "./app-harness";

describe("collapse and a transient hold", () => {
  it.each(["hold round trip", "hold during collapse", "ordinary"] as const)("collapse move respects transient hold: %s", async (scenario) => {
    const h = await setup("split", true), save = deferred<void>(); let release: (() => void) | null = null, off = () => {};
    try {
      h.drafts.setDraftTransport(async (_method, p) => { await save.promise; return { ...(p as object), id: 81, generation: "stable", revision: 5, updatedAt: 0 }; });
      await act(async () => h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "open" }));
      let observedHold = false;
      off = h.drafts.useDrafts.subscribe((state, previous) => { if (scenario === "hold during collapse" && !observedHold && previous.drafts[h.key]?.uiState === "open" && state.drafts[h.key]?.uiState === "collapsed") { observedHold = true; const done = h.drafts.acquireDraftHold(); expect(done).not.toBeNull(); done!(); } });
      const body = h.host.querySelector<HTMLElement>('[data-testid="compose-body"]'); expect(body).not.toBeNull(); body!.focus();
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
});

describe("reopening a collapsed draft", () => {
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
        else expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]'));
        expect(h.drafts.materialize(h.key)?.bodyText).toContain("exact authored work");
      } finally { off(); }
    } finally { waiting.resolve(h.detail); if (newer) await newer; later.remove(); await h.cleanup(); }
  });
});

describe("completion against a later request", () => {
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
});

describe("exact lease completion", () => {
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
});

describe("completion after navigation", () => {
  for (const fallback of [false, true]) it.each(["departure", "round trip", "same id", "ordinary"] as const)(`completion fallback ${fallback} declines placement after navigation: %s`, async (scenario) => {
    const h = await setup("split", true), { openCompose, finishComposeFocus, subscribeComposeFocus } = await import("~/lib/compose"), { pressRow } = await import("~/lib/select");
    let triggered = false;
    try {
      await act(async () => h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "collapsed" }));
      h.other.focus(); const captured: { seq: number | null } = { seq: null };
      const offCapture = h.app.useApp.subscribe((s) => { if (s.draftFocus?.key === h.key) captured.seq = s.draftFocus.seq; });
      try { await act(async () => { void openCompose("reply", 7); }); } finally { offCapture(); }
      expect(captured.seq).not.toBeNull();
      const off = subscribeComposeFocus(() => { if (!triggered) { triggered = true; if (scenario === "departure" || scenario === "round trip") { pressRow(8, { shift: false, meta: false, ctrl: false }); if (scenario === "round trip") pressRow(7, { shift: false, meta: false, ctrl: false }); } else if (scenario === "same id") pressRow(7, { shift: false, meta: false, ctrl: false }); } });
      try {
        let allowed = false; await act(async () => { allowed = finishComposeFocus(h.key, captured.seq!, fallback); });
        expect(triggered).toBe(true); expect(allowed).toBe(scenario === "ordinary");
      } finally { off(); }
    } finally { await h.cleanup(); }
  });
});

describe("focus publication", () => {
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
      else expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]'));
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
      expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]'));
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
      expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]'));
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
});

describe("focus scheduler", () => {
  it("a successful public inline lease completion retires the exact lease", async () => {
    const h = await setup("split", true), { openCompose, composeFocusPending, finishComposeFocus, subscribeComposeFocus } = await import("~/lib/compose");
    let focusSeq: number | undefined, notifications = 0;
    try {
      await act(async () => { h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "open" }); h.other.focus(); });
      const before = h.drafts.useDrafts.getState().drafts[h.key]!;
      const offApp = h.app.useApp.subscribe((state) => { if (state.draftFocus?.key === h.key) focusSeq = state.draftFocus.seq; });
      const offLease = subscribeComposeFocus((thread, fallback) => { expect(thread).toBe(7); expect(fallback).toBe(false); notifications++; });
      try {
        await act(async () => { await openCompose("reply", 7); });
        expect(focusSeq).toBeDefined(); expect(composeFocusPending(7, h.key, focusSeq)).toBe(true);
        let completed = false;
        await act(async () => { completed = finishComposeFocus(h.key, focusSeq!, false); });
        expect(completed).toBe(true); expect(composeFocusPending(7, h.key, focusSeq)).toBe(false); expect(notifications).toBe(1);
        expect(h.drafts.useDrafts.getState().drafts[h.key]!.bodyText).toBe(before.bodyText);
        expect(h.drafts.useDrafts.getState().drafts[h.key]!.toText).toBe(before.toText);
      } finally { offApp(); offLease(); }
    } finally { await h.cleanup(); }
  });

  it("a reentrant ownerless successor retains its key listener after older preparation", async () => {
    const h = await setup("split", true), { openCompose, focusDraft, composeFocusPending, subscribeComposeFocus } = await import("~/lib/compose");
    const add = vi.spyOn(document, "addEventListener"), remove = vi.spyOn(document, "removeEventListener");
    let triggered = false, successorSeq: number | undefined;
    try {
      await act(async () => { h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "open" }); h.other.focus(); });
      const before = h.drafts.useDrafts.getState().drafts[h.key]!;
      await act(async () => { await openCompose("reply", 7); });
      expect(composeFocusPending(7)).toBe(true);
      const keyListeners = add.mock.calls.filter(([type, , capture]) => type === "keydown" && capture === true);
      expect(keyListeners.length).toBeGreaterThan(0);
      const handler = keyListeners.at(-1)![1];
      const offApp = h.app.useApp.subscribe((state) => { if (state.draftFocus?.key === h.key && state.draftFocus.target === "to") successorSeq = state.draftFocus.seq; });
      const offLease = subscribeComposeFocus(() => {
        if (triggered) return;
        triggered = true; focusDraft(h.key, "to"); flushSync(() => {});
      });
      try {
        await act(async () => { focusDraft(h.key, "body"); });
        expect(triggered).toBe(true); expect(successorSeq).toBeDefined(); expect(h.app.getApp().draftFocus).toBeNull();
        const changes = [
          ...add.mock.calls.map((call, i) => ({ call, order: add.mock.invocationCallOrder[i]!, active: true })),
          ...remove.mock.calls.map((call, i) => ({ call, order: remove.mock.invocationCallOrder[i]!, active: false })),
        ].filter(({ call }) => call[0] === "keydown" && call[1] === handler && call[2] === true).sort((a, b) => a.order - b.order);
        expect(changes.length).toBeGreaterThanOrEqual(3); expect(changes.at(-1)?.active).toBe(true);
        expect(h.drafts.useDrafts.getState().drafts[h.key]!.bodyText).toBe(before.bodyText);
        expect(h.drafts.useDrafts.getState().drafts[h.key]!.toText).toBe(before.toText);
        for (let i = 0; i < 4; i++) await h.flush();
        expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-to"]'));
      } finally { offApp(); offLease(); }
    } finally { add.mockRestore(); remove.mockRestore(); await h.cleanup(); }
  });
});

describe("a fresh Reply", () => {
  it.each(["replace", "ordinary"] as const)("fresh Reply respects creation publication: %s", async (scenario) => {
    const h = await setup("split", true), { openCompose, composeFocusPending } = await import("~/lib/compose");
    let created = "", triggered = false;
    try {
      await act(async () => h.drafts.forgetDraft(h.key)); h.other.focus();
      expect(h.drafts.shownDraftKey(h.drafts.useDrafts.getState().drafts, 7, null)).toBeNull();
      const off = h.drafts.useDrafts.subscribe((s, prev) => {
        const key = Object.keys(s.drafts).find((k) => !prev.drafts[k]);
        if (!triggered && key) { triggered = true; created = key; if (scenario === "replace") h.drafts.editDraft(key, { inReplyToMessageId: 4, threadId: null, showSourceContext: false, bodyText: "later work", bodyHtml: "<p>later work</p>", toText: "later@example.test" }); }
      });
      try {
        await act(async () => { await openCompose("reply", 7); });
        expect(triggered).toBe(true); expect(created).not.toBe("");
        if (scenario === "replace") { expect(h.drafts.materialize(created)).toMatchObject({ inReplyToMessageId: 4, bodyText: "later work", bodyHtml: "<p>later work</p>", toText: "later@example.test" }); expect(h.app.getApp().draftFocus).toBeNull(); expect(composeFocusPending(7)).toBe(false); }
        else { for (let i = 0; i < 5; i++) await h.flush(); expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]')); }
      } finally { off(); }
    } finally { await h.cleanup(); }
  });
});

describe("inline focus", () => {
  it.each([true, false])("inline Send respects a later control (later=%s)", async (later) => {
    const h = await setup("split", true);
    const { openCompose } = await import("~/lib/compose"), { gate, deferred } = await import("./app-harness");
    const send = deferred<{ threadId: number }>(), entered = deferred<void>(); let sends = 0;
    gate.call.mockImplementation(async (method: string) => {
      if (method === "drafts.sourceContext") return { threadId: 7, accountId: 1 };
      if (method === "compose.send") { sends++; entered.resolve(); return send.promise; }
      return {};
    });
    h.drafts.setDraftTransport(async (_method, params) => ({ ...params as object, id: 81, generation: "stable", revision: 5, updatedAt: 0 }));
    try {
      await act(async () => { await openCompose("reply", 7); });
      for (let i = 0; i < 4; i++) await h.flush();
      await act(async () => { h.drafts.editDraft(h.key, { toText: "person@example.test" }); });
      const button = h.host.querySelector<HTMLButtonElement>('[data-testid="compose-send"]')!; expect(button).not.toBeNull();
      await act(async () => { button.click(); });
      await entered.promise; expect(sends).toBe(1);
      if (later) { h.other.focus(); expect(document.activeElement).toBe(h.other); }
      await act(async () => { send.resolve({ threadId: 7 }); await send.promise; });
      for (let i = 0; i < 4; i++) await h.flush();
      expect(h.drafts.useDrafts.getState().drafts[h.key]).toBeUndefined();
      if (later) expect(document.activeElement).toBe(h.other);
      else expect(document.activeElement).toBe(h.host.querySelector('[data-testid="quick-reply"]'));
    } finally { send.resolve({ threadId: 7 }); h.drafts.setDraftTransport(async () => null); await h.cleanup(); }
  });

  it.each([true, false])("inline Discard respects a later control (later=%s)", async (later) => {
    const h = await setup("split", true);
    const { openCompose } = await import("~/lib/compose"), { deferred } = await import("./app-harness");
    const deletion = deferred<void>(), entered = deferred<void>(); let deletes = 0;
    h.drafts.setDraftTransport(async (method, params) => {
      if (method === "drafts.delete") { deletes++; entered.resolve(); return deletion.promise; }
      return { ...params as object, id: 81, generation: "stable", revision: 5, updatedAt: 0 };
    });
    try {
      await act(async () => { await openCompose("reply", 7); });
      for (let i = 0; i < 4; i++) await h.flush();
      const button = h.host.querySelector<HTMLButtonElement>('[data-testid="compose-discard"]')!; expect(button).not.toBeNull();
      await act(async () => button.click());
      await entered.promise; expect(deletes).toBe(1);
      if (later) { h.other.focus(); expect(document.activeElement).toBe(h.other); }
      await act(async () => { deletion.resolve(); await deletion.promise; });
      for (let i = 0; i < 4; i++) await h.flush();
      expect(h.drafts.useDrafts.getState().drafts[h.key]).toBeUndefined();
      if (later) expect(document.activeElement).toBe(h.other);
      else expect(document.activeElement).toBe(h.host.querySelector('[data-testid="quick-reply"]'));
      const { undoLast } = await import("~/lib/snack");
      await act(async () => { undoLast(); });
      const restored = Object.values(h.drafts.useDrafts.getState().drafts);
      expect(restored).toHaveLength(1);
      expect(restored[0]).toMatchObject({ bodyText: "exact authored work", mode: "reply", inReplyToMessageId: 3 });
    } finally { deletion.resolve(); h.drafts.setDraftTransport(async () => null); await h.cleanup(); }
  });

  it.each(["rejected", "navigation"] as const)("inline Send preserves the destination after %s", async (scenario) => {
    const h = await setup("split", true);
    const { openCompose } = await import("~/lib/compose"), { gate, deferred } = await import("./app-harness");
    const wait = deferred<void>(), entered = deferred<void>();
    gate.call.mockImplementation(async (method: string) => {
      if (method === "drafts.sourceContext") return { threadId: 7, accountId: 1 };
      if (method === "compose.send") { entered.resolve(); await wait.promise; if (scenario === "rejected") throw new Error("offline"); return { threadId: 7 }; }
      return {};
    });
    h.drafts.setDraftTransport(async (_method, params) => ({ ...params as object, id: 81, generation: "stable", revision: 5, updatedAt: 0 }));
    try {
      await act(async () => { await openCompose("reply", 7); });
      for (let i = 0; i < 4; i++) await h.flush();
      await act(async () => { h.drafts.editDraft(h.key, { toText: "person@example.test" }); });
      await act(async () => { h.host.querySelector<HTMLButtonElement>('[data-testid="compose-send"]')!.click(); });
      await entered.promise;
      if (scenario === "navigation") await act(async () => { h.app.setApp({ selectedId: null, readerOpen: false }); });
      h.other.focus();
      await act(async () => { wait.resolve(); await wait.promise; });
      for (let i = 0; i < 4; i++) await h.flush();
      expect(document.activeElement).toBe(h.other);
      if (scenario === "rejected") expect(h.drafts.useDrafts.getState().drafts[h.key]).toMatchObject({ sending: false, bodyText: "exact authored work" });
      else expect(h.drafts.useDrafts.getState().drafts[h.key]).toBeUndefined();
    } finally { wait.resolve(); h.drafts.setDraftTransport(async () => null); await h.cleanup(); }
  });

  it("a real transient hold cancels pending inline Discard focus", async () => {
    const h = await setup("split", true);
    const { openCompose } = await import("~/lib/compose"), { deferred } = await import("./app-harness");
    const deletion = deferred<void>(), entered = deferred<void>();
    h.drafts.setDraftTransport(async (method, params) => {
      if (method === "drafts.delete") { entered.resolve(); return deletion.promise; }
      return { ...params as object, id: 81, generation: "stable", revision: 5, updatedAt: 0 };
    });
    const hold: { release: (() => void) | null } = { release: null };
    try {
      await act(async () => { await openCompose("reply", 7); });
      for (let i = 0; i < 4; i++) await h.flush();
      await act(async () => { h.host.querySelector<HTMLButtonElement>('[data-testid="compose-discard"]')!.click(); });
      await entered.promise;
      await act(async () => { hold.release = h.drafts.acquireDraftHold(); }); expect(hold.release).not.toBeNull();
      await act(async () => { hold.release!(); }); hold.release = null;
      await act(async () => { deletion.resolve(); await deletion.promise; });
      for (let i = 0; i < 4; i++) await h.flush();
      expect(document.activeElement).not.toBe(h.host.querySelector('[data-testid="quick-reply"]'));
    } finally { hold.release?.(); deletion.resolve(); h.drafts.setDraftTransport(async () => null); await h.cleanup(); }
  });

  it.each(["split", "list"] as const)("an earlier inline Send does not consume a newer %s compose focus", async (layout) => {
    const h = await setup(layout, true);
    const { openCompose } = await import("~/lib/compose"), { gate, deferred } = await import("./app-harness");
    const send = deferred<{ threadId: number }>(), entered = deferred<void>();
    gate.call.mockImplementation(async (method: string) => {
      if (method === "drafts.sourceContext") return { threadId: 7, accountId: 1 };
      if (method === "compose.send") { entered.resolve(); return send.promise; }
      return {};
    });
    h.drafts.setDraftTransport(async (_method, params) => ({ ...params as object, id: 81, generation: "stable", revision: 5, updatedAt: 0 }));
    try {
      await act(async () => { await openCompose("reply", 7); });
      for (let i = 0; i < 4; i++) await h.flush();
      await act(async () => { h.drafts.editDraft(h.key, { toText: "person@example.test" }); });
      await act(async () => { h.host.querySelector<HTMLButtonElement>('[data-testid="compose-send"]')!.click(); });
      await entered.promise;
      await act(async () => { await openCompose("new"); });
      const successor = h.app.getApp().compose; expect(successor).not.toBeNull();
      await act(async () => { send.resolve({ threadId: 7 }); await send.promise; });
      for (let i = 0; i < 4; i++) await h.flush();
      expect(h.app.getApp().compose).toBe(successor);
      expect(document.activeElement).toBe(h.host.querySelector('[data-testid="composer"] [data-testid="compose-to"]'));
    } finally { send.resolve({ threadId: 7 }); h.drafts.setDraftTransport(async () => null); await h.cleanup(); }
  });
});

describe("lease acquisition", () => {
  it.each(["ownership", "round trip", "valid"] as const)("preserves reentrant Forward ownership during Reply replacement: %s", async (scenario) => {
    const h = await setup("split", true), waiting = deferred<ThreadDetail>();
    const { openCompose, composeFocusPending } = await import("~/lib/compose");
    const later = document.createElement("button"); document.body.append(later);
    let first: Promise<void> | undefined, second: Promise<void> | undefined, newer: Promise<void> | undefined;
    let triggered = false;
    try {
      await act(async () => h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "collapsed" }));
      h.other.focus(); gate.load.mockReturnValue(waiting.promise);
      await act(async () => {
        first = openCompose("reply", 7);
        expect(h.app.getApp().draftFocus).not.toBeNull();
        const off = h.app.useApp.subscribe((state, previous) => {
          if (!triggered && previous.draftFocus && !state.draftFocus) {
            triggered = true; off(); newer = openCompose("forward", 7);
          }
        });
        second = openCompose("reply", 7);
        off();
        await Promise.all([first, second]);
      });
      expect(triggered).toBe(true); expect(newer).toBeDefined();
      if (scenario === "ownership") expect(composeFocusPending(7)).toBe(true);
      if (scenario === "round trip") { later.focus(); h.other.focus(); }
      await act(async () => { gate.load.mockResolvedValue(h.detail); waiting.resolve(h.detail); await newer; });
      for (let i = 0; i < 5; i++) await h.flush();
      if (scenario === "round trip") {
        expect(document.activeElement).toBe(h.other);
        expect(h.app.getApp().draftFocus).toBeNull(); expect(composeFocusPending(7)).toBe(false);
      } else expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-to"]'));
    } finally { waiting.resolve(h.detail); if (newer) await newer; later.remove(); await h.cleanup(); }
  });

  it("does not reacquire focus when a release observer chooses another control", async () => {
    const h = await setup("split", true);
    const { openCompose, composeFocusPending } = await import("~/lib/compose");
    const later = document.createElement("button"); document.body.append(later);
    let triggered = false;
    try {
      await act(async () => h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "collapsed" }));
      h.other.focus();
      await act(async () => {
        void openCompose("reply", 7);
        expect(h.app.getApp().draftFocus).not.toBeNull();
        const off = h.app.useApp.subscribe((state, previous) => {
          if (!triggered && previous.draftFocus && !state.draftFocus) { triggered = true; off(); later.focus(); }
        });
        void openCompose("reply", 7); off();
      });
      expect(triggered).toBe(true);
      for (let i = 0; i < 4; i++) await h.flush();
      expect(document.activeElement).toBe(later);
      expect(composeFocusPending(7)).toBe(false); expect(h.app.getApp().draftFocus).toBeNull();
    } finally { later.remove(); await h.cleanup(); }
  });
});

describe("a new draft's creation", () => {
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
});

describe("reentrant compose focus", () => {
  it("does not let an older draft-open notification cancel a newer Forward", async () => {
    const h = await setup("split", true), waiting = deferred<ThreadDetail>();
    const { openCompose, composeFocusPending } = await import("~/lib/compose");
    let newer: Promise<void> | undefined, triggered = false;
    try {
      await act(async () => { h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "collapsed" }); });
      h.other.focus(); gate.load.mockReturnValue(waiting.promise);
      const unsubscribe = h.drafts.useDrafts.subscribe((state, previous) => {
        if (!triggered && previous.drafts[h.key]?.uiState === "collapsed" && state.drafts[h.key]?.uiState === "open") {
          triggered = true; newer = openCompose("forward", 7);
        }
      });
      try {
        await act(async () => { await openCompose("reply", 7); });
        expect(triggered).toBe(true); expect(newer).toBeDefined();
        expect(composeFocusPending(7)).toBe(true);
        await h.flush(); expect(document.activeElement).toBe(h.other);
        await act(async () => { gate.load.mockResolvedValue(h.detail); waiting.resolve(h.detail); await newer; });
        for (let i = 0; i < 3; i++) await h.flush();
        expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-to"]'));
      } finally { unsubscribe(); }
    } finally { waiting.resolve(h.detail); if (newer) await newer; await h.cleanup(); }
  });

  it("keeps an intentional ownerless draft focus working", async () => {
    const h = await setup("split", true), { focusDraft } = await import("~/lib/compose");
    try {
      await act(async () => { h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "open" }); });
      h.other.focus(); await act(async () => focusDraft(h.key, "body"));
      for (let i = 0; i < 3; i++) await h.flush();
      expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]'));
    } finally { await h.cleanup(); }
  });

  it("does not publish an ownerless request after its lease-release listener starts newer work", async () => {
    const h = await setup("split", true), waiting = deferred<{ threadId: number; accountId: number }>();
    const { openCompose, focusDraft, composeFocusPending, subscribeComposeFocus } = await import("~/lib/compose");
    let older: Promise<void> | undefined, newer: Promise<void> | undefined, triggered = false;
    try {
      await act(async () => { h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: true, uiState: "open" }); });
      h.other.focus(); gate.call.mockImplementation((method: string) => method === "drafts.sourceContext" ? waiting.promise : Promise.resolve({}));
      await act(async () => { older = openCompose("reply", 7); });
      expect(composeFocusPending(7)).toBe(true);
      const unsubscribe = subscribeComposeFocus(() => {
        if (!triggered) { triggered = true; newer = openCompose("forward", 7); }
      });
      try {
        await act(async () => focusDraft(h.key, "body"));
        expect(triggered).toBe(true); expect(composeFocusPending(7)).toBe(true);
        await h.flush(); expect(document.activeElement).toBe(h.other);
        await act(async () => { gate.call.mockResolvedValue({ threadId: 7, accountId: 1 }); waiting.resolve({ threadId: 7, accountId: 1 }); await Promise.all([older, newer]); });
        for (let i = 0; i < 3; i++) await h.flush();
        expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-to"]'));
      } finally { unsubscribe(); }
    } finally { waiting.resolve({ threadId: 7, accountId: 1 }); if (older) await older; if (newer) await newer; await h.cleanup(); }
  });
});

describe("a later control during Reply", () => {
  it.each([false, true])("keeps the latest control when Reply publication changes focus: %s", async (move) => {
    const h = await setup("split", true);
    const { openCompose, composeFocusPending } = await import("~/lib/compose");
    const later = document.createElement("button"); document.body.append(later);
    let triggered = false;
    try {
      await act(async () => { h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "collapsed" }); });
      h.other.focus();
      const unsubscribe = h.drafts.useDrafts.subscribe((state, previous) => {
        if (!triggered && previous.drafts[h.key]?.uiState === "collapsed" && state.drafts[h.key]?.uiState === "open") {
          triggered = true; if (move) later.focus();
        }
      });
      try {
        await act(async () => { await openCompose("reply", 7); });
        expect(triggered).toBe(true);
        for (let i = 0; i < 4; i++) await h.flush();
        if (move) {
          expect(document.activeElement).toBe(later);
          expect(h.app.getApp().draftFocus).toBeNull();
          expect(composeFocusPending(7)).toBe(false);
        } else {
          expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]'));
        }
      } finally { unsubscribe(); }
    } finally { later.remove(); await h.cleanup(); }
  });

  it("keeps a later control when source validation resumes into draft-open notification", async () => {
    const h = await setup("split", true);
    const { openCompose, composeFocusPending } = await import("~/lib/compose");
    const { gate, deferred } = await import("./app-harness");
    const waiting = deferred<{ threadId: number; accountId: number }>();
    const later = document.createElement("button"); document.body.append(later);
    let triggered = false, opening: Promise<void> | undefined;
    try {
      await act(async () => { h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: true, uiState: "collapsed" }); });
      gate.call.mockImplementation((method: string) => method === "drafts.sourceContext" ? waiting.promise : Promise.resolve({}));
      h.other.focus();
      const off = h.drafts.useDrafts.subscribe((state, previous) => {
        if (!triggered && previous.drafts[h.key]?.uiState === "collapsed" && state.drafts[h.key]?.uiState === "open") { triggered = true; later.focus(); }
      });
      try {
        await act(async () => { opening = openCompose("reply", 7); });
        expect(gate.call).toHaveBeenCalledWith("drafts.sourceContext", { messageId: 3 });
        await act(async () => { waiting.resolve({ threadId: 7, accountId: 1 }); await opening; });
        expect(triggered).toBe(true);
        for (let i = 0; i < 4; i++) await h.flush();
        expect(document.activeElement).toBe(later);
        expect(h.app.getApp().draftFocus).toBeNull(); expect(composeFocusPending(7)).toBe(false);
      } finally { off(); }
    } finally { waiting.resolve({ threadId: 7, accountId: 1 }); if (opening) await opening; later.remove(); await h.cleanup(); }
  });
});

describe("a queued Reply and selection", () => {
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
      expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]'));
    } finally { await act(async () => { useList.setState(previous, true); }); await h.cleanup(); }
  });
});

describe("before Reader's first frame", () => {
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
});

describe("a retired Reader", () => {
  it.each(["list", "split"] as const)("does not retain Reply after the %s Reader boundary has already retired", async (layout) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = await setup(layout, true), waiting = deferred<ThreadDetail>();
    const { composeFocusPending } = await import("~/lib/compose");
    try {
      h.drafts.forgetDraft(h.key);
      const broken = { ...h.detail, messages: null } as unknown as ThreadDetail;
      await act(async () => { h.useThreads.setState({ details: new Map([[7, broken]]) }); });
      expect(h.host.querySelector('[data-testid="reader-boundary"]')).not.toBeNull();
      expect(h.host.querySelector('[data-testid="reader"]')).toBeNull();
      await act(async () => { h.useThreads.setState({ details: new Map([[7, h.detail]]) }); await Promise.resolve(); });
      expect(h.app.getApp().selectedId).toBe(7); h.other.focus();
      gate.load.mockReturnValue(waiting.promise);
      await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true })));
      await act(async () => { gate.load.mockResolvedValue(h.detail); waiting.resolve(h.detail); });
      for (let i = 0; i < 5; i++) await h.flush();
      expect(composeFocusPending(7)).toBe(false); expect(h.app.getApp().draftFocus).toBeNull();
      expect(document.activeElement).toBe(h.other);
      await act(async () => (h.host.querySelector('[data-testid="reader-boundary-retry"]') as HTMLButtonElement).click());
      for (let i = 0; i < 3; i++) await h.flush();
      expect(h.host.querySelector('[data-testid="reader"]')).not.toBeNull();
      expect(document.activeElement?.closest('[data-testid="composer"]')).toBeNull();
      expect(h.app.getApp().draftFocus).toBeNull();
      h.other.focus(); await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true })));
      for (let i = 0; i < 3; i++) await h.flush();
      expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]'));
    } finally { waiting.resolve(h.detail); await h.cleanup(); error.mockRestore(); }
  });

  it.each(["list", "split"] as const)("does not retain a pre-mount Reply when the initial %s Reader render fails", async (layout) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = await setup(layout), waiting = deferred<ThreadDetail>();
    const { composeFocusPending, openCompose } = await import("~/lib/compose");
    let opening: Promise<void> | undefined;
    try {
      h.drafts.forgetDraft(h.key); h.other.focus(); gate.load.mockReturnValue(waiting.promise);
      const broken = { ...h.detail, messages: null } as unknown as ThreadDetail;
      await act(async () => {
        h.app.setApp({ selectedId: 7, readerOpen: true });
        opening = openCompose("reply", 7);
        h.useThreads.setState({ details: new Map([[7, broken]]) });
      });
      expect(h.host.querySelector('[data-testid="reader-boundary"]')).not.toBeNull();
      expect(h.host.querySelector('[data-testid="reader"]')).toBeNull();
      await act(async () => { h.useThreads.setState({ details: new Map([[7, h.detail]]) }); gate.load.mockResolvedValue(h.detail); waiting.resolve(h.detail); await opening; });
      for (let i = 0; i < 3; i++) await h.flush();
      expect(composeFocusPending(7)).toBe(false); expect(h.app.getApp().draftFocus).toBeNull();
      expect(document.activeElement).toBe(h.other);
    } finally { waiting.resolve(h.detail); if (opening) await opening; await h.cleanup(); error.mockRestore(); }
  });

  it("allows a new conversation's reply while the failed prior boundary resets", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = await setup("split", true), waiting = deferred<ThreadDetail>();
    const { openCompose } = await import("~/lib/compose");
    let opening: Promise<void> | undefined;
    const next = { ...h.detail, thread: { ...h.detail.thread, id: 8 } };
    try {
      h.drafts.forgetDraft(h.key);
      await act(async () => { h.useThreads.setState({ details: new Map([[7, { ...h.detail, messages: null } as unknown as ThreadDetail]]) }); });
      expect(h.host.querySelector('[data-testid="reader-boundary"]')).not.toBeNull();
      gate.load.mockReturnValue(waiting.promise);
      gate.call.mockImplementation(async (method: string) => method === "drafts.sourceContext" ? { threadId: 8, accountId: 1 } : {});
      h.other.focus();
      await act(async () => { h.app.setApp({ selectedId: 8, readerOpen: true }); opening = openCompose("reply", 8); });
      await act(async () => { h.useThreads.setState({ details: new Map([[8, next]]) }); gate.load.mockResolvedValue(next); waiting.resolve(next); await opening; });
      for (let i = 0; i < 3; i++) await h.flush();
      expect(h.host.querySelector('[data-testid="reader"]')).not.toBeNull();
      expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]'));
    } finally { waiting.resolve(next); if (opening) await opening; await h.cleanup(); error.mockRestore(); }
  });

  it("keeps overlapping failed-host registrations until their exact owners leave", async () => {
    const h = await setup("split", true);
    const { openCompose, composeFocusPending, registerReaderPaneFailure } = await import("~/lib/compose");
    const token = {}, other = {};
    const old = registerReaderPaneFailure(7, token);
    const current = registerReaderPaneFailure(7, token);
    const overlapping = registerReaderPaneFailure(7, other);
    try {
      await act(async () => h.drafts.forgetDraft(h.key)); h.other.focus(); gate.load.mockClear();
      old();
      await act(async () => { await openCompose("reply", 7); });
      expect(gate.load).not.toHaveBeenCalled(); expect(composeFocusPending(7)).toBe(false);
      current();
      await act(async () => { await openCompose("reply", 7); });
      expect(gate.load).not.toHaveBeenCalled(); expect(composeFocusPending(7)).toBe(false);
      overlapping();
      await act(async () => { await openCompose("reply", 7); });
      for (let i = 0; i < 3; i++) await h.flush();
      expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]'));
    } finally { old(); current(); overlapping(); await h.cleanup(); }
  });

  it("opens a standalone stored draft while its former Reader fallback is mounted", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = await setup("split", true);
    const { composeFocusPending } = await import("~/lib/compose");
    try {
      await act(async () => { h.useThreads.setState({ details: new Map([[7, { ...h.detail, messages: null } as unknown as ThreadDetail]]) }); });
      expect(h.host.querySelector('[data-testid="reader-boundary"]')).not.toBeNull();
      gate.call.mockImplementation(async (method: string) => method === "drafts.sourceContext" ? null : {});
      const button = h.host.querySelector<HTMLButtonElement>('[data-testid="strip-item"]')!;
      button.focus(); await act(async () => button.click());
      const focus = h.app.getApp().draftFocus!;
      expect(composeFocusPending(null, h.key, focus.seq)).toBe(true);
      expect(h.host.querySelector('[data-testid="reader-boundary"]')).not.toBeNull();
      await act(async () => (h.host.querySelector('[data-testid="reader-boundary-retry"]') as HTMLButtonElement).click());
      for (let i = 0; i < 15; i++) await h.flush();
      expect(h.app.getApp().compose?.key).toBe(h.key);
      expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-to"]'));
    } finally { await h.cleanup(); error.mockRestore(); }
  });

  it("does not suppress Reader focus for a failure in another reader-pane branch", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = await setup("split", true), host = document.createElement("div");
    const { PaneBoundary } = await import("./diag/error-boundary");
    const { openCompose } = await import("~/lib/compose");
    const root = createRoot(host);
    function FailedOtherPane(): never { throw new Error("other pane failed"); }
    document.body.append(host);
    try {
      await act(async () => root.render(<StrictMode><PaneBoundary area="reader" resetKey={7}><FailedOtherPane /></PaneBoundary></StrictMode>));
      expect(host.querySelector('[data-testid="reader-boundary"]')).not.toBeNull();
      await act(async () => h.drafts.forgetDraft(h.key)); h.other.focus();
      await act(async () => { await openCompose("reply", 7); });
      for (let i = 0; i < 3; i++) await h.flush();
      expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]'));
    } finally { await act(async () => root.unmount()); host.remove(); await h.cleanup(); error.mockRestore(); }
  });
});

describe("renderer integration", () => {
  it.each(["departure", "round trip", "same id", "dialog", "harmless", "ordinary"] as const)("does not adopt navigation during lease release: %s", async (scenario) => {
    const h = await setup("split", true);
    const { openCompose, openStoredDraft, composeFocusPending } = await import("~/lib/compose");
    const { pressRow } = await import("~/lib/select");
    const { newFields } = await import("~/lib/compose-fields");
    let triggered = false;
    try {
      await act(async () => h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "collapsed" }));
      let orphan = "";
      await act(async () => { orphan = h.drafts.createDraft({ ...newFields(1), bodyText: "orphan work" }); });
      h.other.focus();
      await act(async () => {
        void openCompose("reply", 7);
        expect(h.app.getApp().draftFocus?.key).toBe(h.key);
        const off = h.app.useApp.subscribe((state, previous) => {
          if (!triggered && previous.draftFocus && !state.draftFocus) {
            triggered = true;
            if (scenario === "departure" || scenario === "round trip") {
              pressRow(8, { shift: false, meta: false, ctrl: false });
              if (scenario === "round trip") pressRow(7, { shift: false, meta: false, ctrl: false });
            } else if (scenario === "same id") pressRow(7, { shift: false, meta: false, ctrl: false });
            else if (scenario === "dialog") { h.app.setApp({ dialog: "addAccount" }); h.app.setApp({ dialog: null }); }
            else if (scenario === "harmless") h.app.setApp({ snackbar: true });
          }
        });
        if (scenario === "round trip") await openCompose("reply", 7);
        else await openStoredDraft(orphan);
        off();
      });
      expect(triggered).toBe(true);
      if (scenario === "departure") {
        expect(h.app.getApp().selectedId).toBe(8);
        expect(h.app.getApp().compose).toBeNull();
        expect(h.app.getApp().draftFocus).toBeNull();
      } else if (scenario === "same id" || scenario === "dialog") {
        expect(h.app.getApp().compose).toBeNull();
        expect(h.app.getApp().draftFocus).toBeNull();
      } else if (scenario === "round trip") {
        expect(h.app.getApp().selectedId).toBe(7);
        expect(h.app.getApp().draftFocus).toBeNull();
        expect(composeFocusPending(7)).toBe(false);
      } else {
        expect(h.app.getApp().compose?.key).toBe(orphan);
      }
      expect(h.drafts.materialize(orphan)?.bodyText).toBe("orphan work");
      expect(h.drafts.materialize(h.key)?.bodyText).toBe("exact authored work");
    } finally { await h.cleanup(); }
  });

  it.each(["changed", "ordinary"] as const)("checks the source after opening a same-mode draft: %s", async (scenario) => {
    const h = await setup("split", true);
    const { openCompose, composeFocusPending } = await import("~/lib/compose");
    let triggered = false;
    try {
      await act(async () => h.drafts.editDraft(h.key, { uiState: "collapsed" }));
      h.other.focus();
      const off = h.drafts.useDrafts.subscribe((state, previous) => {
        if (!triggered && previous.drafts[h.key]?.uiState === "collapsed" && state.drafts[h.key]?.uiState === "open") {
          triggered = true;
          if (scenario === "changed") h.drafts.editDraft(h.key, { inReplyToMessageId: 4, bodyText: "newer source work", bodyHtml: "<p>newer source work</p>" });
        }
      });
      try {
        await act(async () => { await openCompose("reply", 7); });
        expect(triggered).toBe(true);
        if (scenario === "changed") {
          expect(h.drafts.materialize(h.key)).toMatchObject({ id: 81, generation: "stable", inReplyToMessageId: 4, bodyText: "newer source work", bodyHtml: "<p>newer source work</p>" });
          expect(h.app.getApp().draftFocus).toBeNull();
          expect(composeFocusPending(7)).toBe(false);
        } else {
          for (let i = 0; i < 5; i++) await h.flush();
          expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]'));
        }
      } finally { off(); }
    } finally { await h.cleanup(); }
  });

  it.each(["departure", "no departure", "later control"] as const)("focuses collapsed standalone work across ordinary draft expiry: %s", async (scenario) => {
    const h = await setup("split", true);
    const { openStoredDraft, composeFocusPending } = await import("~/lib/compose");
    const { newFields } = await import("~/lib/compose-fields");
    try {
      let orphan = "";
      await act(async () => {
        orphan = h.drafts.createDraft({ ...newFields(1), mode: "reply", inReplyToMessageId: 4, showSourceContext: true, bodyText: "collapsed orphan work", uiState: "collapsed" });
        h.drafts.useDrafts.setState((s) => ({ drafts: { ...s.drafts, [orphan]: { ...s.drafts[orphan]!, id: 82, generation: "orphan", revision: 5, status: "saved", presentationExpired: true } } }));
      });
      if (scenario !== "departure") await act(async () => h.drafts.expireDraftPresentation(7));
      gate.call.mockImplementation(async (method: string) => method === "drafts.sourceContext" ? null : {});
      h.other.focus();
      await act(async () => { await openStoredDraft(orphan); });
      expect(h.app.getApp().compose?.key).toBe(orphan);
      if (scenario === "departure") expect(h.drafts.materialize(h.key)?.presentationExpired).toBe(true);
      if (scenario === "later control") {
        const seq = h.app.getApp().compose?.storedFocusSeq;
        expect(seq).toBeDefined();
        expect(composeFocusPending(null, orphan, seq)).toBe(true);
        const later = document.createElement("button"); document.body.append(later);
        try { later.focus(); for (let i = 0; i < 15; i++) await h.flush(); expect(document.activeElement).toBe(later); } finally { later.remove(); }
        return;
      }
      for (let i = 0; i < 15; i++) await h.flush();
      expect(h.drafts.materialize(orphan)).toMatchObject({ id: 82, generation: "orphan", revision: 5, bodyText: "collapsed orphan work", uiState: "collapsed" });
      expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-to"]'));
    } finally { await h.cleanup(); }
  });
});

describe("collapse exit", () => {
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
        const body = h.host.querySelector<HTMLElement>('[data-testid="compose-body"]'); expect(body).not.toBeNull(); body!.focus();
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
});

describe("the rich controller at Send", () => {
  it.each([true, false])("the rich controller refuses commands at the synchronous Send lock (reenter=%s)", async (reenter) => {
    const drafts = await import("~/lib/drafts"), { controllerFor } = await import("./composer/controller");
    let key: string | undefined, calls = 0; const entered = deferred<void>();
    let reject!: (error: Error) => void; const send = new Promise<{ threadId: number }>((_, fail) => { reject = fail; }); void send.catch(() => {});
    const off = drafts.useDrafts.subscribe((state, previous) => {
      if (reenter && key && !previous.drafts[key]?.sending && state.drafts[key]?.sending) { calls++; controllerFor(key)?.run("quote"); }
    });
    const h = await setup("split", true); key = h.key;
    const { openCompose, sendDraft } = await import("~/lib/compose"); let submitted: unknown, pending: Promise<boolean> | undefined;
    gate.call.mockImplementation(async (method: string, params: unknown) => {
      if (method === "drafts.sourceContext") return { threadId: 7, accountId: 1 };
      if (method === "compose.send") { submitted = params; entered.resolve(); return send; }
      return {};
    });
    let revision = 4;
    drafts.setDraftTransport(async (_method, params) => ({ ...params as object, id: 81, generation: "stable", revision: ++revision, updatedAt: 0 }));
    try {
      await act(async () => { await openCompose("reply", 7); });
      for (let i = 0; i < 4; i++) await h.flush();
      const controller = controllerFor(key)!; expect(controller).not.toBeNull();
      await act(async () => { drafts.editDraft(key!, { toText: "person@example.test" }); await drafts.flushDraft(key!); });
      await act(async () => { h.other.focus(); });
      const before = drafts.useDrafts.getState().drafts[key]!, html = controller.dom.innerHTML, active = document.activeElement;
      const selection = document.getSelection();
      const selectionBefore = selection ? [selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset] : null;
      expect(before.savedRev).toBe(before.localRev); expect(controller.dom.textContent).toContain("exact authored work");
      await act(async () => { pending = sendDraft(key!); });
      await entered.promise; expect(calls).toBe(reenter ? 1 : 0); expect(submitted).toBeDefined();
      if (!reenter) await act(async () => { controller.run("quote"); });
      const current = drafts.useDrafts.getState().drafts[key]!;
      expect(current.localRev).toBe(before.localRev); expect(current.bodyVersion).toBe(before.bodyVersion);
      expect((submitted as { bodyText: string }).bodyText).toContain("exact authored work");
      expect(controller.dom.innerHTML).toBe(html);
      expect(document.activeElement).toBe(active);
      expect(selection ? [selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset] : null).toEqual(selectionBefore);
      await act(async () => { reject(new Error("offline")); expect(await pending).toBe(false); });
      expect(drafts.useDrafts.getState().drafts[key]).toMatchObject({ sending: false, bodyText: before.bodyText, bodyHtml: before.bodyHtml, localRev: before.localRev, bodyVersion: before.bodyVersion });
      expect(controller.dom.innerHTML).toBe(html);
      await act(async () => { controller.run("undo"); });
      expect(controller.dom.innerHTML).toBe(html);
      await act(async () => { controller.run("quote"); await drafts.flushDraft(key!); });
      expect(controller.dom.querySelector("blockquote")).not.toBeNull();
      expect(drafts.useDrafts.getState().drafts[key]!.bodyHtml).toContain("<blockquote");
    } finally { off(); reject(new Error("cleanup")); await act(async () => { await pending?.catch(() => {}); }); drafts.setDraftTransport(async () => null); await h.cleanup(); }
  });

  it("a rich quote command before Send is materialized and saved", async () => {
    const h = await setup("split", true), { controllerFor } = await import("./composer/controller"), { openCompose } = await import("~/lib/compose");
    let saved: Record<string, unknown> | undefined;
    h.drafts.setDraftTransport(async (_method, params) => { saved = params as Record<string, unknown>; return { ...saved, id: 81, generation: "stable", revision: 5, updatedAt: 0 }; });
    try {
      await act(async () => { await openCompose("reply", 7); });
      for (let i = 0; i < 4; i++) await h.flush();
      const controller = controllerFor(h.key)!; expect(controller).not.toBeNull();
      await act(async () => { controller.run("quote"); });
      expect(controller.dom.querySelector("blockquote")).not.toBeNull();
      await act(async () => { await h.drafts.flushDraft(h.key); });
      expect(saved).toBeDefined(); expect(String(saved!.bodyHtml)).toContain("<blockquote");
      const current = h.drafts.useDrafts.getState().drafts[h.key]!;
      expect(current.savedRev).toBe(current.localRev); expect(current.bodyHtml).toContain("<blockquote");
    } finally { h.drafts.setDraftTransport(async () => null); await h.cleanup(); }
  });

  it("Send materializes already accepted dirty rich work", async () => {
    const h = await setup("split", true), { controllerFor } = await import("./composer/controller"), { openCompose, sendDraft } = await import("~/lib/compose");
    const wait = deferred<{ threadId: number }>(), entered = deferred<void>(); let request: Record<string, unknown> | undefined, pending: Promise<boolean> | undefined;
    gate.call.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "drafts.sourceContext") return { threadId: 7, accountId: 1 };
      if (method === "compose.send") { request = params; entered.resolve(); return wait.promise; }
      return {};
    });
    let revision = 4;
    h.drafts.setDraftTransport(async (_method, params) => ({ ...params as object, id: 81, generation: "stable", revision: ++revision, updatedAt: 0 }));
    try {
      await act(async () => { await openCompose("reply", 7); });
      for (let i = 0; i < 4; i++) await h.flush();
      const controller = controllerFor(h.key)!; expect(controller).not.toBeNull();
      await act(async () => { h.drafts.editDraft(h.key, { toText: "person@example.test" }); controller.run("quote"); });
      expect(controller.dom.querySelector("blockquote")).not.toBeNull();
      await act(async () => { pending = sendDraft(h.key); });
      await entered.promise;
      expect(String(request!.bodyHtml)).toContain("<blockquote");
    } finally { wait.resolve({ threadId: 7 }); await act(async () => { await pending?.catch(() => {}); }); h.drafts.setDraftTransport(async () => null); await h.cleanup(); }
  });
});
