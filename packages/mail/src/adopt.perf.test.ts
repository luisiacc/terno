/**
 * Plan 65 (Codex R4, R5, R12–R14): the recovery index's timing at scale: built and consumed in linear time, the event
 * loop never held long while candidates are read, merged or taken. The perf project runs it alone (nothing competes
 * for CPU); what it holds to is in adopt.test.ts.
 */
import { expect, it } from "vitest";
import { AdoptIndex, type Envelope } from "./adopt";

it("50,000 candidates as 25,000 twin pairs: built and every one taken in linear time, each once", async () => {
  const rows: Envelope[] = Array.from({ length: 50_000 }, (_, i) => ({ id: i + 1, subject: `S${i >> 1}`, fromEmail: "a@example.test", date: i >> 1, size: 100, rfcMessageId: `m${i >> 1}@x` }));
  const started = performance.now();
  const index = new AdoptIndex(rows);
  const taken = new Set<number>();
  for (const r of rows) {
    const id = await index.take(r, async () => true);
    expect(id).not.toBeNull();
    taken.add(id!);
  }
  expect(performance.now() - started).toBeLessThan(1000);
  expect(taken.size).toBe(50_000);
  expect(index.size).toBe(0);
});

it("Codex R5: one bucket of 50,000 identical envelopes is consumed in linear time", async () => {
  const e = { subject: "Same", fromEmail: "a@x", date: 1, size: 1, rfcMessageId: null };
  const index = new AdoptIndex(Array.from({ length: 50_000 }, (_, i) => ({ id: i + 1, ...e })));
  const started = performance.now();
  for (let i = 0; i < 50_000; i++) expect(await index.take(e, async () => true)).toBe(i + 1);
  expect(performance.now() - started).toBeLessThan(500);
});

it("Codex R12: 50,000 candidates are read and indexed a slice at a time, the event loop free between slices", async () => {
  const rows: Envelope[] = Array.from({ length: 50_000 }, (_, i) => ({ id: 50_000 - i, subject: `S${i >> 1}`, fromEmail: "a@example.test", date: i >> 1, size: 100, rfcMessageId: `m${i >> 1}@x` }));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const longest = async (slice?: number) => {
    const index = new AdoptIndex();
    let last = performance.now();
    let worst = 0;
    const tick = setInterval(() => {
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 1);
    await index.add(byId.keys(), async (ids) => ids.map((id) => byId.get(id)!), slice);
    clearInterval(tick);
    worst = Math.max(worst, performance.now() - last);
    return { worst, index };
  };
  // warmed once, then the best of three: a stall of ours repeats, another process's preemption doesn't
  await longest();
  const runs = [await longest(), await longest(), await longest()].sort((a, b) => a.worst - b.worst);
  expect(runs[0]!.worst).toBeLessThan(10);
  // still oldest first in each bucket, every candidate taken once
  const e = { subject: "S0", fromEmail: "a@example.test", date: 0, size: 100, rfcMessageId: "m0@x" };
  expect(await runs[0]!.index.take(e, async () => true)).toBe(49_999);
  expect(await runs[0]!.index.take(e, async () => true)).toBe(50_000);
  expect(runs[0]!.index.size).toBe(49_998);
});

it("Codex R13: 25,000 candidates added later, older than 25,000 waiting in the same bucket, merge in linear time", async () => {
  const e = { subject: "Same", fromEmail: "a@x", date: 1, size: 1, rfcMessageId: null };
  const index = new AdoptIndex(Array.from({ length: 25_000 }, (_, i) => ({ id: 2 * i + 2, ...e })));
  expect(await index.take(e, async () => true)).toBe(2);
  let last = performance.now();
  let worst = 0;
  const tick = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 1);
  const started = performance.now();
  await index.add(Array.from({ length: 25_000 }, (_, i) => 2 * i + 1), async (ids) => ids.map((id) => ({ id, ...e })));
  const total = performance.now() - started;
  clearInterval(tick);
  expect(total).toBeLessThan(200);
  expect(worst).toBeLessThan(10);
  // oldest first: the late ones in their places among those still waiting
  for (const id of [1, 3, 4, 5, 6]) expect(await index.take(e, async () => true)).toBe(id);
  expect(index.size).toBe(49_994);
});

it("Codex R14: 200,000 waiting and 200,000 more added later, older and interleaved: linear, never a long stall", async () => {
  const e = { subject: "Same", fromEmail: "a@x", date: 1, size: 1, rfcMessageId: null };
  const index = new AdoptIndex();
  await index.add(Array.from({ length: 200_000 }, (_, i) => 2 * i + 2), async (ids) => ids.map((id) => ({ id, ...e })));
  expect(await index.take(e, async () => true)).toBe(2);
  const older = Array.from({ length: 200_000 }, (_, i) => 2 * i + 1);
  let last = performance.now();
  let worst = 0;
  const tick = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 1);
  const started = performance.now();
  await index.add(older, async (ids) => ids.map((id) => ({ id, ...e })));
  const total = performance.now() - started;
  clearInterval(tick);
  expect(total).toBeLessThan(1000);
  expect(worst).toBeLessThan(10);
  // oldest first across both, every one once
  for (const id of [1, 3, 4, 5, 6, 7]) expect(await index.take(e, async () => true)).toBe(id);
  let n = 6;
  while ((await index.take(e, async () => true)) !== null) n++;
  expect(n).toBe(399_999);
});
