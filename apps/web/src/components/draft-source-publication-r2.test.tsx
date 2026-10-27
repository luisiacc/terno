// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import { setup, gate } from "./draft-presentation-r1-harness";
it.each(["invalidate", "validate"])("stored publication cannot adopt another active source at %s", async (publication) => {
  const h = await setup("list");
  gate.call.mockImplementation(async (method: string, p: { messageId: number }) => method === "drafts.sourceContext" ? { threadId: p.messageId === 3 ? 7 : 8, accountId: 1 } : {});
  const off = h.drafts.useDrafts.subscribe((state, before) => {
    const next = state.drafts[h.key], previous = before.drafts[h.key];
    if (!next || !previous) return;
    const hit = publication === "invalidate" ? !previous.presentationExpired && next.presentationExpired : previous.presentationExpired && !next.presentationExpired;
    if (hit) { off(); h.drafts.editDraft(h.key, { inReplyToMessageId: 4, showSourceContext: true, bodyText: "latest S2 work" }); }
  });
  try {
    const button = h.host.querySelector<HTMLButtonElement>('[data-testid="strip-item"]')!; button.focus(); await act(async () => button.click());
    for (let i = 0; i < 5; i++) await h.flush();
    expect(h.app.getApp().draftShown?.key).not.toBe(h.key);
    expect(h.app.getApp().draftFocus).toBeNull();
    expect(h.drafts.shownDraftKey(h.drafts.useDrafts.getState().drafts, 7, null)).toBeNull();
    expect(h.drafts.useDrafts.getState().drafts[h.key]).toMatchObject({ inReplyToMessageId: 4, bodyText: "latest S2 work", showSourceContext: true, id: 81, generation: "stable" });
    if (publication === "invalidate") expect(gate.load).not.toHaveBeenCalled();
  } finally { off(); await h.cleanup(); }
});

it("stored open rejects a baseline changed synchronously by materializing its editor", async () => {
  const h = await setup("list"), source = h.drafts.attachBody(h.key, () => ({ text: "materialized S1 body", html: "<div>materialized S1 body</div>" }));
  source.changed();
  const off = h.drafts.useDrafts.subscribe((state, before) => {
    if (state.drafts[h.key]?.bodyText === before.drafts[h.key]?.bodyText) return;
    off(); h.drafts.editDraft(h.key, { inReplyToMessageId: 4, showSourceContext: true, bodyText: "latest S2 work" });
  });
  try {
    const button = h.host.querySelector<HTMLButtonElement>('[data-testid="strip-item"]')!; button.focus(); await act(async () => button.click());
    for (let i = 0; i < 5; i++) await h.flush();
    expect(gate.call.mock.calls.filter(([method]) => method === "drafts.sourceContext")).toEqual([]);
    expect(h.app.getApp().draftShown?.key).not.toBe(h.key);
    expect(h.drafts.materialize(h.key)).toMatchObject({ inReplyToMessageId: 4, bodyText: "latest S2 work", id: 81, generation: "stable" });
  } finally { off(); source.dispose(); await h.cleanup(); }
});
