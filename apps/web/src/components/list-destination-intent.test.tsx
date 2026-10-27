// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import { setup, gate, deferred } from "./draft-presentation-r1-harness";

it.each(["new", "stored standalone", "show stored", "reply"] as const)("keeps %s when an older first page completes", async (scenario) => {
  const h = await setup("list", true);
  const { useList, reloadList } = await import("~/state/list");
  const { openCompose, showNewDraft } = await import("~/lib/compose");
  const waiting = deferred<{ items: typeof h.detail.thread[]; nextCursor: null }>();
  const source = deferred<{ threadId: number; accountId: number }>();
  const next = { ...h.detail.thread, id: 8 };
  let opening: Promise<void> | undefined;
  try {
    useList.setState({ key: "prior-view" });
    gate.call.mockImplementation((method: string) => method === "threads.list" ? waiting.promise : method === "drafts.sourceContext" ? (scenario === "reply" ? source.promise : Promise.resolve(null)) : Promise.resolve({}));
    const page = reloadList();
    try {
      expect(gate.call).toHaveBeenCalledWith("threads.list", expect.anything());
      if (scenario === "new") {
        await act(async () => { await openCompose("new", null); });
        expect(h.app.getApp().compose?.key).toBeDefined();
      } else if (scenario === "stored standalone") {
        const button = h.host.querySelector<HTMLButtonElement>('[data-testid="strip-item"]')!;
        expect(button).not.toBeNull(); button.focus(); await act(async () => button.click());
        expect(h.app.getApp().compose?.key).toBe(h.key);
      } else if (scenario === "show stored") {
        await act(async () => showNewDraft(h.key));
        expect(h.app.getApp().compose?.key).toBe(h.key);
      } else {
        h.other.focus(); await act(async () => { opening = openCompose("reply", 7); });
        expect(gate.call).toHaveBeenCalledWith("drafts.sourceContext", { messageId: 3 });
      }
      const selected = h.app.getApp().selectedId, compose = h.app.getApp().compose;
      await act(async () => { waiting.resolve({ items: [next], nextCursor: null }); await page; });
      expect(h.app.getApp().selectedId).toBe(selected);
      if (scenario === "new" || scenario === "stored standalone" || scenario === "show stored") expect(h.app.getApp().compose).toBe(compose);
      if (scenario === "reply") {
        await act(async () => { source.resolve({ threadId: 7, accountId: 1 }); await opening; });
        for (let i = 0; i < 5; i++) await h.flush();
        expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]'));
      }
    } finally { waiting.resolve({ items: [next], nextCursor: null }); source.resolve({ threadId: 7, accountId: 1 }); await page; if (opening) await opening; }
  } finally { await h.cleanup(); }
});

