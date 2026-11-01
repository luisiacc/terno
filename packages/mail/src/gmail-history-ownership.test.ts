import { afterEach, expect, it, vi } from "vitest";
import { createNetworkPolicy } from "../../backend/src/net-policy";
import { ProviderCooldown } from "../../backend/src/provider-cooldown";

afterEach(() => vi.restoreAllMocks());

it.each(["eof", "cancel"] as const)("keeps one native history reader and capacity until actual EOF (%s)", async (action) => {
  let cancellations = 0;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const source = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel() { cancellations++; } }, { highWaterMark: 0 }));
  const getReader = source.body!.getReader.bind(source.body);
  let owned!: ReadableStreamDefaultReader<Uint8Array>;
  const acquire = vi.spyOn(source.body!, "getReader").mockImplementation(() => {
    owned = getReader();
    vi.spyOn(owned, "read");
    vi.spyOn(owned, "releaseLock");
    return owned;
  });
  let requests = 0, ledger: string | null = null;
  const gate = await ProviderCooldown.open({ read: async () => ledger, update: async (fn) => {
    const next = fn(ledger); ledger = next.encoded; return next.result;
  } }, { wallNow: Date.now, elapsedNow: () => performance.now(), random: () => 0.5 });
  const resource = "https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=10";
  const net = createNetworkPolicy({ fetch: async (input) => {
    expect(input).toBeInstanceOf(Request);
    expect((input as Request).url).toBe(resource);
    expect((input as Request).redirect).toBe("error");
    requests++; return source;
  } });
  try {
    const response = await net.fetchGoogle(gate.requestsFor("a".repeat(64)), { request: { endpoint: "gmail-api", purpose: "mail" } })(resource);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(owned.releaseLock).not.toHaveBeenCalled();
    expect(source.body!.locked).toBe(true);
    expect(owned.read).not.toHaveBeenCalled();
    expect(net.googlePending()).toBe(1);
    const reader = response.body!.getReader();
    try {
      const bytes = new TextEncoder().encode('{"historyId":"11"}');
      controller.enqueue(bytes);
      expect(await reader.read()).toEqual({ done: false, value: bytes });
      expect(owned.read).toHaveBeenCalledTimes(1);
      expect(net.googlePending()).toBe(1);
      if (action === "cancel") {
        await reader.cancel("Synthetic local cancellation");
        expect(cancellations).toBe(1);
        expect(owned.read).toHaveBeenCalledTimes(1);
        expect(net.googlePending()).toBe(1);
        expect(acquire).toHaveBeenCalledTimes(1);
        expect(owned.releaseLock).not.toHaveBeenCalled();
        return;
      }
      let settled = false;
      const final = reader.read().then((result) => { settled = true; return result; });
      await Promise.resolve();
      expect(owned.read).toHaveBeenCalledTimes(2);
      expect(settled).toBe(false);
      expect(net.googlePending()).toBe(1);
      controller.close();
      expect(await final).toEqual({ done: true, value: undefined });
      expect(net.googlePending()).toBe(0);
      expect(requests).toBe(1);
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(owned.releaseLock).not.toHaveBeenCalled();
    } finally { reader.releaseLock(); }
  } finally { await gate.close(); }
});
