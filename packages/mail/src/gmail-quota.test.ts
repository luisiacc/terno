import { describe, expect, it } from "vitest";
import { createQuotaPacer, gmailUnits } from "./gmail-quota";

// Google's per-user quota for new projects: 6,000 units a minute; a full message read is 60.
describe("Gmail quota units", () => {
  it("costs each call as Google's table does", () => {
    expect(gmailUnits("/messages/18c2?format=raw")).toBe(60);
    expect(gmailUnits("/messages/18c2")).toBe(60); // no format is full
    expect(gmailUnits("/messages/18c2?format=minimal")).toBe(20);
    expect(gmailUnits("/messages/18c2?format=metadata&metadataHeaders=Subject")).toBe(20);
    expect(gmailUnits("/messages/18c2/attachments/ANGj")).toBe(20);
    expect(gmailUnits("/messages?maxResults=500")).toBe(5);
    expect(gmailUnits("/history?startHistoryId=10")).toBe(2);
    expect(gmailUnits("/messages/send", "POST")).toBe(100);
    expect(gmailUnits("/messages/18c2/modify", "POST")).toBe(5);
    expect(gmailUnits("/messages/18c2/trash", "POST")).toBe(20);
    expect(gmailUnits("/messages/18c2/untrash", "POST")).toBe(5);
    expect(gmailUnits("/messages", "POST")).toBe(25);
    expect(gmailUnits("/messages/import", "POST")).toBe(25);
    expect(gmailUnits("/watch", "POST")).toBe(100);
    expect(gmailUnits("/messages/batchModify", "POST")).toBe(50);
    expect(gmailUnits("/threads/t1?format=full")).toBe(120);
    expect(gmailUnits("/labels")).toBe(1);
    expect(gmailUnits("/profile")).toBe(1);
    expect(gmailUnits("https://people.googleapis.com/v1/people/me")).toBe(0);
  });
});

function harness(perSecond = 100, burst = 600) {
  let t = 0;
  const waits: number[] = [];
  const pacer = createQuotaPacer({ perSecond, burst, now: () => t, sleep: async (ms) => { waits.push(ms); } });
  return { pacer, waits, at: (ms: number) => { t = ms; } };
}

describe("Gmail quota pacer", () => {
  it("lets a burst go at once, then spends at the rate", async () => {
    const h = harness(100, 600);
    for (let i = 0; i < 10; i++) await h.pacer.spend(60);
    expect(h.waits).toEqual([]);
    for (let i = 0; i < 3; i++) await h.pacer.spend(60);
    // 60 units at 100 a second: 600 ms apart
    expect(h.waits).toEqual([600, 1200, 1800]);
  });

  it("a minute of full downloads stays within 6,000 units at the defaults", async () => {
    let t = 0, spent = 0;
    const pacer = createQuotaPacer({ now: () => t, sleep: async (ms) => { t += ms; } });
    while (t < 60_000) { await pacer.spend(60); if (t < 60_000) spent += 60; }
    expect(spent).toBeLessThanOrEqual(6000);
    expect(spent).toBeGreaterThan(5000);
  });

  it("idle time refills the burst but never banks more; a charge never waits but counts", async () => {
    const h = harness(100, 600);
    for (let i = 0; i < 30; i++) await h.pacer.spend(60);
    h.at(600_000); h.waits.length = 0;
    for (let i = 0; i < 10; i++) await h.pacer.spend(60);
    expect(h.waits).toEqual([]);
    h.pacer.charge(100);
    await h.pacer.spend(60);
    expect(h.waits).toEqual([1600]);
  });

  it("an aborted wait rejects with the signal's reason; Infinity doesn't pace", async () => {
    const pacer = createQuotaPacer({ perSecond: 1, burst: 1 });
    await pacer.spend(1);
    const ctl = new AbortController();
    const waiting = pacer.spend(1, ctl.signal);
    ctl.abort(new Error("reset"));
    await expect(waiting).rejects.toThrow("reset");
    const free = createQuotaPacer({ perSecond: Infinity });
    for (let i = 0; i < 100; i++) await free.spend(60);
  });

  it("waits that end late (a suspended Mac) spend again, so six overdue reads and a fresh burst can't overspend (Codex review)", async () => {
    let t = 0;
    const sleeping: (() => void)[] = [];
    let manual = true;
    const pacer = createQuotaPacer({ perSecond: 100, burst: 600, now: () => t, sleep: (ms) => manual ? new Promise<void>((resolve) => sleeping.push(resolve)) : (t += ms, Promise.resolve()) });
    for (let i = 0; i < 10; i++) await pacer.spend(60);
    // six downloads wait for their slots; the Mac sleeps ten minutes before their timers fire
    const overdue = Array.from({ length: 6 }, () => pacer.spend(60));
    await Promise.resolve();
    t = 600_000; manual = false;
    for (const wake of sleeping.splice(0)) wake();
    await Promise.all(overdue);
    // everything that leaves within the next minute: the six, then reads paced from now
    let spent = 6 * 60;
    const start = t;
    while (t - start < 60_000) { await pacer.spend(60); if (t - start < 60_000) spent += 60; }
    expect(spent).toBeLessThanOrEqual(600 + 100 * 60);
  });
});
