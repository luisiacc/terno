// @vitest-environment jsdom
import { act } from "react";
import { flushSync } from "react-dom";
import { expect, it } from "vitest";
import { deferred, gate, setup } from "./draft-presentation-r1-harness";

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
    else expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]'));
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
    else expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]'));
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
    else expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]'));
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
    else expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]'));
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
