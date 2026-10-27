// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import { setup, gate, deferred } from "../draft-presentation-r1-harness";

it.each([true, false])("the rich controller refuses commands at the synchronous Send lock (reenter=%s)", async (reenter) => {
  const drafts = await import("~/lib/drafts"), { controllerFor } = await import("./controller"), { loadComposer } = await import("./lazy");
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
    await act(async () => { await loadComposer(); await openCompose("reply", 7); });
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
  const h = await setup("split", true), { controllerFor } = await import("./controller"), { loadComposer } = await import("./lazy"), { openCompose } = await import("~/lib/compose");
  let saved: Record<string, unknown> | undefined;
  h.drafts.setDraftTransport(async (_method, params) => { saved = params as Record<string, unknown>; return { ...saved, id: 81, generation: "stable", revision: 5, updatedAt: 0 }; });
  try {
    await act(async () => { await loadComposer(); await openCompose("reply", 7); });
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
  const h = await setup("split", true), { controllerFor } = await import("./controller"), { loadComposer } = await import("./lazy"), { openCompose, sendDraft } = await import("~/lib/compose");
  const wait = deferred<{ threadId: number }>(), entered = deferred<void>(); let request: Record<string, unknown> | undefined, pending: Promise<boolean> | undefined;
  gate.call.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === "drafts.sourceContext") return { threadId: 7, accountId: 1 };
    if (method === "compose.send") { request = params; entered.resolve(); return wait.promise; }
    return {};
  });
  let revision = 4;
  h.drafts.setDraftTransport(async (_method, params) => ({ ...params as object, id: 81, generation: "stable", revision: ++revision, updatedAt: 0 }));
  try {
    await act(async () => { await loadComposer(); await openCompose("reply", 7); });
    for (let i = 0; i < 4; i++) await h.flush();
    const controller = controllerFor(h.key)!; expect(controller).not.toBeNull();
    await act(async () => { h.drafts.editDraft(h.key, { toText: "person@example.test" }); controller.run("quote"); });
    expect(controller.dom.querySelector("blockquote")).not.toBeNull();
    await act(async () => { pending = sendDraft(h.key); });
    await entered.promise;
    expect(String(request!.bodyHtml)).toContain("<blockquote");
  } finally { wait.resolve({ threadId: 7 }); await act(async () => { await pending?.catch(() => {}); }); h.drafts.setDraftTransport(async () => null); await h.cleanup(); }
});
