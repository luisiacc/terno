// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Account } from "@terno/core";
const rpc = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: { call: rpc.call, on: () => () => {} } }));
vi.mock("./thread-list", async () => { const { DraftsStrip } = await import("./drafts-strip"); return { ThreadList: () => <DraftsStrip /> }; });
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
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }

for (const layout of ["split", "list"] as const) it.each(["authored successor", "untouched successor", "outside focus", "outside roundtrip", "same-key strip", "rejected", "ordinary"] as const)(`${layout}: an earlier Send respects %s`, async (scenario) => {
  const { App } = await import("~/app"), drafts = await import("~/lib/drafts"), app = await import("~/state/app"), { useAppearance } = await import("~/lib/appearance"), { useList } = await import("~/state/list");
  const previous = app.getApp(), list = useList.getState(), appearance = useAppearance.getState();
  const account = { id: 1, kind: "imap", email: "me@example.test", displayName: "Me", signature: "", color: "blue", syncState: {} } as Account;
  const send = deferred<{ threadId: number }>(), entered = deferred<void>(); let sends = 0, saves = 0;
  rpc.call.mockImplementation(async (method) => { if (method === "compose.send") { sends++; entered.resolve(); return send.promise; } return []; });
  drafts.setDraftTransport(async (_method, params) => ({ ...params as object, id: 100 + ++saves, generation: "stable", revision: 1, updatedAt: 0 }));
  const frames = new Map<number, FrameRequestCallback>(); let n = 0;
  const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { frames.set(++n, cb); return n; }), cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  const host = document.createElement("div"), outside = document.createElement("button"), another = document.createElement("button"); document.body.append(host, outside, another); const root = createRoot(host);
  try {
    useAppearance.setState({ layout, motionMs: 0 }); useList.setState({ items: [], index: new Map() });
    app.setApp({ ready: true, accounts: [account], accountId: 1, selectedId: null, readerOpen: false, compose: null, checked: new Set(), scope: null, draftFocus: null, draftShown: null, dialog: null, fatal: null });
    await act(async () => root.render(<StrictMode><App /></StrictMode>));
    const composeButton = host.querySelector<HTMLButtonElement>('[data-testid="compose-button"]')!; expect(composeButton).not.toBeNull();
    await act(async () => composeButton.click());
    const original = app.getApp().compose!; expect(original).not.toBeNull();
    await act(async () => { drafts.editDraft(original.key, { toText: "ana@example.test", bodyText: "original work", bodyHtml: "<p>original work</p>" }); });
    const form = host.querySelector<HTMLFormElement>('[data-testid="composer"]')!; expect(form).not.toBeNull();
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await entered.promise; expect(sends).toBe(1); expect(drafts.useDrafts.getState().drafts[original.key]?.sending).toBe(true);
    let successor: typeof original | undefined, focus: HTMLElement | null = null;
    if (scenario === "authored successor" || scenario === "untouched successor") {
      await act(async () => composeButton.click());
      successor = app.getApp().compose!; expect(successor.key).not.toBe(original.key);
      if (scenario === "authored successor") await act(async () => { drafts.editDraft(successor!.key, { subject: "later subject", subjectEdited: true, toText: "unfinished@", bodyText: "new work", bodyHtml: "<p>new work</p>" }); });
      focus = host.querySelector<HTMLElement>(scenario === "authored successor" ? '[data-testid="compose-subject"]' : '[data-testid="compose-to"]')!;
      expect(focus).not.toBeNull();
      await act(async () => { focus!.focus(); if (focus instanceof HTMLInputElement && scenario === "authored successor") focus.setSelectionRange(2, 7); });
      expect(document.activeElement).toBe(focus);
    } else if (scenario === "outside focus" || scenario === "outside roundtrip") { outside.focus(); if (scenario === "outside roundtrip") { another.focus(); outside.focus(); } expect(document.activeElement).toBe(outside); }
    else if (scenario === "same-key strip") {
      const item = host.querySelector<HTMLButtonElement>(`[data-testid="strip-item"][data-key="${original.key}"]`);
      expect(item).not.toBeNull();
      await act(async () => item!.click());
      expect(app.getApp().compose).toBe(original);
    }
    if (scenario === "rejected") await act(async () => { send.reject(new Error("offline")); await send.promise.catch(() => {}); });
    else await act(async () => { send.resolve({ threadId: 9 }); await send.promise; });
    if (scenario === "rejected") { expect(app.getApp().compose).toBe(original); expect(drafts.useDrafts.getState().drafts[original.key]).toMatchObject({ bodyText: "original work", sending: false }); }
    else if (scenario === "ordinary" || scenario === "outside focus" || scenario === "outside roundtrip" || scenario === "same-key strip") { expect(app.getApp().compose).toBeNull(); if (scenario === "outside focus" || scenario === "outside roundtrip") expect(document.activeElement).toBe(outside); }
    else {
      expect(app.getApp().compose).toBe(successor);
      expect(drafts.useDrafts.getState().drafts[successor!.key]).toBeDefined();
      if (scenario === "authored successor") expect(drafts.useDrafts.getState().drafts[successor!.key]).toMatchObject({ subject: "later subject", toText: "unfinished@", bodyText: "new work", bodyHtml: "<p>new work</p>" });
      expect(document.activeElement).toBe(focus);
      if (scenario === "authored successor") expect([ (focus as HTMLInputElement).selectionStart, (focus as HTMLInputElement).selectionEnd ]).toEqual([2, 7]);
    }
    expect(sends).toBe(1); if (scenario !== "rejected") expect(drafts.useDrafts.getState().drafts[original.key]).toBeUndefined();
  } finally { send.resolve({ threadId: 9 }); await act(async () => root.unmount()); for (const key of Object.keys(drafts.useDrafts.getState().drafts)) drafts.forgetDraft(key); drafts.setDraftTransport(async () => null); app.useApp.setState(previous, true); useList.setState(list, true); useAppearance.setState(appearance, true); host.remove(); outside.remove(); another.remove(); raf.mockRestore(); cancel.mockRestore(); rpc.call.mockReset(); }
});
