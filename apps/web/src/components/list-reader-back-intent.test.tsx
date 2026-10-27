// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import { setup, gate, deferred } from "./draft-presentation-r1-harness";

it("keeps the selected thread when Reader toolbar Back precedes an older first page", async () => {
  const h = await setup("list", true), waiting = deferred<{ items: typeof h.detail.thread[]; nextCursor: null }>();
  const { useList, reloadList } = await import("~/state/list");
  const next = { ...h.detail.thread, id: 8 };
  try {
    useList.setState({ key: "prior-view" });
    gate.call.mockImplementation((method: string) => method === "threads.list" ? waiting.promise : Promise.resolve({}));
    const page = reloadList();
    try {
      expect(gate.call).toHaveBeenCalledWith("threads.list", expect.anything());
      const button = h.host.querySelector<HTMLButtonElement>('[data-testid="reader-back"]')!;
      expect(button).not.toBeNull(); await act(async () => button.click());
      expect(h.app.getApp().readerOpen).toBe(false);
      await act(async () => { waiting.resolve({ items: [next], nextCursor: null }); await page; });
      expect(h.app.getApp().selectedId).toBe(7);
    } finally { waiting.resolve({ items: [next], nextCursor: null }); await page; }
  } finally { await h.cleanup(); }
});

it("lets a new-view first page select its first row after automatic page closure", async () => {
  const h = await setup("list", true), waiting = deferred<{ items: typeof h.detail.thread[]; nextCursor: null }>();
  const { useList } = await import("~/state/list");
  const next = { ...h.detail.thread, id: 8 };
  let resolve!: () => void; const finished = new Promise<void>((done) => { resolve = done; });
  const off = useList.subscribe((state, previous) => { if (previous.loading && !state.loading) resolve(); });
  try {
    useList.setState({ key: "prior-view" });
    gate.call.mockImplementation((method: string) => method === "threads.list" ? waiting.promise : Promise.resolve({}));
    await act(async () => h.app.setApp({ view: "all", selectedId: null }));
    expect(h.app.getApp().readerOpen).toBe(false);
    await act(async () => { waiting.resolve({ items: [next], nextCursor: null }); await finished; });
    expect(h.app.getApp().selectedId).toBe(8);
  } finally { off(); waiting.resolve({ items: [next], nextCursor: null }); await h.cleanup(); }
});
