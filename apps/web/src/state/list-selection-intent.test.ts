// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import type { ThreadSummary } from "@terno/core";

const rpc = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: { call: rpc.call } }));
vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }));
const { useAppearance } = await import("~/lib/appearance");
const { setApp, getApp } = await import("~/state/app");
const { useList, reloadList } = await import("~/state/list");
const { pressRow } = await import("~/lib/select");
const { goBack } = await import("~/lib/page");
const row = (id: number) => ({ id, lastDate: 1000 - id, categoryIds: [], unread: false }) as unknown as ThreadSummary;
const page = { items: [row(1), row(2), row(3)], nextCursor: null };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

beforeEach(async () => {
  rpc.call.mockReset(); rpc.call.mockResolvedValue(page);
  useAppearance.setState({ layout: "list", motionMs: 0 });
  setApp({ view: "inbox", accountId: null, query: "", categoryId: null, reviewCategoryId: null, selectedId: 2, checked: new Set(), scope: null, readerOpen: false, compose: null, dialog: null, fatal: null, listFilters: new Map() });
  await Promise.resolve(); await Promise.resolve();
  useList.setState({ key: "prior-view", items: page.items, index: new Map(page.items.map((item, index) => [item.id, index])) });
});

it.each(["same id", "away and back", "same row in bulk", "Back"] as const)("does not let a first page overwrite later %s selection", async (scenario) => {
  const waiting = deferred<typeof page>(); rpc.call.mockReturnValue(waiting.promise);
  if (scenario === "same row in bulk") setApp({ checked: new Set([2, 3]) });
  if (scenario === "Back") setApp({ readerOpen: true });
  const pending = reloadList();
  try {
    expect(rpc.call).toHaveBeenCalledWith("threads.list", expect.objectContaining({ view: "inbox" }));
    if (scenario === "same id") pressRow(2, { meta: false, ctrl: false, shift: false });
    if (scenario === "away and back") { pressRow(3, { meta: false, ctrl: false, shift: false }); pressRow(2, { meta: false, ctrl: false, shift: false }); }
    if (scenario === "same row in bulk") pressRow(2, { meta: false, ctrl: false, shift: false });
    if (scenario === "Back") goBack();
    waiting.resolve(page); await pending;
    expect(getApp().selectedId).toBe(2);
  } finally { waiting.resolve(page); await pending; }
});

it("selects the first row when a first page has no later selection", async () => {
  const waiting = deferred<typeof page>(); rpc.call.mockReturnValue(waiting.promise);
  const pending = reloadList();
  try { waiting.resolve(page); await pending; expect(getApp().selectedId).toBe(1); }
  finally { waiting.resolve(page); await pending; }
});

it("does not let an older first-page response overwrite a newer one", async () => {
  const older = deferred<typeof page>(), newer = deferred<typeof page>();
  rpc.call.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  const first = reloadList(); useList.setState({ key: "another-prior-view" }); const second = reloadList();
  try {
    newer.resolve({ items: [row(3)], nextCursor: null }); await second;
    older.resolve(page); await first;
    expect(getApp().selectedId).toBe(3);
    expect(useList.getState().items.map((item) => item.id)).toEqual([3]);
  } finally { older.resolve(page); newer.resolve(page); await Promise.all([first, second]); }
});

it("honors an explicit same-id functional update without evaluating it twice", async () => {
  const waiting = deferred<typeof page>(); rpc.call.mockReturnValue(waiting.promise);
  const pending = reloadList(); let calls = 0;
  try {
    setApp((state) => { calls++; return { selectedId: state.selectedId }; });
    waiting.resolve(page); await pending;
    expect(calls).toBe(1); expect(getApp().selectedId).toBe(2);
  } finally { waiting.resolve(page); await pending; }
});

it("does not treat a same-object no-op updater as a selection", async () => {
  const waiting = deferred<typeof page>(); rpc.call.mockReturnValue(waiting.promise);
  const pending = reloadList(); let calls = 0, notifications = 0;
  const off = (await import("~/state/app")).useApp.subscribe(() => { notifications++; });
  try {
    setApp((state) => { calls++; return state; });
    expect(notifications).toBe(0);
    waiting.resolve(page); await pending;
    expect(calls).toBe(1); expect(getApp().selectedId).toBe(1);
  } finally { off(); waiting.resolve(page); await pending; }
});

it("honors a selection reentered during the page's list notification", async () => {
  const waiting = deferred<typeof page>(); rpc.call.mockReturnValue(waiting.promise);
  const pending = reloadList(); let changed = false;
  const off = useList.subscribe((state, previous) => {
    if (!changed && previous.loading && !state.loading) { changed = true; setApp({ selectedId: 2 }); }
  });
  try {
    waiting.resolve(page); await pending;
    expect(changed).toBe(true); expect(getApp().selectedId).toBe(2);
  } finally { off(); waiting.resolve(page); await pending; }
});

it("preserves a valid clamped keyboard selection while the first page waits", async () => {
  const { move } = await import("~/lib/keyboard");
  const waiting = deferred<typeof page>(); rpc.call.mockReturnValue(waiting.promise);
  useList.setState({ items: [row(2), row(3)], index: new Map([[2, 0], [3, 1]]) });
  const pending = reloadList();
  try { move(-1); waiting.resolve(page); await pending; expect(getApp().selectedId).toBe(2); }
  finally { waiting.resolve(page); await pending; }
});

it("uses the live state when an updater reenters before returning its original state", async () => {
  const waiting = deferred<typeof page>(); rpc.call.mockReturnValue(waiting.promise);
  const pending = reloadList(); let calls = 0;
  try {
    setApp((state) => { calls++; setApp({ selectedId: 3 }); return state; });
    expect(getApp().selectedId).toBe(2);
    waiting.resolve(page); await pending;
    expect(calls).toBe(1); expect(getApp().selectedId).toBe(2);
  } finally { waiting.resolve(page); await pending; }
});

it("selects the first row after a new-view navigation starts its own request", async () => {
  const waiting = deferred<typeof page>(); rpc.call.mockReturnValue(waiting.promise);
  let resolve!: () => void; const completed = new Promise<void>((done) => { resolve = done; });
  const off = useList.subscribe((state, previous) => { if (previous.loading && !state.loading) resolve(); });
  try {
    setApp({ view: "all", selectedId: null });
    waiting.resolve(page); await completed;
    expect(getApp().selectedId).toBe(1);
  } finally { off(); waiting.resolve(page); }
});

it("preserves a same-id explicit replacement and sends only its normal notification", async () => {
  const { useApp } = await import("~/state/app");
  const waiting = deferred<typeof page>(); rpc.call.mockReturnValue(waiting.promise);
  const pending = reloadList(); let notifications = 0;
  const off = useApp.subscribe(() => { notifications++; });
  try {
    const result = setApp({ ...getApp(), selectedId: 2 }, true);
    expect(result).toBeUndefined(); expect(notifications).toBe(1);
    waiting.resolve(page); await pending; expect(getApp().selectedId).toBe(2);
  } finally { off(); waiting.resolve(page); await pending; }
});

it("does not publish or protect a selection when an updater throws", async () => {
  const { useApp } = await import("~/state/app");
  const waiting = deferred<typeof page>(); rpc.call.mockReturnValue(waiting.promise);
  const pending = reloadList(); let calls = 0, notifications = 0;
  const off = useApp.subscribe(() => { notifications++; });
  try {
    expect(() => setApp(() => { calls++; throw new Error("updater failed"); })).toThrow("updater failed");
    expect(calls).toBe(1); expect(notifications).toBe(0);
    waiting.resolve(page); await pending; expect(getApp().selectedId).toBe(1);
  } finally { off(); waiting.resolve(page); await pending; }
});
