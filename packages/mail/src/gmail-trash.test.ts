import { afterEach, expect, it, vi } from "vitest";
import { createNetworkPolicy } from "../../backend/src/net-policy";
import { createGmailApiProvider } from "./gmail-api";
import type { GoogleRequests, ProviderContext, ProviderRequests } from "./types";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); }
});

/** Trash through the managed request path: every request reserves its ticket and hands back what it heard. */
function mailbox(answer: (id: string) => Response | Promise<Response>) {
  const asked: string[] = [], settled429: number[] = [];
  let reservations = 0, active = 0, peak = 0, dispatched = 0;
  const net = createNetworkPolicy({ fetch: async (input) => {
    const id = new URL((input as Request).url).pathname.split("/").at(-2)!;
    asked.push(id);
    active++; peak = Math.max(peak, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return await answer(id);
    } finally { active--; }
  } });
  const policy: ProviderRequests = {
    check() {},
    reserve(descriptor) {
      reservations++;
      return { request: descriptor.request, dispatch: (transport) => { descriptor.run?.markDispatched(); return transport(); }, headers() {},
        headers429: async () => { settled429.push(reservations); return "committed"; }, release() { reservations--; } };
    }, accessAvailable() {}, tokenUnavailable() {}, close() {},
  };
  const ctx = {
    account: { id: 1, email: "me@example.test" }, config: {}, fetch: async () => { throw new Error("unmanaged fetch forbidden"); },
    google: { check() {}, generation: () => 1, prove: async () => {}, request: (descriptor, input, init) => net.fetchGoogle(policy, descriptor)(input, init), accessAvailable() {}, tokenUnavailable() {} } satisfies GoogleRequests,
    store: { providerIds: async (ids: number[]) => new Map(ids.map((id) => [id, `g${id}`])) },
  } as unknown as ProviderContext;
  const provider = createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() });
  cleanup.push(async () => { await provider.close(); expect(reservations).toBe(0); expect(net.googlePending()).toBe(0); });
  const trash = (count: number) => provider.execute({ id: "trash", kind: "trash", target: { messageIds: Array.from({ length: count }, (_, i) => i + 1) }, payload: {}, requestRun: { markDispatched() { dispatched++; } } } as never);
  return { trash, asked, settled429, peak: () => peak, dispatched: () => dispatched };
}

const ok = (id: string) => Response.json({ id });

it("a bulk trash goes side by side, each message once, none skipped", async () => {
  const box = mailbox(ok);
  await box.trash(40);
  expect(box.peak()).toBe(6);
  expect([...box.asked].sort()).toEqual(Array.from({ length: 40 }, (_, i) => `g${i + 1}`).sort());
  expect(box.dispatched()).toBe(40);
});

it("a message gone for good fails the operation; what hadn't begun isn't sent", async () => {
  const box = mailbox((id) => (id === "g2" ? new Response(null, { status: 404 }) : ok(id)));
  await expect(box.trash(40)).rejects.toMatchObject({ retryable: false });
  expect(box.asked).toContain("g1");
  expect(box.asked.length).toBeLessThan(40);
  expect(box.dispatched()).toBe(box.asked.length);
});

it("a 429 among siblings stays retryable, is heard once, and every ticket settles", async () => {
  const box = mailbox((id) => (id === "g3" ? new Response(null, { status: 429, headers: { "retry-after": "60" } }) : ok(id)));
  await expect(box.trash(40)).rejects.toMatchObject({ retryable: true });
  expect(box.settled429).toHaveLength(1);
  expect(box.asked.length).toBeLessThan(40);
});

it("one message still works as one request", async () => {
  const box = mailbox(ok);
  await box.trash(1);
  expect(box.asked).toEqual(["g1"]);
});
