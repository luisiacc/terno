import { createMemoryTransportPair, RPC_VERSION, RpcClient, type RpcRequest, type Transport, type Events, type EventName, type RpcErrorPayload } from "@terno/core/rpc";
import type { ThreadDetail, ThreadSummary } from "@terno/core";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("~/rpc/connection", async () => {
  const { RpcClient } = await import("@terno/core/rpc");
  return { client: new RpcClient() };
});
const { client } = await import("./connection");
const { loadThread, useThreads } = await import("~/state/threads");
const { reloadList, useList } = await import("~/state/list");
const { setApp } = await import("~/state/app");

const transports: Transport[] = [];
function attach() {
  const [renderer, server] = createMemoryTransportPair();
  transports.push(renderer, server);
  const requests: RpcRequest[] = [];
  server.onMessage((m) => { if (m.t === "req") requests.push(m); });
  client.attach(renderer);
  return { requests, event: <E extends EventName>(event: E, payload: Events[E]) => server.send({ v: RPC_VERSION, t: "evt", e: event, p: payload }), error: (req: RpcRequest, code: string) => server.send({ v: RPC_VERSION, t: "res", id: req.id, ok: false, e: { code, message: "synthetic" } as RpcErrorPayload }), reply: (req: RpcRequest, result: unknown) => server.send({ v: RPC_VERSION, t: "res", id: req.id, ok: true, r: result }) };
}
// a task, not a count of microtasks: threads.get hydrates its body parts through more hops (w11)
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const row = (id: number, starred = false): ThreadSummary => ({ id, accountId: 1, subject: "synthetic", snippet: "", lastDate: id, messageCount: 1, unread: !starred, starred, categoryIds: [], fromName: "Synthetic", fromEmail: "synthetic@example.test", hasAttachments: false });
const detail = (id: number, starred = false): ThreadDetail => ({ thread: { ...row(id, starred), inInbox: true, inTrash: false, inSpam: false }, messages: [] });
afterEach(() => {
  client.close();
  for (const t of transports.splice(0)) t.close();
  useThreads.setState({ details: new Map(), gone: new Set() });
  useList.setState({ loadingMore: false, nextCursor: null });
  setApp({ selectedId: null });
});

it("a warm unchanged-ID detail must refetch on replacement instead of serving the old connection cache", async () => {
  const old = attach();
  const first = loadThread(701, true); await tick();
  old.reply(old.requests[0]!, detail(701)); await first;
  setApp({ selectedId: 701 });
  const replacement = attach();
  const next = loadThread(701); await tick();
  expect(replacement.requests.map((r) => [r.m, r.p])).toEqual([["threads.get", { threadId: 701, bodyFormat: "parts" }]]);
  replacement.reply(replacement.requests[0]!, detail(701, true));
  await next;
  expect(useThreads.getState().details.get(701)?.thread).toMatchObject({ id: 701, starred: true, unread: false });
});

it("a received detail whose Promise continuation runs after attach cannot publish old connection state", async () => {
  const old = attach();
  const first = loadThread(702, true); await tick();
  old.reply(old.requests[0]!, detail(702));
  await Promise.resolve(); // receive resolves, but the cache continuation has not run
  const replacement = attach();
  await first;
  expect(useThreads.getState().details.has(702)).toBe(false);
  const next = loadThread(702); await tick();
  replacement.reply(replacement.requests[0]!, detail(702, true)); await next;
  expect(useThreads.getState().details.get(702)?.thread.starred).toBe(true);
});

it("an already received old query must not publish after connection replacement", async () => {
  const old = attach();
  const first = reloadList({ keepSelection: true }); await tick();
  old.reply(old.requests[0]!, { items: [row(703)], nextCursor: null });
  await Promise.resolve();
  const replacement = attach();
  await first;
  expect(useList.getState().items.some((r) => r.id === 703)).toBe(false);
  const next = reloadList({ keepSelection: true }); await tick();
  replacement.reply(replacement.requests[0]!, { items: [row(704, true)], nextCursor: null }); await next;
  expect(useList.getState().items.map((r) => r.id)).toEqual([704]);
});

it("actual RpcClient rejects an old pending mutation ACK and never replays it on the new transport", async () => {
  const old = attach();
  const call = client.call("threads.act", { threadIds: [705], action: "star" });
  const rejected = expect(call).rejects.toMatchObject({ code: "UNAVAILABLE" }); await tick();
  const replacement = attach();
  old.reply(old.requests[0]!, { undoId: 9 }); await rejected; await tick();
  expect(replacement.requests).toEqual([]);
  expect(client.pendingCount).toBe(0);
  expect(client).toBeInstanceOf(RpcClient);
});

it("ready-state recovery refreshes unchanged queries, retains the selected detail until replacement, and orders counts events", async () => {
  const { installQueryRecovery } = await import("./reconnect");
  const { getApp, EMPTY_COUNTS } = await import("~/state/app");
  const old = attach();
  const first = loadThread(706, true); await tick(); old.reply(old.requests[0]!, detail(706)); await first;
  setApp({ selectedId: 706, checked: new Set([706]), anchorId: 706 });
  const before = useThreads.getState().details.get(706);
  const stop = installQueryRecovery({ covered: () => false, readerShown: () => true });
  try {
    const replacement = attach(); await tick();
    expect(useThreads.getState().details.get(706)).toBe(before);
    expect(replacement.requests.map((r) => r.m)).toEqual(["threads.list", "threads.get", "counts.get"]);
    for (const req of replacement.requests) replacement.reply(req, req.m === "threads.list" ? { items: [row(706, true)], nextCursor: null } : req.m === "threads.get" ? detail(706, true) : { ...EMPTY_COUNTS, inboxUnread: 8 });
    await tick();
    expect(getApp().counts.inboxUnread).toBe(8);
    expect(getApp().selectedId).toBe(706);
    expect([...getApp().checked]).toEqual([706]);
    expect(getApp().anchorId).toBe(706);
    expect(useThreads.getState().details.get(706)?.thread.starred).toBe(true);
    const third = attach(); await tick();
    // A newer event beats the reconnect read on the very same connection.
    // send via the actual currently attached peer
    third.event("counts", { ...EMPTY_COUNTS, inboxUnread: 3 }); await tick();
    for (const req of third.requests) third.reply(req, req.m === "threads.list" ? { items: [row(706, true)], nextCursor: null } : req.m === "threads.get" ? detail(706, true) : { ...EMPTY_COUNTS, inboxUnread: 99 });
    await tick(); expect(getApp().counts.inboxUnread).toBe(3);
  } finally { stop(); }
  const afterDispose = attach(); await tick(); expect(afterDispose.requests).toEqual([]);
});

it("covered-list recovery retires cursors and negative detail state without loading invisible panes", async () => {
  const { installQueryRecovery } = await import("./reconnect");
  const { flushDeferredRefresh } = await import("~/state/list");
  const { EMPTY_COUNTS } = await import("~/state/app");
  attach();
  useThreads.setState({ gone: new Set([707]) });
  useList.setState({ loadingMore: true, nextCursor: { id: 707, lastDate: 707 } });
  const stop = installQueryRecovery({ covered: () => true, readerShown: () => false });
  try {
    const replacement = attach(); await tick();
    expect(replacement.requests.map((r) => r.m)).toEqual(["counts.get"]);
    expect(useThreads.getState().gone.size).toBe(0);
    expect(useList.getState().nextCursor).toBeNull();
    expect(useList.getState().loadingMore).toBe(false);
    replacement.reply(replacement.requests[0]!, EMPTY_COUNTS); await tick();
    flushDeferredRefresh(); await tick();
    expect(replacement.requests[1]?.m).toBe("threads.list");
    replacement.reply(replacement.requests[1]!, { items: [], nextCursor: null }); await tick();
  } finally { stop(); }
});

it.each(["NOT_FOUND", "INTERNAL"])("an already received old %s detail error cannot delete replacement state", async (code) => {
  const old = attach();
  const first = loadThread(708, true); await tick();
  old.error(old.requests[0]!, code); await Promise.resolve();
  const replacement = attach();
  const next = loadThread(708); await tick();
  replacement.reply(replacement.requests[0]!, detail(708, true));
  await Promise.all([first, next]);
  expect(useThreads.getState().gone.has(708)).toBe(false);
  expect(useThreads.getState().details.get(708)?.thread.starred).toBe(true);
});

it.each(["success", "STALE", "INTERNAL"])("an old pagination %s cannot publish or restart a replacement query", async (outcome) => {
  const { loadMore, invalidateListConnection } = await import("~/state/list");
  const old = attach();
  const initial = reloadList({ keepSelection: true }); await tick();
  old.reply(old.requests[0]!, { items: [row(710)], nextCursor: { id: 710, lastDate: 710 } }); await initial;
  const more = loadMore(); await tick();
  const request = old.requests[1]!;
  if (outcome === "success") old.reply(request, { items: [row(711)], nextCursor: null }); else old.error(request, outcome);
  await Promise.resolve();
  const replacement = attach();
  invalidateListConnection();
  const current = reloadList({ keepSelection: true }); await tick();
  replacement.reply(replacement.requests[0]!, { items: [row(712)], nextCursor: null });
  await Promise.all([more, current]); await tick();
  expect(useList.getState().items.map((r) => r.id)).toEqual([712]);
  expect(replacement.requests.map((r) => r.m)).toEqual(["threads.list"]);
});

it("detail entries and stale marks remain bounded through eviction and repeated replacements", async () => {
  const { staleMarksForTests } = await import("~/state/threads");
  const peer = attach();
  for (let id = 1000; id < 1155; id++) {
    const p = loadThread(id, true); await tick();
    peer.reply(peer.requests.at(-1)!, detail(id)); await p;
  }
  expect(useThreads.getState().details.size).toBe(150);
  for (let i = 0; i < 20; i++) {
    const next = attach();
    const p = loadThread(1154); await tick(); next.reply(next.requests[0]!, detail(1154)); await p;
    expect(useThreads.getState().details.size).toBe(1);
    expect(staleMarksForTests()).toBe(0);
    expect(client.pendingCount).toBe(0);
  }
});
