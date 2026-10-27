// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Account, ThreadDetail, ThreadSummary } from "@terno/core";

const gate = vi.hoisted(() => ({ load: vi.fn(), call: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: { call: gate.call } }));
vi.mock("~/state/threads", async (original) => ({ ...await original<typeof import("~/state/threads")>(), loadThread: gate.load }));
vi.mock("./sidebar", () => ({ Sidebar: () => null }));
vi.mock("./thread-list", () => ({ ThreadList: () => null }));
vi.mock("./pane-handle", () => ({ PaneHandle: () => null }));
vi.mock("./snack-dock", () => ({ SnackDock: () => null }));
vi.mock("./command-palette", () => ({ CommandPalette: () => null }));
vi.mock("./category-picker", () => ({ CategoryPicker: () => null }));
vi.mock("./diag/report-preview", () => ({ ReportPreview: () => null }));
vi.mock("./diag/engine-stopped", () => ({ EngineStopped: () => null }));
vi.mock("./drag-ghost", () => ({ DragGhost: () => null }));
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }));
HTMLElement.prototype.scrollIntoView = () => {};
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect();

it.each([
  { target: 7, selection: "all", rows: 2, earlyClear: false },
  { target: 7, selection: "all", rows: 2, earlyClear: true },
  { target: 8, selection: "all", rows: 2, earlyClear: true },
  { target: 7, selection: "scope", rows: 0, earlyClear: true },
  { target: 7, selection: "scope", rows: 1, earlyClear: true },
  { target: 7, selection: "single", rows: 1, earlyClear: false },
] as const)("cancels target $target on $selection with $rows rows (clear early: $earlyClear)", async ({ target, selection, rows: rowCount, earlyClear }) => {
  const { App } = await import("~/app");
  const { openCompose, composeFocusPending } = await import("~/lib/compose");
  const { selectAll, selectScope, clearSelection } = await import("~/lib/select");
  const { useThreads } = await import("~/state/threads");
  const { useList } = await import("~/state/list");
  const { useApp, setApp } = await import("~/state/app");
  const { useAppearance } = await import("~/lib/appearance");
  const { useDrafts, forgetDraft } = await import("~/lib/drafts");
  const account = { id: 1, kind: "imap", email: "me@example.test", displayName: "Me", signature: "", color: "blue", syncState: {} } as Account;
  const detail = { thread: { id: target, accountId: 1, subject: "Subject", categoryIds: [], inSpam: false, inTrash: false }, messages: [{ id: 3, accountId: 1, attachmentState: "complete", isSent: false, from: { name: "Sender", email: "sender@example.test" }, to: [], cc: [], subject: "Subject", date: 0, bodyText: "Body", attachments: [] }] } as unknown as ThreadDetail;
  const rows = (selection === "single" ? [{ id: 8 }] : [{ id: 7 }, { id: 8 }].slice(0, rowCount)) as ThreadSummary[];
  let resolve!: (value: ThreadDetail) => void; const waiting = new Promise<ThreadDetail>((r) => { resolve = r; });
  gate.load.mockReturnValue(waiting); gate.call.mockImplementation((method: string) => Promise.resolve(method === "drafts.sourceContext" ? { threadId: target, accountId: 1 } : {}));
  const frames = new Map<number, FrameRequestCallback>(); let next = 0;
  const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { frames.set(++next, cb); return next; });
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  const host = document.createElement("div"), outside = document.createElement("button"); document.body.append(host, outside); const root = createRoot(host);
  useAppearance.setState({ layout: "split", motionMs: 0 }); useList.setState({ items: rows });
  setApp({ ready: true, accounts: [account], selectedId: 7, accountId: 1, checked: new Set(), scope: null, draftFocus: null, draftShown: null, dialog: null, fatal: null });
  let opening: Promise<void> | undefined;
  const flush = async () => act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((cb) => cb(0)); });
  try {
    await act(async () => root.render(<StrictMode><App /></StrictMode>));
    expect(host.querySelector('[data-testid="reader"]')).not.toBeNull(); outside.focus();
    await act(async () => { opening = openCompose("reply", target); });
    await act(async () => { if (selection === "all") selectAll(); else if (selection === "scope") selectScope(20); else setApp({ checked: new Set([8]) }); });
    expect(useApp.getState().selectedId).toBe(7); expect(useApp.getState().checked.size).toBe(rowCount);
    expect(useApp.getState().scope !== null).toBe(selection === "scope");
    if (selection === "single") {
      expect(host.querySelector('[data-testid="reader"]')).not.toBeNull();
      await act(async () => { useThreads.setState({ details: new Map([[target, detail]]) }); gate.load.mockResolvedValue(detail); resolve(detail); await opening; }); await flush();
      expect(document.activeElement).toBe(host.querySelector('[data-testid="compose-body"]') ?? host.querySelector('[data-testid="compose-body-loading"]'));
      return;
    }
    expect(host.querySelector('[data-testid="selection-bar"]')).not.toBeNull(); expect(host.querySelector('[data-testid="reader"]')).toBeNull();
    if (earlyClear) await act(async () => { clearSelection(); });
    await act(async () => { useThreads.setState({ details: new Map([[target, detail]]) }); gate.load.mockResolvedValue(detail); resolve(detail); await opening; });
    await act(async () => { clearSelection(); }); await flush();
    expect(document.activeElement).toBe(outside);
    expect(useApp.getState().draftFocus).toBeNull(); expect(composeFocusPending(7)).toBe(false);
    expect(Object.keys(useDrafts.getState().drafts)).toHaveLength(0);
    if (target === 7) {
      await act(async () => { await openCompose("reply", 7); }); await flush();
      expect(document.activeElement).toBe(host.querySelector('[data-testid="compose-body"]') ?? host.querySelector('[data-testid="compose-body-loading"]'));
    }
  } finally {
    resolve(detail); if (opening) await opening; await act(async () => root.unmount());
    for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key);
    useThreads.setState({ details: new Map(), gone: new Set() }); useList.setState({ items: [] });
    host.remove(); outside.remove(); raf.mockRestore(); cancel.mockRestore(); gate.load.mockReset(); gate.call.mockReset();
  }
});
