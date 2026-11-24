import type { Observation429, RequestDescriptor } from "@terno/mail/portable";
import { decodeCooldown } from "@terno/store";
import { describe, expect, it } from "vitest";
import { COOLDOWN_RECOVERY_MS, ProviderCooldown, type CooldownPersistence } from "./provider-cooldown";

// plan 264: every hold the gate makes has a way back without a restart
const A = "a".repeat(64);
const gmail: RequestDescriptor = { request: { endpoint: "gmail-api", purpose: "mail" } };
const turns = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function fixture() {
  let encoded: string | null = null, wall = 1000, elapsed = 10, failing = 0;
  const timers = new Map<number, { at: number; ms: number; fn: () => void }>();
  let next = 0;
  const port: CooldownPersistence = {
    read: async () => encoded,
    update: async (fn) => { if (failing > 0) { failing--; throw new Error("Synthetic SQLITE_BUSY"); } const v = fn(encoded); encoded = v.encoded; return v.result; },
  };
  const hooks = {
    setTimeout: (fn: () => void, ms: number) => { const id = ++next; timers.set(id, { fn, ms, at: elapsed + ms }); return id as unknown as ReturnType<typeof setTimeout>; },
    clearTimeout: (id: ReturnType<typeof setTimeout>) => { timers.delete(id as unknown as number); },
  };
  const open = (p: CooldownPersistence = port) => ProviderCooldown.open(p, { wallNow: () => wall, elapsedNow: () => elapsed, random: () => 0.5 }, hooks);
  return {
    open, port, timers,
    fail(n: number) { failing = n; },
    time(w: number, e: number) { wall = w; elapsed = e; },
    encoded: () => encoded,
    /** fires every timer due by now (as a host would) */
    async fire() { for (const [id, t] of timers) if (t.at <= elapsed) { timers.delete(id); t.fn(); } await turns(); },
  };
}

const at = (wallMs: number, atMs: number): Observation429 => ({ received: { source: "date-now", kind: "wall", wallMs }, minimum: { kind: "at", basis: "delay", atMs } });
async function refuse(g: ProviderCooldown, e: Observation429) {
  const ticket = g.requestsFor(A).reserve(gmail);
  await ticket.dispatch(async () => new Response(null, { status: 429 }));
  const result = ticket.headers429(e);
  ticket.release();
  return result;
}
async function succeed(g: ProviderCooldown) {
  const ticket = g.requestsFor(A).reserve(gmail);
  await ticket.dispatch(async () => new Response(null, { status: 200 }));
  ticket.headers(200);
  ticket.release();
  await g.drain(5000);
}

describe("plan 264: a storage fault recovers by itself", () => {
  it("a failed commit is read again after 1 s, then reopens admission once the store confirms", async () => {
    const f = fixture(), g = await f.open();
    f.fail(1);
    expect(await refuse(g, at(1000, 3000))).toBe("unconfirmed");
    await turns();
    expect(g.state(A, "gmail-api")).toEqual({ kind: "hold", reason: "storage" });
    expect([...f.timers.values()].map((t) => t.ms)).toEqual([COOLDOWN_RECOVERY_MS[0]]);
    f.time(5000, 4010);
    await f.fire();
    await g.drain(5000);
    // the refusal it couldn't write is kept, and written now
    expect(g.state(A, "gmail-api")).toEqual({ kind: "ready" });
    expect(decodeCooldown(f.encoded()).rows[0]).toMatchObject({ owner: A, minimum: "3000" });
    // healthy: no timer left
    expect(f.timers.size).toBe(0);
    await g.close();
  });

  it("a store still failing backs off (1 s, then 5 s), and Retry Now reads it at once", async () => {
    const f = fixture(), g = await f.open();
    f.fail(3);
    await refuse(g, at(1000, 3000)); await turns();
    f.time(1000, 1010); await f.fire();
    expect(g.state(A, "gmail-api")).toEqual({ kind: "hold", reason: "storage" });
    expect([...f.timers.values()].map((t) => t.ms)).toEqual([COOLDOWN_RECOVERY_MS[1]]);
    await g.retry(); await turns();
    expect(g.state(A, "gmail-api")).toEqual({ kind: "hold", reason: "storage" });
    await g.retry(); await g.drain(5000);
    expect(g.state(A, "gmail-api")).not.toEqual({ kind: "hold", reason: "storage" });
    expect(f.timers.size).toBe(0);
    await g.close();
  });

  it("a ledger that couldn't be read at start is read again", async () => {
    const f = fixture();
    let broken = true;
    const g = await f.open({ read: async () => { if (broken) throw new Error("Synthetic read failure"); return f.port.read(); }, update: f.port.update });
    expect(g.state(A, "gmail-api")).toEqual({ kind: "hold", reason: "storage" });
    expect([...f.timers.values()].map((t) => t.ms)).toEqual([COOLDOWN_RECOVERY_MS[0]]);
    broken = false;
    f.time(1000, 2000); await f.fire(); await g.drain(5000);
    expect(g.state(A, "gmail-api")).toEqual({ kind: "ready" });
    await g.close();
  });
});

describe("plan 264: a clock that steps back never holds for good", () => {
  it("a pause already met stays met (no hold, nothing written as held)", async () => {
    const f = fixture(), g = await f.open();
    expect(await refuse(g, at(1000, 3000))).toBe("committed");
    f.time(9000, 9010);
    expect(g.state(A, "gmail-api")).toEqual({ kind: "ready" });
    f.time(8000, 9020);
    expect(g.state(A, "gmail-api")).toEqual({ kind: "ready" });
    await g.drain(5000);
    expect(decodeCooldown(f.encoded()).rows[0]).toMatchObject({ hold: null });
    await g.close();
  });

  it("a pause still waiting re-waits its full length from now, keeping its deadline, instead of holding", async () => {
    const f = fixture(), g = await f.open();
    expect(await refuse(g, at(1000, 121_000))).toBe("committed");
    f.time(999, 20);
    expect(g.state(A, "gmail-api")).toEqual({ kind: "at", atMs: 121_000 });
    await g.drain(5000);
    expect(decodeCooldown(f.encoded()).rows[0]).toMatchObject({ hold: null, minimum: "121000", replay: "120000" });
    // both clocks: the wall deadline, and 120 s of elapsed time from the step (20), never from the first anchor
    f.time(200_000, 120_019); expect(g.state(A, "gmail-api")).toEqual({ kind: "at", atMs: 121_000 });
    f.time(200_000, 120_020); expect(g.state(A, "gmail-api")).toEqual({ kind: "ready" });
    await g.close();
  });

  it("a held row saved by an earlier run is repaired when read, without a restart", async () => {
    const f = fixture(), g = await f.open();
    await refuse(g, at(1000, 3000)); await g.drain(5000); await g.close();
    const held = decodeCooldown(f.encoded());
    held.rows[0] = { ...held.rows[0]!, hold: "clock" };
    await f.port.update(() => ({ encoded: JSON.stringify(held), result: undefined }));
    const again = await f.open();
    f.time(5000, 30);
    expect(again.state(A, "gmail-api")).toEqual({ kind: "at", atMs: 3000 });
    f.time(5000, 2030);
    expect(again.state(A, "gmail-api")).toEqual({ kind: "ready" });
    await again.close();
  });
});

describe("plan 264: a pause Google has since accepted a request after is over", () => {
  it("a restart doesn't re-wait it", async () => {
    const f = fixture(), g = await f.open();
    expect(await refuse(g, at(1000, 3_601_000))).toBe("committed");
    f.time(3_700_000, 3_700_010);
    expect(g.state(A, "gmail-api")).toEqual({ kind: "ready" });
    await succeed(g);
    expect(decodeCooldown(f.encoded()).rows[0]).toMatchObject({ replay: "0", position: 0, minimum: "3700000" });
    await g.close();
    f.time(3_800_000, 5);
    const again = await f.open();
    expect(again.state(A, "gmail-api")).toEqual({ kind: "ready" });
    await again.close();
  });

  it("a later short refusal isn't stretched to the old long one", async () => {
    const f = fixture(), g = await f.open();
    await refuse(g, at(1000, 3_601_000));
    f.time(3_700_000, 3_700_010);
    await succeed(g);
    expect(await refuse(g, at(3_700_000, 3_702_000))).toBe("committed");
    f.time(3_702_000, 3_702_010);
    expect(g.state(A, "gmail-api")).toEqual({ kind: "ready" });
    await g.close();
  });
});
