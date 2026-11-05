/**
 * Plan 68 (Codex R4, R5, R12–R14): the recovery index's timing at scale: built and consumed in linear time, the event
 * loop never held long while candidates are read, merged or taken. A stall is the loop's busy time (timing.ts), never
 * how late an idle timer fired. The perf project runs it alone (nothing competes for CPU); what it holds to is in
 * adopt.test.ts.
 */
import { expect, it } from "vitest";
import { watchLoop } from "../../db/src/test/timing";
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
    const loop = watchLoop(10);
    await index.add(byId.keys(), async (ids) => ids.map((id) => byId.get(id)!), slice);
    return { worst: loop.stop().stall, index };
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
  const merge = async () => {
    const index = new AdoptIndex(Array.from({ length: 25_000 }, (_, i) => ({ id: 2 * i + 2, ...e })));
    expect(await index.take(e, async () => true)).toBe(2);
    const loop = watchLoop(10);
    const started = performance.now();
    await index.add(Array.from({ length: 25_000 }, (_, i) => 2 * i + 1), async (ids) => ids.map((id) => ({ id, ...e })));
    return { index, total: performance.now() - started, stall: loop.stop().stall };
  };
  let run = await merge();
  // over budget it's run again, up to three times, and the best counts: a stall of ours repeats, a busy moment doesn't
  for (let attempt = 1; attempt < 3 && !(run.total < 200 && run.stall < 10); attempt++) run = await merge();
  const index = run.index;
  expect(run.total).toBeLessThan(200);
  expect(run.stall).toBeLessThan(10);
  // oldest first: the late ones in their places among those still waiting
  for (const id of [1, 3, 4, 5, 6]) expect(await index.take(e, async () => true)).toBe(id);
  expect(index.size).toBe(49_994);
});

it("Codex R14: 200,000 waiting and 200,000 more added later, older and interleaved: linear, never a long stall", async () => {
  const e = { subject: "Same", fromEmail: "a@x", date: 1, size: 1, rfcMessageId: null };
  const older = Array.from({ length: 200_000 }, (_, i) => 2 * i + 1);
  const merge = async () => {
    const index = new AdoptIndex();
    await index.add(Array.from({ length: 200_000 }, (_, i) => 2 * i + 2), async (ids) => ids.map((id) => ({ id, ...e })));
    expect(await index.take(e, async () => true)).toBe(2);
    const loop = watchLoop(10);
    const started = performance.now();
    await index.add(older, async (ids) => ids.map((id) => ({ id, ...e })));
    return { index, total: performance.now() - started, stall: loop.stop().stall };
  };
  let run = await merge();
  for (let attempt = 1; attempt < 3 && !(run.total < 1000 && run.stall < 10); attempt++) run = await merge();
  const index = run.index;
  expect(run.total).toBeLessThan(1000);
  expect(run.stall).toBeLessThan(10);
  // oldest first across both, every one once
  for (const id of [1, 3, 4, 5, 6, 7]) expect(await index.take(e, async () => true)).toBe(id);
  let n = 6;
  while ((await index.take(e, async () => true)) !== null) n++;
  expect(n).toBe(399_999);
});

it("Codex R43: 500,000 recovery candidates in no order are sorted and their first envelopes read without holding the loop a frame", async () => {
  const { sortIds } = await import("./adopt");
  // a shuffled permutation (a folder's UID order is no message-id order)
  const ids = Array.from({ length: 500_000 }, (_, i) => i + 1);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = (i * 7919 + 13) % (i + 1);
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  }
  const given = new Set(ids);
  const stall = async () => {
    const loop = watchLoop(16);
    const sorted = await sortIds(given);
    const index = new AdoptIndex();
    // up to the first envelopes read
    let reads = 0;
    await index.add(sorted, async (chunk) => {
      reads++;
      return reads > 2 ? [] : chunk.map((id) => ({ id, subject: "S", fromEmail: "a@x", date: 1, size: 1, rfcMessageId: null }));
    });
    const worst = loop.stop().stall;
    expect(sorted).toHaveLength(500_000);
    expect(sorted.every((id, i) => i === 0 || id > sorted[i - 1]!)).toBe(true);
    return worst;
  };
  // warmed once, then the best of up to three: a stall of ours repeats, another process's preemption doesn't
  await stall();
  let best = Infinity;
  for (let attempt = 0; attempt < 3 && best >= 16; attempt++) best = Math.min(best, await stall());
  expect(best).toBeLessThan(16);
});
