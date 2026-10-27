// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ call: vi.fn(), load: vi.fn(), focus: vi.fn(), standalone: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: { call: mocks.call } }));
vi.mock("~/state/threads", () => ({ loadThread: mocks.load }));
vi.mock("~/lib/compose", () => ({ focusDraft: mocks.focus, showNewDraft: mocks.standalone }));
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const { DraftsStrip } = await import("./drafts-strip");
const { createDraft, editDraft, forgetDraft, useDrafts } = await import("~/lib/drafts");
const { newFields } = await import("~/lib/compose-fields");
const { setApp, useApp } = await import("~/state/app");

it.each(["missing", "navigation", "focus", "changed generation"])("strip validation preserves work after late %s", async (scenario) => {
  const host = document.createElement("div"), other = document.createElement("button"); document.body.append(host, other);
  const root = createRoot(host); let resolve!: (value: { threadId: number; accountId: number } | null) => void;
  mocks.call.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const key = createDraft({ ...newFields(2), threadId: 7, mode: "reply", inReplyToMessageId: 3, showSourceContext: true, bodyText: "exact work" });
  editDraft(key, { bodyText: "exact work" });
  setApp({ selectedId: null, compose: null, readerOpen: false, draftShown: null });
  try {
    await act(async () => root.render(<DraftsStrip />));
    const button = host.querySelector<HTMLButtonElement>('[data-testid="strip-item"]')!;
    button.focus(); await act(async () => button.click());
    expect(mocks.call).toHaveBeenCalledWith("drafts.sourceContext", { messageId: 3 });
    if (scenario === "navigation") { setApp({ selectedId: 8 }); setApp({ selectedId: null }); }
    if (scenario === "focus") other.focus();
    if (scenario === "changed generation") useDrafts.setState((s) => ({ drafts: { ...s.drafts, [key]: { ...s.drafts[key]!, generation: "replacement" } } }));
    await act(async () => { resolve(scenario === "missing" ? null : { threadId: 7, accountId: 1 }); });
    expect(useDrafts.getState().drafts[key]?.bodyText).toBe("exact work");
    if (scenario === "missing") expect(mocks.standalone).toHaveBeenCalledWith(key);
    else { expect(mocks.standalone).not.toHaveBeenCalled(); expect(useApp.getState().selectedId).toBeNull(); }
    expect(mocks.focus).not.toHaveBeenCalled();
    expect(mocks.load).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount()); forgetDraft(key); host.remove(); other.remove(); vi.clearAllMocks();
  }
});

it.each(["missing", "merged"])("an expired placement reopens through the live source (%s)", async (scenario) => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  mocks.call.mockResolvedValue(scenario === "missing" ? null : { threadId: 9, accountId: 1 });
  mocks.load.mockResolvedValue({ thread: { id: 9, accountId: 1 } });
  const key = createDraft({ ...newFields(2), threadId: null, mode: "reply", inReplyToMessageId: 3, showSourceContext: true });
  editDraft(key, { bodyText: "exact expired work" });
  useDrafts.setState((s) => ({ drafts: { ...s.drafts, [key]: { ...s.drafts[key]!, sourceContextThreadId: null } } }));
  setApp({ selectedId: 7, compose: null, readerOpen: true, draftShown: null, checked: new Set(), scope: null });
  try {
    await act(async () => root.render(<DraftsStrip />));
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="strip-item"]')!.click());
    expect(mocks.call).toHaveBeenCalledWith("drafts.sourceContext", { messageId: 3 });
    expect(useDrafts.getState().drafts[key]?.bodyText).toBe("exact expired work");
    expect(Object.keys(useDrafts.getState().drafts)).toEqual([key]);
    if (scenario === "missing") { expect(mocks.standalone).toHaveBeenCalledWith(key); expect(mocks.load).not.toHaveBeenCalled(); }
    else { expect(mocks.load).toHaveBeenCalledWith(9); expect(useApp.getState().draftShown).toEqual({ threadId: 9, key }); expect(mocks.focus).toHaveBeenCalledWith(key, "body"); }
  } finally { await act(async () => root.unmount()); forgetDraft(key); host.remove(); vi.clearAllMocks(); }
});

it.each(["generation", "edit", "navigation", "selection", "unmount"])("thread loading cannot revive strip intent after %s", async (scenario) => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  let release!: (value: object) => void;
  mocks.call.mockResolvedValue({ threadId: 7, accountId: 1 });
  mocks.load.mockImplementation(() => new Promise((done) => { release = done; }));
  const key = createDraft({ ...newFields(2), threadId: 7, mode: "reply", inReplyToMessageId: 3, showSourceContext: true });
  editDraft(key, { bodyText: "exact work" });
  setApp({ selectedId: null, compose: null, readerOpen: false, draftShown: null, checked: new Set(), scope: null });
  let unmounted = false;
  try {
    await act(async () => root.render(<DraftsStrip />));
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="strip-item"]')!.click());
    expect(mocks.load).toHaveBeenCalledWith(7);
    await act(async () => {
      if (scenario === "generation") useDrafts.setState((s) => ({ drafts: { ...s.drafts, [key]: { ...s.drafts[key]!, generation: "replacement" } } }));
      if (scenario === "edit") editDraft(key, { bodyText: "later work" });
      if (scenario === "navigation") { setApp({ selectedId: 8 }); setApp({ selectedId: 7 }); }
      if (scenario === "selection") { setApp({ checked: new Set([7, 8]) }); setApp({ checked: new Set() }); }
      if (scenario === "unmount") { root.unmount(); unmounted = true; }
      release({ thread: { id: 7, accountId: 1 } });
    });
    expect(mocks.focus).not.toHaveBeenCalled();
    expect(mocks.standalone).not.toHaveBeenCalled();
    expect(useDrafts.getState().drafts[key]?.bodyText).toBe(scenario === "edit" ? "later work" : "exact work");
  } finally { if (!unmounted) await act(async () => root.unmount()); forgetDraft(key); host.remove(); vi.clearAllMocks(); }
});
