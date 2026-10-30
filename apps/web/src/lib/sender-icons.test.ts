/**
 * Plan 22, the renderer's icon store (Codex review): no more than two requests in flight however
 * many frames ask, no image kept alive by an avatar that's gone, and nothing asked in spam.
 */
import type { IconAnswer } from "@terno/core/rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.document = { visibilityState: "visible" };
  g.window = globalThis;
  // a frame = a macrotask here
  g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
  const pending: { method: string; params: { emails?: string[]; ids?: string[] }; resolve(v: unknown): void; reject(e: unknown): void }[] = [];
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
        return new Promise((resolve, reject) => pending.push({ method, params, resolve: (v) => (inflight--, resolve(v)), reject: (e) => (inflight--, reject(e)) }));
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

const { __senderIconsForTests: store, iconsAllowed, iconsAllowedForList, shown, subscribeIcon } = await import("./sender-icons");
const frame = () => new Promise((r) => setTimeout(r, 1));

beforeEach(() => {
  store.reset();
  fake.pending.length = 0;
  fake.resetStats();
});

afterEach(async () => {
  store.visible.clear();
  for (let i = 0; i < 20; i++) {
    for (const p of fake.pending.splice(0)) p.resolve({});
    await frame();
    if (i >= 3 && store.inflight === 0 && fake.pending.length === 0) break;
  }
  expect(store.inflight).toBe(0);
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

  it("leaving Spam: the rows still on screen were loaded for Spam, so they don't ask (second Codex review)", () => {
    expect(iconsAllowedForList(JSON.stringify(["spam", null, null, null, null, ""]))).toBe(false);
    expect(iconsAllowedForList(JSON.stringify(["inbox", null, null, null, null, "en:spam"]))).toBe(false);
    // plan 68 (Codex R2): a folder's key puts the folder before the query, which stays last
    expect(iconsAllowedForList(JSON.stringify(["all", 2, null, null, null, "Label_1", "in:spam"]))).toBe(false);
    expect(iconsAllowedForList(JSON.stringify(["all", 2, null, null, null, "Label_1", ""]))).toBe(true);
    expect(iconsAllowedForList(JSON.stringify(["inbox", null, null, null, null, ""]))).toBe(true);
    expect(iconsAllowedForList(null)).toBe(false);
  });

  it("an icon whose bytes are gone (evicted, a lost file) is looked up again, once, while it's on screen (second Codex review)", async () => {
    const ref = { id: "d:gone.com", v: 1, kind: "site" as const, px: 32, full: false };
    store.entries.set("a@gone.com", { state: "ref", ref });
    store.visible.add("a@gone.com");
    store.request("a@gone.com");
    await frame();
    const data = fake.pending.shift()!;
    expect(data.method).toBe("icons.data");
    data.resolve({ "d:gone.com": null });
    await frame();
    await frame();
    const again = fake.pending.shift()!;
    expect(again).toMatchObject({ method: "icons.lookup", params: { emails: ["a@gone.com"] } });
    // the same ref and still no bytes: initials, no loop
    again.resolve({ "a@gone.com": ref });
    await frame();
    await frame();
    fake.pending.shift()!.resolve({ "d:gone.com": null });
    await frame();
    await frame();
    expect(fake.pending).toEqual([]);
    expect(store.entries.get("a@gone.com")).toEqual({ state: "none" });
  });
});

// A reset (a source on or off, photos listed, icons forgotten) never blanks the avatars on screen: they'd flash to
// initials and back. What's on screen keeps drawing until its new answer can be drawn.
describe("a reset doesn't flash the list", () => {
  const ref = (id: string, v = 1) => ({ id, v, kind: "site" as const, px: 32, full: false });
  const answerAll = async (answer: (p: (typeof fake.pending)[number]) => unknown) => {
    for (let i = 0; i < 10 && fake.pending.length; i++) {
      const p = fake.pending.shift()!;
      p.resolve(answer(p));
      await frame();
    }
  };
  const showing = (email: string, a: ReturnType<typeof ref>) => {
    store.visible.add(email);
    store.entries.set(email, { state: "ref", ref: a });
    store.data.set(`${a.id}:${a.v}`, `data:${a.id}`);
  };

  it("an icon on screen stays drawn through the reset and its lookup; the same answer keeps it", async () => {
    showing("ana@acme.com", ref("d:acme.com"));
    const seen: (string | undefined)[] = [];
    subscribeIcon("ana@acme.com", () => seen.push(shown("ana@acme.com")?.url));
    fake.listeners.forEach((l) => l({ icons: {}, reset: true }));
    expect(shown("ana@acme.com")?.url).toBe("data:d:acme.com");
    await frame();
    expect(fake.pending.map((p) => p.method)).toEqual(["icons.lookup"]);
    expect(shown("ana@acme.com")?.url).toBe("data:d:acme.com");
    await answerAll(() => ({ "ana@acme.com": ref("d:acme.com") }));
    expect(shown("ana@acme.com")?.url).toBe("data:d:acme.com");
    // never drawn as initials in between
    expect(seen.every((u) => u !== undefined)).toBe(true);
  });

  it("a new icon replaces the old one only once its bytes are here", async () => {
    showing("ana@gmail.com", ref("d:gmail.com"));
    fake.listeners.forEach((l) => l({ icons: {}, reset: true }));
    await frame();
    fake.pending.shift()!.resolve({ "ana@gmail.com": { ...ref("p:ana"), kind: "photo" } });
    await frame();
    await frame();
    // the lookup answered; the photo's bytes are on their way: still the old icon
    expect(fake.pending.map((p) => p.method)).toEqual(["icons.data"]);
    expect(shown("ana@gmail.com")?.url).toBe("data:d:gmail.com");
    await answerAll(() => ({ "p:ana": "data:photo" }));
    expect(shown("ana@gmail.com")?.url).toBe("data:photo");
  });

  it("an icon that's gone (its source off) goes to initials when the answer says so; off-screen ones are forgotten", async () => {
    showing("ana@gmail.com", { ...ref("p:ana"), kind: "photo" } as unknown as ReturnType<typeof ref>);
    store.entries.set("away@x.com", { state: "ref", ref: ref("d:x.com") });
    fake.listeners.forEach((l) => l({ icons: {}, reset: true }));
    expect(store.entries.has("away@x.com")).toBe(false);
    await frame();
    expect(shown("ana@gmail.com")?.url).toBe("data:p:ana");
    await answerAll(() => ({ "ana@gmail.com": null }));
    expect(shown("ana@gmail.com")).toBeNull();
  });
});

// Codex review (plan 75)
describe("holding through a reset, the edge cases", () => {
  const ref = (id: string, v = 1) => ({ id, v, kind: "site" as const, px: 32, full: false });
  const showing = (email: string, a: ReturnType<typeof ref>) => {
    store.visible.add(email);
    store.entries.set(email, { state: "ref", ref: a });
    store.data.set(`${a.id}:${a.v}`, `data:${a.id}`);
  };
  const reset = () => fake.listeners.forEach((l) => l({ icons: {}, reset: true }));
  const take = (method: string) => {
    const i = fake.pending.findIndex((p) => p.method === method);
    return fake.pending.splice(i, 1)[0]!;
  };

  it("a replacement from before a reset never comes back for an address that left the screen", async () => {
    showing("ana@gmail.com", ref("d:gmail.com"));
    reset();
    await frame();
    take("icons.lookup").resolve({ "ana@gmail.com": ref("p:ana") });
    await frame();
    await frame();
    const data = take("icons.data");
    // scrolled away, then the photo source turned off
    store.visible.delete("ana@gmail.com");
    reset();
    data.resolve({ "p:ana": "data:photo" });
    await frame();
    expect(store.entries.has("ana@gmail.com")).toBe(false);
    expect(shown("ana@gmail.com")).toBeNull();
  });

  it("a replacement whose bytes fail to come is looked up again, not stuck on the old icon", async () => {
    showing("ana@acme.com", ref("d:acme.com"));
    reset();
    await frame();
    take("icons.lookup").resolve({ "ana@acme.com": ref("d:acme.com", 2) });
    await frame();
    await frame();
    take("icons.data").reject(new Error("offline"));
    await frame();
    await frame();
    expect(fake.pending.some((p) => p.method === "icons.lookup" && p.params.emails?.includes("ana@acme.com"))).toBe(true);
  });

  it("another address's bytes arriving don't release a hold: the old icon stays until the new one's are here", async () => {
    showing("ana@acme.com", ref("d:acme.com"));
    // another avatar on screen whose bytes are on their way
    store.visible.add("bob@bob.com");
    store.entries.set("bob@bob.com", { state: "ref", ref: ref("d:bob.com") });
    reset();
    store.request("bob@bob.com");
    await frame();
    await frame();
    const other = fake.pending.find((p) => p.method === "icons.data");
    if (other) {
      fake.pending.splice(fake.pending.indexOf(other), 1);
      other.resolve({ "d:bob.com": "data:bob" });
      await frame();
    }
    take("icons.lookup").resolve({ "ana@acme.com": ref("d:acme.com", 2), "bob@bob.com": ref("d:bob.com") });
    await frame();
    expect(shown("ana@acme.com")?.url).toBe("data:d:acme.com");
  });
});

// A backend reset cannot retract RPC replies that are already on their way to the renderer.
describe("reset generations", () => {
  const email = "ana@acme.com";
  const ref = { id: "d:acme.com", v: 1, kind: "site" as const, px: 32, full: false };
  const reset = () => fake.listeners.forEach((l) => l({ icons: {}, reset: true }));

  it("an old lookup cannot resurrect an icon after the new generation answers none", async () => {
    store.visible.add(email);
    store.request(email);
    await frame();
    const old = fake.pending.shift()!;
    reset();
    await frame();
    fake.pending.shift()!.resolve({ [email]: null });
    await frame();
    old.resolve({ [email]: ref });
    await frame();
    await frame();
    expect(store.entries.get(email)).toEqual({ state: "none" });
    expect(fake.pending).toEqual([]);
    expect(shown(email)).toBeNull();
  });

  it("old bytes cannot populate a new generation's same ref while its own data is held", async () => {
    store.visible.add(email);
    store.entries.set(email, { state: "ref", ref });
    store.request(email);
    await frame();
    const old = fake.pending.shift()!;
    reset();
    await frame();
    fake.pending.shift()!.resolve({ [email]: ref });
    await frame();
    old.resolve({ [ref.id]: "data:old" });
    await frame();
    await frame();
    const current = fake.pending.shift()!;
    expect(current.method).toBe("icons.data");
    const before = shown(email);
    current.resolve({ [ref.id]: "data:new" });
    await frame();
    expect(before).toBeNull();
    expect(shown(email)?.url).toBe("data:new");
  });
});

describe("obsolete failures and retries (review regression)", () => {
  const email = "ana@acme.com";
  const ref = (v: number) => ({ id: "d:acme.com", v, kind: "site" as const, px: 32, full: false });
  const reset = () => fake.listeners.forEach((l) => l({ icons: {}, reset: true }));
  const showing = () => {
    store.visible.add(email);
    store.entries.set(email, { state: "ref", ref: ref(1) });
    store.data.set("d:acme.com:1", "data:initial");
    store.request(email);
  };

  it.each(["lookup", "data"] as const)("an old %s rejection cannot release the current replacement", async (method) => {
    showing();
    if (method === "data") {
      store.data.clear();
      store.request(email);
    } else reset();
    await frame();
    const old = fake.pending.shift()!;
    expect(old.method).toBe(`icons.${method}`);
    if (method === "data") {
      store.entries.set(email, { state: "ref", ref: ref(0) });
      store.data.set("d:acme.com:0", "data:initial");
    }
    reset();
    await frame();
    fake.pending.shift()!.resolve({ [email]: ref(method === "data" ? 1 : 2) });
    await frame();
    await frame();
    const current = fake.pending.shift()!;
    expect(current.method).toBe("icons.data");
    old.reject(new Error("old connection closed"));
    await frame();
    current.resolve({ "d:acme.com": "data:current" });
    await frame();
    expect(shown(email)?.url).toBe("data:current");
    expect(fake.stats().maxInflight).toBeLessThanOrEqual(2);
  });

  it.each([false, true])("a pre-reset again timer launches no stale retry (held=%s)", async (held) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      showing();
      if (!held) {
        store.entries.clear();
        store.data.clear();
      } else {
        reset();
        await vi.advanceTimersByTimeAsync(1);
        fake.pending.shift()!.resolve({});
        await vi.advanceTimersByTimeAsync(1);
      }
      fake.listeners.forEach((l) => l({ icons: { [email]: "again" } }));
      reset();
      await vi.advanceTimersByTimeAsync(1);
      const current = fake.pending.shift()!;
      // A failed current lookup leaves an unheld address eligible to ask again.
      if (held) current.resolve({});
      else current.reject(new Error("offline"));
      await vi.advanceTimersByTimeAsync(1501);
      const calls = fake.pending.length;
      for (const p of fake.pending.splice(0)) p.resolve({});
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("two obsolete jobs retain their slots until settled, then current work resumes", async () => {
    const other = "bob@other.com";
    store.visible.add(email);
    store.request(email);
    await frame();
    store.visible.add(other);
    store.request(other);
    await frame();
    const old = fake.pending.splice(0);
    expect(old).toHaveLength(2);
    reset();
    await frame();
    expect(fake.pending).toEqual([]);
    old[0]!.resolve({});
    await frame();
    await frame();
    const current = fake.pending.shift()!;
    expect(current.params.emails).toEqual([email, other]);
    current.resolve({ [email]: null, [other]: null });
    old[1]!.resolve({});
    await frame();
    expect(fake.stats().maxInflight).toBe(2);
    expect(store.inflight).toBe(0);
  });
});
