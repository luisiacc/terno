/**
 * Plan 88: what the palette remembers about its own use, on this device only
 * (ids like "thread.archive" or "move:12", never mail). Read when the palette
 * opens, written once per run, and bounded to the last MAX ids.
 */

export interface Use {
  /** times run */
  n: number;
  /** last run (ms) */
  at: number;
}
export type Usage = ReadonlyMap<string, Use>;

const KEY = "terno:palette-usage";
export const MAX = 50;
const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
/** the most use adds: a strong match still beats a weak one used daily */
const BOOST_CAP = 0.5;

export function readUsage(): Usage {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(raw)) return new Map();
    const out = new Map<string, Use>();
    for (const row of raw) {
      if (!Array.isArray(row)) continue;
      const [id, n, at] = row as unknown[];
      if (typeof id === "string" && Number.isFinite(n) && Number.isFinite(at)) out.set(id, { n: n as number, at: at as number });
    }
    return out;
  } catch {
    return new Map();
  }
}

/** The usage with one more run of `id`; the least recently used ids past MAX drop off. */
export function recordUse(usage: Usage, id: string, now: number): Usage {
  const next = new Map(usage);
  next.set(id, { n: (usage.get(id)?.n ?? 0) + 1, at: now });
  if (next.size <= MAX) return next;
  return new Map([...next].sort((a, b) => b[1].at - a[1].at).slice(0, MAX));
}

export function noteUse(id: string, now = Date.now()): void {
  const next = recordUse(readUsage(), id, now);
  try {
    localStorage.setItem(KEY, JSON.stringify([...next].map(([k, u]) => [k, u.n, u.at])));
  } catch {
    // private mode or full: the palette just doesn't learn
  }
}

/** The factor a match score is multiplied by: 1 for unused, at most 1.5, halving with every two weeks unused. */
export function boost(use: Use | undefined, now: number): number {
  if (!use) return 1;
  const decay = 0.5 ** (Math.max(0, now - use.at) / HALF_LIFE_MS);
  return 1 + Math.min(BOOST_CAP, 0.15 * Math.log2(1 + use.n)) * decay;
}

/** Up to `limit` of `available` ids, the most recently run first. */
export function recentIds(usage: Usage, available: ReadonlySet<string>, limit: number): string[] {
  return [...usage]
    .filter(([id]) => available.has(id))
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, limit)
    .map(([id]) => id);
}
