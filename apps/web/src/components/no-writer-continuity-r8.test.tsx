// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import type { ThreadDetail } from "@terno/core";
import { setup, gate, deferred } from "./draft-presentation-r1-harness";

it.each(["absent attach dispose", "replacement", "reset", "coalesced edit", "writer appears", "target restoration", "ordinary"] as const)("no-writer conversion retains original source continuity: %s", async (scenario) => {
  const h = await setup("split", true), loading = deferred<ThreadDetail>(), entered = deferred<void>();
  const { openCompose, supersedeCompose } = await import("~/lib/compose"), { resetSnacks, useSnack } = await import("~/lib/snack");
  let source: ReturnType<typeof h.drafts.attachBody> | undefined, replacement: ReturnType<typeof h.drafts.attachBody> | undefined, opening: Promise<void> | undefined;
  try {
    resetSnacks();
    await act(async () => { h.drafts.useDrafts.setState((state) => ({ drafts: { ...state.drafts, [h.key]: { ...state.drafts[h.key]!, threadId: 7, showSourceContext: false, inReplyToMessageId: 3 } } })); });
    const before = h.drafts.useDrafts.getState().drafts[h.key]!;
    if (scenario !== "absent attach dispose") source = h.drafts.attachBody(h.key, () => ({ text: before.bodyText, html: before.bodyHtml }));
    gate.load.mockImplementation(async () => { entered.resolve(); return loading.promise; });
    await act(async () => { opening = openCompose("replyAll", 7); });
    await Promise.race([entered.promise, opening!.then(() => { throw new Error("Conversion finished before its gated load"); })]);
    expect(h.drafts.useDrafts.getState().drafts[h.key]).toBe(before);
    if (scenario === "absent attach dispose") { replacement = h.drafts.attachBody(h.key, () => ({ text: before.bodyText, html: before.bodyHtml })); replacement.dispose(); }
    if (scenario === "replacement") { replacement = h.drafts.attachBody(h.key, () => ({ text: before.bodyText, html: before.bodyHtml })); replacement.dispose(); source = h.drafts.attachBody(h.key, () => ({ text: before.bodyText, html: before.bodyHtml })); }
    if (scenario === "reset") source!.reset();
    if (scenario === "coalesced edit") { await act(async () => { source!.changed(); source!.changed(); }); }
    if (scenario === "writer appears") h.drafts.retryDraft(h.key);
    if (scenario === "target restoration") await act(async () => { h.drafts.useDrafts.setState((state) => ({ drafts: { ...state.drafts, [h.key]: { ...before, accountId: 99 } } })); h.drafts.useDrafts.setState((state) => ({ drafts: { ...state.drafts, [h.key]: before } })); });
    await act(async () => { loading.resolve(h.detail); await opening; });
    const after = h.drafts.useDrafts.getState().drafts[h.key]!;
    if (scenario === "ordinary") expect(after.mode).toBe("replyAll");
    else { expect(after.mode).toBe("reply"); expect(h.app.getApp().draftFocus).toBeNull(); expect(useSnack.getState().undo).toBeNull(); }
    expect(after).toMatchObject({ key: h.key, id: before.id, generation: before.generation, revision: before.revision, bodyText: before.bodyText, bodyHtml: before.bodyHtml });
  } finally { loading.resolve(h.detail); if (opening) await opening; supersedeCompose(); source?.dispose(); replacement?.dispose(); await h.cleanup(); }
});

it("an older no-writer completion cannot cancel a newer conversion", async () => {
  const h = await setup("split", true), first = deferred<ThreadDetail>(), second = deferred<ThreadDetail>();
  const { openCompose, supersedeCompose } = await import("~/lib/compose");
  let one: Promise<void> | undefined, two: Promise<void> | undefined, loads = 0;
  try {
    await act(async () => { h.drafts.useDrafts.setState((state) => ({ drafts: { ...state.drafts, [h.key]: { ...state.drafts[h.key]!, threadId: 7, showSourceContext: false, inReplyToMessageId: 3 } } })); });
    gate.load.mockImplementation(async () => (++loads === 1 ? first.promise : second.promise));
    await act(async () => { one = openCompose("replyAll", 7); });
    await act(async () => { two = openCompose("forward", 7); });
    expect(loads).toBe(2);
    await act(async () => { first.resolve(h.detail); await one; });
    expect(h.drafts.useDrafts.getState().drafts[h.key]?.mode).toBe("reply");
    await act(async () => { second.resolve(h.detail); await two; });
    expect(h.drafts.useDrafts.getState().drafts[h.key]?.mode).toBe("forward");
  } finally { first.resolve(h.detail); second.resolve(h.detail); await Promise.allSettled([one, two].filter((p): p is Promise<void> => Boolean(p))); supersedeCompose(); await h.cleanup(); }
});

it("converts an untouched no-writer reply without fabricating a saved draft", async () => {
  const h = await setup("split", true), loading = deferred<ThreadDetail>();
  const { openCompose, supersedeCompose } = await import("~/lib/compose"), { replyFields } = await import("~/lib/compose-fields");
  let key = "", opening: Promise<void> | undefined;
  try {
    await act(async () => {
      h.drafts.forgetDraft(h.key);
      key = h.drafts.createDraft(replyFields("reply", h.detail, h.app.getApp().accounts[0]!));
      h.app.setApp({ draftShown: { threadId: 7, key } });
    });
    expect(h.drafts.useDrafts.getState().drafts[key]).toMatchObject({ id: null, localRev: 0, status: "clean" });
    gate.load.mockReturnValue(loading.promise);
    await act(async () => { opening = openCompose("replyAll", 7); });
    await act(async () => { loading.resolve(h.detail); await opening; });
    expect(h.drafts.useDrafts.getState().drafts[key]).toMatchObject({ key, id: null, mode: "replyAll" });
  } finally { loading.resolve(h.detail); if (opening) await opening; supersedeCompose(); await h.cleanup(); }
});
