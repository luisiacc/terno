// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import { setup } from "./draft-presentation-r1-harness";

it.each([true, false])("inline Send respects a later control (later=%s)", async (later) => {
  const h = await setup("split", true);
  const { openCompose } = await import("~/lib/compose"), { gate, deferred } = await import("./draft-presentation-r1-harness");
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
  const { openCompose } = await import("~/lib/compose"), { deferred } = await import("./draft-presentation-r1-harness");
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
  const { openCompose } = await import("~/lib/compose"), { gate, deferred } = await import("./draft-presentation-r1-harness");
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
  const { openCompose } = await import("~/lib/compose"), { deferred } = await import("./draft-presentation-r1-harness");
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
