import { expect, it } from "vitest";
import { BUDGET_MULTIPLIER } from "../../db/src/test/perf";
import { ProviderError } from "./types";
import { GmailFixtureEntryError, GmailFixturePool, GmailResponseFixture } from "./test/gmail-response.fixture";

it.each([25, 35])("validates six %i MiB raw responses within the backend slice budget", async (mib) => {
  // The first full bad validation cancels sibling preparation; the reader scope remains six.
  const source = (() => {
    const bytes = Buffer.alloc(mib * 1024 * 1024, 65);
    bytes[bytes.length - 1] = 33;
    return bytes.toString("ascii");
  })();
  globalThis.gc?.();
  const ids = Array.from({ length: 6 }, (_, i) => `m${i}`);
  const budget = 15 * BUDGET_MULTIPLIER;
  const fixture = new GmailResponseFixture(source, ids, budget);
  let failure: { error: unknown } | undefined;
  try {
    const error = await fixture.run();
    await fixture.joinActualTerminals();
    const downloaded = fixture.counts.consumers;
    const checkpoints = fixture.counts.checkpoints;
    const effects = fixture.counts.effects;
    expect(fixture.syncSettled).toBe(true);
    expect(fixture.counts.requests).toBe(6);
    expect(downloaded).toBe(6);
    expect(fixture.readers).toHaveLength(6);
    expect(fixture.readers.every((reader) => reader.readerObtained && reader.readerClosed)).toBe(true);
    expect(fixture.counts.maxProducerChunk).toBeLessThanOrEqual(65536);
    expect(fixture.counts.maxProducerBacking).toBeLessThanOrEqual(1024 * 1024);
    expect(fixture.counts.acquireGranted).toBe(6);
    expect(fixture.counts.acquireReleaseCalls).toBe(6);
    expect(fixture.counts.promotionGranted + fixture.counts.promotionRejected).toBe(fixture.counts.promotionCalls);
    expect(fixture.counts.promotionReleaseCalls).toBe(fixture.counts.promotionGranted);
    expect(fixture.abortedPassCount()).toBe(1);
    expect(fixture.pool.jobs).toHaveLength(1);
    const job = fixture.pool.jobs[0]!;
    expect(ids).toContain(job.id);
    expect(job).toMatchObject({ bytes: fixture.wireBytes(job.id), settled: true, succeeded: false, code: "malformed-base64" });
    expect(job.maxChunk).toBeLessThanOrEqual(65536);
    expect(fixture.pool.active).toBe(0);
    expect(fixture.pool.idleJoined).toBe(true);
    // Five siblings have joined reader terminals but no completed worker validation.
    expect(fixture.readers.filter((reader) => reader.id !== job.id && reader.readerClosed)).toHaveLength(5);
    const timing = fixture.timingReport();
    expect(timing.stall, `raw validation stall (${mib} MiB, six reader entries, one full bad worker): ${JSON.stringify(timing)}`).toBeLessThanOrEqual(budget);
    expect(error).toBeInstanceOf(ProviderError);
    expect(downloaded).toBe(6);
    expect(checkpoints).toBe(0);
    expect(effects).toBe(0);
  } catch (error) { failure = { error }; }
  await fixture.finish(failure);
  expect(fixture.providerCloseFulfilled).toBe(true);
  expect(fixture.pool.closeFulfilled).toBe(true);
  expect(fixture.counts.restored).toBe(6);
});

it("admits a valid promoted Gmail body through the actual worker and sink", async () => {
  const text = "qualified synthetic body ".repeat(24000) + "Exact end.";
  const source = Buffer.from(`From: sender@example.test\r\nSubject: Synthetic\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n`).toString("base64url");
  const fixture = new GmailResponseFixture(source, ["valid"], 15 * BUDGET_MULTIPLIER);
  let failure: { error: unknown } | undefined;
  try {
    const error = await fixture.run();
    await fixture.joinActualTerminals();
    expect(error).toBeUndefined();
    expect(fixture.counts.requests).toBe(1);
    expect(fixture.counts.consumers).toBe(1);
    expect(fixture.syncSettled).toBe(true);
    expect(fixture.counts.acquireGranted).toBe(1);
    expect(fixture.counts.acquireReleaseCalls).toBe(1);
    expect(fixture.counts.promotionGranted).toBe(1);
    expect(fixture.counts.promotionReleaseCalls).toBe(1);
    expect(fixture.readers[0]).toMatchObject({ readerObtained: true, readerClosed: true, produced: fixture.wireBytes("valid") });
    expect(fixture.pool.jobs).toHaveLength(1);
    expect(fixture.pool.jobs[0]).toMatchObject({ id: "valid", bytes: fixture.wireBytes("valid"), settled: true, succeeded: true });
    expect(fixture.pool.active).toBe(0);
    expect(fixture.counts.ingested).toBe(1);
    expect(fixture.counts.checkpoints).toBe(1);
    expect(fixture.lastBodyText).toBe(`${text}\n`);
    expect(fixture.timingReport().stall).toBeLessThanOrEqual(15 * BUDGET_MULTIPLIER);
  } catch (error) { failure = { error }; }
  await fixture.finish(failure);
  expect(fixture.providerCloseFulfilled).toBe(true);
  expect(fixture.pool.closeFulfilled).toBe(true);
  expect(fixture.counts.restored).toBe(1);
});

it("refuses the empty json-only Gmail fixture before granting a timing witness", async () => {
  const fixture = new GmailResponseFixture("QUFB!", ["empty"], 15 * BUDGET_MULTIPLIER, { mode: "empty-json-only" });
  let failure: { error: unknown } | undefined;
  try {
    const error = await fixture.run();
    await fixture.joinActualTerminals();
    expect(error).toBeInstanceOf(ProviderError);
    expect(fixture.counts.requests).toBe(1);
    expect(fixture.counts.consumers).toBe(0);
    expect(fixture.counts.jsonCalls).toBe(0);
    expect(fixture.pool.jobs).toHaveLength(0);
    expect(() => fixture.timingReport()).toThrow(GmailFixtureEntryError);
    expect(fixture.counts.checkpoints).toBe(0);
    expect(fixture.counts.effects).toBe(0);
  } catch (error) { failure = { error }; }
  await fixture.finish(failure);
  expect(fixture.providerCloseFulfilled).toBe(true);
  expect(fixture.pool.closeFulfilled).toBe(true);
});

it.each([25, 35])("joins six independent %i MiB bad Gmail validations on one real pipeline", async (mib) => {
  const bytes = Buffer.alloc(mib * 1024 * 1024, 65);
  bytes[bytes.length - 1] = 33;
  const source = bytes.toString("ascii");
  globalThis.gc?.();
  const budget = 15 * BUDGET_MULTIPLIER;
  const pool = new GmailFixturePool();
  const fixtures = Array.from({ length: 6 }, (_, i) => new GmailResponseFixture(source, [`m${i}`], budget, { accountId: i + 1, pool }));
  const failures: unknown[] = [];
  try {
    const results = await Promise.all(fixtures.map((fixture) => fixture.run()));
    await Promise.all(fixtures.map((fixture) => fixture.joinActualTerminals()));
    expect(results.every((error) => error instanceof ProviderError)).toBe(true);
    expect(pool.jobs).toHaveLength(6);
    expect(new Set(pool.jobs.map((job) => job.id))).toEqual(new Set(fixtures.map((_, i) => `m${i}`)));
    for (let i = 0; i < fixtures.length; i++) {
      const fixture = fixtures[i]!;
      expect(fixture.counts.requests).toBe(1);
      expect(fixture.counts.consumers).toBe(1);
      expect(fixture.syncSettled).toBe(true);
      expect(fixture.counts.acquireGranted).toBe(1);
      expect(fixture.counts.acquireReleaseCalls).toBe(1);
      expect(fixture.counts.promotionGranted).toBe(1);
      expect(fixture.counts.promotionReleaseCalls).toBe(1);
      expect(fixture.readers[0]).toMatchObject({ readerObtained: true, readerClosed: true, produced: fixture.wireBytes(`m${i}`) });
      expect(pool.jobs.find((job) => job.id === `m${i}`)).toMatchObject({ bytes: fixture.wireBytes(`m${i}`), settled: true, succeeded: false, code: "malformed-base64" });
      expect(fixture.counts.checkpoints).toBe(0);
      expect(fixture.counts.effects).toBe(0);
      expect(fixture.timingReport().stall).toBeLessThanOrEqual(budget);
    }
    expect(pool.active).toBe(0);
  } catch (error) { failures.push(error); }
  const closing = await Promise.allSettled(fixtures.map((fixture) => fixture.finish()));
  failures.push(...closing.flatMap((result) => result.status === "rejected" ? [result.reason] : []));
  try { await pool.close(); } catch (error) { failures.push(error); }
  try { pool.stopMonitor(); } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Independent Gmail validation/control cleanup failed");
  expect(fixtures.every((fixture) => fixture.providerCloseFulfilled)).toBe(true);
  expect(pool.closeFulfilled).toBe(true);
});
