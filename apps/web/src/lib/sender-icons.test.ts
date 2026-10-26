/**
 * Plan 22, the renderer's icon store (Codex review): no more than two requests in flight however
 * many frames ask, no image kept alive by an avatar that's gone, and nothing asked in spam.
 */
import type { IconAnswer } from "@terno/core/rpc";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.document = { visibilityState: "visible" };
  g.window = globalThis;
  // a frame = a macrotask here
  g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
  const pending: { method: string; params: { emails?: string[]; ids?: string[] }; resolve(v: unknown): void }[] = [];
  const listeners: ((e: { icons: Record<string, IconAnswer>; reset?: boolean }) => void)[] = [];
  let inflight = 0;
  let maxInflight = 0;
  return {
    pending,
    listeners,
    stats: () => ({ maxInflight }),
    resetStats: () => void (maxInflight = 0),
    client: {
      call: (method: string, params: { emails?: string[]; ids?: string[] }) => {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        return new Promise((resolve) => pending.push({ method, params, resolve: (v) => (inflight--, resolve(v)) }));
      },
      on: (_e: string, l: (e: { icons: Record<string, IconAnswer>; reset?: boolean }) => void) => {
        listeners.push(l);
        return () => {};
      },
    },
  };
});

vi.mock("~/rpc/connection", () => ({ client: fake.client }));
vi.mock("~/state/app", () => ({ useApp: () => true }));

const { __senderIconsForTests: store, iconsAllowed, shown, subscribeIcon } = await import("./sender-icons");
const frame = () => new Promise((r) => setTimeout(r, 1));

beforeEach(() => {
  store.reset();
  fake.pending.length = 0;
  fake.resetStats();
});

describe("the renderer's sender icons (plan 22)", () => {
  it("frames of new avatars against a slow backend: never more than two requests in flight", async () => {
    for (let f = 0; f < 12; f++) {
      for (let i = 0; i < 30; i++) {
        const email = `p${f}-${i}@site${f}.com`;
        store.visible.add(email);
        store.request(email);
      }
      await frame();
    }
    expect(fake.stats().maxInflight).toBeLessThanOrEqual(2);
    // answering lets the queue go on, still two at a time
    while (fake.pending.length) {
      fake.pending.shift()!.resolve({});
      await frame();
    }
    expect(fake.stats().maxInflight).toBeLessThanOrEqual(2);
    expect(store.inflight).toBe(0);
  });

  it("an avatar that's gone keeps no image alive: 5,000 avatars come and go, snapshots don't accumulate", async () => {
    for (let i = 0; i < 5000; i++) {
      const email = `p${i}@x${i}.com`;
      const ref = { id: `d:x${i}.com`, v: 1, kind: "site" as const, px: 32, full: false };
      store.entries.set(email, { state: "ref", ref });
      store.data.set(`${ref.id}:1`, `data:image/png;base64,${"A".repeat(2000)}`);
      const off = subscribeIcon(email, () => {});
      expect(shown(email)?.url).toBeTruthy();
      off();
      // what the data LRU would do
      if (store.data.size > 400) store.data.delete(store.data.keys().next().value!);
    }
    expect(store.snapshots.size).toBe(0);
  });

  it("no icons in spam, however the search says it", () => {
    expect(iconsAllowed("inbox", "")).toBe(true);
    expect(iconsAllowed("spam", "")).toBe(false);
    for (const q of ["in:spam", "en:spam", 'in:"spam"', "IN:Spam factura", "from:ana in:spam"]) expect(iconsAllowed("inbox", q), q).toBe(false);
    for (const q of ["spam", "in:inbox", "in:all factura", "-in:spam"]) expect(iconsAllowed("all", q), q).toBe(true);
  });
});
