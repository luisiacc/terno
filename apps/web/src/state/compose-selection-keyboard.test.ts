// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import type { ThreadSummary } from "@terno/core";
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn(), on: () => () => {} } }));
vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }));
const { useAppearance } = await import("~/lib/appearance");
const { useList } = await import("~/state/list");
const { getApp, setApp, useApp, subscribeComposeSelectionIntent } = await import("~/state/app");
const { move } = await import("~/lib/keyboard");

it("notifies the current conversion when keyboard movement clamps to the selected row", () => {
  const previous = getApp(), list = useList.getState(), appearance = useAppearance.getState();
  const row = { id: 7, lastDate: 1, categoryIds: [], unread: false } as unknown as ThreadSummary;
  let retired = 0;
  try {
    useAppearance.setState({ layout: "split" });
    setApp({ selectedId: 7, checked: new Set(), scope: null });
    useList.setState({ items: [row], index: new Map([[7, 0]]), nextCursor: null });
    const stop = subscribeComposeSelectionIntent(() => { retired++; });
    try { move(-1); expect(getApp().selectedId).toBe(7); expect(retired).toBe(1); }
    finally { stop(); }
  } finally { useApp.setState(previous, true); useList.setState(list, true); useAppearance.setState(appearance, true); }
});
