// @vitest-environment jsdom
// Ownerless focus requests (focusDraft): holds, selection intent and publication failures.
import type { ThreadSummary } from "@terno/core";
import { act } from "react";
import { flushSync } from "react-dom";
import { describe, expect, it, vi } from "vitest";
import { deferred, gate, setup } from "./app-harness";

describe("hold admission", () => {
  it.each(["before-effect", "successor", "rejected", "held"] as const)("ownerless hold admission %s", async (scenario) => {
    const h = await setup("split", true), { focusDraft } = await import("~/lib/compose");
    let release: (() => void) | null = null, work: (() => void) | null = null, hit = false;
    try {
      await act(async () => { h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "open" }); h.other.focus(); });
      if (scenario === "rejected") { work = h.drafts.beginDraftWork(); expect(work).not.toBeNull(); expect(h.drafts.acquireDraftHold()).toBeNull(); }
      if (scenario === "held") { release = h.drafts.acquireDraftHold(); expect(release).not.toBeNull(); }
      const off = h.app.useApp.subscribe((state, previous) => {
        if (!hit && state.draftFocus && state.draftFocus !== previous.draftFocus) {
          hit = true;
          if (scenario === "before-effect" || scenario === "successor") {
            const stop = h.drafts.acquireDraftHold(); expect(stop).not.toBeNull(); stop!();
            if (scenario === "successor") focusDraft(h.key, "to");
          }
        }
      });
      try { await act(async () => { focusDraft(h.key, "body"); }); } finally { off(); }
      if (scenario === "held") { expect(hit).toBe(false); release!(); release = null; } else expect(hit).toBe(true);
      work?.(); work = null;
      for (let i = 0; i < 4; i++) await h.flush();
      if (scenario === "before-effect" || scenario === "held") expect(document.activeElement).toBe(h.other);
      else if (scenario === "successor") expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-to"]'));
      else expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]'));
    } finally { if (release) (release as () => void)(); if (work) (work as () => void)(); await h.cleanup(); }
  });

  it.each([false, true])("ownerless queued focus respects a transient hold (hold=%s)", async (hold) => {
    const h = await setup("split", true), { focusDraft } = await import("~/lib/compose");
    let release: (() => void) | null = null;
    try {
      await act(async () => { h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "open" }); h.other.focus(); });
      await act(async () => { focusDraft(h.key, "body"); });
      expect(h.app.useApp.getState().draftFocus).toBeNull();
      if (hold) {
        await act(async () => { release = h.drafts.acquireDraftHold(); });
        expect(release).not.toBeNull();
        await act(async () => { release!(); }); release = null;
      }
      for (let i = 0; i < 4; i++) await h.flush();
      if (hold) expect(document.activeElement).toBe(h.other);
      else expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]'));
    } finally { if (release) (release as () => void)(); await h.cleanup(); }
  });

  it("ownerless focus respects a control chosen while releasing a prior lease", async () => {
    const h = await setup("split", true), { focusDraft, openCompose, subscribeComposeFocus } = await import("~/lib/compose");
    const waiting = deferred<typeof h.detail>(); const later = document.createElement("button"); document.body.append(later);
    let pending: Promise<void> | undefined, notified = false;
    try {
      await act(async () => { h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "open" }); h.other.focus(); });
      gate.load.mockReturnValue(waiting.promise);
      await act(async () => { pending = openCompose("forward", 7); });
      expect(gate.load).toHaveBeenCalledWith(7);
      const off = subscribeComposeFocus(() => { notified = true; later.focus(); });
      try { await act(async () => { focusDraft(h.key, "body"); }); } finally { off(); }
      expect(notified).toBe(true);
      for (let i = 0; i < 4; i++) await h.flush();
      expect(document.activeElement).toBe(later);
    } finally { waiting.resolve(h.detail); if (pending) await pending; later.remove(); await h.cleanup(); }
  });

  it.each((["split", "list"] as const).flatMap((layout) => (["before", "after", "ordinary", "successor"] as const).map((scenario) => [layout, scenario] as const)))("ownerless synchronous effect ordering %s %s", async (layout, scenario) => {
    const h = await setup(layout, true), { focusDraft } = await import("~/lib/compose");
    const later = document.createElement("button"); document.body.append(later);
    let hit = false, consumed = false;
    try {
      await act(async () => { h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "open" }); h.other.focus(); });
      const off = h.app.useApp.subscribe((state, previous) => {
        if (!hit && state.draftFocus && state.draftFocus !== previous.draftFocus) {
          hit = true;
          if (scenario === "before") later.focus();
          flushSync(() => {});
          consumed = h.app.useApp.getState().draftFocus === null;
          if (scenario === "after") later.focus();
          if (scenario === "successor") focusDraft(h.key, "to");
        }
      });
      try { await act(async () => { focusDraft(h.key, "body"); }); } finally { off(); }
      expect(hit).toBe(true);
      // Prove the effect actually ran before the outer publication returned.
      expect(consumed).toBe(true);
      for (let i = 0; i < 4; i++) await h.flush();
      if (scenario === "before" || scenario === "after") expect(document.activeElement).toBe(later);
      else if (scenario === "successor") expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-to"]'));
      else expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]'));
    } finally { later.remove(); await h.cleanup(); }
  });

  it.each([true, false])("ownerless publication respects a later control (move=%s)", async (move) => {
    const h = await setup("split", true), { focusDraft } = await import("~/lib/compose");
    const later = document.createElement("button"); document.body.append(later); let hit = false;
    try {
      await act(async () => { h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "open" }); });
      await act(async () => { h.other.focus(); });
      const off = h.app.useApp.subscribe((state, previous) => {
        if (!hit && state.draftFocus && state.draftFocus !== previous.draftFocus) { hit = true; if (move) later.focus(); }
      });
      try { await act(async () => { focusDraft(h.key, "body"); }); } finally { off(); }
      expect(hit).toBe(true); if (move) expect(document.activeElement).toBe(later);
      for (let i = 0; i < 4; i++) await h.flush();
      if (move) expect(document.activeElement).toBe(later);
      else expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]'));
    } finally { later.remove(); await h.cleanup(); }
  });

  it.each(["roundtrip", "successor"] as const)("ownerless publication preserves %s during notification", async (scenario) => {
    const h = await setup("split", true), { focusDraft } = await import("~/lib/compose");
    const later = document.createElement("button"); document.body.append(later); let hit = false;
    try {
      await act(async () => { h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "open" }); h.other.focus(); });
      const off = h.app.useApp.subscribe((state, previous) => {
        if (!hit && state.draftFocus && state.draftFocus !== previous.draftFocus) {
          hit = true; later.focus();
          if (scenario === "roundtrip") h.other.focus(); else focusDraft(h.key, "to");
        }
      });
      try { await act(async () => { focusDraft(h.key, "body"); }); } finally { off(); }
      expect(hit).toBe(true);
      for (let i = 0; i < 4; i++) await h.flush();
      if (scenario === "roundtrip") expect(document.activeElement).toBe(h.other);
      else expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-to"]'));
    } finally { later.remove(); await h.cleanup(); }
  });
});

describe("moves and publication", () => {

  it.each([false, true])('cleans an ownerless move when publication throws (consumed=%s)', async (consume) => {
    const h = await setup('split', true), { focusDraft } = await import('~/lib/compose'); let hit = false;
    try {
      await act(async () => { h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: 'open' }); h.other.focus(); });
      const off = h.app.useApp.subscribe((state, previous) => {
        if (hit || !state.draftFocus || state.draftFocus === previous.draftFocus) return;
        hit = true;
        if (consume) { flushSync(() => {}); expect(h.app.getApp().draftFocus).toBeNull(); }
        throw new Error('publication failed');
      });
      try { await act(async () => { expect(() => focusDraft(h.key, 'body')).toThrow('publication failed'); }); } finally { off(); }
      expect(hit).toBe(true); expect(h.app.getApp().draftFocus).toBeNull();
      for (let i = 0; i < 14; i++) await h.flush();
      expect(document.activeElement).toBe(h.other);
      await act(async () => { focusDraft(h.key, 'body'); });
      for (let i = 0; i < 4; i++) await h.flush();
      expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]'));
    } finally { await h.cleanup(); }
  });

  it('cancels its exact pending move and listener when its slot unmounts', async () => {
    const h = await setup('split', true), { focusDraft } = await import('~/lib/compose');
    const add = vi.spyOn(document, 'addEventListener'), remove = vi.spyOn(document, 'removeEventListener');
    try {
      await act(async () => { h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: 'open' }); h.other.focus(); });
      await act(async () => { focusDraft(h.key, 'body'); });
      const listeners = add.mock.calls.filter(([type, , capture]) => type === 'focusin' && capture === true).map(([, listener]) => listener);
      expect(listeners.length).toBeGreaterThan(0);
      await act(async () => { h.root.unmount(); await Promise.resolve(); });
      expect(listeners.some((listener) => remove.mock.calls.some(([type, removed, capture]) => type === 'focusin' && removed === listener && capture === true))).toBe(true);
      expect(window.cancelAnimationFrame).toHaveBeenCalled();
      for (let i = 0; i < 14; i++) await h.flush();
      expect(document.activeElement).toBe(h.other);
    } finally { add.mockRestore(); remove.mockRestore(); await h.cleanup(); }
  });

  it('expires an ownerless request when no DraftSlot consumes it', async () => {
    const h = await setup('split', false), { focusDraft } = await import('~/lib/compose');
    try {
      await act(async () => { h.other.focus(); focusDraft(h.key, 'body'); });
      expect(h.app.getApp().draftFocus?.key).toBe(h.key);
      for (let i = 0; i < 14; i++) await h.flush();
      expect(h.app.getApp().draftFocus).toBeNull(); expect(document.activeElement).toBe(h.other);
    } finally { await h.cleanup(); }
  });

  it('cancels an unconsumed ownerless request on pagehide without blocking a later request', async () => {
    const h = await setup('split', true), { focusDraft } = await import('~/lib/compose');
    try {
      await act(async () => { h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: 'open' }); h.other.focus(); });
      await act(async () => { focusDraft(h.key, 'body'); expect(h.app.getApp().draftFocus?.key).toBe(h.key); window.dispatchEvent(new Event('pagehide')); });
      expect(h.app.getApp().draftFocus).toBeNull();
      for (let i = 0; i < 14; i++) await h.flush();
      expect(document.activeElement).toBe(h.other);
      await act(async () => { focusDraft(h.key, 'body'); });
      for (let i = 0; i < 4; i++) await h.flush();
      expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]'));
    } finally { await h.cleanup(); }
  });

  it('does not focus an inert slot after the bounded move expires', async () => {
    const h = await setup('split', true), { focusDraft } = await import('~/lib/compose');
    try {
      await act(async () => { h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: 'open' }); h.other.focus(); });
      h.host.setAttribute('inert', '');
      await act(async () => { focusDraft(h.key, 'body'); });
      for (let i = 0; i < 14; i++) await h.flush();
      expect(h.app.getApp().draftFocus).toBeNull(); expect(document.activeElement).toBe(h.other);
    } finally { h.host.removeAttribute('inert'); await h.cleanup(); }
  });

  it.each((['split', 'list'] as const).flatMap((layout) => (['before-effect', 'after-effect', 'ordinary'] as const).map((scenario) => [layout, scenario] as const)))('%s ownerless later focus %s', async (layout, scenario) => {
    const h = await setup(layout, true), { focusDraft } = await import('~/lib/compose');
    const later = document.createElement('button'); document.body.append(later); let captured: { key: string; seq: number } | null = null;
    try {
      await act(async () => { h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: 'open', toText: 'synthetic@example.test' }); h.other.focus(); });
      const initial = h.drafts.useDrafts.getState().drafts[h.key]!;
      await act(async () => {
        focusDraft(h.key, 'body');
        const request = h.app.getApp().draftFocus;
        if (scenario === 'before-effect') { expect(request).not.toBeNull(); expect(request!.key).toBe(h.key); captured = { key: request!.key, seq: request!.seq }; later.focus(); expect(document.activeElement).toBe(later); }
      });
      if (scenario === 'before-effect') expect(captured).not.toBeNull();
      if (scenario === 'after-effect') { expect(h.app.getApp().draftFocus).toBeNull(); await act(async () => { later.focus(); }); }
      expect(h.drafts.useDrafts.getState().drafts[h.key]!.bodyText).toBe(initial.bodyText);
      expect(h.drafts.useDrafts.getState().drafts[h.key]!.toText).toBe(initial.toText);
      for (let i = 0; i < 4; i++) await h.flush();
      if (scenario === 'ordinary') expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]'));
      else expect(document.activeElement).toBe(later);
    } finally { later.remove(); await h.cleanup(); }
  });
});

describe("selection intent", () => {

  it.each((['split', 'list'] as const).flatMap((layout) => (['key', 'passive', 'ordinary', 'successor', 'after-effect'] as const).map((scenario) => [layout, scenario] as const)))('%s ownerless selection intent %s', async (layout, scenario) => {
    const h = await setup(layout, true), { focusDraft } = await import('~/lib/compose'), { useList } = await import('~/state/list');
    const list = useList.getState(); let hit = false, requestKey: string | undefined;
    try {
      const row = { id: 7, lastDate: 1, categoryIds: [], unread: false } as unknown as ThreadSummary;
      await act(async () => { useList.setState({ items: [row], index: new Map([[7, 0]]), nextCursor: null }); h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: 'open', toText: 'synthetic@example.test' }); });
      const button = h.host.querySelector<HTMLButtonElement>('[data-testid="action-reply"]'); expect(button).not.toBeNull();
      await act(async () => { button!.focus(); }); expect(document.activeElement).toBe(button);
      const initial = h.drafts.useDrafts.getState().drafts[h.key]!, revision = h.app.getSelectionWriteRevision();
      const keydown = () => button!.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true, cancelable: true }));
      const off = h.app.useApp.subscribe((state, previous) => {
        if (!hit && state.draftFocus && state.draftFocus !== previous.draftFocus) {
          hit = true; requestKey = state.draftFocus.key;
          if (scenario === 'key' || scenario === 'successor') keydown();
          if (scenario === 'passive') h.app.setListAutoSelection(7);
          if (scenario === 'successor') focusDraft(h.key, 'to');
        }
      });
      try { await act(async () => { focusDraft(h.key, 'body'); }); } finally { off(); }
      expect(hit).toBe(true); expect(requestKey).toBe(h.key); expect(h.app.getApp().selectedId).toBe(7);
      if (scenario === 'after-effect') { expect(h.app.getApp().draftFocus).toBeNull(); await act(async () => { keydown(); }); }
      expect(h.app.getSelectionWriteRevision()).toBe(revision + (['key', 'successor', 'after-effect'].includes(scenario) ? 1 : 0));
      expect(h.drafts.useDrafts.getState().drafts[h.key]!.bodyText).toBe(initial.bodyText);
      expect(h.drafts.useDrafts.getState().drafts[h.key]!.toText).toBe(initial.toText);
      for (let i = 0; i < 4; i++) await h.flush();
      if (scenario === 'key' || scenario === 'after-effect') expect(document.activeElement).toBe(button);
      else if (scenario === 'successor') expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-to"]'));
      else expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]'));
    } finally { await act(async () => { useList.setState(list, true); }); await h.cleanup(); }
  });
});
