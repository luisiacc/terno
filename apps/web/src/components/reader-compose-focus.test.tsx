// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
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

async function setup() {
  gate.call.mockImplementation((method: string) => Promise.resolve(method === "drafts.sourceContext" ? { threadId: 7, accountId: 1 } : {}));
  const { Reader } = await import("./reader");
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
  await act(async () => root.render(<StrictMode><Reader /></StrictMode>));
  const flushFrame = async () => act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((cb) => cb(0)); });
  const publish = () => { useThreads.setState({ details: new Map([[7, detail]]) }); gate.load.mockResolvedValue(detail); };
  const cleanup = async () => {
    await act(async () => root.unmount()); for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key);
    useThreads.setState({ details: new Map(), gone: new Set() }); setApp({ dialog: null, fatal: null });
    host.remove(); anchor.remove(); other.remove(); raf.mockRestore(); cancel.mockRestore(); gate.load.mockReset(); gate.call.mockReset().mockResolvedValue({}); gate.budget = null;
  };
  return { openCompose, supersedeCompose, setApp, useDrafts, detail, host, anchor, other, frames, flushFrame, publish, cleanup };
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
    await h.flushFrame();
    expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]'));
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
