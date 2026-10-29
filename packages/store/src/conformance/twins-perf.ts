import { expect } from "vitest";
import type { MailStore } from "../mail-store";
import { ingest, msg, withAccounts } from "./fixtures";

/**
 * Plan 65 (Codex R20): an ID-less message's twins are found by exactly its envelope: with 50,000 ID-less messages
 * from one sender at one date and size (distinct subjects), 250 lookups take a few milliseconds, never a cohort scan.
 */
export async function twinLookupsMs(store: MailStore): Promise<number> {
  const [, m] = await withAccounts(store);
  const base = { from: { name: "", email: "boletin@example.test" }, date: 1_800_000_000_000, size: 4096, rfcMessageId: null };
  for (let i = 0; i < 50_000; i += 5000) await ingest(store, Array.from({ length: 5000 }, (_, j) => msg({ accountId: m!, providerMsgId: `nomid:${i + j}`, subject: `Edición ${i + j}`, ...base })));
  const locations = store.providerStore(m!).locations;
  const lookups = () => Promise.all(Array.from({ length: 250 }, (_, i) => locations.twins({ subject: `Edición ${i * 199}`, fromEmail: base.from.email, date: base.date, size: base.size }, 0, 500)));
  expect((await lookups()).every((ids) => ids.length === 1)).toBe(true);
  const runs: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    await lookups();
    runs.push(performance.now() - t0);
  }
  return Math.min(...runs);
}
