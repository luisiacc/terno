import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdbMailStore } from "@terno/idb";
import { IDBFactory } from "fake-indexeddb";
import { createGmailApiProvider, type ProviderRegistry } from "@terno/mail/portable";
import { processIncoming } from "@terno/mail/incoming-processing-worker";
import type { IncomingMessage } from "@terno/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const api = "https://gmail.googleapis.com/gmail/v1/users/me", baseline = "90071992547409930000";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { try { for (const close of cleanup.splice(0).reverse()) await close(); } finally { vi.restoreAllMocks(); } });

async function mailbox(kind: "SQL" | "IndexedDB", mode: "normal" | "local" | "gone" = "normal", emptyContinuation = false) {
  const requests: URL[] = [], unexpected: string[] = [];
  let checkpoint: ((value: unknown) => Promise<void>) | undefined;
  let historyId = baseline;
  const history: { messages: { id: string }[]; labelsRemoved: { message: { id: string } }[] }[] = [];
  const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const refuse = (): never => { unexpected.push(`Unexpected synthetic Gmail route: ${input instanceof Request ? input.url : String(input)}`); throw new Error(unexpected.at(-1)); };
    if (!(input instanceof Request) || init !== undefined || input.method !== "GET" || input.redirect !== "error" || !["Bearer synthetic:me@example.test", "Bearer synthetic:peer@example.test"].includes(input.headers.get("authorization") ?? "")) return refuse();
    const url = new URL(input.url);
    if (url.origin !== new URL(api).origin || !url.pathname.startsWith(`${new URL(api).pathname}/`)) return refuse();
    requests.push(url);
    const path = url.pathname.slice(new URL(api).pathname.length);
    if (path === "/profile" && !url.search) return Response.json({ emailAddress: input.headers.get("authorization")!.slice("Bearer synthetic:".length), historyId: baseline });
    if (path === "/labels" && !url.search) return Response.json({ labels: [] });
    if (path === "/messages" && url.searchParams.get("includeSpamTrash") === "true" && url.searchParams.get("maxResults") === "500" && /^after:\d+$/.test(url.searchParams.get("q") ?? "")) {
      const token = url.searchParams.get("pageToken");
      if (url.searchParams.size !== (token === null ? 3 : 4) || (token !== null && (!emptyContinuation || token !== "opaque/+?=empty"))) return refuse();
      return Response.json(emptyContinuation && token === null ? { messages: [], nextPageToken: "opaque/+?=empty" } : { messages: [{ id: "sibling" }] });
    }
    if (path === "/history" && url.searchParams.size === 6 && url.searchParams.get("maxResults") === "500" && url.searchParams.getAll("historyTypes").sort().join(",") === "labelAdded,labelRemoved,messageAdded,messageDeleted" && [baseline, historyId].includes(url.searchParams.get("startHistoryId") ?? "")) return Response.json({ historyId, history: url.searchParams.get("startHistoryId") === baseline ? history : [] });
    const id = path.slice("/messages/".length);
    if (path === "/messages/sibling" && url.searchParams.size === 1 && url.searchParams.get("format") === "raw") return Response.json({ id, threadId: id, labelIds: [], internalDate: "1", raw: Buffer.from(["From: sender@example.test", "To: me@example.test", "Subject: Sibling", "Message-ID: <sibling@example.test>", "Content-Type: text/plain", "", "Exact unaffected sibling"].join("\r\n")).toString("base64url") });
    if (path.startsWith("/messages/") && /^(a|z|sibling|m\d{4})$/.test(id) && url.searchParams.size === 1 && url.searchParams.get("format") === "minimal") return mode === "gone" && id !== "sibling" ? Response.json({}, { status: 404 }) : Response.json({ id, labelIds: [] });
    return refuse();
  });
  const dir = mkdtempSync(join(tmpdir(), "terno-refresh-invocation-")), factory = new IDBFactory(), name = crypto.randomUUID();
  const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
  const providers: ProviderRegistry = {
    create: (ctx) => createGmailApiProvider({ ...ctx, saveCursor: async (value, check) => { await ctx.saveCursor(value, check); await checkpoint?.(value); } }, { tokens: { get: async () => `synthetic:${ctx.account.email}`, invalidate() {} }, buildRaw: async () => new Uint8Array() }),
    async verifyImap() {}, async connectGmail() { throw new Error("Unused synthetic consent"); },
  };
  const open = async () => new Backend({ dbPath: join(dir, "synthetic.db"), store: kind === "IndexedDB" ? await IdbMailStore.open({ name, factory, platform, instantSearch: false }) : undefined,
    incomingProcessor: { async run(input, signal) { signal.throwIfAborted(); const result = await processIncoming(input); signal.throwIfAborted(); return result; }, async whenIdle() {}, async close() {} },
    platform, providers, cipher: plaintextCipher, version: "test", autoSync: false, instantSearch: false, iconTransport: null });
  let backend = await open(); await backend.ready;
  const { account } = await backend.store.accounts.create({ kind: "gmail", email: "me@example.test", displayName: "Synthetic", color: "indigo", now: 1 });
  const runs: Promise<void>[] = [];
  cleanup.push(async () => { await Promise.allSettled(runs); try { expect(unexpected).toEqual([]); expect(backend.net.googlePending()).toBe(0); } finally { await backend.stop(); rmSync(dir, { recursive: true, force: true }); } });
  const cursor = async () => (await backend.store.accounts.config<{ cursor?: unknown }>(account.id))?.config.cursor;
  const rows = async () => (await backend.store.debug.snapshot()).messages;
  const seed = async (ids: string[], local = false) => {
    await backend.ingestSliced(ids.map((id): IncomingMessage => ({ accountId: account.id, providerMsgId: local || mode === "local" ? `local:${id}` : id, providerThreadId: null, rfcMessageId: `${id}@example.test`, inReplyTo: null, references: [], from: { name: "", email: "sender@example.test" }, to: [], cc: [], bcc: [], subject: id, date: 1, snippet: id, bodyText: `Exact body ${id}`, bodyHtml: null, bodyState: "full", listId: null, isRead: false, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: !id.startsWith("m"), gmailLabels: ["INBOX", "UNREAD"], attachments: id.startsWith("m") ? [] : [{ filename: "exact.bin", mime: "application/octet-stream", size: 4, bytes: new Uint8Array([0, 255, 128, 13]) }], size: 5 })));
  };
  return {
    requests, transport, cursor, rows, seed, account,
    get backend() { return backend; },
    sync() { const run = backend.syncAccount(account.id); runs.push(run); return run; },
    checkpoint(fn?: typeof checkpoint) { checkpoint = fn; },
    async peer() {
      const { account: peer } = await backend.store.accounts.create({ kind: "gmail", email: "peer@example.test", displayName: "Peer", color: "indigo", now: 2 });
      await backend.store.accounts.setCursor(peer.id, { historyId: baseline });
      return () => { const run = backend.syncAccount(peer.id); runs.push(run); return run; };
    },
    historyChange(id: string) { historyId = "90071992547409930001"; history.push({ messages: [{ id }], labelsRemoved: [{ message: { id } }] }); },
    async reopen() { await backend.stop(); backend = await open(); await backend.ready; },
  };
}

describe.each(["SQL", "IndexedDB"] as const)("%s cached-refresh checkpoint admission", (kind) => {
  it.each(["behind", "promoted", "ahead", "history"] as const)("refreshes a local identity admitted %s the durable key across reopen", async (position) => {
    const t = await mailbox(kind);
    const ids = Array.from({ length: 100 }, (_, i) => `m${String(i).padStart(4, "0")}`);
    await t.seed(ids);
    const added = position === "ahead" ? "z" : "a";
    if (position === "promoted") await t.seed([added], true);
    const prior = (await t.rows()).find((m) => m.providerMsgId === `local:${added}`);
    const key = position === "promoted" ? "m0048" : "m0049";
    let admitted = false;
    t.checkpoint(async (value) => {
      const progress = (value as { reconciliation?: { stage: string; refreshAfter?: string } }).reconciliation;
      if (!admitted && progress?.stage === "refresh" && progress.refreshAfter === key) {
        admitted = true;
        await t.seed([added]);
        if (position === "history") t.historyChange(added);
        throw new Error("Synthetic interruption after durable page and local admission");
      }
    });
    await t.sync(); expect(admitted).toBe(true);
    expect(await t.cursor()).toMatchObject({ reconciliation: { stage: "refresh", refreshAfter: key, baseline } });
    const before = await t.rows(), local = before.find((m) => m.providerMsgId === added)!;
    if (prior) expect(local.id).toBe(prior.id);
    const assets = await t.backend.store.attachments.current(t.account.id, { id: local.id });
    expect(assets).toHaveLength(1);
    const bytes = await t.backend.store.attachments.read(t.account.id, assets[0]!.assetId!, 0);
    expect(bytes).toBe("AP+ADQ==");
    expect(local).toMatchObject({ inInbox: true, isRead: false, bodyText: `Exact body ${added}` });
    expect(before.filter((m) => m.providerMsgId?.startsWith("m")).every((m) => m.inInbox === (m.providerMsgId! > key))).toBe(true);
    t.checkpoint(); await t.reopen(); t.requests.length = 0; await t.sync();
    expect(await t.cursor()).toEqual({ historyId: position === "history" ? "90071992547409930001" : baseline });
    await t.reopen(); await t.sync();
    expect((await t.backend.store.providerStore(t.account.id).pendingFlagSnapshots({ limit: 50 })).items).toEqual([]);
    const after = await t.rows();
    expect(after).toHaveLength(102);
    const sibling = before.find((m) => m.providerMsgId === "sibling")!;
    expect(sibling.bodyText).toContain("Exact unaffected sibling");
    expect(after.find((m) => m.id === sibling.id)).toEqual(sibling);
    expect(await t.backend.store.attachments.current(t.account.id, { id: local.id })).toEqual(assets);
    expect(await t.backend.store.attachments.read(t.account.id, assets[0]!.assetId!, 0)).toBe(bytes);
    expect(after.filter((m) => m.providerMsgId?.startsWith("m"))).toEqual(before.filter((m) => m.providerMsgId?.startsWith("m")).map((m) => ({ ...m, inInbox: false, isRead: true, gmailLabels: "[]" })));
    expect(after.find((m) => m.id === local.id)).toEqual({ ...local, inInbox: false, isRead: true, gmailLabels: "[]" });
    expect(t.requests.filter((u) => u.pathname.endsWith(`/messages/${added}`)).map((u) => u.searchParams.get("format"))).toEqual(position === "history" ? ["minimal", "minimal"] : ["minimal"]);
    await t.reopen(); await t.sync(); expect(await t.rows()).toEqual(after);
  });
  it("refreshes an admission racing with completed cursor promotion on the next public sync", async () => {
    const t = await mailbox(kind);
    await t.seed(["m0000"]);
    let admitted = false;
    t.checkpoint(async (value) => {
      if (!admitted && (value as { historyId?: string }).historyId === baseline && !(value as { reconciliation?: unknown }).reconciliation) {
        admitted = true; await t.seed(["a"]);
      }
    });
    await t.sync(); expect(admitted).toBe(true);
    expect(await t.cursor()).toEqual({ historyId: baseline });
    const owed = (await t.backend.store.providerStore(t.account.id).pendingFlagSnapshots({ limit: 50 })).items;
    expect(owed.map((item) => item.providerMsgId)).toEqual(["a"]);
    t.checkpoint(); await t.reopen(); t.requests.length = 0; await t.sync();
    expect(t.requests.filter((url) => url.pathname.endsWith("/messages/a")).map((url) => url.searchParams.get("format"))).toEqual(["minimal"]);
    expect((await t.rows()).find((row) => row.id === owed[0]!.id)).toMatchObject({ providerMsgId: "a", isRead: true, inInbox: false, bodyText: "Exact body a" });
    expect((await t.backend.store.providerStore(t.account.id).pendingFlagSnapshots({ limit: 50 })).items).toEqual([]);
  });

});


describe.each(["SQL", "IndexedDB"] as const)("%s local cached-refresh fairness", (kind) => {
  it.each(["normal", "local", "gone"] as const)("allows a concurrent account to complete during 1050 %s identities and an empty continuation", async (mode) => {
    const t = await mailbox(kind, mode, true);
    await t.seed(Array.from({ length: 1050 }, (_, i) => `m${String(i).padStart(4, "0")}`));
    const peer = await t.peer();
    let pages = 0, completedAt: number | undefined, caughtUpAt: number | undefined;
    let scheduled: Promise<void> | undefined;
    t.checkpoint(async (value) => {
      const progress = (value as { reconciliation?: { stage: string; refreshAfter?: string } }).reconciliation;
      if (progress?.stage === "refresh" && progress.refreshAfter) {
        pages++;
        if (!scheduled) scheduled = new Promise<void>((resolve) => setImmediate(resolve)).then(peer).then(() => { completedAt = pages; });
      }
      if (progress?.stage === "catchup") caughtUpAt = completedAt;
    });
    await t.sync(); await scheduled;
    expect(pages).toBe(22);
    expect(caughtUpAt).toBeDefined();
    expect(completedAt).toBeLessThan(pages);
    expect(await t.cursor()).toEqual({ historyId: baseline });
    expect(t.requests.filter((url) => url.pathname.endsWith("/messages") && url.searchParams.has("pageToken")).map((url) => url.searchParams.get("pageToken"))).toEqual(["opaque/+?=empty"]);
    const rows = (await t.rows()).filter((m) => m.providerMsgId !== "sibling");
    expect(rows).toHaveLength(mode === "gone" ? 0 : 1050);
  });

  it.each(["normal", "local", "gone"] as const)("honors cancellation before draining 1050 %s identities", async (mode) => {
    const t = await mailbox(kind, mode);
    await t.seed(Array.from({ length: 1050 }, (_, i) => `m${String(i).padStart(4, "0")}`));
    let scheduled: Promise<void> | undefined, catchup = false;
    t.checkpoint(async (value) => {
      const progress = (value as { reconciliation?: { stage: string; refreshAfter?: string } }).reconciliation;
      if (!scheduled && progress?.stage === "refresh" && progress.refreshAfter) scheduled = new Promise<void>((resolve) => setImmediate(resolve)).then(() => t.backend.dropAccount(t.account.id));
      if (progress?.stage === "catchup") catchup = true;
    });
    await t.sync(); await scheduled;
    expect(catchup).toBe(false);
    expect(await t.cursor()).toMatchObject({ reconciliation: { stage: "refresh", baseline } });
    const checkpoint = await t.cursor() as { reconciliation: { refreshAfter: string } };
    expect(checkpoint.reconciliation.refreshAfter < (mode === "local" ? "local:m1049" : "m1049")).toBe(true);
    const reads = t.requests.length;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(t.requests).toHaveLength(reads);
  });
});
