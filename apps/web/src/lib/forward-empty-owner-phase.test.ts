import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Account, ThreadDetail } from "@terno/core";

const { loadThread, details } = vi.hoisted(() => ({ loadThread: vi.fn(), details: new Map<number, ThreadDetail>() }));
vi.mock("~/state/threads", () => ({ loadThread, invalidateThreads: vi.fn(), useThreads: { getState: () => ({ details }), subscribe: () => () => {} } }));
vi.mock("~/rpc/connection", () => ({ client: { call: async (method: string) => method === "drafts.sourceContext" ? { threadId: 7, accountId: 1 } : { assetId: "source-asset", filename: "empty", mime: "text/plain", size: 0 } } }));
const { openCompose, supersedeCompose } = await import("./compose");
const { replyFields } = await import("./compose-fields");
const { createDraft, editDraft, editDraftRecipients, forgetDraft, markDraftMissing, setDraftTransport, setDraftUi, useDrafts } = await import("./drafts");
const { markSelectionIntent, setApp } = await import("~/state/app");
const { resetSnacks, useSnack } = await import("./snack");
const source = { id: 1, email: "source@test.com" } as Account;
const other = { id: 2, email: "other@test.com" } as Account;
const detail = { thread: { id: 7, accountId: 1, subject: "source" }, messages: [{ id: 3, accountId: 1, attachmentState: "complete", isSent: false, from: { name: "Sender", email: "sender@test.com" }, to: [], cc: [], subject: "source", date: 0, bodyText: "source bytes", attachments: [{ id: 1, assetId: "source-asset", filename: "empty", mime: "text/plain", size: 0 }] }] } as unknown as ThreadDetail;
beforeEach(() => { loadThread.mockImplementation(async (id: number) => details.get(id)); details.set(7, detail); resetSnacks(); });
afterEach(() => { supersedeCompose(); for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key); details.clear(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

it.each(["UI roundtrip", "source roundtrip", "account roundtrip", "mode roundtrip", "attachment roundtrip", "quote roundtrip", "forged auto", "selection intent", "navigation roundtrip", "recovery", "reentrant restoration", "missing response", "rejected save", "recipient", "body"] as const)("forward empty-owner flush fences %s while retaining authored work", async (scenario) => {
  const key = createDraft(replyFields("reply", detail, source));
  setApp({ accounts: [source, other], accountId: 1, selectedId: 7, checked: new Set(), scope: null, draftShown: { threadId: 7, key }, draftFocus: null });
  editDraft(key, { bodyText: "before wait" });
  let acknowledge!: () => void, reached!: () => void;
  const gate = new Promise<void>((r) => { acknowledge = r; });
  const waiting = new Promise<void>((r) => { reached = r; });
  let calls = 0;
  setDraftTransport(async (_method, params) => {
    const input = params as Record<string, unknown>;
    if (++calls === 1) { reached(); await gate; }
    if (scenario === "missing response") return null;
    if (scenario === "rejected save") throw { code: "BAD_REQUEST" };
    return { ...input, id: 9, generation: "stable", revision: calls, updatedAt: 0 };
  });
  vi.stubGlobal("document", { activeElement: {} });
  let stop = () => {};
  if (scenario === "reentrant restoration") stop = useDrafts.subscribe((state, previous) => {
    const current = state.drafts[key];
    if (current?.status === "saved" && previous.drafts[key]?.status === "saving") {
      stop();
      useDrafts.setState({ drafts: { ...state.drafts, [key]: { ...current, accountId: 2 } } });
      useDrafts.setState((s) => ({ drafts: { ...s.drafts, [key]: current } }));
    }
  });
  const opening = openCompose("forward", 7);
  try {
    await Promise.race([waiting, opening.then(() => { throw new Error("Forward finished before the empty-owner save gate"); })]);
    expect(useDrafts.getState().drafts[key]).toMatchObject({ mode: "reply", attachments: [], status: "saving" });
    if (scenario === "UI roundtrip") { setDraftUi(key, "collapsed"); setDraftUi(key, "open"); }
    if (scenario === "source roundtrip") { editDraft(key, { inReplyToMessageId: 999 }); editDraft(key, { inReplyToMessageId: 3 }); }
    if (scenario === "account roundtrip") { editDraft(key, { accountId: 2 }); editDraft(key, { accountId: 1 }); }
    if (scenario === "mode roundtrip") { editDraft(key, { mode: "replyAll" }); editDraft(key, { mode: "reply" }); }
    if (scenario === "attachment roundtrip") { editDraft(key, { attachments: [{ assetId: "temporary", filename: "temporary", mime: "text/plain", size: 0 }] }); editDraft(key, { attachments: [] }); }
    if (scenario === "quote roundtrip") { editDraft(key, { includeQuote: true }); editDraft(key, { includeQuote: false }); }
    if (scenario === "forged auto") editDraft(key, { auto: { to: [], cc: [], bcc: [] } });
    if (scenario === "recipient") editDraftRecipients(key, "to", "sender@test.com, extra@example.test", ["sender@test.com"]);
    if (scenario === "selection intent") markSelectionIntent();
    if (scenario === "navigation roundtrip") { setApp({ selectedId: 8 }); setApp({ selectedId: 7 }); }
    if (scenario === "recovery") markDraftMissing(key);
    if (scenario === "body") editDraft(key, { bodyText: "new authored text", bodyHtml: "<p>new authored text</p>" });
    acknowledge(); await opening;
    const actual = useDrafts.getState().drafts[key]!;
    if (scenario === "body") expect(actual).toMatchObject({ mode: "forward", bodyText: "new authored text", bodyHtml: "<p>new authored text</p>" });
    else if (scenario === "recipient") { expect(actual.mode).toBe("forward"); expect(actual.toText).toContain("extra@example.test"); expect(actual.auto.to).not.toContain("sender@test.com"); }
    else { expect(actual.mode).toBe("reply"); expect(actual.attachments).toEqual([]); expect(useSnack.getState().undo).toBeNull(); }
  } finally { stop(); acknowledge(); await opening; }
});
