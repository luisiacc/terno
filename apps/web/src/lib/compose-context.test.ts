import { expect, it, vi } from "vitest";
import type { Account } from "@terno/core";

const rpc = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: rpc }));
vi.mock("~/state/threads", () => ({ loadThread: vi.fn(), invalidateThreads: vi.fn() }));
const { openCompose } = await import("./compose");
const { createDraft, editDraft, forgetDraft, useDrafts } = await import("./drafts");
const { newFields } = await import("./compose-fields");
const { setApp, getApp } = await import("~/state/app");

it.each(["source moved", "edit", "navigation", "generation"])("conversion preflight keeps the draft safe after late %s", async (scenario) => {
  let resolve!: (value: { threadId: number; accountId: number } | null) => void;
  rpc.call.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const account = { id: 1, email: "from@example.test" } as Account;
  const key = createDraft({ ...newFields(1), threadId: 7, mode: "reply", inReplyToMessageId: 3, showSourceContext: true, bodyText: "authored work" });
  setApp({ accounts: [account], accountId: 1, selectedId: 7, checked: new Set(), scope: null, compose: null, draftShown: { threadId: 7, key }, dialog: null, fatal: null });
  try {
    const pending = openCompose("forward", 7);
    expect(rpc.call).toHaveBeenCalledWith("drafts.sourceContext", { messageId: 3 });
    if (scenario === "edit") editDraft(key, { bodyText: "later work" });
    if (scenario === "navigation") { setApp({ selectedId: 8 }); setApp({ selectedId: 7 }); }
    if (scenario === "generation") useDrafts.setState((s) => ({ drafts: { ...s.drafts, [key]: { ...s.drafts[key]!, generation: "replacement" } } }));
    resolve({ threadId: scenario === "source moved" ? 9 : 7, accountId: 1 });
    await pending;
    const draft = useDrafts.getState().drafts[key]!;
    expect(draft.mode).toBe("reply");
    expect(draft.bodyText).toBe(scenario === "edit" ? "later work" : "authored work");
    if (scenario === "source moved") { expect(getApp().compose?.key).toBe(key); expect(draft.showSourceContext).toBe(false); }
    else expect(getApp().compose).toBeNull();
  } finally { forgetDraft(key); vi.clearAllMocks(); }
});

it.each([false, true])("leaving Reader expires its placement, including a delayed normalization (%s)", async (delayed) => {
  const { installComposeFollowsSelection } = await import("./compose");
  const { flushDraft, setDraftTransport, shownDraftKey } = await import("./drafts");
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  setDraftTransport(async (_method, params) => {
    if (delayed) await gate;
    return { ...(params as object), id: 42, generation: "stored", revision: 1, threadId: 9, presentationThreadId: 9, showSourceContext: true, updatedAt: 0 };
  });
  const key = createDraft({ ...newFields(2), threadId: 7, mode: "reply", inReplyToMessageId: 3, showSourceContext: true });
  setApp({ selectedId: 7, readerOpen: true, compose: null, checked: new Set(), scope: null, draftShown: { threadId: 7, key } });
  const stop = installComposeFollowsSelection();
  try {
    editDraft(key, { bodyText: "exact mounted work" });
    const pending = flushDraft(key);
    if (!delayed) await pending;
    expect(shownDraftKey(useDrafts.getState().drafts, 7, null)).toBe(key);
    setApp({ selectedId: 8 });
    if (delayed) { release(); await pending; }
    setApp({ selectedId: 7 });
    expect(shownDraftKey(useDrafts.getState().drafts, 7, { threadId: 7, key })).toBeNull();
    expect(shownDraftKey(useDrafts.getState().drafts, 9, null)).toBeNull();
    expect(useDrafts.getState().drafts[key]).toMatchObject({ bodyText: "exact mounted work", showSourceContext: true });
  } finally { stop(); release(); forgetDraft(key); }
});

it.each(["source", "mode", "false"])("a local %s change cannot reuse positive source intent", async (change) => {
  const { shownDraftKey } = await import("./drafts");
  const key = createDraft({ ...newFields(2), threadId: null, mode: "reply", inReplyToMessageId: 3, showSourceContext: true });
  useDrafts.setState((s) => ({ drafts: { ...s.drafts, [key]: { ...s.drafts[key]!, sourceContextThreadId: 7 } } }));
  try {
    editDraft(key, change === "source" ? { inReplyToMessageId: 4 } : change === "mode" ? { mode: "new" } : { showSourceContext: false });
    expect(shownDraftKey(useDrafts.getState().drafts, 7, null)).toBeNull();
    expect(useDrafts.getState().drafts[key]?.showSourceContext).toBe(false);
  } finally { forgetDraft(key); }
});
