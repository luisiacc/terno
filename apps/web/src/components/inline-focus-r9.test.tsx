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
  } finally { deletion.resolve(); h.drafts.setDraftTransport(async () => null); await h.cleanup(); }
});
