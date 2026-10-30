// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { expect, it, vi } from "vitest";
import type { Account, ThreadDetail } from "@terno/core";

const gate = vi.hoisted(() => ({ load: vi.fn(), call: vi.fn().mockResolvedValue({}), budget: null as null | (() => Promise<void>) }));
vi.mock("~/rpc/connection", () => ({ client: { call: gate.call } }));
vi.mock("~/state/threads", async (original) => ({ ...await original<typeof import("~/state/threads")>(), loadThread: gate.load }));
vi.mock("~/lib/attachments", async (original) => {
  const actual = await original<typeof import("~/lib/attachments")>();
  return { ...actual, draftAttachmentBudget: async (...args: Parameters<typeof actual.draftAttachmentBudget>) => {
    const result = await actual.draftAttachmentBudget(...args);
    if (gate.budget) await gate.budget();
    return result;
  } };
});
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
HTMLElement.prototype.scrollIntoView = () => {};
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }));
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect();

function ReaderFailure({ fail }: { fail: boolean }) {
  if (fail) throw new Error("synthetic reader failure");
  return null;
}

async function setup(boundary = false, deferMount = false) {
  gate.call.mockImplementation((method: string) => Promise.resolve(method === "drafts.sourceContext" ? { threadId: 7, accountId: 1 } : {}));
  const { Reader } = await import("./reader");
  const { PaneBoundary } = await import("./diag/error-boundary");
  const { openCompose, supersedeCompose } = await import("~/lib/compose");
  const { useThreads } = await import("~/state/threads");
  const { setApp } = await import("~/state/app");
  const { useAppearance } = await import("~/lib/appearance");
  const { useDrafts, forgetDraft } = await import("~/lib/drafts");
  const account = { id: 1, kind: "imap", email: "me@example.test", displayName: "Me", signature: "", color: "blue" } as Account;
  const detail = { thread: { id: 7, accountId: 1, subject: "Subject", categoryIds: [], inSpam: false, inTrash: false }, messages: [{ id: 3, accountId: 1, attachmentState: "complete", isSent: false, from: { name: "Sender", email: "sender@example.test" }, to: [], cc: [], subject: "Subject", date: 0, bodyText: "Body", attachments: [] }] } as unknown as ThreadDetail;
  const frames = new Map<number, FrameRequestCallback>(); let next = 0;
  const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { frames.set(++next, cb); return next; });
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  const host = document.createElement("div"), anchor = document.createElement("button"), other = document.createElement("button");
  document.body.append(host, anchor, other); const root = createRoot(host);
  useAppearance.setState({ layout: "list", motionMs: 0 });
  setApp({ accounts: [account], selectedId: 7, accountId: 1, checked: new Set(), scope: null, draftFocus: null, draftShown: null, dialog: null, fatal: null });
  const render = async (fail = false, instance = "reader") => act(async () => root.render(<StrictMode>{boundary ? <PaneBoundary area="reader" resetKey={7}><Reader key={instance} /><ReaderFailure fail={fail} /></PaneBoundary> : <Reader key={instance} />}</StrictMode>));
  if (!deferMount) await render();
  const failReader = async (beforeFailure: () => void) => act(async () => {
    beforeFailure();
    flushSync(() => root.render(<StrictMode><PaneBoundary area="reader" resetKey={7}><Reader /><ReaderFailure fail /></PaneBoundary></StrictMode>));
  });
  const replaceReader = async (duringGap: () => void, remount = true) => act(async () => {
    flushSync(() => root.render(null));
    duringGap();
    if (remount) flushSync(() => root.render(<StrictMode><Reader key="replacement" /></StrictMode>));
  });
  const flushFrame = async () => act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((cb) => cb(0)); });
  const publish = () => { useThreads.setState({ details: new Map([[7, detail]]) }); gate.load.mockResolvedValue(detail); };
  const cleanup = async () => {
    await act(async () => root.unmount()); for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key);
    useThreads.setState({ details: new Map(), gone: new Set() }); setApp({ dialog: null, fatal: null });
    host.remove(); anchor.remove(); other.remove(); raf.mockRestore(); cancel.mockRestore(); gate.load.mockReset(); gate.call.mockReset().mockResolvedValue({}); gate.budget = null;
  };
  return { openCompose, supersedeCompose, setApp, useDrafts, detail, host, anchor, other, frames, flushFrame, publish, cleanup, render, replaceReader, failReader };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it.each([true, false])("honors reply focus with the Reader frame %s loading", async (frameFirst) => {
  const h = await setup(), load = deferred<ThreadDetail>(); gate.load.mockReturnValue(load.promise);
  try {
    let opening!: Promise<void>; await act(async () => { opening = h.openCompose("reply", 7); });
    expect(h.frames.size).toBeGreaterThan(0);
    if (frameFirst) await h.flushFrame();
    await act(async () => { h.publish(); load.resolve(h.detail); await opening; });
    const readerFocus = vi.spyOn(h.host.querySelector<HTMLElement>('[data-testid="reader"]')!, "focus");
    await h.flushFrame();
    expect(readerFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]'));
    readerFocus.mockRestore();
  } finally { load.resolve(h.detail); await h.cleanup(); }
});

it.each([false, true])("preserves a later focus selection during loading (return to anchor: %s)", async (returnToAnchor) => {
  const h = await setup(), load = deferred<ThreadDetail>(); gate.load.mockReturnValue(load.promise);
  try {
    h.anchor.focus(); let opening!: Promise<void>; await act(async () => { opening = h.openCompose("reply", 7); });
    await h.flushFrame(); h.other.focus(); if (returnToAnchor) h.anchor.focus();
    await act(async () => { h.publish(); load.resolve(h.detail); await opening; }); await h.flushFrame();
    expect(document.activeElement).toBe(returnToAnchor ? h.anchor : h.other);
  } finally { load.resolve(h.detail); await h.cleanup(); }
});

it("returns focus to Reader when an open fails after its frame was deferred", async () => {
  const h = await setup(), load = deferred<ThreadDetail | null>(); gate.load.mockReturnValue(load.promise);
  try {
    let opening!: Promise<void>; await act(async () => { opening = h.openCompose("reply", 7); }); await h.flushFrame();
    expect(document.activeElement).toBe(document.body);
    await act(async () => { load.resolve(null); await opening; });
    expect(document.activeElement).toBe(h.host.querySelector('[data-testid="reader"]'));
  } finally { load.resolve(null); await h.cleanup(); }
});

it("does not focus the previous conversation after navigation", async () => {
  const h = await setup(), load = deferred<ThreadDetail>(); gate.load.mockReturnValue(load.promise);
  try {
    let opening!: Promise<void>; await act(async () => { opening = h.openCompose("reply", 7); }); await h.flushFrame();
    await act(async () => { h.setApp({ selectedId: 8 }); h.publish(); load.resolve(h.detail); await opening; }); await h.flushFrame();
    expect(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]')).toBeNull();
    expect(document.activeElement).not.toBe(h.host.querySelector('[data-testid="reader"]'));
  } finally { load.resolve(h.detail); await h.cleanup(); }
});

it("keeps the newer lease when an older request finishes, then falls back on abort", async () => {
  const h = await setup(), first = deferred<ThreadDetail>(), second = deferred<ThreadDetail | null>();
  gate.load.mockReturnValueOnce(first.promise).mockReturnValue(second.promise);
  try {
    let opening!: Promise<void>, newer!: Promise<void>; await act(async () => { opening = h.openCompose("reply", 7); }); await h.flushFrame();
    await act(async () => { newer = h.openCompose("replyAll", 7); first.resolve(h.detail); await opening; });
    expect(document.activeElement).toBe(document.body);
    await act(async () => { second.resolve(null); await newer; });
    expect(document.activeElement).toBe(h.host.querySelector('[data-testid="reader"]'));
  } finally { first.resolve(h.detail); second.resolve(null); await h.cleanup(); }
});

it("drops ownership when the compose intent is superseded", async () => {
  const h = await setup(), load = deferred<ThreadDetail>(); gate.load.mockReturnValue(load.promise);
  try {
    let opening!: Promise<void>; await act(async () => { opening = h.openCompose("reply", 7); }); await h.flushFrame();
    h.supersedeCompose(); await act(async () => { h.publish(); load.resolve(h.detail); await opening; }); await h.flushFrame();
    expect(document.activeElement).toBe(document.body);
    expect(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]')).toBeNull();
  } finally { load.resolve(h.detail); await h.cleanup(); }
});

it("preserves a focus round trip during attachment admission", async () => {
  const h = await setup(), waiting = deferred<void>(), entered = deferred<void>();
  gate.load.mockResolvedValue(h.detail); gate.budget = async () => { entered.resolve(); await waiting.promise; };
  let opening: Promise<void> | undefined;
  try {
    h.anchor.focus(); await act(async () => { opening = h.openCompose("reply", 7); }); await entered.promise; await h.flushFrame();
    h.other.focus(); h.anchor.focus();
    await act(async () => { h.publish(); waiting.resolve(); await opening; }); await h.flushFrame();
    expect(document.activeElement).toBe(h.anchor);
  } finally { waiting.resolve(); if (opening) await opening; await h.cleanup(); }
});

it.each(["dialog", "fatal", "held"] as const)("does not restore Reader focus behind %s", async (block) => {
  const h = await setup(), load = deferred<ThreadDetail | null>(); gate.load.mockReturnValue(load.promise);
  try {
    let opening!: Promise<void>; await act(async () => { opening = h.openCompose("reply", 7); }); await h.flushFrame();
    await act(async () => {
      if (block === "dialog") h.setApp({ dialog: "addAccount" });
      if (block === "fatal") h.setApp({ fatal: "synthetic" });
      if (block === "held") h.useDrafts.setState({ held: true });
      load.resolve(null); await opening;
    });
    expect(document.activeElement).toBe(document.body);
  } finally { load.resolve(null); h.useDrafts.setState({ held: false }); await h.cleanup(); }
});

it("relinquishes a published draft focus when another control is chosen before placement", async () => {
  const h = await setup(), load = deferred<ThreadDetail>(); gate.load.mockReturnValue(load.promise);
  try {
    let opening!: Promise<void>; await act(async () => { opening = h.openCompose("reply", 7); }); await h.flushFrame();
    await act(async () => { h.publish(); load.resolve(h.detail); await opening; });
    h.other.focus(); await h.flushFrame();
    expect(document.activeElement).toBe(h.other);
  } finally { load.resolve(h.detail); await h.cleanup(); }
});

it("preserves a focus round trip while forwarding checks attachment information", async () => {
  const h = await setup(), info = deferred<{ filename: string; mime: string; size: number }>(), entered = deferred<void>();
  const message = h.detail.messages[0]!;
  message.attachments = [{ id: 1, assetId: "asset", filename: "file.txt", mime: "text/plain", size: 0 }];
  gate.load.mockResolvedValue(h.detail);
  gate.call.mockImplementation((method: string) => {
    if (method === "attachments.info") { entered.resolve(); return info.promise; }
    return Promise.resolve(method === "drafts.sourceContext" ? { threadId: 7, accountId: 1 } : {});
  });
  let opening: Promise<void> | undefined;
  try {
    h.anchor.focus(); await act(async () => { opening = h.openCompose("forward", 7); }); await entered.promise; await h.flushFrame();
    h.other.focus(); h.anchor.focus();
    await act(async () => { h.publish(); info.resolve({ filename: "file.txt", mime: "text/plain", size: 0 }); await opening; }); await h.flushFrame();
    expect(document.activeElement).toBe(h.anchor);
  } finally { info.resolve({ filename: "file.txt", mime: "text/plain", size: 0 }); if (opening) await opening; await h.cleanup(); }
});

it.each([false, true])("a pending reply focus %s a newer gated forward", async (forward) => {
  const h = await setup(), waiting = deferred<void>(), entered = deferred<void>();
  gate.call.mockImplementation((method: string) => Promise.resolve(method === "drafts.sourceContext" ? { threadId: 7, accountId: 1 } : {}));
  let opening: Promise<void> | undefined;
  try {
    await act(async () => { h.publish(); }); await h.flushFrame();
    await act(async () => { await h.openCompose("reply", 7); }); await h.flushFrame();
    const body = h.host.querySelector<HTMLElement>('[data-testid="compose-body"]') ?? h.host.querySelector<HTMLElement>('[data-testid="compose-body-loading"]');
    const toolbar = h.host.querySelector<HTMLButtonElement>('[data-testid="action-reply"]');
    expect(body).not.toBeNull(); expect(toolbar).not.toBeNull();
    toolbar!.focus(); expect(document.activeElement).toBe(toolbar);
    await act(async () => { await h.openCompose("reply", 7); });
    if (forward) {
      gate.budget = async () => { entered.resolve(); await waiting.promise; };
      await act(async () => { opening = h.openCompose("forward", 7); });
      await entered.promise;
    }
    await h.flushFrame();
    expect(document.activeElement).toBe(forward ? toolbar : body);
    if (forward) {
      await act(async () => { waiting.resolve(); await opening; });
      await h.flushFrame();
      expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-to"]'));
    }
  } finally { waiting.resolve(); if (opening) await opening; await h.cleanup(); }
});

it("does not place a consumed draft focus after editing is held", async () => {
  const h = await setup();
  gate.call.mockImplementation((method: string) => Promise.resolve(method === "drafts.sourceContext" ? { threadId: 7, accountId: 1 } : {}));
  try {
    await act(async () => { h.publish(); }); await h.flushFrame();
    await act(async () => { await h.openCompose("reply", 7); }); await h.flushFrame();
    const toolbar = h.host.querySelector<HTMLButtonElement>('[data-testid="action-reply"]')!;
    toolbar.focus(); expect(document.activeElement).toBe(toolbar);
    await act(async () => { await h.openCompose("reply", 7); });
    await act(async () => { h.useDrafts.setState({ held: true }); });
    await h.flushFrame();
    expect(document.activeElement).toBe(toolbar);
  } finally { h.useDrafts.setState({ held: false }); await h.cleanup(); }
});

it("keeps a newer same-draft move when the older move completes, then releases a later aborted open", async () => {
  const h = await setup(), { useApp } = await import("~/state/app"), { composeFocusPending } = await import("~/lib/compose");
  const seen: { key: string; seq: number }[] = [];
  const unsubscribe = useApp.subscribe((state) => { if (state.draftFocus && seen.at(-1)?.seq !== state.draftFocus.seq) seen.push(state.draftFocus); });
  gate.call.mockImplementation((method: string) => Promise.resolve(method === "drafts.sourceContext" ? { threadId: 7, accountId: 1 } : {}));
  try {
    await act(async () => { h.publish(); }); await h.flushFrame();
    await act(async () => { await h.openCompose("reply", 7); }); await h.flushFrame();
    const toolbar = h.host.querySelector<HTMLButtonElement>('[data-testid="action-reply"]')!;
    toolbar.focus();
    await act(async () => { await h.openCompose("reply", 7); });
    const older = seen.at(-1)!;
    await act(async () => { await h.openCompose("reply", 7); });
    const newer = seen.at(-1)!;
    expect(newer.key).toBe(older.key); expect(newer.seq).toBeGreaterThan(older.seq);
    expect(composeFocusPending(7, newer.key, newer.seq)).toBe(true);
    await h.flushFrame();
    expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]'));
    toolbar.focus(); gate.load.mockResolvedValue(null);
    await act(async () => { await h.openCompose("forward", 7); });
    expect(composeFocusPending(7)).toBe(false); expect(document.activeElement).toBe(toolbar);
  } finally { unsubscribe(); await h.cleanup(); }
});

it("cancels a compose open when bulk selection interrupts attachment admission", async () => {
  const h = await setup(), waiting = deferred<void>(), entered = deferred<void>();
  let opening: Promise<void> | undefined;
  try {
    await act(async () => { h.publish(); }); await h.flushFrame();
    gate.budget = async () => { entered.resolve(); await waiting.promise; };
    h.anchor.focus(); await act(async () => { opening = h.openCompose("reply", 7); }); await entered.promise;
    await act(async () => { h.setApp({ checked: new Set([7, 8]) }); h.setApp({ checked: new Set() }); });
    await act(async () => { waiting.resolve(); await opening; }); await h.flushFrame();
    expect(document.activeElement).toBe(h.anchor);
    expect(Object.values(h.useDrafts.getState().drafts)).toHaveLength(0);
  } finally { waiting.resolve(); if (opening) await opening; await h.cleanup(); }
});

it("an old bulk-canceled lookup cannot cancel a newer deliberate open", async () => {
  const h = await setup(), old = deferred<ThreadDetail>(); gate.load.mockReturnValueOnce(old.promise).mockResolvedValue(h.detail);
  try {
    let opening!: Promise<void>; await act(async () => { opening = h.openCompose("reply", 7); });
    await act(async () => { h.setApp({ checked: new Set([7, 8]) }); h.setApp({ checked: new Set() }); });
    await act(async () => { h.publish(); await h.openCompose("reply", 7); });
    await act(async () => { old.resolve(h.detail); await opening; }); await h.flushFrame();
    expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]'));
    expect(Object.values(h.useDrafts.getState().drafts)).toHaveLength(1);
  } finally { old.resolve(h.detail); await h.cleanup(); }
});

it("cancels an existing draft open when bulk selection interrupts source-context validation", async () => {
  const h = await setup(), waiting = deferred<void>(), entered = deferred<void>();
  let opening: Promise<void> | undefined;
  try {
    await act(async () => { h.publish(); }); await h.flushFrame();
    await act(async () => { await h.openCompose("reply", 7); }); await h.flushFrame();
    gate.call.mockImplementation(async (method: string) => {
      if (method === "drafts.sourceContext") { entered.resolve(); await waiting.promise; return { threadId: 7, accountId: 1 }; }
      return {};
    });
    h.anchor.focus(); await act(async () => { opening = h.openCompose("forward", 7); }); await entered.promise;
    await act(async () => { h.setApp({ checked: new Set([7, 8]) }); h.setApp({ checked: new Set() }); });
    await act(async () => { waiting.resolve(); await opening; }); await h.flushFrame();
    expect(document.activeElement).toBe(h.anchor);
    const drafts = Object.values(h.useDrafts.getState().drafts);
    expect(drafts).toHaveLength(1); expect(drafts[0]?.mode).toBe("reply");
  } finally { waiting.resolve(); if (opening) await opening; await h.cleanup(); }
});

it.each(["list", "split"] as const)("retires a pending reply when the %s Reader pane boundary replaces its destination", async (layout) => {
  const { composeFocusPending } = await import("~/lib/compose");
  const { useApp } = await import("~/state/app");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const h = await setup(true), load = deferred<ThreadDetail>(); gate.load.mockReturnValue(load.promise);
  const { useAppearance } = await import("~/lib/appearance");
  let opening: Promise<void> | undefined;
  try {
    await act(async () => useAppearance.setState({ layout }));
    h.anchor.focus(); await act(async () => { opening = h.openCompose("reply", 7); });
    await h.flushFrame(); expect(composeFocusPending(7)).toBe(true);
    await h.render(true);
    expect(h.host.querySelector('[data-testid="reader-boundary"]')).not.toBeNull();
    expect(h.host.querySelector('[data-testid="reader"]')).toBeNull();
    expect(document.activeElement).toBe(h.anchor); expect(useApp.getState().selectedId).toBe(7);
    await act(async () => { h.publish(); load.resolve(h.detail); await opening; });
    expect(composeFocusPending(7)).toBe(false); expect(useApp.getState().draftFocus).toBeNull();
    await h.render(false);
    await act(async () => (h.host.querySelector('[data-testid="reader-boundary-retry"]') as HTMLButtonElement).click());
    await h.flushFrame();
    expect(h.host.querySelector('[data-testid="reader"]')).not.toBeNull();
    expect(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]')).toBeNull();
    expect(useApp.getState().draftFocus).toBeNull();
  } finally { load.resolve(h.detail); if (opening) await opening; await h.cleanup(); error.mockRestore(); }
});

it("preserves a pending reply through StrictMode Reader setup after the request starts", async () => {
  const h = await setup(false, true), load = deferred<ThreadDetail>(); gate.load.mockReturnValue(load.promise);
  let opening: Promise<void> | undefined;
  try {
    h.anchor.focus(); await act(async () => { opening = h.openCompose("reply", 7); });
    await h.render(); await h.flushFrame();
    await act(async () => { h.publish(); load.resolve(h.detail); await opening; }); await h.flushFrame();
    expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]'));
  } finally { load.resolve(h.detail); if (opening) await opening; await h.cleanup(); }
});

it("does not let old Reader cleanup cancel a replacement Reader's pending reply", async () => {
  const h = await setup(true), load = deferred<ThreadDetail>(); gate.load.mockReturnValue(load.promise);
  let opening: Promise<void> | undefined;
  try {
    h.anchor.focus(); await act(async () => { opening = h.openCompose("reply", 7); }); await h.flushFrame();
    await h.render(false, "replacement"); await h.flushFrame();
    await act(async () => { h.publish(); load.resolve(h.detail); await opening; }); await h.flushFrame();
    expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]'));
  } finally { load.resolve(h.detail); if (opening) await opening; await h.cleanup(); }
});

it("does not let retired Reader cleanup cancel a newer request during replacement", async () => {
  const h = await setup(), first = deferred<ThreadDetail>(), second = deferred<ThreadDetail>();
  gate.load.mockReturnValueOnce(first.promise).mockReturnValue(second.promise);
  let older: Promise<void> | undefined, newer: Promise<void> | undefined;
  try {
    h.anchor.focus(); await act(async () => { older = h.openCompose("reply", 7); }); await h.flushFrame();
    await h.replaceReader(() => { newer = h.openCompose("reply", 7); });
    await act(async () => { first.resolve(h.detail); await older; });
    await act(async () => { h.publish(); second.resolve(h.detail); await newer; }); await h.flushFrame();
    expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]'));
  } finally { first.resolve(h.detail); second.resolve(h.detail); if (older) await older; if (newer) await newer; await h.cleanup(); }
});

it("retires a newer request started during Reader teardown if no replacement appears", async () => {
  const { composeFocusPending } = await import("~/lib/compose");
  const { useApp } = await import("~/state/app");
  const h = await setup(), first = deferred<ThreadDetail>(), second = deferred<ThreadDetail>();
  gate.load.mockReturnValueOnce(first.promise).mockReturnValue(second.promise);
  let older: Promise<void> | undefined, newer: Promise<void> | undefined;
  try {
    h.anchor.focus(); await act(async () => { older = h.openCompose("reply", 7); }); await h.flushFrame();
    await h.replaceReader(() => { newer = h.openCompose("reply", 7); }, false);
    await act(async () => { first.resolve(h.detail); await older; });
    await act(async () => { h.publish(); second.resolve(h.detail); await newer; });
    expect(composeFocusPending(7)).toBe(false); expect(useApp.getState().draftFocus).toBeNull();
    expect(Object.values(h.useDrafts.getState().drafts)).toHaveLength(0);
  } finally { first.resolve(h.detail); second.resolve(h.detail); if (older) await older; if (newer) await newer; await h.cleanup(); }
});

it("cannot publish a reply when loading resolves immediately before Reader boundary teardown", async () => {
  const { composeFocusPending } = await import("~/lib/compose");
  const { useApp } = await import("~/state/app");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const h = await setup(true), load = deferred<ThreadDetail>(); gate.load.mockReturnValue(load.promise);
  let opening: Promise<void> | undefined;
  try {
    h.anchor.focus(); await act(async () => { opening = h.openCompose("reply", 7); }); await h.flushFrame();
    await h.failReader(() => { h.publish(); load.resolve(h.detail); });
    await act(async () => { await opening; });
    expect(h.host.querySelector('[data-testid="reader-boundary"]')).not.toBeNull();
    expect(composeFocusPending(7)).toBe(false); expect(useApp.getState().draftFocus).toBeNull();
    expect(Object.values(h.useDrafts.getState().drafts)).toHaveLength(0); expect(document.activeElement).toBe(h.anchor);
  } finally { load.resolve(h.detail); if (opening) await opening; await h.cleanup(); error.mockRestore(); }
});

it("keeps a synchronous existing-draft open begun during a same-thread Reader replacement", async () => {
  const h = await setup(); let opening: Promise<void> | undefined;
  try {
    await act(async () => { h.publish(); }); await h.flushFrame();
    await act(async () => { await h.openCompose("reply", 7); }); await h.flushFrame();
    h.anchor.focus();
    await h.replaceReader(() => { opening = h.openCompose("reply", 7); });
    await act(async () => { await opening; }); await h.flushFrame();
    expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]'));
  } finally { if (opening) await opening; await h.cleanup(); }
});

it("cannot publish an existing-draft focus when source validation resolves at Reader teardown", async () => {
  const { composeFocusPending } = await import("~/lib/compose");
  const { useApp } = await import("~/state/app");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const h = await setup(true), waiting = deferred<void>(), entered = deferred<void>();
  let opening: Promise<void> | undefined;
  try {
    await act(async () => { h.publish(); }); await h.flushFrame();
    await act(async () => { await h.openCompose("reply", 7); }); await h.flushFrame();
    gate.call.mockImplementation(async (method: string) => {
      if (method === "drafts.sourceContext") { entered.resolve(); await waiting.promise; return { threadId: 7, accountId: 1 }; }
      return {};
    });
    h.anchor.focus(); await act(async () => { opening = h.openCompose("reply", 7); }); await entered.promise;
    await h.failReader(() => waiting.resolve()); await act(async () => { await opening; });
    expect(h.host.querySelector('[data-testid="reader-boundary"]')).not.toBeNull();
    expect(composeFocusPending(7)).toBe(false); expect(useApp.getState().draftFocus).toBeNull();
    expect(Object.values(h.useDrafts.getState().drafts)).toHaveLength(1); expect(document.activeElement).toBe(h.anchor);
  } finally { waiting.resolve(); if (opening) await opening; await h.cleanup(); error.mockRestore(); }
});

it.each(["ordinary", "control", "successor", "hold", "inert"] as const)("Reader defers to exact compose completion: %s", async (scenario) => {
  const h = await setup(), load = deferred<ThreadDetail>(); gate.load.mockReturnValue(load.promise);
  const { subscribeComposeFocus } = await import("~/lib/compose");
  const { acquireDraftHold } = await import("~/lib/drafts");
  let off = () => {}, release = () => {}, triggered = false;
  try {
    let opening!: Promise<void>; await act(async () => { opening = h.openCompose("reply", 7); });
    await h.flushFrame();
    await act(async () => { h.publish(); load.resolve(h.detail); await opening; });
    const reader = h.host.querySelector<HTMLElement>('[data-testid="reader"]')!;
    const editor = h.host.querySelector<HTMLElement>('[data-testid="compose-body"]') ?? h.host.querySelector<HTMLElement>('[data-testid="compose-body-loading"]');
    expect(editor).not.toBeNull();
    if (scenario === "inert") editor!.setAttribute("inert", "");
    off = subscribeComposeFocus(() => {
      if (triggered) return;
      triggered = true;
      if (scenario === "control") h.other.focus();
      if (scenario === "successor") h.supersedeCompose();
      if (scenario === "hold") { const done = acquireDraftHold(); expect(done).not.toBeNull(); release = done!; }
    });
    for (let i = 0; i < 13; i++) await h.flushFrame();
    expect(triggered).toBe(true);
    if (scenario === "ordinary") expect(document.activeElement).toBe(editor);
    else if (scenario === "inert") expect(document.activeElement).toBe(reader);
    else if (scenario === "control") expect(document.activeElement).toBe(h.other);
    else expect(document.activeElement).not.toBe(editor);
  } finally { off(); release(); load.resolve(h.detail); await h.cleanup(); }
});
