import { fixtureCleanup, type ExpectedTerminal } from "./provider-cooldown.test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeCooldown, encodeCooldown, type CooldownRow } from "@terno/store";
import { ProviderCooldown, ProviderCooldownError, type CooldownPersistence } from "./provider-cooldown";
import { requestHttp, RequestNotDispatchedError, type Observation429, type RequestDescriptor } from "@terno/mail/portable";

const A = "a".repeat(64), B = "b".repeat(64);
const gmail: RequestDescriptor = { request: { endpoint: "gmail-api", purpose: "mail" } };
const token: RequestDescriptor = { request: { endpoint: "oauth-token", purpose: "refresh" } };

const cleanups = fixtureCleanup();
beforeEach(() => cleanups.assertAvailable());
afterEach(() => cleanups.finish());
function latch<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
function heldWriter() { const held = latch<void>(); cleanups.release(() => held.resolve()); return held; }
async function turns() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function fixture(initial: string | null = null) {
  let encoded = initial, wall = 1000, elapsed = 10, random = 0.5, samples = 0, writes = 0;
  let timerId = 0, wakes = 0, timerStarts = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const port: CooldownPersistence = { read: async () => encoded, update: async (fn) => { writes++; const v = fn(encoded); encoded = v.encoded; return v.result; } };
  const clock = { wallNow: () => wall, elapsedNow: () => elapsed, random: () => { samples++; return random; } };
  const hooks = {
    changed: () => { wakes++; },
    setTimeout: (fn: () => void, ms: number) => { timerStarts++; const id = ++timerId; timers.set(id, { fn, at: elapsed + ms }); return id as unknown as ReturnType<typeof setTimeout>; },
    clearTimeout: (id: ReturnType<typeof setTimeout>) => { timers.delete(id as unknown as number); },
  };
  const open = async (p = port, expected?: ExpectedTerminal) => { const gate = await cleanups.watch("policy/open", ProviderCooldown.open(p, clock, hooks)); cleanups.gate(expected?.label ?? "policy/healthy-close", gate, expected); return gate; };
  return { port, clock, hooks, open, wakes: () => wakes, timerStarts: () => timerStarts, encoded: () => encoded, samples: () => samples, writes: () => writes, random: (r: number) => { random = r; }, time: (w: number, e: number) => { wall = w; elapsed = e; }, fire: () => { const due = [...timers].filter(([, v]) => v.at <= elapsed); for (const [id, v] of due) { timers.delete(id); v.fn(); } }, timers };
}
const none: Observation429 = { received: { source: "date-now", kind: "wall", wallMs: 1000 }, minimum: { kind: "none", reason: "not-visible" } };
const at = (atMs: number): Observation429 => ({ ...none, minimum: { kind: "at", basis: "delay", atMs } });
async function observe(g: ProviderCooldown, e = none, owner = A, d = gmail) {
  const ticket = g.requestsFor(owner).reserve(d);
  await ticket.dispatch(async () => new Response(null, { status: 429 }));
  const result = ticket.headers429(e);
  ticket.release();
  return cleanups.watch("policy/observation", result);
}
function seeded(row: Partial<CooldownRow> = {}) {
  return encodeCooldown({ version: 1, revision: "1", overflow: false, bindings: [], rows: [{ owner: A, service: "gmail-api", revision: "1", phaseRevision: "1", minimum: "121000", wall: "1000", replay: "120000", sample: 2000, position: 1, hold: null, repair: null, ...row }] });
}

describe("latent cooldown policy", () => {
  it("01 missing header floor is 3000", async () => { const f = fixture(), g = await f.open(); await observe(g); expect(g.state(A, "gmail-api")).toEqual({ kind: "at", atMs: 3000 }); expect(f.samples()).toBe(1); });
  it("02 malformed header has finite floor", async () => { const f = fixture(), g = await f.open(); await observe(g, { ...none, minimum: { kind: "none", reason: "invalid" } }); expect(g.state(A, "gmail-api")).toEqual({ kind: "at", atMs: 3000 }); });
  it("03 overlong header has finite floor", async () => { const f = fixture(), g = await f.open(); await observe(g, { ...none, minimum: { kind: "none", reason: "too-long" } }); expect(g.state(A, "gmail-api")).toEqual({ kind: "at", atMs: 3000 }); });
  it("04 zero directive keeps local floor", async () => { const f = fixture(), g = await f.open(); await observe(g, at(1000)); expect(g.state(A, "gmail-api")).toEqual({ kind: "at", atMs: 3000 }); expect(f.samples()).toBe(1); });
  it("05 jitter lower endpoint is 2600", async () => { const f = fixture(); f.random(0); const g = await f.open(); await observe(g); expect(g.state(A, "gmail-api")).toEqual({ kind: "at", atMs: 2600 }); });
  it("06 jitter upper endpoint is 3400", async () => { const f = fixture(); f.random(1); const g = await f.open(); await observe(g); expect(g.state(A, "gmail-api")).toEqual({ kind: "at", atMs: 3400 }); });
  it("07 refusals do not sample or extend", async () => { const f = fixture(), g = await f.open(); await observe(g, at(121000)); const old = f.encoded(); for (let i = 0; i < 8; i++) expect(() => g.requestsFor(A).check(gmail)).toThrow(ProviderCooldownError); expect(f.samples()).toBe(1); expect(f.encoded()).toBe(old); });
  it("08 phase saturates without resampling", async () => { const f = fixture(seeded({ position: 6, minimum: "1000", replay: "0" })), g = await f.open(); await observe(g); expect(g.state(A, "gmail-api")).toEqual({ kind: "at", atMs: 301000 }); expect(decodeCooldown(f.encoded()).rows[0]?.position).toBe(6); expect(f.samples()).toBe(1);
    f.time(301000, 300010);
    const ticket = g.requestsFor(A).reserve(gmail); await ticket.dispatch(async () => new Response()); ticket.headers(200); ticket.release(); await g.drain(5000);
    expect(decodeCooldown(f.encoded()).rows[0]?.position).toBe(0);
    await observe(g, { ...none, received: { source: "date-now", kind: "wall", wallMs: 301000 } });
    expect(g.state(A, "gmail-api")).toEqual({ kind: "at", atMs: 303000 }); expect(f.samples()).toBe(2);
  });
  it("09 valid minimum beats local floor", async () => { const f = fixture(), g = await f.open(); await observe(g, at(121000)); expect(g.state(A, "gmail-api")).toEqual({ kind: "at", atMs: 121000 }); });
  it("10 late weaker evidence keeps D", async () => { const f = fixture(), g = await f.open(); const p = g.requestsFor(A), a = p.reserve(gmail), b = p.reserve(gmail), success = p.reserve(gmail); await success.dispatch(async () => new Response()); await a.dispatch(async () => new Response(null, { status: 429 })); await b.dispatch(async () => new Response(null, { status: 429 })); await a.headers429(at(121000)); await b.headers429(none); a.release(); b.release(); expect(g.state(A, "gmail-api")).toEqual({ kind: "at", atMs: 121000 }); success.headers(200); success.release(); await g.drain(5000); expect(decodeCooldown(f.encoded()).rows[0]?.position).toBe(2); expect(f.samples()).toBe(2); });
  it("11 calendar hold is never fallback", async () => { const f = fixture(), g = await f.open(); await observe(g, { ...none, minimum: { kind: "hold", reason: "calendar" } }); expect(g.state(A, "gmail-api")).toEqual({ kind: "hold", reason: "calendar" }); expect(g.checkClock(A, "gmail-api", g.revisionFor(A, "gmail-api")!)).toEqual({ kind: "hold", reason: "calendar" }); });
  it("12 leap hold keeps known D", async () => { const f = fixture(), g = await f.open(); const p = g.requestsFor(A), a = p.reserve(gmail), b = p.reserve(gmail); await a.dispatch(async () => new Response(null, { status: 429 })); await b.dispatch(async () => new Response(null, { status: 429 })); await a.headers429(at(121000)); await b.headers429({ ...none, minimum: { kind: "hold", reason: "leap-second" } }); a.release(); b.release(); const row = decodeCooldown(f.encoded()).rows[0]!; expect(row.minimum).toBe("121000"); expect(g.state(A, "gmail-api")).toEqual({ kind: "hold", reason: "leap-second" }); });
  it("13 range hold has no timed authority", async () => { const f = fixture(), g = await f.open(); await observe(g, { ...none, minimum: { kind: "hold", reason: "range" } }); f.time(9000000, 9000000); expect(g.state(A, "gmail-api")).toEqual({ kind: "hold", reason: "range" }); });
  it("14 invalid receipt stays unresolved", async () => { const f = fixture(), g = await f.open(); await observe(g, { received: { source: "date-now", kind: "invalid" }, minimum: { kind: "hold", reason: "clock" } }); expect(g.state(A, "gmail-api")).toEqual({ kind: "hold", reason: "clock-evidence" });
    const valid = fixture(); valid.time(1000, NaN); const repairable = await valid.open(); await observe(repairable);
    expect(repairable.state(A, "gmail-api")).toEqual({ kind: "hold", reason: "clock" });
    valid.time(2000, 30); repairable.checkClock(A, "gmail-api", repairable.revisionFor(A, "gmail-api")!); await repairable.drain(5000);
    expect(decodeCooldown(valid.encoded()).rows[0]?.minimum).toBe("3000"); valid.time(4000, 2030); expect(repairable.state(A, "gmail-api")).toEqual({ kind: "ready" });
  });
  it("15 floor epoch overflow holds", async () => { const f = fixture(), g = await f.open(); await observe(g, { ...none, received: { source: "date-now", kind: "wall", wallMs: 8640000000000000 } }); expect(g.state(A, "gmail-api")).toEqual({ kind: "hold", reason: "range" }); expect(g.nextWakeDelay()).toBe(null);
    const long = fixture(seeded({ minimum: "8640000000000000", replay: "8639999999999000" })), next = await long.open(); expect(next.nextWakeDelay()).toBe(2147483647);
  });
  it("16 other mailbox and service work", async () => { const f = fixture(), g = await f.open(); await observe(g); expect(() => g.requestsFor(B).check(gmail)).not.toThrow(); expect(() => g.requestsFor(A).check(token)).not.toThrow(); });
  it("17 wall alone cannot release", async () => { const f = fixture(), g = await f.open(); await observe(g); f.time(3000, 2009); expect(g.state(A, "gmail-api")).toEqual({ kind: "at", atMs: 3000 }); expect(g.nextWakeDelay()).toBe(1); });
  it("18 elapsed alone cannot release", async () => { const f = fixture(), g = await f.open(); await observe(g); f.time(2999, 2010); expect(g.state(A, "gmail-api")).toEqual({ kind: "at", atMs: 3000 }); });
  it("19 exact two-clock boundary opens", async () => { const f = fixture(), g = await f.open(); await observe(g); f.time(3000, 2010); expect(g.state(A, "gmail-api")).toEqual({ kind: "ready" }); expect(g.nextWakeDelay()).toBe(null);
    const fractional = fixture(); fractional.time(1000, 10.75); const bounded = await fractional.open(); await observe(bounded);
    fractional.time(3000, 2010.75); expect(bounded.state(A, "gmail-api")).toEqual({ kind: "at", atMs: 3000 }); fractional.time(3000, 2011); expect(bounded.state(A, "gmail-api")).toEqual({ kind: "ready" });
  });
  it("20 restart waits complete duration", async () => { const f = fixture(seeded()), g = await f.open(); f.time(121000, 120009); expect(g.state(A, "gmail-api")).toEqual({ kind: "at", atMs: 121000 }); f.time(121000, 120010); expect(g.state(A, "gmail-api")).toEqual({ kind: "ready" }); expect(f.samples()).toBe(0); });
  it("21 backward wall requires repair", async () => { const f = fixture(), g = await f.open(); await observe(g); f.time(999, 20); expect(g.state(A, "gmail-api")).toEqual({ kind: "hold", reason: "clock" }); await turns(); });
  it("22 elapsed rollback requires repair", async () => { const f = fixture(), g = await f.open(); await observe(g); f.time(1100, 9); expect(g.state(A, "gmail-api")).toEqual({ kind: "hold", reason: "clock" }); await turns(); });
  it("23 check clock retains D and full wait", async () => { const f = fixture(), g = await f.open(); await observe(g, at(121000)); f.time(999, 20); g.state(A, "gmail-api"); f.time(2000, 30); const rev = g.revisionFor(A, "gmail-api")!; g.checkClock(A, "gmail-api", rev); await g.drain(5000); expect(decodeCooldown(f.encoded()).rows[0]?.minimum).toBe("121000"); f.time(122000, 120029); expect(g.state(A, "gmail-api")).toEqual({ kind: "at", atMs: 121000 }); f.time(122000, 120030); expect(g.state(A, "gmail-api")).toEqual({ kind: "ready" }); });
  it("24 obsolete repair cannot slide", async () => { const f = fixture(), g = await f.open(); await observe(g); f.time(999, 20); g.state(A, "gmail-api"); const rev = g.revisionFor(A, "gmail-api")!; f.time(2000, 30); g.checkClock(A, "gmail-api", rev); f.time(3000, 1000); g.checkClock(A, "gmail-api", rev); f.time(4000, 2030); expect(g.state(A, "gmail-api")).toEqual({ kind: "ready" }); expect(f.samples()).toBe(1); await turns(); });
  it("25 load is an independent barrier", async () => { const f = fixture(), load = latch<string | null>(); cleanups.release(() => load.resolve(null)); let published = false; const opening = f.open({ ...f.port, read: () => load.promise }).then((g) => { published = true; return g; }); await turns(); expect(published).toBe(false); load.resolve(null); await opening; expect(published).toBe(true); const failed = await f.open({ ...f.port, read: async () => { throw new Error("Synthetic read failure"); } }); expect(failed.state(A, "gmail-api")).toEqual({ kind: "hold", reason: "storage" }); });
  it("26 final dispatch rechecks pause", async () => { const f = fixture(), g = await f.open(); const ticket = g.requestsFor(A).reserve(gmail); await observe(g); let dispatched = 0; expect(() => ticket.dispatch(async () => { dispatched++; return new Response(); })).toThrow(ProviderCooldownError); expect(dispatched).toBe(0); ticket.release(); });
  it("27 all 64 late headers retain evidence", async () => {
    const ledger = JSON.parse(seeded());
    ledger.rows = Array.from({ length: 256 }, (_, i) => ({ ...ledger.rows[0], owner: i.toString(16).padStart(64, "0"), hold: "calendar" }));
    const image = JSON.stringify(ledger);
    expect(new TextEncoder().encode(image).length).toBeLessThanOrEqual(65536);
    const f = fixture(image), held = heldWriter();
    const g = await f.open({ read: f.port.read, update: async (fn) => { await held.promise; return f.port.update(fn); } });
    const policies = Array.from({ length: 64 }, (_, i) => g.requestsFor((10000 + i).toString(16).padStart(64, "0")));
    const tickets = policies.map((p) => p.reserve(gmail));
    expect(() => g.requestsFor(A).reserve(gmail)).toThrow(ProviderCooldownError);
    expect(g.resources()).toMatchObject({ tickets: 64, reservedBytes: 131072 });
    expect((await g.admission(() => undefined)).blockAllGoogle).toBe(true);
    await Promise.all(tickets.map((t) => t.dispatch(async () => new Response(null, { status: 429 }))));
    const acks = tickets.map((t) => t.headers429(at(121000)));
    tickets.forEach((t) => t.release());
    expect(g.resources().tickets).toBe(64);
    expect(f.samples()).toBe(64);
    held.resolve();
    expect(await Promise.all(acks)).toEqual(Array.from({ length: 64 }, () => "committed"));
    await g.close();
    const durable = decodeCooldown(f.encoded());
    expect(durable.overflow).toBe(true);
    expect(durable.rows.filter((r) => r.hold === "calendar")).toHaveLength(256);
    expect(g.resources().tickets).toBe(0);
    expect(new TextEncoder().encode(f.encoded()!).length).toBeLessThanOrEqual(65536);
  });
  it("28 header closes before pending write", async () => { const f = fixture(), held = heldWriter(); const g = await f.open({ ...f.port, update: async (fn) => { await held.promise; return f.port.update(fn); } }); const result = observe(g); await turns(); expect(() => g.requestsFor(A).check(gmail)).toThrow(ProviderCooldownError); expect(g.resources().writer).toBe(true); held.resolve(); expect(await result).toBe("committed"); });
  it("29 deadline retains physical writer", async () => { const f = fixture(), held = heldWriter(); const g = await f.open({ ...f.port, update: async (fn) => { await held.promise; return f.port.update(fn); } }); const result = observe(g); await turns(); f.time(6000, 5010); f.fire(); expect(await result).toBe("unconfirmed"); expect(g.resources()).toMatchObject({ tickets: 1, writer: true }); expect(await g.recoverStorage()).toBe("pending-terminal"); held.resolve(); await turns(); expect(g.resources()).toMatchObject({ tickets: 0, writer: false }); });
  it("30 terminal failure preserves candidate", async () => { const f = fixture(), expected = cleanups.expectTerminal("policy30/disk-unconfirmed"), g = await f.open({ read: f.port.read, update: async () => { throw new Error("Synthetic disk failure"); } }, expected); expect(await observe(g)).toBe("unconfirmed"); expect(g.state(A, "gmail-api")).toEqual({ kind: "hold", reason: "storage" }); expect(g.resources().tickets).toBe(1); expect(f.samples()).toBe(1); });
  it("31 committed then thrown confirms", async () => { const f = fixture(), g = await f.open({ read: f.port.read, update: async (fn) => { await f.port.update(fn); throw new Error("Synthetic postcommit failure"); } }); expect(await observe(g)).toBe("committed"); expect(g.state(A, "gmail-api")).toEqual({ kind: "at", atMs: 3000 }); expect(f.samples()).toBe(1); expect(f.writes()).toBe(1); });
  it("32 close waits for real terminal", async () => { const f = fixture(), held = heldWriter(); const g = await f.open({ ...f.port, update: async (fn) => { await held.promise; return f.port.update(fn); } }); const response = observe(g); await turns(); let closed = false; const stop = cleanups.watch("policy32/explicit-close", g.close().then(() => { closed = true; })); await turns(); expect(closed).toBe(false); expect(() => g.requestsFor(B).check(gmail)).toThrow(ProviderCooldownError); held.resolve(); expect(await response).toBe("committed"); await stop; expect(closed).toBe(true); expect(g.resources().tickets).toBe(0); });
});

describe("latent cooldown delta", () => {
  it("33 ordinary responses do not wake", async () => {
    const f = fixture(), g = await f.open(), policy = g.requestsFor(A);
    await g.drain(5000); await turns();
    const wakes = f.wakes(), timers = f.timerStarts(), writes = f.writes();
    let transports = 0;
    for (let i = 0; i < 24; i++) {
      const response = await requestHttp(policy, gmail, async () => { transports++; return new Response(null, { status: 200 }); }, () => 1000);
      expect(response.status).toBe(200);
      await turns();
    }
    expect(f.wakes() - wakes).toBe(0);
    expect(transports).toBe(24);
    expect(f.timerStarts() - timers).toBe(0);
    expect(f.writes() - writes).toBe(0);
    expect(f.samples()).toBe(0);
    expect(f.timers.size).toBe(0);
    expect(g.nextWakeDelay()).toBe(null);
    expect(g.state(A, "gmail-api")).toEqual({ kind: "ready" });
    expect(g.resources()).toEqual({ tickets: 0, pendingScopes: 0, reservedBytes: 0, writer: false });
  });

  it("34 capacity release wakes admission", async () => {
    const f = fixture(), g = await f.open(), policy = g.requestsFor(A);
    await turns(); const initial = f.wakes();
    const tickets = Array.from({ length: 64 }, () => policy.reserve(gmail));
    await turns();
    expect(f.wakes() - initial).toBe(1);
    expect((await g.admission(() => undefined)).blockAllGoogle).toBe(true);
    expect(() => policy.check(gmail)).toThrow(ProviderCooldownError);
    const full = f.wakes();
    tickets[0]!.release(); await turns();
    expect(f.wakes() - full).toBe(1);
    expect((await g.admission(() => undefined)).blockAllGoogle).toBe(false);
    expect(() => policy.check(gmail)).not.toThrow();
    const released = f.wakes(); tickets[0]!.release(); await turns();
    expect(f.wakes()).toBe(released);
    expect(f.timerStarts()).toBe(1);
    expect(f.writes()).toBe(0);
    expect(f.samples()).toBe(0);
    for (const ticket of tickets.slice(1)) ticket.release();
  });

  it("35 cooldown and clock changes wake", async () => {
    const f = fixture(), g = await f.open();
    await turns(); const ready = f.wakes();
    await observe(g); await g.drain(5000); await turns();
    expect(f.wakes()).toBeGreaterThan(ready);
    expect(g.state(A, "gmail-api")).toEqual({ kind: "at", atMs: 3000 });
    const paused = f.wakes();
    f.time(999, 20);
    expect(g.state(A, "gmail-api")).toEqual({ kind: "hold", reason: "clock" });
    await g.drain(5000); await turns();
    expect(f.wakes()).toBeGreaterThan(paused);
    const fault = f.wakes();
    f.time(2000, 30);
    g.checkClock(A, "gmail-api", g.revisionFor(A, "gmail-api")!);
    await g.drain(5000); await turns();
    expect(f.wakes()).toBeGreaterThan(fault);
    expect(g.state(A, "gmail-api")).toEqual({ kind: "at", atMs: 3000 });
    expect(f.samples()).toBe(1);
    expect(JSON.parse(f.encoded()!).rows[0].minimum).toBe("3000");
  });

  it("36 dependency changes wake admission", async () => {
    const key = "580852f44dc8a5bc68cbd0130926bedcbfb143d6ca60f3f40fdf6ff7b4dd820f";
    const stamp = { id: 1, email: "synthetic1@example.test", createdAt: 1 };
    const ledger = JSON.parse(seeded({ owner: key, service: "oauth-token" }));
    ledger.bindings = [{ id: 1, createdAt: 1, emailDigest: key, mailboxKey: key }];
    const f = fixture(JSON.stringify(ledger)), g = await f.open();
    const policy = await g.requestsForAccount(stamp, () => true);
    const accountAt = (id: number) => id === 1 ? { ...stamp, kind: "gmail" } : undefined;
    await turns(); const cached = f.wakes();
    expect((await g.admission(accountAt)).blockedAccountIds).toEqual([]);
    policy.tokenUnavailable(); await turns();
    expect(f.wakes() - cached).toBe(1);
    expect((await g.admission(accountAt)).blockedAccountIds).toEqual([1]);
    const dependent = f.wakes(); policy.tokenUnavailable(); await turns();
    expect(f.wakes()).toBe(dependent);
    policy.accessAvailable(); await turns();
    expect(f.wakes() - dependent).toBe(1);
    expect((await g.admission(accountAt)).blockedAccountIds).toEqual([]);
    policy.tokenUnavailable(); await turns(); const closing = f.wakes();
    policy.close(); await turns();
    expect(f.wakes() - closing).toBe(1);
    expect((await g.admission(accountAt)).blockedAccountIds).toEqual([]);
    const closed = f.wakes(); policy.close(); await turns();
    expect(f.wakes()).toBe(closed);
    expect(g.state(key, "oauth-token")).toEqual({ kind: "at", atMs: 121000 });
    expect(f.writes()).toBe(0); expect(f.samples()).toBe(0);
  });

  it("37 reentry cannot invoke transport twice", async () => {
    const f = fixture(), g = await f.open();
    let transports = 0, marks = 0, nestedError: unknown, nested: Promise<Response> | undefined;
    const ticket = g.requestsFor(A).reserve({ ...gmail, run: { markDispatched: () => { marks++; } } });
    const outer = ticket.dispatch(() => {
      transports++;
      try { nested = ticket.dispatch(async () => { transports++; return new Response(null, { status: 200 }); }); }
      catch (error) { nestedError = error; }
      return Promise.resolve(new Response(null, { status: 200 }));
    });
    const response = await outer; if (nested) await nested;
    expect(transports).toBe(1);
    expect(marks).toBe(1);
    expect(nestedError).toBeInstanceOf(Error);
    expect((nestedError as Error).message).toBe("Request ticket dispatch already started");
    expect(response.status).toBe(200);
    ticket.headers(200); ticket.release(); ticket.release();
    expect(() => ticket.dispatch(async () => { transports++; return new Response(); })).toThrow();
    expect(transports).toBe(1); expect(marks).toBe(1);
    expect(g.resources().tickets).toBe(0);
  });

  it("38 propagated reentry remains issued", async () => {
    const f = fixture(), g = await f.open();
    let transports = 0, marks = 0, caught: unknown, returned: Promise<Response> | undefined;
    const ticket = g.requestsFor(A).reserve({ ...gmail, run: { markDispatched: () => { marks++; } } });
    try {
      returned = ticket.dispatch(() => {
        transports++;
        return ticket.dispatch(async () => { transports++; return new Response(null, { status: 200 }); });
      });
    } catch (error) { caught = error; }
    if (returned) await returned;
    expect(transports).toBe(1);
    expect(marks).toBe(1);
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(RequestNotDispatchedError);
    ticket.release(); ticket.release();
    expect(g.resources().tickets).toBe(0);
  });

  it("39 known synchronous refusal marks none", async () => {
    const f = fixture(), g = await f.open();
    let callbacks = 0, marks = 0, caught: unknown;
    const expected = new RequestNotDispatchedError("Synthetic host refusal");
    const ticket = g.requestsFor(A).reserve({ ...gmail, run: { markDispatched: () => { marks++; } } });
    try { ticket.dispatch(() => { callbacks++; throw expected; }); } catch (error) { caught = error; }
    expect(caught).toBe(expected); expect(callbacks).toBe(1); expect(marks).toBe(0);
    ticket.release(); ticket.release();
    expect(() => ticket.dispatch(async () => { callbacks++; return new Response(); })).toThrow();
    expect(callbacks).toBe(1); expect(marks).toBe(0);
    expect(g.resources().tickets).toBe(0); expect(f.writes()).toBe(0); expect(f.samples()).toBe(0);
  });

  it("40 unknown and async failures stay issued", async () => {
    const f = fixture(), g = await f.open();
    let callbacks = 0, marks = 0, caught: unknown;
    const unknown = new Error("Synthetic invocation failure");
    const policy = g.requestsFor(A), descriptor = { ...gmail, run: { markDispatched: () => { marks++; } } };
    const first = policy.reserve(descriptor);
    try { first.dispatch(() => { callbacks++; throw unknown; }); } catch (error) { caught = error; }
    expect(caught).toBe(unknown); expect(callbacks).toBe(1); expect(marks).toBe(1);
    first.release(); first.release();
    const second = policy.reserve(descriptor), rejected = new RequestNotDispatchedError("Synthetic asynchronous failure");
    await expect(second.dispatch(() => { callbacks++; return Promise.reject(rejected); })).rejects.toBe(rejected);
    second.release(); second.release();
    expect(callbacks).toBe(2); expect(marks).toBe(2);
    expect(g.resources().tickets).toBe(0); expect(f.writes()).toBe(0); expect(f.samples()).toBe(0);
  });

  it("41 final live fence marks no attempt", async () => {
    const f = fixture(), g = await f.open();
    let live = true, transports = 0, marks = 0;
    const ticket = g.requestsFor(A, () => live).reserve({ ...gmail, run: { markDispatched: () => { marks++; } } });
    live = false;
    expect(() => ticket.dispatch(async () => { transports++; return new Response(); })).toThrow(RequestNotDispatchedError);
    ticket.release(); ticket.release();
    expect(transports).toBe(0); expect(marks).toBe(0);
    expect(g.resources().tickets).toBe(0); expect(f.writes()).toBe(0); expect(f.samples()).toBe(0);
  });

  it("42 late response cancels body once", async () => {
    const f = fixture(), g = await f.open(), policy = g.requestsFor(A), pending = latch<Response>();
    let transports = 0, marks = 0, cancelled = 0;
    const ticket = policy.reserve({ ...gmail, run: { markDispatched: () => { marks++; } } });
    const response = ticket.dispatch(() => { transports++; return pending.promise; });
    policy.close();
    pending.resolve(new Response(new ReadableStream<Uint8Array>({ cancel: () => { cancelled++; } }), { status: 200 }));
    await expect(response).rejects.toMatchObject({ name: "AbortError" });
    ticket.release(); ticket.release();
    expect(transports).toBe(1); expect(marks).toBe(1); expect(cancelled).toBe(1);
    expect(g.resources().tickets).toBe(0); expect(f.writes()).toBe(0); expect(f.samples()).toBe(0);
  });
});

describe("latent cooldown fixture ownership", () => {
  it("43 healthy cleanup sentinel remains failure", async () => {
    const local = fixtureCleanup(), sentinel = new Error("UNEXPECTED_HEALTHY_CLOSE_SENTINEL");
    local.gate("healthy-sentinel", { close: async () => { throw sentinel; }, resources: () => ({ writer: false }) });
    const result = await local.finish().then(() => null, (error: unknown) => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual([sentinel]);
  });
  it("44 exact expected terminal failure is consumed", async () => {
    const local = fixtureCleanup(), expected = local.expectTerminal("fixture44/exact-unconfirmed");
    local.gate(expected.label, { close: async () => { throw new Error("Private cooldown persistence remains unconfirmed"); }, resources: () => ({ writer: false }) }, expected);
    await local.finish();
    expect(expected.consumed).toBe(true);
    const wrong = fixtureCleanup(), mismatch = wrong.expectTerminal("fixture44/mismatch");
    const sentinel = new Error("UNEXPECTED_EXPECTED_CLOSE_SENTINEL");
    wrong.gate(mismatch.label, { close: async () => { throw sentinel; }, resources: () => ({ writer: false }) }, mismatch);
    const result = await wrong.finish().then(() => null, (error: unknown) => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors[0]).toBe(sentinel);
    expect((result as AggregateError).errors[1].message).toBe("Expected terminal failure not consumed: fixture44/mismatch");
    expect(mismatch.consumed).toBe(false);
  });
  it("45 early assertion releases and joins real writer", async () => {
    const local = fixtureCleanup(), f = fixture(), held = latch<void>();
    local.release(() => held.resolve());
    cleanups.release(() => held.resolve());
    const g = await f.open({ read: f.port.read, update: async (fn) => { await held.promise; return f.port.update(fn); } });
    local.gate("fixture45/close", g);
    const response = local.watch("fixture45/actual-write", observe(g));
    await turns();
    expect(g.resources().writer).toBe(true);
    let primary: unknown;
    try { expect("deliberate fixture fault").toBe("later gate release"); } catch (error) { primary = error; }
    await local.finish();
    expect(primary).toBeInstanceOf(Error);
    expect((primary as Error).name).toBe("AssertionError");
    expect(await response).toBe("committed");
    expect(g.resources().writer).toBe(false);
    expect(g.resources().tickets).toBe(0);
    expect(decodeCooldown(f.encoded()).rows[0]?.minimum).toBe("3000");
  });
  it("46 independent cleanup survives terminal failure", async () => {
    const local = fixtureCleanup(), sentinel = new Error("UNEXPECTED_TERMINAL_SENTINEL");
    let independent = 0, dependent = 0, removed = 0;
    local.push(async () => { dependent++; });
    local.remove(() => { removed++; });
    local.independent("fixture46/a", async () => { independent++; });
    local.independent("fixture46/b", async () => { independent++; });
    local.gate("fixture46/failed", { close: async () => { throw sentinel; }, resources: () => ({ writer: true }) });
    const result = await local.finish().then(() => null, (error: unknown) => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors[0]).toBe(sentinel);
    expect(independent).toBe(2);
    expect(dependent).toBe(0);
    expect(removed).toBe(0);
  });
});

function reviewNoHttp() {
  const actual = globalThis.fetch;
  let calls = 0;
  cleanups.independent("review/fetch-restore", async () => { globalThis.fetch = actual; });
  globalThis.fetch = async () => { calls++; throw new Error("Unexpected HTTP in local recovery"); };
  return () => calls;
}

async function reviewRollback(firstElapsed: number, wall: number, elapsed: number, minimum: string, atMs: number) {
  const f = fixture(); f.time(1000, firstElapsed);
  const g = await f.open(), policy = g.requestsFor(A);
  const first = policy.reserve(gmail), late = policy.reserve(gmail);
  let transports = 0;
  await first.dispatch(async () => { transports++; return new Response(null, { status: 429 }); });
  await late.dispatch(async () => { transports++; return new Response(null, { status: 429 }); });
  expect(await cleanups.watch("review/R1/first", first.headers429(none))).toBe("committed"); first.release();
  expect(await g.drain(5000)).toBe("drained");
  f.time(wall, elapsed);
  expect(await cleanups.watch("review/R1/late", late.headers429({ ...none, received: { source: "date-now", kind: "wall", wallMs: wall } }))).toBe("committed"); late.release();
  expect(await g.drain(5000)).toBe("drained");
  const row = decodeCooldown(f.encoded()).rows[0]!;
  expect({ minimum: row.minimum, replay: row.replay, sample: row.sample, position: row.position }).toEqual({ minimum, replay: "5000", sample: 5000, position: 2 });
  expect(f.samples()).toBe(2); expect(transports).toBe(2);
  expect(row.hold).toBe("clock");
  expect(g.state(A, "gmail-api")).toEqual({ kind: "hold", reason: "clock" });
  expect(g.nextWakeDelay()).toBe(null);
  await g.close();
  const reopened = await f.open();
  expect(reopened.state(A, "gmail-api")).toEqual({ kind: "hold", reason: "clock" });
  f.time(7000, 6011); f.fire();
  expect(reopened.state(A, "gmail-api")).toEqual({ kind: "hold", reason: "clock" });
  expect(reopened.nextWakeDelay()).toBe(null);
  const revision = reopened.revisionFor(A, "gmail-api")!;
  f.time(8000, 7000);
  expect(reopened.checkClock(A, "gmail-api", revision)).toEqual({ kind: "at", atMs });
  expect(await reopened.drain(5000)).toBe("drained");
  const repaired = f.encoded();
  expect(decodeCooldown(repaired).rows[0]?.minimum).toBe(minimum);
  expect(decodeCooldown(repaired).rows[0]?.repair).toBe(revision);
  f.time(9000, 8000);
  expect(reopened.checkClock(A, "gmail-api", revision)).toEqual({ kind: "at", atMs });
  expect(f.encoded()).toBe(repaired);
  f.time(13000, 11999);
  expect(reopened.state(A, "gmail-api")).toEqual({ kind: "at", atMs });
  f.time(13000, 12000);
  expect(reopened.state(A, "gmail-api")).toEqual({ kind: "ready" });
  expect(f.samples()).toBe(2); expect(f.timers.size).toBe(0);
}

function reviewBoundLedger() {
  const key = "580852f44dc8a5bc68cbd0130926bedcbfb143d6ca60f3f40fdf6ff7b4dd820f";
  return encodeCooldown({ version: 1, revision: "1", overflow: false, bindings: [{ id: 1, createdAt: 1, emailDigest: key, mailboxKey: key }], rows: [] });
}

describe("cooldown review unit", () => {
  it("R1 elapsed rollback requires persisted repair", async () => { await reviewRollback(10, 1001, 9, "6001", 6001); });
  it("R1 wall rollback requires persisted repair", async () => { await reviewRollback(10, 999, 11, "5999", 5999); });
  it("R1 fractional rollback retains raw checkpoint", async () => { await reviewRollback(10.75, 1001, 10.5, "6001", 6001); });

  it("R1 forward clocks meet both exact bounds", async () => {
    const f = fixture(); f.time(1000, 10.75);
    const g = await f.open(), policy = g.requestsFor(A), first = policy.reserve(gmail), late = policy.reserve(gmail);
    await first.dispatch(async () => new Response(null, { status: 429 }));
    await late.dispatch(async () => new Response(null, { status: 429 }));
    expect(await first.headers429(none)).toBe("committed"); first.release(); await g.drain(5000);
    f.time(1001, 11);
    expect(await late.headers429({ ...none, received: { source: "date-now", kind: "wall", wallMs: 1001 } })).toBe("committed"); late.release(); await g.drain(5000);
    expect(decodeCooldown(f.encoded()).rows[0]).toMatchObject({ minimum: "6001", replay: "5000", sample: 5000, position: 2, hold: null });
    const stored = f.encoded(), revision = g.revisionFor(A, "gmail-api")!;
    f.time(6000, 5010); expect(g.state(A, "gmail-api")).toEqual({ kind: "at", atMs: 6001 });
    expect(g.checkClock(A, "gmail-api", revision)).toEqual({ kind: "at", atMs: 6001 });
    f.time(6001, 5010); expect(g.state(A, "gmail-api")).toEqual({ kind: "at", atMs: 6001 });
    f.time(6001, 5011); expect(g.state(A, "gmail-api")).toEqual({ kind: "ready" });
    expect(f.encoded()).toBe(stored); expect(f.samples()).toBe(2);
  });

  it("R1 unresolved hold is never clock repair", async () => {
    const f = fixture(), g = await f.open(), policy = g.requestsFor(A), first = policy.reserve(gmail), late = policy.reserve(gmail);
    await first.dispatch(async () => new Response(null, { status: 429 }));
    await late.dispatch(async () => new Response(null, { status: 429 }));
    expect(await first.headers429({ ...none, minimum: { kind: "hold", reason: "calendar" } })).toBe("committed"); first.release(); await g.drain(5000);
    f.time(1001, 9);
    expect(await late.headers429({ ...none, received: { source: "date-now", kind: "wall", wallMs: 1001 } })).toBe("committed"); late.release(); await g.drain(5000);
    expect(decodeCooldown(f.encoded()).rows[0]).toMatchObject({ minimum: "6001", replay: "5000", sample: 5000, position: 2, hold: "calendar" });
    const stored = f.encoded(); f.time(8000, 7000);
    expect(g.checkClock(A, "gmail-api", g.revisionFor(A, "gmail-api")!)).toEqual({ kind: "hold", reason: "calendar" });
    expect(f.encoded()).toBe(stored); expect(g.nextWakeDelay()).toBe(null); expect(f.samples()).toBe(2);
  });

  it("R1 admitted HTTP rollback cannot reopen", async () => {
    const f = fixture(), g = await f.open(), policy = g.requestsFor(A), held = latch<Response>();
    cleanups.release(() => held.resolve(new Response(null, { status: 429 })));
    let wall = 1000, calls = 0;
    expect((await requestHttp(policy, gmail, async () => { calls++; return new Response(null, { status: 429 }); }, () => wall)).status).toBe(429);
    f.time(3000, 2010); wall = 3000;
    const late = cleanups.watch("review/R1/requestHttp", requestHttp(policy, gmail, () => { calls++; return held.promise; }, () => wall));
    expect(calls).toBe(2);
    f.time(2999, 2009); wall = 2999; held.resolve(new Response(null, { status: 429 }));
    expect((await late).status).toBe(429); await g.drain(5000);
    expect(decodeCooldown(f.encoded()).rows[0]).toMatchObject({ minimum: "7999", replay: "5000", sample: 5000, position: 2 });
    expect(g.state(A, "gmail-api")).toEqual({ kind: "hold", reason: "clock" });
    expect(g.nextWakeDelay()).toBe(null);
    await expect(requestHttp(policy, gmail, async () => { calls++; return new Response(); }, () => wall)).rejects.toBeInstanceOf(ProviderCooldownError);
    expect(calls).toBe(2); expect(f.samples()).toBe(2);
  });

  it("R2 empty recovery wakes one reopening", async () => {
    const http = reviewNoHttp(), f = fixture(); let reads = 0;
    const g = await f.open({ read: async () => { if (++reads === 1) throw new Error("Synthetic initial load failure"); return f.port.read(); }, update: f.port.update });
    await turns(); expect((await g.admission(() => undefined)).blockAllGoogle).toBe(true);
    const wakes = f.wakes();
    expect(await g.recoverStorage()).toBe("confirmed"); await turns();
    expect((await g.admission(() => undefined)).blockAllGoogle).toBe(false);
    expect(reads).toBe(2); expect(f.writes()).toBe(0); expect(f.samples()).toBe(0); expect(http()).toBe(0);
    expect(f.wakes() - wakes).toBe(1); expect(f.timers.size).toBe(0); expect(g.nextWakeDelay()).toBe(null);
  });

  it("R2 healthy empty recovery stays quiet", async () => {
    const http = reviewNoHttp(), f = fixture(); let reads = 0;
    const g = await f.open({ read: async () => { reads++; return f.port.read(); }, update: f.port.update });
    await turns(); const wakes = f.wakes();
    expect(await g.recoverStorage()).toBe("confirmed"); await turns();
    expect((await g.admission(() => undefined)).blockAllGoogle).toBe(false);
    expect(f.wakes() - wakes).toBe(0); expect(reads).toBe(2); expect(http()).toBe(0);
    expect(f.writes()).toBe(0); expect(f.samples()).toBe(0); expect(f.timers.size).toBe(0);
  });

  it("R2 read only binding change wakes once", async () => {
    const http = reviewNoHttp(), f = fixture(); let image: string | null = null;
    const g = await f.open({ read: async () => image, update: f.port.update });
    const stamp = { id: 1, email: "synthetic1@example.test", createdAt: 1, kind: "gmail" };
    expect((await g.admission((id) => id === 1 ? stamp : undefined)).verifiedAccountIds).toEqual([]);
    await turns(); const wakes = f.wakes(); image = reviewBoundLedger();
    expect(await g.refreshAfterBind()).toBe("confirmed"); await turns();
    expect((await g.admission((id) => id === 1 ? stamp : undefined)).verifiedAccountIds).toEqual([1]);
    expect(f.wakes() - wakes).toBe(1); expect(http()).toBe(0); expect(f.samples()).toBe(0); expect(f.writes()).toBe(0);
  });

  it("R2 identical bound recovery stays quiet", async () => {
    const http = reviewNoHttp(), f = fixture(reviewBoundLedger()), g = await f.open();
    await turns(); const wakes = f.wakes();
    expect(await g.refreshAfterBind()).toBe("confirmed"); await turns();
    const stamp = { id: 1, email: "synthetic1@example.test", createdAt: 1, kind: "gmail" };
    expect((await g.admission((id) => id === 1 ? stamp : undefined)).verifiedAccountIds).toEqual([1]);
    expect(f.wakes() - wakes).toBe(0); expect(http()).toBe(0); expect(f.samples()).toBe(0); expect(f.writes()).toBe(0);
  });

  it("R3 later legitimate dispatch resets phase", async () => {
    const f = fixture(), g = await f.open(), policy = g.requestsFor(A), held = policy.reserve(gmail);
    await observe(g); await g.drain(5000); f.time(3000, 2010);
    expect((await held.dispatch(async () => new Response(null, { status: 200 }))).status).toBe(200);
    held.headers(200); held.release(); await g.drain(5000);
    expect(f.samples()).toBe(1);
    expect(decodeCooldown(f.encoded()).rows[0]?.position).toBe(0);
    await observe(g, { ...none, received: { source: "date-now", kind: "wall", wallMs: 3000 } });
    expect(decodeCooldown(f.encoded()).rows[0]).toMatchObject({ minimum: "5000", sample: 2000, position: 1 });
    expect(f.samples()).toBe(2);
  });

  it("R3 callback cannot reset a newer phase", async () => {
    const f = fixture(), g = await f.open(), policy = g.requestsFor(A), success = policy.reserve(gmail), later = policy.reserve(gmail);
    await later.dispatch(async () => new Response(null, { status: 429 }));
    let observation: Promise<"committed" | "unconfirmed"> | undefined;
    expect((await success.dispatch(() => {
      observation = cleanups.watch("review/R3/reentrant-observation", later.headers429(none)); later.release();
      f.time(3000, 2010);
      return Promise.resolve(new Response(null, { status: 200 }));
    })).status).toBe(200);
    success.headers(200); success.release(); expect(await observation).toBe("committed"); await g.drain(5000);
    expect(decodeCooldown(f.encoded()).rows[0]?.position).toBe(1);
    f.time(3000, 2010);
    await observe(g, { ...none, received: { source: "date-now", kind: "wall", wallMs: 3000 } });
    expect(decodeCooldown(f.encoded()).rows[0]).toMatchObject({ minimum: "8000", sample: 5000, position: 2 });
    expect(f.samples()).toBe(2);
  });

  it("F4 successful close refuses late recovery", async () => {
    const f = fixture(), completion = latch<void>(); let reads = 0;
    const g = await f.open({ read: async () => { reads++; return f.port.read(); }, update: f.port.update });
    cleanups.release(() => completion.resolve());
    const late = cleanups.watch("review/F4/late-bind", completion.promise.then(() => g.refreshAfterBind()));
    await g.close(); const before = { reads, timers: f.timerStarts(), writes: f.writes() };
    completion.resolve(); const callback = await late, direct = await g.recoverStorage(); await turns();
    expect(reads - before.reads).toBe(0);
    expect(f.timerStarts() - before.timers).toBe(0); expect(f.writes() - before.writes).toBe(0);
    expect(callback).toBe("unconfirmed"); expect(direct).toBe("unconfirmed");
    expect(g.resources().writer).toBe(false); expect(f.samples()).toBe(0); expect(f.timers.size).toBe(0);
  });

  it("F4 open recovery still joins its action", async () => {
    const f = fixture(); let reads = 0;
    const g = await f.open({ read: async () => { reads++; return f.port.read(); }, update: f.port.update });
    expect(await g.recoverStorage()).toBe("confirmed"); await turns();
    expect(reads).toBe(2); expect(g.resources().writer).toBe(false);
    expect(g.state(A, "gmail-api")).toEqual({ kind: "ready" }); expect(f.timers.size).toBe(0);
  });

  it("F4 closing joins an already held writer", async () => {
    const f = fixture(), held = heldWriter(); let reads = 0, completed = 0;
    const g = await f.open({ read: async () => { reads++; return f.port.read(); }, update: async (fn) => { await held.promise; return f.port.update(fn); } });
    const response = cleanups.watch("review/F4/held-observation", observe(g)); await turns();
    const stop = cleanups.watch("review/F4/close", g.close().then(() => { completed++; }));
    await turns(); const timers = f.timerStarts();
    expect(completed).toBe(0); expect(g.resources().writer).toBe(true);
    expect(await g.recoverStorage()).toBe("pending-terminal"); expect(await g.refreshAfterBind()).toBe("pending-terminal");
    expect(reads).toBe(1); expect(f.timerStarts()).toBe(timers);
    held.resolve(); expect(await response).toBe("committed"); await stop;
    expect(completed).toBe(1); expect(g.resources().writer).toBe(false); expect(f.samples()).toBe(1);
  });

  it("F4 failed close retains explicit recovery", async () => {
    const f = fixture(); let fail = true;
    const g = await f.open({ read: f.port.read, update: (fn) => fail ? Promise.reject(new Error("Synthetic precommit refusal")) : f.port.update(fn) });
    expect(await observe(g)).toBe("unconfirmed"); await g.drain(5000);
    await expect(g.close()).rejects.toThrow("Private cooldown persistence remains unconfirmed");
    fail = false; expect(await g.recoverStorage()).toBe("confirmed");
    expect(g.state(A, "gmail-api")).toEqual({ kind: "hold", reason: "closed" });
    expect(decodeCooldown(f.encoded()).rows[0]).toMatchObject({ minimum: "3000", sample: 2000, position: 1 });
    expect(f.samples()).toBe(1); await g.close();
  });
});

function r2Phase(f: ReturnType<typeof fixture>) {
  return decodeCooldown(f.encoded()).rows.find((row) => row.owner === A && row.service === "gmail-api")!;
}
async function r2Metadata(f: ReturnType<typeof fixture>, revision: string) {
  await f.port.update((encoded) => {
    const ledger = decodeCooldown(encoded);
    ledger.revision = revision;
    ledger.rows[0] = { ...ledger.rows[0]!, revision };
    return { encoded: encodeCooldown(ledger), result: undefined };
  });
}
async function r2Stronger(f: ReturnType<typeof fixture>) {
  await f.port.update((encoded) => {
    const ledger = decodeCooldown(encoded);
    ledger.revision = "2";
    ledger.rows[0] = { ...ledger.rows[0]!, revision: "2", phaseRevision: "2", minimum: "7000", wall: "1100", replay: "6000", sample: 5000, position: 2 };
    return { encoded: encodeCooldown(ledger), result: undefined };
  });
}

describe("R2 anchor reconciliation", () => {
  it("01 metadata recovery keeps the original elapsed boundary", async () => {
    const f = fixture(seeded({ minimum: "3000", replay: "2000" })), g = await f.open();
    f.time(2999, 2009); await r2Metadata(f, "2");
    const writes = f.writes();
    expect(await g.refreshAfterBind()).toBe("confirmed");
    expect(g.revisionFor(A, "gmail-api")).toBe("2");
    f.time(3000, 2010);
    expect(g.state(A, "gmail-api")).toEqual({ kind: "ready" });
    expect(f.writes()).toBe(writes); expect(f.samples()).toBe(0);
  });

  it("02 stronger recovery checks the old raw checkpoint first", async () => {
    const f = fixture(seeded({ minimum: "3000", replay: "2000" })), g = await f.open();
    await r2Stronger(f); f.time(1001, 9);
    expect(await g.recoverStorage()).toBe("confirmed");
    expect(r2Phase(f).hold).toBe("clock");
    expect(r2Phase(f)).toMatchObject({ minimum: "7000", replay: "6000", phaseRevision: "2", sample: 5000, position: 2, hold: "clock", repair: null });
    expect(g.state(A, "gmail-api")).toEqual({ kind: "hold", reason: "clock" });
    f.time(9000, 8000);
    expect(g.state(A, "gmail-api")).toEqual({ kind: "hold", reason: "clock" });
    const revision = g.revisionFor(A, "gmail-api")!;
    expect(g.checkClock(A, "gmail-api", revision)).toEqual({ kind: "at", atMs: 7000 });
    expect(await g.drain(5000)).toBe("drained");
    f.time(15000, 13999); expect(g.state(A, "gmail-api")).toEqual({ kind: "at", atMs: 7000 });
    f.time(15000, 14000); expect(g.state(A, "gmail-api")).toEqual({ kind: "ready" });
    expect(f.samples()).toBe(0);
  });

  it("03 forward stronger recovery starts one full conservative wait", async () => {
    const f = fixture(seeded({ minimum: "3000", replay: "2000" })), g = await f.open();
    await r2Stronger(f); f.time(1100, 110);
    expect(await g.recoverStorage()).toBe("confirmed");
    expect(r2Phase(f)).toMatchObject({ minimum: "7000", replay: "6000", sample: 5000, position: 2, hold: null });
    f.time(7000, 6109); expect(g.state(A, "gmail-api")).toEqual({ kind: "at", atMs: 7000 });
    f.time(7000, 6110); expect(g.state(A, "gmail-api")).toEqual({ kind: "ready" });
    expect(f.samples()).toBe(0);
  });

  it("04 metadata recovery cannot convert an unresolved calendar hold", async () => {
    const f = fixture(seeded({ minimum: "3000", replay: "2000", hold: "calendar" })), g = await f.open();
    await r2Metadata(f, "2"); f.time(999, 9);
    const writes = f.writes();
    expect(await g.refreshAfterBind()).toBe("confirmed");
    expect(r2Phase(f)).toMatchObject({ revision: "2", phaseRevision: "1", minimum: "3000", replay: "2000", sample: 2000, position: 1, hold: "calendar", repair: null });
    expect(g.state(A, "gmail-api")).toEqual({ kind: "hold", reason: "calendar" });
    expect(g.checkClock(A, "gmail-api", "2")).toEqual({ kind: "hold", reason: "calendar" });
    expect(f.writes()).toBe(writes); expect(f.samples()).toBe(0);
  });

  it("05 failed rollback persistence retains the candidate for recovery", async () => {
    const f = fixture(seeded({ minimum: "3000", replay: "2000" })); let fail = false;
    cleanups.release(() => { fail = false; });
    const g = await ProviderCooldown.open({ read: f.port.read, update: (fn) => { if (fail) return Promise.reject(new Error("R2 rollback write failure")); return f.port.update(fn); } }, f.clock, f.hooks);
    let stopping: Promise<void> | undefined;
    cleanups.gate("R2/recover-write/terminal", {
      resources: () => g.resources(),
      close: () => stopping ??= (async () => { fail = false; await g.drain(5000); expect(await g.recoverStorage()).toBe("confirmed"); await g.close(); })(),
    });
    await r2Metadata(f, "2"); const durable = f.encoded(); fail = true; f.time(1001, 9);
    expect(await g.refreshAfterBind()).toBe("pending-terminal");
    expect(g.state(A, "gmail-api")).toEqual({ kind: "hold", reason: "storage" });
    expect(f.encoded()).toBe(durable); expect(g.resources().pendingScopes).toBe(1);
    fail = false;
    expect(await g.recoverStorage()).toBe("confirmed");
    expect(r2Phase(f)).toMatchObject({ minimum: "3000", replay: "2000", phaseRevision: "1", sample: 2000, position: 1, hold: "clock" });
    expect(g.resources().pendingScopes).toBe(0); expect(f.samples()).toBe(0);
  });

  for (const rollback of [true, false] as const) {
    it(rollback ? "06 committed readback checks the old raw checkpoint" : "07 forward committed readback keeps its new conservative wait", async () => {
      const f = fixture(); let updates = 0;
      const g = await f.open({ read: f.port.read, update: async (fn) => {
        updates++;
        return f.port.update((encoded) => {
          if (updates !== 1) return fn(encoded);
          const ledger = decodeCooldown(seeded());
          ledger.revision = "2";
          ledger.rows[0] = { ...ledger.rows[0]!, revision: "2", phaseRevision: "2", minimum: "7000", wall: "1100", replay: "6000", sample: 5000, position: 2 };
          f.time(1100, rollback ? 9 : 110);
          return fn(encodeCooldown(ledger));
        });
      } });
      expect(await observe(g)).toBe("committed"); expect(await g.drain(5000)).toBe("drained");
      expect(r2Phase(f).hold).toBe(rollback ? "clock" : null);
      expect(r2Phase(f)).toMatchObject({ minimum: "7000", replay: "6000", phaseRevision: "2", sample: 5000, position: 2, hold: rollback ? "clock" : null });
      if (rollback) {
        f.time(9000, 8000); expect(g.state(A, "gmail-api")).toEqual({ kind: "hold", reason: "clock" });
        expect(updates).toBe(2);
      } else {
        f.time(7000, 6109); expect(g.state(A, "gmail-api")).toEqual({ kind: "at", atMs: 7000 });
        f.time(7000, 6110); expect(g.state(A, "gmail-api")).toEqual({ kind: "ready" });
        expect(updates).toBe(1);
      }
      expect(f.samples()).toBe(1);
    });
  }

  it("08 metadata observations advance raw checkpoints without sliding the wait", async () => {
    const f = fixture(seeded({ minimum: "3000", replay: "2000" })), g = await f.open();
    await r2Metadata(f, "2"); f.time(1100, 110);
    expect(await g.recoverStorage()).toBe("confirmed");
    await r2Metadata(f, "3"); f.time(1101, 109);
    expect(await g.recoverStorage()).toBe("confirmed");
    expect(r2Phase(f).hold).toBe("clock");
    expect(r2Phase(f)).toMatchObject({ minimum: "3000", replay: "2000", phaseRevision: "1", sample: 2000, position: 1 });
    expect(f.samples()).toBe(0);
  });

  for (const invalid of ["wall", "elapsed"] as const) {
    it(invalid === "wall" ? "09 invalid wall recovery persists the clock hold" : "10 invalid elapsed recovery persists the clock hold", async () => {
      const f = fixture(seeded({ minimum: "3000", replay: "2000" })), g = await f.open();
      await r2Metadata(f, "2");
      f.time(invalid === "wall" ? NaN : 1001, invalid === "elapsed" ? Infinity : 11);
      expect(await g.recoverStorage()).toBe("confirmed");
      expect(r2Phase(f).hold).toBe("clock");
      expect(r2Phase(f)).toMatchObject({ minimum: "3000", replay: "2000", phaseRevision: "1", sample: 2000, position: 1, hold: "clock", repair: null });
      f.time(7000, 6010);
      expect(g.state(A, "gmail-api")).toEqual({ kind: "hold", reason: "clock" });
      expect(f.samples()).toBe(0);
    });
  }

  for (const rollback of [true, false] as const) {
    it(rollback ? "11 first recovered row retains its persisted wall reference" : "12 forward first recovered row starts a full wait", async () => {
      const f = fixture(), g = await f.open();
      await f.port.update(() => ({ encoded: seeded({ minimum: "3000", replay: "2000" }), result: undefined }));
      f.time(rollback ? 999 : 1100, 110);
      expect(await g.recoverStorage()).toBe("confirmed");
      expect(r2Phase(f).hold).toBe(rollback ? "clock" : null);
      if (rollback) {
        f.time(7000, 6010); expect(g.state(A, "gmail-api")).toEqual({ kind: "hold", reason: "clock" });
      } else {
        f.time(3100, 2109); expect(g.state(A, "gmail-api")).toEqual({ kind: "at", atMs: 3000 });
        f.time(3100, 2110); expect(g.state(A, "gmail-api")).toEqual({ kind: "ready" });
      }
      expect(f.samples()).toBe(0);
    });
  }
});
