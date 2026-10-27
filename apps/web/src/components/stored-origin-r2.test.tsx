// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import { setup, gate, deferred } from "./draft-presentation-r1-harness";
it.each(["control", "keyboard"])("stored origin revoked before the first NewMessage effect stays cancelled (%s)", async (kind) => {
  const h = await setup("split", true), newerSource = deferred<{ threadId: number; accountId: number }>();
  const { composeFocusPending } = await import("~/lib/compose");
  gate.call.mockImplementation(async (method: string) => method === "drafts.sourceContext" ? null : {});
  const off = h.app.useApp.subscribe((state) => {
    if (state.draftFocus?.key !== h.key || state.compose?.key !== h.key) return;
    off();
    if (kind === "control") h.other.focus();
    else {
      gate.call.mockImplementation((method: string) => method === "drafts.sourceContext" ? newerSource.promise : Promise.resolve({}));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true }));
    }
  });
  try {
    const button = h.host.querySelector<HTMLButtonElement>('[data-testid="strip-item"]')!; button.focus(); await act(async () => button.click());
    for (let i = 0; i < 15; i++) await h.flush();
    if (kind === "control") expect(document.activeElement).toBe(h.other);
    else { expect(document.activeElement?.closest('[data-testid="composer"]')).toBeNull(); expect(composeFocusPending(7)).toBe(true); }
  } finally { off(); newerSource.resolve({ threadId: 7, accountId: 1 }); await act(async () => {}); await h.cleanup(); }
});

it("stored standalone source mutation during publication cannot retain focus permission", async () => {
  const h = await setup("split", true);
  gate.call.mockImplementation(async (method: string) => method === "drafts.sourceContext" ? null : {});
  const off = h.app.useApp.subscribe((state) => {
    if (state.compose?.key !== h.key) return;
    off(); h.drafts.editDraft(h.key, { inReplyToMessageId: 4, showSourceContext: true, bodyText: "newer source work" });
  });
  try {
    const button = h.host.querySelector<HTMLButtonElement>('[data-testid="strip-item"]')!; button.focus(); await act(async () => button.click());
    for (let i = 0; i < 15; i++) await h.flush();
    expect(document.activeElement?.closest('[data-testid="composer"]')).toBeNull();
    expect(h.drafts.materialize(h.key)).toMatchObject({ id: 81, generation: "stable", inReplyToMessageId: 4, showSourceContext: true, bodyText: "newer source work" });
  } finally { off(); await h.cleanup(); }
});
