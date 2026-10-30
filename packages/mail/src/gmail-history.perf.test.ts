import { afterEach, expect, it, vi } from "vitest";
import { createNetworkPolicy } from "../../backend/src/net-policy";
import { ProviderCooldown } from "../../backend/src/provider-cooldown";
import { BUDGET_MULTIPLIER } from "../../db/src/test/perf";
import { watchLoop } from "../../db/src/test/timing";
import { createGmailApiProvider } from "./gmail-api";
import type { ProviderContext, SyncSink } from "./types";

afterEach(() => vi.restoreAllMocks());

it("keeps maximal admitted history decoding and expansion within the control slice budget", async () => {
  const history = [{ labelsRemoved: Array.from({ length: 2000 }, (_, i) => ({ message: { id: `m${i}` } })) }];
  const body = JSON.stringify({ historyId: "11", history, ignored: "x".repeat(190_000) });
  const bytes = new TextEncoder().encode(body);
  expect(bytes.length).toBeLessThanOrEqual(256 * 1024);
  let pulled = 0, requests = 0, lookups = 0, nativeReleases = 0, saved: unknown;
  const source = new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    pulled += bytes.length;
    controller.enqueue(bytes); controller.close();
  } }, { highWaterMark: 0 }));
  const getReader = source.body!.getReader.bind(source.body);
  const nativeReaders = vi.spyOn(source.body!, "getReader").mockImplementation(() => {
    const reader = getReader();
    const release = reader.releaseLock.bind(reader);
    vi.spyOn(reader, "releaseLock").mockImplementation(() => { nativeReleases++; release(); });
    return reader;
  });
  const query = new URLSearchParams({ startHistoryId: "10", maxResults: "500" });
  for (const type of ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"]) query.append("historyTypes", type);
  const resource = `https://gmail.googleapis.com/gmail/v1/users/me/history?${query}`;
  let ledger: string | null = null;
  const gate = await ProviderCooldown.open({ read: async () => ledger, update: async (fn) => {
    const next = fn(ledger); ledger = next.encoded; return next.result;
  } }, { wallNow: Date.now, elapsedNow: () => performance.now(), random: () => 0.5 });
  const policy = gate.requestsFor("a".repeat(64));
  const net = createNetworkPolicy({ localMode: () => true, fetch: async (input) => {
    expect(input).toBeInstanceOf(Request);
    const request = input as Request;
    expect(request.url).toBe(resource);
    expect(request.redirect).toBe("error");
    requests++;
    return source;
  } });
  // Prepare the actual admitted response, without pulling its body. Native admission owns the first lock handoff.
  const response = await net.fetchGoogle(policy, { request: { endpoint: "gmail-api", purpose: "mail" } })(resource);
  const ctx = { account: { id: 1 }, config: {}, store: {
    messageByProviderId: async () => { lookups++; return null; }, pendingAttachmentBodies: async () => [],
  }, loadCursor: async () => ({ historyId: "10" }), saveCursor: async (value: unknown) => { saved = value; },
  fetch: async (input: string | URL) => { expect(String(input)).toBe(resource); return response; } } as unknown as ProviderContext;
  const noop = async () => {};
  const sink: SyncSink = { signal: new AbortController().signal, windowStart: 0, ingest: noop, updateFlags: noop,
    removeMessages: noop, setBody: noop, setSyncState: noop, pendingMessageIds: async () => new Set() };
  const provider = createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() });
  try {
    expect(nativeReaders).toHaveBeenCalledTimes(2);
    expect(nativeReleases).toBe(1);
    expect(source.body!.locked).toBe(true);
    expect(response).not.toBe(source);
    expect(pulled).toBe(0);
    expect(net.googlePending()).toBe(1);
    const budget = 15 * BUDGET_MULTIPLIER, monitor = watchLoop(budget);
    try { await provider.sync(sink); }
    finally {
      const timing = monitor.stop();
      expect(timing.stall, JSON.stringify(timing)).toBeLessThanOrEqual(budget);
    }
    expect(pulled).toBe(bytes.length);
    expect(net.googlePending()).toBe(0);
    expect(requests).toBe(1);
    expect(lookups).toBe(2000);
    expect(saved).toEqual({ historyId: "11" });
  } finally { await provider.close(); await gate.close(); }
});
