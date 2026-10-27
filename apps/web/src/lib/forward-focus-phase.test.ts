// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import type { Account, ThreadDetail } from "@terno/core";
const { loadThread, details } = vi.hoisted(() => ({ loadThread: vi.fn(), details: new Map<number, ThreadDetail>() }));
vi.mock("~/state/threads", () => ({ loadThread, invalidateThreads: vi.fn(), useThreads: { getState: () => ({ details }) } }));
vi.mock("~/rpc/connection", () => ({ client: { call: async (method: string) => method === "drafts.sourceContext" ? { threadId: 7, accountId: 1 } : { assetId: "source-asset", filename: "empty", mime: "text/plain", size: 0 } } }));
vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }));
const { openCompose, supersedeCompose } = await import("./compose");
const { replyFields } = await import("./compose-fields");
const { createDraft, editDraft, forgetDraft, setDraftTransport, useDrafts } = await import("./drafts");
const { getApp, setApp, useApp } = await import("~/state/app");
const account = { id: 1, email: "source@test.com" } as Account;
const detail = { thread: { id: 7, accountId: 1, subject: "source" }, messages: [{ id: 3, accountId: 1, attachmentState: "complete", isSent: false, from: { name: "Sender", email: "sender@test.com" }, to: [], cc: [], subject: "source", date: 0, bodyText: "source", attachments: [{ id: 1, assetId: "source-asset", filename: "empty", mime: "text/plain", size: 0 }] }] } as unknown as ThreadDetail;

it("a real focus choice during the empty-owner save cancels Forward and stays focused", async () => {
  const previous = getApp(), key = createDraft(replyFields("reply", detail, account));
  const start = document.createElement("button"), other = document.createElement("button"); document.body.append(start, other);
  let acknowledge!: () => void, reached!: () => void;
  const gate = new Promise<void>((r) => { acknowledge = r; });
  const waiting = new Promise<void>((r) => { reached = r; });
  let calls = 0;
  setDraftTransport(async (_method, params) => { if (++calls === 1) { reached(); await gate; } return { ...params as object, id: 9, generation: "stable", revision: calls, updatedAt: 0 }; });
  loadThread.mockImplementation(async (id: number) => details.get(id)); details.set(7, detail);
  setApp({ accounts: [account], accountId: 1, selectedId: 7, checked: new Set(), scope: null, draftShown: { threadId: 7, key }, draftFocus: null });
  editDraft(key, { bodyText: "before wait" }); start.focus();
  const opening = openCompose("forward", 7);
  try {
    await Promise.race([waiting, opening.then(() => { throw new Error("Forward finished before save gate"); })]);
    other.focus(); expect(document.activeElement).toBe(other);
    acknowledge(); await opening;
    expect(useDrafts.getState().drafts[key]).toMatchObject({ mode: "reply", bodyText: "before wait", attachments: [] });
    expect(document.activeElement).toBe(other); expect(getApp().draftFocus).toBeNull();
  } finally { acknowledge(); await opening; supersedeCompose(); forgetDraft(key); setDraftTransport(async () => null); useApp.setState(previous, true); details.clear(); start.remove(); other.remove(); }
});
