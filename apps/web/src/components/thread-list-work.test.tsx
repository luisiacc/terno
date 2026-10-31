// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { ThreadSummary } from "@terno/core";
import type { ReactVirtualizerOptions } from "@tanstack/react-virtual";
import { ThreadList } from "./thread-list";
import { listKey, useList } from "~/state/list";
import { client } from "~/rpc/connection";
import { useApp } from "~/state/app";

const row = (id: number): ThreadSummary => ({ id, accountId: 1, subject: "Synthetic", snippet: "", fromName: "Sender", fromEmail: "sender@example.test", messageCount: 1, hasAttachments: false, starred: false, categoryIds: [], unread: false, lastDate: 1000 - id });

const probe = vi.hoisted(() => ({ estimates: 0, scroll: undefined as undefined | ((offset: number, scrolling: boolean) => void) }));
vi.hoisted(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }));
});
vi.mock("@tanstack/react-virtual", async (original) => {
  const real = await original<typeof import("@tanstack/react-virtual")>();
  return { ...real, useVirtualizer: (options: ReactVirtualizerOptions<HTMLDivElement, Element>) => real.useVirtualizer({
    ...options,
    estimateSize: (i) => { probe.estimates++; return options.estimateSize(i); },
    observeElementRect: (_instance, cb) => { cb({ width: 600, height: 600 }); return () => {}; },
    observeElementOffset: (_instance, cb) => { probe.scroll = cb; cb(0, false); return () => { probe.scroll = undefined; }; },
    scrollToFn: () => {},
  }) };
});
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn().mockResolvedValue({ items: [], nextCursor: null }) } }));
vi.mock("~/lib/drag-install", () => ({ installDragController: () => () => {} }));
vi.mock("~/lib/scroll-hairline", () => ({ installScrollHairline: () => () => {} }));
vi.mock("./thread-menu", () => ({ ThreadMenu: ({ children }: { children: ReactNode }) => children }));
vi.mock("./drafts-strip", () => ({ DraftsStrip: () => null }));
vi.mock("./learned-banner", () => ({ LearnedBanner: () => null }));
vi.mock("./diag/report-row", () => ({ ReportRow: () => null }));
vi.mock("~/lib/web-parts", () => ({ DesktopBanner: null }));
vi.mock("./thread-row", () => ({ ThreadRow: ({ thread, top, height }: { thread: ThreadSummary; top: number; height: number }) => <div id={`thread-${thread.id}`} data-testid="thread-row" data-thread-id={thread.id} style={{ transform: `translateY(${top}px)`, height }} /> }));

it("scrolling a 50k loaded list reuses measurements; replacements and density still remeasure", async () => {
  const app = useApp.getState(), list = useList.getState();
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const items = Array.from({ length: 50_000 }, (_, i) => row(i + 1));
  const publish = (rows: ThreadSummary[]) => useList.setState({ items: rows, index: new Map(rows.map((row, i) => [row.id, i])), loading: false, nextCursor: null });
  try {
    publish(items);
    await act(async () => root.render(<ThreadList />));
    expect(probe.estimates).toBeGreaterThanOrEqual(items.length);
    const before = probe.estimates;
    for (const offset of [1000, 3000, 5000, 5000]) await act(async () => probe.scroll!(offset, true));
    await act(async () => probe.scroll!(5000, false));
    await act(async () => root.render(<ThreadList />));
    expect(host.querySelectorAll('[data-testid="thread-row"]').length).toBeLessThanOrEqual(60);
    expect(host.querySelector('[data-testid="thread-row"]')?.getAttribute("data-thread-id")).not.toBe("1");
    expect(probe.estimates - before, "same rows must not be remeasured on scroll").toBe(0);
    const reversed = [...items].reverse();
    await act(async () => publish(reversed));
    expect(probe.estimates).toBeGreaterThan(before);
    const first = host.querySelector<HTMLElement>('[data-testid="thread-row"]')!;
    const oldHeight = first.style.height;
    const height = Number.parseFloat(oldHeight);
    const firstIndex = Math.max(0, Math.floor(5000 / height) - 10);
    expect(first.dataset.threadId).toBe(String(reversed[firstIndex]!.id));
    expect(first.style.transform).toBe(`translateY(${firstIndex * height}px)`);
    const visible = [...host.querySelectorAll<HTMLElement>('[data-testid="thread-row"]')];
    for (const [i, node] of visible.entries()) {
      expect(node.dataset.threadId).toBe(String(reversed[firstIndex + i]!.id));
      expect(node.style.transform).toBe(`translateY(${(firstIndex + i) * height}px)`);
    }
    const swapped = [...reversed];
    [swapped[firstIndex], swapped[firstIndex + 1]] = [swapped[firstIndex + 1]!, swapped[firstIndex]!];
    await act(async () => publish(swapped));
    const reordered = [...host.querySelectorAll<HTMLElement>('[data-testid="thread-row"]')];
    expect(reordered[0]).toBe(visible[1]); expect(reordered[1]).toBe(visible[0]);
    expect(reordered[0]!.style.transform).toBe(`translateY(${firstIndex * height}px)`);
    await act(async () => publish(reversed));
    const appended = [...reversed, row(50_001)];
    await act(async () => publish(appended));
    await act(async () => probe.scroll!(50_000 * height, true));
    expect(host.querySelector('[data-thread-id="50001"]')).not.toBeNull();
    await act(async () => publish(appended.slice(0, 100)));
    await act(async () => probe.scroll!(0, false));
    expect(host.querySelector('[data-thread-id="50001"]')).toBeNull();
    expect(host.querySelector('[data-testid="thread-row"]')?.getAttribute("data-thread-id")).toBe("50000");
    const replacementCount = probe.estimates;
    await act(async () => useApp.setState({ settings: { ...app.settings!, density: "compact" } }));
    expect(probe.estimates).toBeGreaterThan(replacementCount);
    const compact = host.querySelector<HTMLElement>('[data-testid="thread-row"]')!;
    expect(compact.style.height).not.toBe(oldHeight);
    const compactHeight = Number.parseFloat(compact.style.height);
    expect(compact.style.transform).toBe("translateY(0px)");
    expect(compact.parentElement!.style.height).toBe(`${100 * compactHeight}px`);
    await act(async () => probe.scroll!(compactHeight * 25, true));
    const compactFirst = host.querySelector<HTMLElement>('[data-testid="thread-row"]')!;
    expect(compactFirst.dataset.threadId).toBe(String(reversed[15]!.id));
    expect(compactFirst.style.transform).toBe(`translateY(${15 * compactHeight}px)`);
  } finally {
    await act(async () => root.unmount());
    useApp.setState(app, true); useList.setState(list, true); host.remove();
  }
});


it("the visible-range pagination trigger appends current keys once and keeps the cursor", async () => {
  const app = useApp.getState(), list = useList.getState();
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const items = Array.from({ length: 100 }, (_, i) => row(i + 1));
  let deliver!: (page: { items: ThreadSummary[]; nextCursor: null }) => void;
  const page = new Promise<{ items: ThreadSummary[]; nextCursor: null }>((resolve) => { deliver = resolve; });
  const call = vi.mocked(client.call);
  call.mockClear(); call.mockImplementation(() => page as never);
  try {
    useApp.setState({ selectedId: 75 });
    const key = listKey();
    useList.setState({ key, itemsKey: key, items, index: new Map(items.map((t, i) => [t.id, i])), loading: false, loadingMore: false, nextCursor: { id: 100, lastDate: 900 } });
    await act(async () => root.render(<ThreadList />));
    expect(call).not.toHaveBeenCalled();
    const height = Number.parseFloat(host.querySelector<HTMLElement>('[data-testid="thread-row"]')!.style.height);
    await act(async () => probe.scroll!(height * 70, true));
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]![0]).toBe("threads.list");
    await act(async () => probe.scroll!(height * 71, true));
    expect(call).toHaveBeenCalledTimes(1);
    await act(async () => { deliver({ items: [row(101), row(102)], nextCursor: null }); await page; });
    expect(useList.getState().items.map((t) => t.id)).toEqual([...items.map((t) => t.id), 101, 102]);
    expect(useApp.getState().selectedId).toBe(75);
    await act(async () => probe.scroll!(height * 95, false));
    expect(host.querySelector('[data-thread-id="102"]')?.getAttribute("id")).toBe("thread-102");
    expect(host.querySelectorAll('[data-testid="thread-row"]').length).toBeLessThanOrEqual(60);
    expect(call).toHaveBeenCalledTimes(1);
  } finally {
    deliver({ items: [], nextCursor: null }); await page;
    await act(async () => root.unmount());
    useApp.setState(app, true); useList.setState(list, true); host.remove();
    call.mockReset(); call.mockResolvedValue({ items: [], nextCursor: null } as never);
  }
});
