// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { vi } from "vitest";
import type { Account, ThreadDetail } from "@terno/core";
type OwnedRpcOption = typeof import("./draft-presentation-owned-rpc")["presentationOwnedRpc"];
const gate = vi.hoisted(() => ({ load: vi.fn(), call: vi.fn(), ownedCall: undefined as undefined | ((method: string, params: unknown) => unknown) }));
// The unopted route remains the exact original gate.call mock object.
vi.mock("~/rpc/connection", () => ({ client: { get call() { return gate.ownedCall ?? gate.call; } } }));
vi.mock("~/state/threads", async (original) => ({ ...await original<typeof import("~/state/threads")>(), loadThread: gate.load }));
vi.mock("./sidebar", () => ({ Sidebar: () => null }));
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
export function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { resolve, promise }; }
export async function setup(layout: "list" | "split", reader = false, options: { rpc?: OwnedRpcOption } = {}) {
  if (gate.ownedCall) throw new Error("Presentation RPC owner is still active");
  options.rpc?.available();
  const { App } = await import("~/app"), drafts = await import("~/lib/drafts"), app = await import("~/state/app"), { useThreads } = await import("~/state/threads"), { useList } = await import("~/state/list"), { useAppearance } = await import("~/lib/appearance");
  const { newFields } = await import("~/lib/compose-fields");
  const prior = options.rpc ? {
    keys: new Set(Object.keys(drafts.useDrafts.getState().drafts)), threads: useThreads.getState(),
    app: app.useApp.getState(), list: useList.getState(), appearance: useAppearance.getState(),
  } : undefined;
  if (prior?.keys.size) throw new Error("Owned presentation RPC cannot acquire live drafts");
  const rpc = options.rpc?.begin();
  const ownedCall = rpc ? (method: string, params: unknown) => options.rpc!.call(method, params, () => gate.call(method, params)) : undefined;
  if (ownedCall) gate.ownedCall = ownedCall;
  let host: HTMLDivElement | undefined, other: HTMLButtonElement | undefined;
  let root: ReturnType<typeof createRoot> | undefined, raf: { mockRestore(): void } | undefined, cancel: { mockRestore(): void } | undefined;
  let ownedCleanup: Promise<void> | undefined;
  const frames = new Map<number, FrameRequestCallback>(); let next = 0;
  const retireOwned = () => ownedCleanup ??= rpc!.retire((async () => {
    const errors: unknown[] = [];
    try { if (root) await act(async () => root!.unmount()); } catch (error) { errors.push(error); }
    for (const key of Object.keys(drafts.useDrafts.getState().drafts)) {
      try { if (!prior!.keys.has(key)) drafts.forgetDraft(key); } catch (error) { errors.push(error); }
    }
    try { useThreads.setState(prior!.threads, true); app.useApp.setState(prior!.app, true); useList.setState(prior!.list, true); useAppearance.setState(prior!.appearance, true); } catch (error) { errors.push(error); }
    host?.remove(); other?.remove(); raf?.mockRestore(); cancel?.mockRestore(); frames.clear();
    if (errors.length) throw new AggregateError(errors, "Owned presentation renderer cleanup");
  })()).then(() => {
    if (gate.ownedCall !== ownedCall) throw new Error("Owned presentation RPC route changed during retirement");
    gate.ownedCall = undefined; gate.call.mockReset(); gate.load.mockReset();
  });
  try {
  rpc?.seed();
  const account = { id: 1, kind: "imap", email: "me@example.test", displayName: "Me", signature: "", color: "blue", syncState: {} } as Account;
  const detail = { thread: { id: 7, accountId: 1, subject: "Source", categoryIds: [], inSpam: false, inTrash: false }, messages: [{ id: 3, accountId: 1, attachmentState: "complete", isSent: false, from: { name: "Sender", email: "sender@example.test" }, to: [], cc: [], subject: "Source", date: 0, bodyText: "Source body", attachments: [] }] } as unknown as ThreadDetail;
  gate.call.mockImplementation(rpc ? options.rpc!.defaultCall : async (method: string) => { if (method === "drafts.sourceContext") return { threadId: 7, accountId: 1 }; return {}; }); gate.load.mockImplementation(async (id: number) => { useThreads.setState((s) => ({ details: new Map(s.details).set(id, detail) })); return detail; });
  const key = drafts.createDraft({ ...newFields(1), threadId: null, mode: "reply", inReplyToMessageId: 3, showSourceContext: true, bodyText: "exact authored work" });
  if (rpc) {
    const { composeFocusPending } = await import("~/lib/compose");
    rpc.observe(drafts, app, () => composeFocusPending(7), key);
  }
  drafts.useDrafts.setState((s) => ({ drafts: { ...s.drafts, [key]: { ...s.drafts[key]!, id: 81, generation: "stable", revision: 4, status: "saved", sourceContextThreadId: 7 } } }));
  useAppearance.setState({ layout, motionMs: 0 }); useList.setState({ items: [], index: new Map() });
  useThreads.setState({ details: reader ? new Map([[7, detail]]) : new Map(), gone: new Set() });
  app.setApp({ accounts: [account], accountId: 1, readerOpen: false, compose: null });
  app.setApp({ ready: true, accounts: [account], accountId: 1, selectedId: reader ? 7 : null, readerOpen: reader, compose: null, checked: new Set(), scope: null, draftFocus: null, draftShown: null, dialog: null, fatal: null });
  raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { frames.set(++next, cb); return next; }); cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  host = document.createElement("div"); other = document.createElement("button"); document.body.append(host, other); root = createRoot(host);
  await act(async () => root!.render(<StrictMode><App /></StrictMode>));
  const flush = async () => act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((cb) => cb(0)); });
  const cleanup = rpc ? retireOwned : async () => { await act(async () => root!.unmount()); for (const id of Object.keys(drafts.useDrafts.getState().drafts)) drafts.forgetDraft(id); useThreads.setState({ details: new Map(), gone: new Set() }); app.setApp({ compose: null, fatal: null }); host!.remove(); other!.remove(); raf!.mockRestore(); cancel!.mockRestore(); gate.call.mockReset(); gate.load.mockReset(); };
  return { App, drafts, app, useThreads, detail, key, host, other, root, flush, cleanup };
  } catch (error) {
    if (rpc) {
      try { await retireOwned(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Owned presentation setup and cleanup"); }
    }
    throw error;
  }
}

export { gate };
