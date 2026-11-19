import { datedGroup, dayKeyOf, localDay, planEnd, type TodayAlso, type TodayItem, type TodayList, type TodayWhy } from "@terno/core";

/**
 * Plan 222: a clear What matters (nothing missed, due today or waiting on you), what it says and draws: the next moment
 * ahead, the sun's place on its arc by the clock, and the clear days counted on this machine. No imports of the app.
 */

/** The next moment ahead: a time (`timed`) or a day; "today", an untimed item today (the day stays as it was); null, nothing ahead. */
export type NextUp = { at: number; timed: boolean } | "today" | null;

export type Moment = { at: number; timed: boolean; day: string; /** a plan's end: underway until then */ until?: number };

/**
 * An item's moment, if it has one: put off with Later, when it's back (Codex's plan critique, 1); else a dated item's or a
 * dated promise's, a reminder's. An ask's `dueAt` is its arrival: none. A plan has its end too, so one underway is today's.
 */
function momentOf(why: TodayWhy): Moment | null {
  if (why.back !== undefined) return { at: why.back, timed: true, day: dayKeyOf(why.back) };
  if (why.dueAt === undefined) return null;
  if (why.kind === "dated") {
    const item = why.item;
    if (!item?.dated) return null;
    const until = datedGroup(item.kind) === "plans" ? { until: planEnd({ dueDay: item.dueDay, dueAt: why.dueAt, timed: item.timed }) } : {};
    return item.timed ? { at: why.dueAt, timed: true, day: dayKeyOf(why.dueAt), ...until } : { at: localDay(item.dueDay)?.getTime() ?? why.dueAt, timed: false, day: item.dueDay };
  }
  if (why.kind === "promise") return why.promise?.dated ? { at: why.dueAt, timed: why.promise.timed === true, day: dayKeyOf(why.dueAt) } : null;
  if (why.kind === "reminder") return { at: why.dueAt, timed: true, day: dayKeyOf(why.dueAt) };
  return null;
}

/** The other promises and items a row carries (`also`): a reply's later promise can lead an earlier one (Codex's plan critique, 3). */
const alsoMoment = (a: TodayAlso): Moment | null => (a.dated ? (a.timed ? { at: a.dueAt, timed: true, day: dayKeyOf(a.dueAt) } : { at: localDay(a.dueDay)?.getTime() ?? a.dueAt, timed: false, day: a.dueDay }) : null);

const momentsOf = (item: TodayItem): (Moment | null)[] => [momentOf(item.why), ...(item.also ?? []).map(alsoMoment)];

/** Every moment the answer's items have, Coming up's included (drawn or not): read once, when the answer is published. */
export const momentsOfList = (list: Pick<TodayList, "sections">): Moment[] => list.sections.flatMap((s) => s.items.flatMap(momentsOf)).filter((m): m is Moment => m !== null);

/**
 * The soonest of the moments still ahead at `now`, read when it's drawn (Codex's plan critique, 4: 3:00 PM passes): a timed one after `now`,
 * an untimed one on a day after today. An untimed one today (an all-day plan, which isn't counted) or a plan underway (Codex's
 * plan critique, 5: you're at it, not free) is "today". Reminders after today aren't What matters' items, so they aren't here.
 */
export function nextUp(moments: readonly Moment[], now: number): NextUp {
  const today = dayKeyOf(now);
  let best: { at: number; timed: boolean } | null = null;
  for (const m of moments) {
    if (!m.timed && m.day === today) return "today";
    if (m.until !== undefined && m.at <= now && now < m.until) return "today";
    if (m.timed ? m.at <= now : m.day <= today) continue;
    if (!best || m.at < best.at) best = { at: m.at, timed: m.timed };
  }
  return best;
}

/**
 * When what a clear What matters says next changes by the clock alone: the next timed moment or plan's end still ahead,
 * else the next local midnight (a new day: its words, and a clear day to count). One moment, so the window arms one timer
 * to it, never a polling one.
 */
export function nextChange(moments: readonly Moment[], now: number): number {
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  let at = midnight.getTime();
  for (const m of moments) {
    if (m.timed && m.at > now && m.at < at) at = m.at;
    if (m.until !== undefined && m.until > now && m.until < at) at = m.until;
  }
  return at;
}

/** The sun's arc in the horizon's viewBox (440 × 110): its feet on the line, its top above the box. */
export const ARC = { from: [30, 92], top: [220, -48], to: [410, 92] } as const;

/**
 * Where the sun is at `hour` (0–24, fractional): on the arc from 6:00 to 18:00; before, resting at its left foot, after, at
 * its right (half below the line, which hides it). `up`: on the arc.
 */
export function sunPlace(hour: number): { x: number; y: number; up: boolean } {
  const t = Math.min(1, Math.max(0, (hour - 6) / 12));
  const up = hour > 6 && hour < 18;
  const q = (i: 0 | 1) => (1 - t) ** 2 * ARC.from[i] + 2 * (1 - t) * t * ARC.top[i] + t * t * ARC.to[i];
  return { x: q(0), y: q(1), up };
}

const CLEAR_DAYS_KEY = "terno.whatMatters.clearDays";

/**
 * The clear days seen on this machine (a count, never a streak): today counted once, the first time a clear What matters
 * is seen on it. Null when storage is refused, so there's no number to say.
 */
export function countClearDay(now: number, storage: Pick<Storage, "getItem" | "setItem"> | null = safeStorage()): number | null {
  if (!storage) return null;
  try {
    const today = dayKeyOf(now);
    const raw = storage.getItem(CLEAR_DAYS_KEY);
    const was = raw ? (JSON.parse(raw) as { n?: unknown; day?: unknown }) : null;
    const n = typeof was?.n === "number" && Number.isFinite(was.n) && was.n >= 0 ? Math.floor(was.n) : 0;
    const day = typeof was?.day === "string" ? was.day : "";
    if (n > 0 && day >= today) return n;
    storage.setItem(CLEAR_DAYS_KEY, JSON.stringify({ n: n + 1, day: today }));
    return n + 1;
  } catch {
    return null;
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
