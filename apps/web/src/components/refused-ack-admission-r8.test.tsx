// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import type { ThreadDetail } from "@terno/core";
import { setup, gate, deferred } from "./draft-presentation-r1-harness";

it.each(["UI roundtrip", "ordinary"] as const)("saving-publication conversion does not rebase on %s", async (scenario) => {
  const h = await setup("split", true), loading = deferred<ThreadDetail>(), entered = deferred<void>(), ack = deferred<unknown>();
  const { openCompose, supersedeCompose } = await import("~/lib/compose"), { resetSnacks, useSnack } = await import("~/lib/snack");
  let opening: Promise<void> | undefined, saving: Promise<void> | undefined, off = () => {}, calls = 0;
  try {
    resetSnacks();
    await act(async () => { h.drafts.useDrafts.setState((state) => ({ drafts: { ...state.drafts, [h.key]: { ...state.drafts[h.key]!, threadId: 7, showSourceContext: false, inReplyToMessageId: 3 } } })); h.drafts.editDraft(h.key, { bodyText: "exact work", bodyHtml: "<p>exact work</p>" }); });
    const before = h.drafts.useDrafts.getState().drafts[h.key]!;
    h.drafts.setDraftTransport(async (_method, params) => { calls++; await ack.promise; return { ...params as object, id: before.id, generation: before.generation, revision: before.revision + 1, updatedAt: 0 }; });
    gate.load.mockImplementation(async () => { entered.resolve(); return loading.promise; });
    off = h.drafts.useDrafts.subscribe((state, previous) => {
      if (scenario === "UI roundtrip" && !opening && state.drafts[h.key]?.status === "saving" && previous.drafts[h.key]?.status !== "saving") opening = openCompose("replyAll", 7);
    });
    await act(async () => { saving = h.drafts.flushDraft(h.key); if (scenario === "ordinary") opening = openCompose("replyAll", 7); });
    const reachedLoad = await Promise.race([entered.promise.then(() => true), opening!.then(() => false), saving!.then(() => { throw new Error("Save completed before its gate"); })]);
    expect(opening).toBeDefined(); expect(calls).toBe(1);
    expect(h.drafts.useDrafts.getState().drafts[h.key]).toMatchObject({ key: h.key, id: before.id, generation: before.generation, revision: before.revision, mode: "reply", bodyText: "exact work" });
    if (scenario === "UI roundtrip") await act(async () => { h.drafts.setDraftUi(h.key, "collapsed"); h.drafts.setDraftUi(h.key, "open"); });
    await act(async () => { if (reachedLoad) loading.resolve(h.detail); await opening; });
    const after = h.drafts.useDrafts.getState().drafts[h.key]!;
    if (scenario === "UI roundtrip") { expect(after.mode).toBe("reply"); expect(h.app.getApp().draftFocus).toBeNull(); expect(useSnack.getState().undo).toBeNull(); }
    else expect(after.mode).toBe("replyAll");
    expect(after).toMatchObject({ key: h.key, bodyText: "exact work", bodyHtml: "<p>exact work</p>" });
  } finally { off(); loading.resolve(h.detail); ack.resolve(null); await Promise.allSettled([opening, saving].filter((p): p is Promise<void> => Boolean(p))); supersedeCompose(); h.drafts.setDraftTransport(async () => null); await h.cleanup(); }
});
