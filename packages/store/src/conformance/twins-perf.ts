import { expect } from "vitest";
import type { MailStore } from "../mail-store";
import { withAccounts } from "./fixtures";

/** 50,000 messages of one sender, date and size; `subject` null: each its own. A store writes them by its quickest route. */
export interface TwinCohort {
  providerPrefix: string;
  fromEmail: string;
  subject: string | null;
  rfcMessageId: string | null;
  date: number;
  size: number;
  n: number;
}

const base = { date: 1_800_000_000_000, size: 4096, n: 50_000 };
/** Lookups and pages, ID-less and with a reused Message-ID: side by side in one store, each its own envelope. */
const LOOKUPS: [string, TwinCohort][] = [
  ["ID-less", { ...base, providerPrefix: "nomid:", fromEmail: "boletin@example.test", subject: null, rfcMessageId: null }],
  ["reused Message-ID", { ...base, providerPrefix: "reused:", fromEmail: "boletin-r@example.test", subject: null, rfcMessageId: "reused-1@example.test" }],
];
const PAGES: [string, TwinCohort][] = [
  ["ID-less", { ...base, providerPrefix: "nomid:x#", fromEmail: "igual@example.test", subject: "Igual", rfcMessageId: null }],
  ["reused Message-ID", { ...base, providerPrefix: "reused:x#", fromEmail: "igual-r@example.test", subject: "Igual", rfcMessageId: "reused-2@example.test" }],
];

/** A cohort's subject for its i-th message. */
export const twinSubject = (c: TwinCohort, i: number) => c.subject ?? `Edición ${i}`;

/**
 * Plan 68 (Codex R20, R21, R27): an ID-less message's twins are found by exactly its envelope, on one store holding every
 * cohort: 250 lookups among 50,000 messages of one sender, date and size take a few milliseconds, never a cohort scan;
 * 50,000 of one envelope page 500 at a time from first to last; and a reused Message-ID stays as fast. `add` writes
 * a cohort: not through ingest (50,000 are half a minute there), but the columns these read as ingest leaves them.
 */
export async function measureTwins(store: MailStore, add: (accountId: number, c: TwinCohort) => void, o: { budget: number; log: (line: string) => void }): Promise<void> {
  const [, m] = await withAccounts(store);
  for (const [, c] of [...LOOKUPS, ...PAGES]) add(m!, c);
  const locations = store.providerStore(m!).locations;
  const bestOf3 = async (fn: () => Promise<unknown>) => {
    const runs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      await fn();
      runs.push(performance.now() - t0);
    }
    return Math.min(...runs);
  };
  for (const [label, c] of LOOKUPS) {
    const lookups = () => Promise.all(Array.from({ length: 250 }, (_, i) => locations.twins({ subject: twinSubject(c, i * 199), fromEmail: c.fromEmail, date: c.date, size: c.size, rfcMessageId: c.rfcMessageId }, 0, 500)));
    expect((await lookups()).every((ids) => ids.length === 1)).toBe(true);
    const ms = await bestOf3(lookups);
    o.log(`250 twin lookups, ${label}: ${ms.toFixed(2)} ms`);
    expect(ms, `250 twin lookups, ${label}`).toBeLessThanOrEqual(25 * o.budget);
  }
  for (const [label, c] of PAGES) {
    const e = { subject: c.subject!, fromEmail: c.fromEmail, date: c.date, size: c.size, rfcMessageId: c.rfcMessageId };
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
    expect(first).toHaveLength(c.n);
    expect(first.every((id, i) => i === 0 || id > first[i - 1]!)).toBe(true);
    const ms = await bestOf3(all);
    o.log(`50,000 twins paged, ${label}: ${ms.toFixed(2)} ms`);
    expect(ms, `50,000 twins paged, ${label}`).toBeLessThanOrEqual(50 * o.budget);
  }
}
