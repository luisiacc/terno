import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Account, ThreadDetail } from "@terno/core";

const { loadThread, details } = vi.hoisted(() => ({ loadThread: vi.fn(), details: new Map<number, ThreadDetail>() }));
vi.mock("~/state/threads", () => ({ loadThread, invalidateThreads: vi.fn(), useThreads: { getState: () => ({ details }), subscribe: () => () => {} } }));
vi.mock("~/rpc/connection", () => ({ client: { call: async (method: string) => method === "drafts.sourceContext" ? { threadId: 7, accountId: 1 } : { assetId: "source-asset", filename: "empty", mime: "text/plain", size: 0 } } }));
const { openCompose } = await import("./compose");
const { replyFields } = await import("./compose-fields");
const { createDraft, editDraft, forgetDraft, setDraftTransport, useDrafts } = await import("./drafts");
const { setApp, getApp } = await import("~/state/app");
const { useSnack } = await import("./snack");

const source = { id: 1, email: "source@test.com" } as Account;
const other = { id: 2, email: "other@test.com" } as Account;
const detail = { thread: { id: 7, accountId: 1, subject: "source" }, messages: [{ id: 3, accountId: 1, attachmentState: "complete", isSent: false, from: { name: "Sender", email: "sender@test.com" }, to: [], cc: [], subject: "source", date: 0, bodyText: "source bytes", attachments: [{ id: 1, assetId: "source-asset", filename: "empty", mime: "text/plain", size: 0 }] }] } as unknown as ThreadDetail;
beforeEach(() => { loadThread.mockImplementation(async (id: number) => details.get(id)); });
afterEach(() => { for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key); details.clear(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

it.each(["latest account", "missing source", "discard"])("a late conversation lookup preserves the current work on %s", async (scenario) => {
  const key = createDraft(replyFields("reply", detail, source));
  setApp({ accounts: [source, other], selectedId: 7, checked: new Set(), scope: null, draftShown: { threadId: 7, key } });
  let complete!: (value: ThreadDetail) => void;
  loadThread.mockReturnValueOnce(new Promise<ThreadDetail>((r) => { complete = r; }));
  const opening = openCompose("forward", 7);
  editDraft(key, { bodyText: "typed while loading", bodyHtml: "<div><b>typed while loading</b></div>", accountId: 2 });
  if (scenario === "missing source") setApp({ accounts: [other] });
  if (scenario === "discard") forgetDraft(key);
  const before = useDrafts.getState().drafts[key];
  complete(detail); await opening;
  expect(useDrafts.getState().drafts[key]).toEqual(before);
  if (scenario !== "discard") expect(useSnack.getState().current?.message).toBe(scenario === "missing source" ? "That account is no longer connected." : "To forward these attachments, choose source@test.com in From.");
});

it.each(["edit", "focus", "account", "discard", "navigation", "new intent", "failed save"])("conversion waits for an acknowledged empty revision and fences late %s", async (scenario) => {
  details.set(7, detail);
  const key = createDraft(replyFields("reply", detail, source));
  setApp({ accounts: [source, other], selectedId: 7, checked: new Set(), scope: null, draftShown: { threadId: 7, key }, draftFocus: null });
  editDraft(key, { bodyText: "before wait" });
  let acknowledge!: () => void, reached!: () => void;
  const gate = new Promise<void>((r) => { acknowledge = r; });
  const waiting = new Promise<void>((r) => { reached = r; });
  let calls = 0;
  setDraftTransport(async (_method, params) => {
    const input = params as Record<string, unknown>;
    if (++calls === 1) { reached(); await gate; }
    if (scenario === "failed save") throw { code: "BAD_REQUEST" };
    return { ...input, id: 9, generation: "stable", revision: calls, updatedAt: 0 };
  });
  const document = Object.assign(new EventTarget(), { activeElement: {} });
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", new EventTarget());
  const opening = openCompose("forward", 7);
  await waiting;
  expect(useDrafts.getState().drafts[key]!.mode).toBe("reply");
  expect(useDrafts.getState().drafts[key]!.attachments).toEqual([]);
  if (scenario === "edit" || scenario === "focus") editDraft(key, { bodyText: "latest while waiting" });
  if (scenario === "focus") document.activeElement = {};
  if (scenario === "account") editDraft(key, { accountId: 2 });
  if (scenario === "discard") forgetDraft(key);
  if (scenario === "navigation") setApp({ selectedId: 8 });
  if (scenario === "new intent") await openCompose("reply", 7);
  acknowledge(); await opening;
  const current = useDrafts.getState().drafts[key];
  if (scenario === "discard") expect(current).toBeUndefined();
  else if (scenario === "edit" || scenario === "focus") {
    expect(current).toMatchObject({ mode: "forward", bodyText: "latest while waiting", attachments: [expect.objectContaining({ assetId: "source-asset" })] });
    if (scenario === "focus") expect(getApp().draftFocus).toBeNull();
  } else expect(current).toMatchObject({ mode: "reply", attachments: [] });
});
