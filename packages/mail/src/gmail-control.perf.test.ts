import { createNetworkPolicy } from "../../backend/src/net-policy";
import { ProviderCooldown } from "../../backend/src/provider-cooldown";
import { expect, it } from "vitest";
import { BUDGET_MULTIPLIER } from "../../db/src/test/perf";
import { watchLoop } from "../../db/src/test/timing";
import { createGmailApiProvider } from "./gmail-api";
import type { ProviderContext } from "./types";

it.each([false, true].flatMap((managed) => [1, 65_536].map((chunkSize) => ({ managed, chunkSize }))))("consumes a bounded control response within the slice budget ($managed, $chunkSize-byte chunks)", async ({ managed, chunkSize }) => {
  const bytes = new TextEncoder().encode(JSON.stringify({ historyId: "9007199254740995", ignored: "x".repeat(60_000) }));
  const pieces: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) pieces.push(bytes.slice(i, i + chunkSize));
  let offset = 0, requests = 0;
  let next = 0;
  const response = new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset === bytes.length) return controller.close();
    const piece = pieces[next++]!;
    controller.enqueue(piece); offset += piece.length;
  } }));
  globalThis.gc?.();
  let raw: string | null = null;
  const gate = await ProviderCooldown.open({ read: async () => raw, update: async (fn) => { const next = fn(raw); raw = next.encoded; return next.result; } }, { wallNow: Date.now, elapsedNow: () => performance.now(), random: () => 0.5 });
  const policy = gate.requestsFor("a".repeat(64));
  const wire = async () => { requests++; return response; };
  const net = createNetworkPolicy({ localMode: () => true, fetch: wire });
  const ctx = {
    google: managed ? {
      generation: () => 0,
      check: (request: Parameters<NonNullable<ProviderContext["google"]>["check"]>[0]) => policy.check({ request }),
      request: (descriptor: Parameters<NonNullable<ProviderContext["google"]>["request"]>[0], input: Parameters<typeof fetch>[0], init?: RequestInit) => net.fetchGoogle(policy, descriptor)(input, init),
      prove: async () => {}, tokenUnavailable() {}, accessAvailable() {},
    } : undefined,
    account: { id: 1 }, store: {},
    fetch: async () => {
      requests++;
      return response;
    },
  } as unknown as ProviderContext;
  const p = createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() });
  const budget = 15 * BUDGET_MULTIPLIER;
  const monitor = watchLoop(budget);
  try { await p.verify(); }
  finally {
    const timing = monitor.stop();
    await p.close();
    await gate.close();
    expect(timing.stall, JSON.stringify(timing)).toBeLessThanOrEqual(budget);
  }
  expect(requests).toBe(1);
  expect(offset).toBe(bytes.length);
});
