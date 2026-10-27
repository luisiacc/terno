// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import { setup } from "./draft-presentation-r1-harness";

it.each(["replace", "ordinary", "unwritten replace", "unwritten ordinary"] as const)("conversion validates the draft after synchronous publication: %s", async (scenario) => {
  const h = await setup("split", true), { openCompose, composeFocusPending } = await import("~/lib/compose");
  let triggered = false;
  try {
    if (scenario.startsWith("unwritten")) await act(async () => h.drafts.useDrafts.setState((s) => ({ drafts: { ...s.drafts, [h.key]: { ...s.drafts[h.key]!, bodyText: "", bodyHtml: "", localRev: 0, subjectEdited: false, attachments: [] } } })));
    h.other.focus();
    const off = h.drafts.useDrafts.subscribe((state, previous) => {
      if (!triggered && previous.drafts[h.key]?.mode === "reply" && state.drafts[h.key]?.mode === "replyAll") {
        triggered = true;
        if (scenario.endsWith("replace")) h.drafts.editDraft(h.key, { inReplyToMessageId: 4, threadId: null, showSourceContext: false, bodyText: "newer body", bodyHtml: "<p>newer body</p>", toText: "newer@example.test" });
      }
    });
    try {
      await act(async () => { await openCompose("replyAll", 7); });
      expect(triggered).toBe(true);
      if (scenario.endsWith("replace")) {
        expect(h.drafts.materialize(h.key)).toMatchObject({ id: 81, generation: "stable", inReplyToMessageId: 4, bodyText: "newer body", bodyHtml: "<p>newer body</p>", toText: "newer@example.test" });
        expect(h.app.getApp().draftFocus).toBeNull(); expect(composeFocusPending(7)).toBe(false);
      } else { for (let i = 0; i < 5; i++) await h.flush(); expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]')); }
    } finally { off(); }
  } finally { await h.cleanup(); }
});

it.each(["focus publication", "undo registration"] as const)("conversion stops stale feedback after a later edit during %s", async (phase) => {
  const h = await setup("split", true), { openCompose, composeFocusPending } = await import("~/lib/compose"), { useSnack } = await import("~/lib/snack");
  let triggered = false;
  try {
    h.other.focus();
    const before = useSnack.getState();
    const replace = () => { triggered = true; h.drafts.editDraft(h.key, { inReplyToMessageId: 4, threadId: null, showSourceContext: false, bodyText: "later work" }); };
    const off = phase === "focus publication" ? h.app.useApp.subscribe((state) => { if (!triggered && state.draftFocus?.key === h.key) replace(); }) : useSnack.subscribe((state, previous) => { if (!triggered && state.undo !== previous.undo && state.undo) replace(); });
    try {
      await act(async () => { await openCompose("replyAll", 7); });
      expect(triggered).toBe(true);
      expect(h.drafts.materialize(h.key)).toMatchObject({ inReplyToMessageId: 4, bodyText: "later work" });
      expect(useSnack.getState().current).toBe(before.current);
      expect(h.app.getApp().draftFocus).toBeNull(); expect(composeFocusPending(7)).toBe(false);
      if (phase === "undo registration") expect(useSnack.getState().undo).toBeNull();
    } finally { off(); }
  } finally { await h.cleanup(); }
});
