// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import { setup, gate } from "./draft-presentation-r1-harness";

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
        expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]'));
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
