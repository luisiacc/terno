// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { ThreadDetail } from "@terno/core";
import { setup, gate, deferred } from "./draft-presentation-r1-harness";

it.each(["list", "split"] as const)("does not retain Reply after the %s Reader boundary has already retired", async (layout) => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const h = await setup(layout, true), waiting = deferred<ThreadDetail>();
  const { composeFocusPending } = await import("~/lib/compose");
  try {
    h.drafts.forgetDraft(h.key);
    const broken = { ...h.detail, messages: null } as unknown as ThreadDetail;
    await act(async () => { h.useThreads.setState({ details: new Map([[7, broken]]) }); });
    expect(h.host.querySelector('[data-testid="reader-boundary"]')).not.toBeNull();
    expect(h.host.querySelector('[data-testid="reader"]')).toBeNull();
    await act(async () => { h.useThreads.setState({ details: new Map([[7, h.detail]]) }); await Promise.resolve(); });
    expect(h.app.getApp().selectedId).toBe(7); h.other.focus();
    gate.load.mockReturnValue(waiting.promise);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true })));
    await act(async () => { gate.load.mockResolvedValue(h.detail); waiting.resolve(h.detail); });
    for (let i = 0; i < 5; i++) await h.flush();
    expect(composeFocusPending(7)).toBe(false); expect(h.app.getApp().draftFocus).toBeNull();
    expect(document.activeElement).toBe(h.other);
    await act(async () => (h.host.querySelector('[data-testid="reader-boundary-retry"]') as HTMLButtonElement).click());
    for (let i = 0; i < 3; i++) await h.flush();
    expect(h.host.querySelector('[data-testid="reader"]')).not.toBeNull();
    expect(document.activeElement?.closest('[data-testid="composer"]')).toBeNull();
    expect(h.app.getApp().draftFocus).toBeNull();
    h.other.focus(); await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true })));
    for (let i = 0; i < 3; i++) await h.flush();
    expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]'));
  } finally { waiting.resolve(h.detail); await h.cleanup(); error.mockRestore(); }
});

it.each(["list", "split"] as const)("does not retain a pre-mount Reply when the initial %s Reader render fails", async (layout) => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const h = await setup(layout), waiting = deferred<ThreadDetail>();
  const { composeFocusPending, openCompose } = await import("~/lib/compose");
  let opening: Promise<void> | undefined;
  try {
    h.drafts.forgetDraft(h.key); h.other.focus(); gate.load.mockReturnValue(waiting.promise);
    const broken = { ...h.detail, messages: null } as unknown as ThreadDetail;
    await act(async () => {
      h.app.setApp({ selectedId: 7, readerOpen: true });
      opening = openCompose("reply", 7);
      h.useThreads.setState({ details: new Map([[7, broken]]) });
    });
    expect(h.host.querySelector('[data-testid="reader-boundary"]')).not.toBeNull();
    expect(h.host.querySelector('[data-testid="reader"]')).toBeNull();
    await act(async () => { h.useThreads.setState({ details: new Map([[7, h.detail]]) }); gate.load.mockResolvedValue(h.detail); waiting.resolve(h.detail); await opening; });
    for (let i = 0; i < 3; i++) await h.flush();
    expect(composeFocusPending(7)).toBe(false); expect(h.app.getApp().draftFocus).toBeNull();
    expect(document.activeElement).toBe(h.other);
  } finally { waiting.resolve(h.detail); if (opening) await opening; await h.cleanup(); error.mockRestore(); }
});

it("allows a new conversation's reply while the failed prior boundary resets", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const h = await setup("split", true), waiting = deferred<ThreadDetail>();
  const { openCompose } = await import("~/lib/compose");
  let opening: Promise<void> | undefined;
  const next = { ...h.detail, thread: { ...h.detail.thread, id: 8 } };
  try {
    h.drafts.forgetDraft(h.key);
    await act(async () => { h.useThreads.setState({ details: new Map([[7, { ...h.detail, messages: null } as unknown as ThreadDetail]]) }); });
    expect(h.host.querySelector('[data-testid="reader-boundary"]')).not.toBeNull();
    gate.load.mockReturnValue(waiting.promise);
    gate.call.mockImplementation(async (method: string) => method === "drafts.sourceContext" ? { threadId: 8, accountId: 1 } : {});
    h.other.focus();
    await act(async () => { h.app.setApp({ selectedId: 8, readerOpen: true }); opening = openCompose("reply", 8); });
    await act(async () => { h.useThreads.setState({ details: new Map([[8, next]]) }); gate.load.mockResolvedValue(next); waiting.resolve(next); await opening; });
    for (let i = 0; i < 3; i++) await h.flush();
    expect(h.host.querySelector('[data-testid="reader"]')).not.toBeNull();
    expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]'));
  } finally { waiting.resolve(next); if (opening) await opening; await h.cleanup(); error.mockRestore(); }
});

it("keeps overlapping failed-host registrations until their exact owners leave", async () => {
  const h = await setup("split", true);
  const { openCompose, composeFocusPending, registerReaderPaneFailure } = await import("~/lib/compose");
  const token = {}, other = {};
  const old = registerReaderPaneFailure(7, token);
  const current = registerReaderPaneFailure(7, token);
  const overlapping = registerReaderPaneFailure(7, other);
  try {
    await act(async () => h.drafts.forgetDraft(h.key)); h.other.focus(); gate.load.mockClear();
    old();
    await act(async () => { await openCompose("reply", 7); });
    expect(gate.load).not.toHaveBeenCalled(); expect(composeFocusPending(7)).toBe(false);
    current();
    await act(async () => { await openCompose("reply", 7); });
    expect(gate.load).not.toHaveBeenCalled(); expect(composeFocusPending(7)).toBe(false);
    overlapping();
    await act(async () => { await openCompose("reply", 7); });
    for (let i = 0; i < 3; i++) await h.flush();
    expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]'));
  } finally { old(); current(); overlapping(); await h.cleanup(); }
});

it("opens a standalone stored draft while its former Reader fallback is mounted", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const h = await setup("split", true);
  const { composeFocusPending } = await import("~/lib/compose");
  try {
    await act(async () => { h.useThreads.setState({ details: new Map([[7, { ...h.detail, messages: null } as unknown as ThreadDetail]]) }); });
    expect(h.host.querySelector('[data-testid="reader-boundary"]')).not.toBeNull();
    gate.call.mockImplementation(async (method: string) => method === "drafts.sourceContext" ? null : {});
    const button = h.host.querySelector<HTMLButtonElement>('[data-testid="strip-item"]')!;
    button.focus(); await act(async () => button.click());
    const focus = h.app.getApp().draftFocus!;
    expect(composeFocusPending(null, h.key, focus.seq)).toBe(true);
    expect(h.host.querySelector('[data-testid="reader-boundary"]')).not.toBeNull();
    await act(async () => (h.host.querySelector('[data-testid="reader-boundary-retry"]') as HTMLButtonElement).click());
    for (let i = 0; i < 15; i++) await h.flush();
    expect(h.app.getApp().compose?.key).toBe(h.key);
    expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-to"]'));
  } finally { await h.cleanup(); error.mockRestore(); }
});

it("does not suppress Reader focus for a failure in another reader-pane branch", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const h = await setup("split", true), host = document.createElement("div");
  const { PaneBoundary } = await import("./diag/error-boundary");
  const { openCompose } = await import("~/lib/compose");
  const root = createRoot(host);
  function FailedOtherPane(): never { throw new Error("other pane failed"); }
  document.body.append(host);
  try {
    await act(async () => root.render(<StrictMode><PaneBoundary area="reader" resetKey={7}><FailedOtherPane /></PaneBoundary></StrictMode>));
    expect(host.querySelector('[data-testid="reader-boundary"]')).not.toBeNull();
    await act(async () => h.drafts.forgetDraft(h.key)); h.other.focus();
    await act(async () => { await openCompose("reply", 7); });
    for (let i = 0; i < 3; i++) await h.flush();
    expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]'));
  } finally { await act(async () => root.unmount()); host.remove(); await h.cleanup(); error.mockRestore(); }
});
