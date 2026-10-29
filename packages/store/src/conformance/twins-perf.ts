import { expect } from "vitest";
import type { MailStore } from "../mail-store";
import { ingest, msg, withAccounts } from "./fixtures";

/**
 * Plan 65 (Codex R20): an ID-less message's twins are found by exactly its envelope: with 50,000 ID-less messages
 * from one sender at one date and size (distinct subjects), 250 lookups take a few milliseconds, never a cohort scan.
 */
export async function twinLookupsMs(store: MailStore, rfc: string | null = null): Promise<number> {
  const [, m] = await withAccounts(store);
  const base = { from: { name: "", email: "boletin@example.test" }, date: 1_800_000_000_000, size: 4096, rfcMessageId: rfc };
  for (let i = 0; i < 50_000; i += 5000) await ingest(store, Array.from({ length: 5000 }, (_, j) => msg({ accountId: m!, providerMsgId: `nomid:${i + j}`, subject: `Edición ${i + j}`, ...base })));
  const locations = store.providerStore(m!).locations;
  const stored = rfc === null ? null : (await store.debug.snapshot()).messages.find((x) => x.accountId === m)!.rfcMessageId;
  const lookups = () => Promise.all(Array.from({ length: 250 }, (_, i) => locations.twins({ subject: `Edición ${i * 199}`, fromEmail: base.from.email, date: base.date, size: base.size, rfcMessageId: stored }, 0, 500)));
  expect((await lookups()).every((ids) => ids.length === 1)).toBe(true);
  const runs: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    await lookups();
    runs.push(performance.now() - t0);
  }
  return Math.min(...runs);
}

/** Plan 65 (Codex R21): 50,000 ID-less messages of one envelope, paged 500 at a time from the first to the last. */
export async function twinPagesMs(store: MailStore, rfc: string | null = null): Promise<number> {
  const [, m] = await withAccounts(store);
  const base = { from: { name: "", email: "boletin@example.test" }, subject: "Igual", date: 1_800_000_000_000, size: 4096, rfcMessageId: rfc };
  for (let i = 0; i < 50_000; i += 5000) await ingest(store, Array.from({ length: 5000 }, (_, j) => msg({ accountId: m!, providerMsgId: `nomid:x#${i + j}`, ...base })));
  const locations = store.providerStore(m!).locations;
  const stored = rfc === null ? null : (await store.debug.snapshot()).messages.find((x) => x.accountId === m)!.rfcMessageId;
  const e = { subject: base.subject, fromEmail: base.from.email, date: base.date, size: base.size, rfcMessageId: stored };
  const all = async () => {
    const ids: number[] = [];
    for (let after = 0; ; ) {
      const page = await locations.twins(e, after, 500);
      ids.push(...page);
      if (page.length < 500) return ids;
      after = page.at(-1)!;
    }
  };
  const first = await all();
  expect(first).toHaveLength(50_000);
  expect(first.every((id, i) => i === 0 || id > first[i - 1]!)).toBe(true);
  const runs: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    await all();
    runs.push(performance.now() - t0);
  }
  return Math.min(...runs);
}
