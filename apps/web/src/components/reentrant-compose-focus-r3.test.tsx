// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import type { ThreadDetail } from "@terno/core";
import { setup, gate, deferred } from "./draft-presentation-r1-harness";

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
    expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]'));
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
