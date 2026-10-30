import { afterEach, expect, it, vi } from "vitest";
import type { FlagSnapshotRequest, FlagUpdate } from "@terno/store";
import { createGmailApiProvider } from "./gmail-api";
import type { MailProvider, ProviderContext, SyncSink } from "./types";

const providers: MailProvider[] = [];
afterEach(async () => { for (const provider of providers.splice(0)) await provider.close(); });
function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }

function setup(count = 3, bad: "shape" | "quota" | "gone" | null = null, tokens?: { get(): Promise<string>; invalidate(): void }) {
  const requested: string[] = [], pages: FlagSnapshotRequest[] = [], writes: FlagUpdate[][] = [], removals: number[][] = [], cursors: unknown[] = [];
  const held = gate();
  let newTail = false, available = count;
  const ctx = {
    flagObservation: true,
    account: { id: 1 }, config: {},
    store: {
      async pendingFlagSnapshots(p: FlagSnapshotRequest) {
        pages.push({ ...p });
        const through = p.throughMessageId ?? available;
        const after = p.afterMessageId ?? 0;
        if (after === 0 && !newTail) { newTail = true; available++; }
        const end = Math.min(through, after + Math.min(2, p.limit));
        return { items: Array.from({ length: Math.max(0, end - after) }, (_, i) => ({ id: after + i + 1, providerMsgId: `m${after + i + 1}` })), throughMessageId: through, hasMore: end < through };
      },
      async messageByProviderId() { return null; }, async syncedMessages() { return []; }, async syncedMessagePage() { return { items: [] }; }, async pendingAttachmentBodies() { return []; },
    },
    loadCursor: async () => ({ historyId: "10" }), saveCursor: async (cursor: unknown) => { cursors.push(cursor); },
    fetch: async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/history")) { requested.push("history"); return Response.json({ historyId: "11", history: [] }); }
      const id = url.pathname.split("/").at(-1)!;
      requested.push(id);
      if (id === "m1" && bad === "gone") return Response.json({ error: { message: "synthetic" } }, { status: 404 });
      if (id === "m1" && bad === "shape") return Response.json({ id: "wrong", labelIds: ["UNREAD"] });
      if (id === "m1" && bad === "quota") return Response.json({ error: { message: "synthetic" } }, { status: 429 });
      if (bad === "quota") await held.promise;
      return Response.json({ id, labelIds: ["INBOX", "STARRED"] });
    },
  } as unknown as ProviderContext;
  const provider = createGmailApiProvider(ctx, { tokens: tokens ?? { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() });
  providers.push(provider);
  const sink: SyncSink = {
    signal: new AbortController().signal, windowStart: 0,
    async ingest() { throw new Error("Unexpected synthetic body fetch"); },
    async updateFlags(updates) { writes.push(updates); }, async removeMessages(ids) { removals.push(ids); }, async setBody() {}, async setSyncState() {}, async pendingMessageIds() { return new Set(); },
  };
  return { provider, ctx, sink, requested, pages, writes, removals, cursors, held, hasNewTail: () => newTail };
}

it("drains a finite captured snapshot traversal before empty history without revisiting retained rows", async () => {
  const t = setup();
  await t.provider.sync(t.sink);
  expect(t.requested).toEqual(["m1", "m2", "m3", "history"]);
  expect(t.pages).toEqual([{ limit: 50 }, { limit: 50, afterMessageId: 2, throughMessageId: 3 }]);
  expect(t.hasNewTail()).toBe(true);
  expect(t.writes.flat()).toEqual([1, 2, 3].map((id) => ({ messageId: id, expectedProviderMsgId: `m${id}`, flags: { isRead: true, isStarred: true, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false }, gmailLabels: ["INBOX", "STARRED"] })));
  expect(t.cursors).toEqual([{ historyId: "11" }]);
  expect(t.removals).toEqual([]);
});

it("retains one malformed target while committing healthy later pages and ordinary history", async () => {
  const t = setup(3, "shape");
  await expect(t.provider.sync(t.sink)).rejects.toMatchObject({ retryable: true, network: false, i18n: { key: "errors.gmail.invalidResponse" } });
  expect(t.requested).toEqual(["m1", "m2", "m3", "history"]);
  expect(t.writes.flat().map((update) => update.messageId)).toEqual([2, 3]);
  expect(t.removals).toEqual([]);
  expect(t.cursors).toEqual([{ historyId: "11" }]);
});

it("a systemic quota refusal stops new snapshot pages and never promotes the normal cursor", async () => {
  const t = setup(10, "quota");
  const work = t.provider.sync(t.sink).then(() => undefined, (error: unknown) => error);
  try {
    await expect.poll(() => t.requested.length).toBe(2);
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally { t.held.release(); }
  expect(await work).toMatchObject({ retryable: true, network: false, status: 429 });
  expect(t.pages).toHaveLength(1);
  expect(t.requested).toEqual(["m1", "m2"]);
  expect(t.cursors).toEqual([]);
  expect(t.removals).toEqual([]);
});

it("leaves legacy standalone contexts on their existing history path", async () => {
  const t = setup();
  delete t.ctx.flagObservation;
  const pages = vi.spyOn(t.ctx.store, "pendingFlagSnapshots");
  await t.provider.sync(t.sink);
  expect(pages).not.toHaveBeenCalled();
  expect(t.requested).toEqual(["history"]);
  expect(t.cursors).toEqual([{ historyId: "11" }]);
});


it("only deletes an actual target-resource404 and continues healthy snapshot pages", async () => {
  const t = setup(3, "gone");
  await t.provider.sync(t.sink);
  expect(t.requested).toEqual(["m1", "m2", "m3", "history"]);
  expect(t.removals).toEqual([[1]]);
  expect(t.writes.flat().map((update) => update.messageId)).toEqual([2, 3]);
  expect(t.cursors).toEqual([{ historyId: "11" }]);
});

it.each(["quota", "reset"] as const)("fences a token-pending snapshot sibling after %s without aborting already dispatched work", async (mode) => {
  const pending = gate(), token = gate();
  let calls = 0;
  const t = setup(3, mode === "quota" ? "quota" : null, {
    async get() { if (++calls === 2) { pending.release(); await token.promise; } return "synthetic"; }, invalidate() {},
  });
  let settled = false, outcome: unknown;
  const work = t.provider.sync(t.sink).then((value) => { settled = true; return value; }, (error: unknown) => { settled = true; outcome = error; });
  try {
    await pending.promise;
    await expect.poll(() => t.requested.length).toBe(1);
    if (mode === "reset") t.provider.reset!();
    await expect.poll(() => settled).toBe(true);
    if (mode === "quota") expect(outcome).toMatchObject({ status: 429, retryable: true, network: false });
    else expect(outcome).toMatchObject({ retryable: true, network: false, i18n: { key: "errors.gmail.requestOffline" } });
    expect(t.requested).toEqual(["m1"]);
    expect(t.cursors).toEqual([]);
    expect(t.removals).toEqual([]);
    if (mode === "reset") expect(t.writes).toEqual([]);
  } finally { token.release(); t.held.release(); await work; }
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(t.requested).toEqual(["m1"]);
});
