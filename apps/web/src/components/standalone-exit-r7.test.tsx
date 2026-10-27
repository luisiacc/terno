// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import type { ThreadDetail } from "@terno/core";
import { setup, gate, deferred } from "./draft-presentation-r1-harness";

it.each(["successor", "ordinary"] as const)("standalone Escape respects a later Forward: %s", async (scenario) => {
  const h = await setup("split", true), waiting = deferred<ThreadDetail>(), save = deferred<void>(), { showNewDraft, openCompose, composeFocusPending } = await import("~/lib/compose"), { newFields } = await import("~/lib/compose-fields");
  let key = "", newer: Promise<void> | undefined, triggered = false;
  try {
    await act(async () => { key = h.drafts.createDraft({ ...newFields(1), bodyText: "standalone work" }); h.drafts.useDrafts.setState((s) => ({ drafts: { ...s.drafts, [key]: { ...s.drafts[key]!, id: 82, generation: "standalone", revision: 5, status: "saved" } } })); showNewDraft(key); });
    h.drafts.setDraftTransport(async (_method, p) => { await save.promise; return { ...(p as object), id: 82, generation: "standalone", revision: 6, updatedAt: 0 }; });
    for (let i = 0; i < 4; i++) await h.flush();
    const input = h.host.querySelector<HTMLElement>('[data-testid="compose-to"]'); expect(input).not.toBeNull(); input!.focus(); gate.load.mockReturnValue(waiting.promise);
    const off = h.app.useApp.subscribe((s, prev) => { if (!triggered && prev.compose?.key === key && !s.compose) { triggered = true; if (scenario === "successor") newer = openCompose("forward", 7); } });
    try {
      await act(async () => input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
      expect(triggered).toBe(true);
      if (scenario === "successor") { expect(newer).toBeDefined(); expect(composeFocusPending(7)).toBe(true); }
      await h.flush();
      if (scenario === "successor") { expect(composeFocusPending(7)).toBe(true); await act(async () => { gate.load.mockResolvedValue(h.detail); waiting.resolve(h.detail); await newer; }); for (let i = 0; i < 5; i++) await h.flush(); expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-to"]')); }
      else expect(document.activeElement).toBe(h.host.querySelector(`[data-testid="strip-item"][data-key="${key}"]`));
      expect(h.drafts.useDrafts.getState().drafts[key]).toMatchObject({ id: 82, generation: "standalone", bodyText: "standalone work" });
    } finally { off(); }
  } finally { waiting.resolve(h.detail); if (newer) await newer; save.resolve(); if (key) await act(async () => { await h.drafts.flushDraft(key); }); h.drafts.setDraftTransport((method, p) => gate.call(method, p)); await h.cleanup(); }
});
