/**
 * Plan 65 (Codex R4): a renamed folder's messages are recognised by envelope from an index built once, so
 * recovering 25,000 Message-ID twins (50,000 messages) is linear, never a scan of every candidate per message.
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

it("a candidate the folder already holds is passed over; a dropped one is never taken", async () => {
  const e = { subject: "S", fromEmail: "a@x", date: 1, size: 1, rfcMessageId: null };
  const index = new AdoptIndex([{ id: 1, ...e }, { id: 2, ...e }, { id: 3, ...e }]);
  index.drop(2);
  expect(await index.take(e, async (id) => id !== 1)).toBe(3);
  expect(await index.take(e, async () => true)).toBeNull();
});
