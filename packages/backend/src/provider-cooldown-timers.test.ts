import { afterEach, expect, it, vi } from "vitest";
import { ProviderCooldown, type CooldownPersistence } from "./provider-cooldown";

const clock = { wallNow: () => 1000, elapsedNow: () => 10, random: () => 0.5 };

afterEach(() => vi.unstubAllGlobals());

it("uses host-compatible native timer receivers and joins physical writes before close", async () => {
  const nativeSet = globalThis.setTimeout, nativeClear = globalThis.clearTimeout;
  let started = 0, cleared = 0;
  vi.stubGlobal("setTimeout", function (this: unknown, fn: () => void, ms: number) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation: setTimeout");
    started++;
    return nativeSet(fn, ms);
  });
  vi.stubGlobal("clearTimeout", function (this: unknown, timer: ReturnType<typeof setTimeout>) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation: clearTimeout");
    cleared++;
    nativeClear(timer);
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let encoded: string | null = null;
  const port: CooldownPersistence = {
    read: async () => encoded,
    update: async (fn) => { await held; const result = fn(encoded); encoded = result.encoded; return result.result; },
  };
  const gate = await ProviderCooldown.open(port, clock);
  expect([started, cleared]).toEqual([1, 1]);
  const ticket = gate.requestsFor("a".repeat(64)).reserve({ request: { endpoint: "gmail-api", purpose: "mail" } });
  await ticket.dispatch(async () => new Response(null, { status: 429 }));
  const observation = ticket.headers429({ received: { source: "date-now", kind: "wall", wallMs: 1000 }, minimum: { kind: "none", reason: "not-visible" } });
  ticket.release();
  const drain = gate.drain(5000);
  let closed = false;
  const close = gate.close().then(() => { closed = true; });
  await Promise.resolve();
  expect(closed).toBe(false);
  release();
  expect(await observation).toBe("committed");
  expect(await drain).toBe("drained");
  await close;
  expect(closed).toBe(true);
  expect(gate.resources().tickets).toBe(0);
  expect(started).toBe(cleared);
});

it("clears the actual startup handle using the native receiver even with an injected scheduler", async () => {
  const nativeSet = globalThis.setTimeout, nativeClear = globalThis.clearTimeout;
  let handle: ReturnType<typeof setTimeout> | undefined, cleared = false, fired = false;
  vi.stubGlobal("clearTimeout", function (this: unknown, timer: ReturnType<typeof setTimeout>) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation: clearTimeout");
    expect(timer).toBe(handle);
    cleared = true;
    nativeClear(timer);
  });
  const port: CooldownPersistence = { read: async () => null, update: async (fn) => fn(null).result };
  const gate = await ProviderCooldown.open(port, clock, { setTimeout: (fn, ms) => (handle = nativeSet(() => { fired = true; fn(); }, ms)) });
  expect(cleared).toBe(true);
  expect(fired).toBe(false);
  await gate.close();
});

it("keeps the existing receiver for injected timer hooks", async () => {
  const receivers: unknown[] = [];
  const hooks = {
    setTimeout(this: unknown, _fn: () => void, _ms: number) { receivers.push(this); return 1 as unknown as ReturnType<typeof setTimeout>; },
    clearTimeout(this: unknown, _timer: ReturnType<typeof setTimeout>) { receivers.push(this); },
  };
  const port: CooldownPersistence = { read: async () => null, update: async (fn) => fn(null).result };
  const gate = await ProviderCooldown.open(port, clock, hooks);
  expect(receivers).toEqual([gate, gate]);
  await gate.close();
});

it("observer deadlines retain the physical writer until close joins it", async () => {
  let now = 0, next = 0, writes = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const hooks = {
    setTimeout: (fn: () => void, ms: number) => { const id = ++next; timers.set(id, { at: now + ms, fn }); return id as unknown as ReturnType<typeof setTimeout>; },
    clearTimeout: (id: ReturnType<typeof setTimeout>) => { timers.delete(id as unknown as number); },
  };
  const advance = (time: number) => { now = time; for (const [id, timer] of Array.from(timers)) if (timer.at <= now) { timers.delete(id); timer.fn(); } };
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const port: CooldownPersistence = { read: async () => null, update: async (fn) => { writes++; await held; return fn(null).result; } };
  const gate = await ProviderCooldown.open(port, clock, hooks);
  const ticket = gate.requestsFor("a".repeat(64)).reserve({ request: { endpoint: "gmail-api", purpose: "mail" } });
  await ticket.dispatch(async () => new Response(null, { status: 429 }));
  const observation = ticket.headers429({ received: { source: "date-now", kind: "wall", wallMs: 1000 }, minimum: { kind: "none", reason: "not-visible" } });
  ticket.release();
  const short = gate.drain(5000), long = gate.drain(30000);
  let closed = false; const close = gate.close().then(() => { closed = true; });
  advance(5000);
  expect(await observation).toBe("unconfirmed"); expect(await short).toBe("pending-terminal");
  expect(gate.resources().writer).toBe(true); expect(await gate.recoverStorage()).toBe("pending-terminal");
  advance(30000); expect(await long).toBe("pending-terminal");
  expect(closed).toBe(false); expect(writes).toBe(1);
  release(); await close;
  expect(closed).toBe(true); expect(gate.resources().tickets).toBe(0); expect(timers.size).toBe(0);
});
