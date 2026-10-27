// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { expect, it } from "vitest";
import { setup } from "./draft-presentation-r1-harness";
it("List Back expires the actual Reader while preserving identity and work", async () => {
  const h = await setup("list", true), { closePage, openThread } = await import("~/lib/page");
  try {
    expect(h.host.querySelector('[data-testid="reader"]')).not.toBeNull();
    await act(async () => closePage());
    expect(h.host.querySelector('[data-testid="reader"]')).toBeNull(); expect(h.app.getApp().selectedId).toBe(7);
    expect(h.drafts.shownDraftKey(h.drafts.useDrafts.getState().drafts, 7, null)).toBeNull();
    expect(h.drafts.useDrafts.getState().drafts[h.key]).toMatchObject({ id: 81, generation: "stable", revision: 4, bodyText: "exact authored work" });
    await act(async () => openThread(7));
    expect(h.host.querySelector('[data-draft-key]')).toBeNull();
  } finally { await h.cleanup(); }
});
it("Split readerOpen false and same-thread Strict replacement retain a mounted draft", async () => {
  const h = await setup("split", true);
  try {
    await act(async () => h.app.setApp({ readerOpen: false }));
    expect(h.host.querySelector('[data-testid="reader"]')).not.toBeNull();
    expect(h.drafts.shownDraftKey(h.drafts.useDrafts.getState().drafts, 7, null)).toBe(h.key);
    await act(async () => h.root.render(<StrictMode><h.App key="replacement" /></StrictMode>));
    expect(h.drafts.shownDraftKey(h.drafts.useDrafts.getState().drafts, 7, null)).toBe(h.key);
  } finally { await h.cleanup(); }
});
