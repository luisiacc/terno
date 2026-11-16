import { localDay } from "./followups";
import { REMIND_MORNING } from "./reminders";

/**
 * Plan 210 (iteration 5, the Codex review's revision 4): "Friday morning", "tonight", "Saturday morning" are a part of a day,
 * not a clock. It's stored beside the item's day (`partOfDay`, a promise's and a dated request's), never written into its
 * words as a made-up time ("by 12:00 PM": prompt v12 did), and the item is untimed. One cutoff says when that part is over:
 * placement, a broken promise's day and the clock read it here.
 */
export const PARTS_OF_DAY = ["morning", "afternoon", "evening"] as const;
export type PartOfDay = (typeof PARTS_OF_DAY)[number];

export const isPartOfDay = (v: unknown): v is PartOfDay => v === "morning" || v === "afternoon" || v === "evening";

/** A stored part (SQL's text, a record's field): one that doesn't read as a part is none. */
export const readPartOfDay = (v: unknown): PartOfDay | null => (isPartOfDay(v) ? v : null);

/** When each part is over, local wall clock: a morning at noon, an afternoon at 18:00, an evening at the day's end. */
const CUTOFF_HOUR: Readonly<Record<PartOfDay, number>> = { morning: 12, afternoon: 18, evening: 24 };
/** When each part begins: what a promise for it is due at, as a whole day's is at 9:00. */
const START_HOUR: Readonly<Record<PartOfDay, number>> = { morning: REMIND_MORNING, afternoon: 13, evening: 18 };

/** A local day at an hour (24: the next day's 0:00), by wall clock across DST. */
const hourOf = (day: Date, hour: number): number => {
  const d = new Date(day);
  d.setDate(d.getDate() + Math.floor(hour / 24));
  d.setHours(hour % 24, 0, 0, 0);
  return d.getTime();
};

/**
 * The one cutoff resolver: the moment an item due on `day` (YYYY-MM-DD, local) is over, its part's end when it has one
 * (a morning at noon), else the day's end (the next day's 0:00). NaN for a day that doesn't read.
 */
export function dueCutoff(day: string, part: PartOfDay | null | undefined): number {
  const d = localDay(day);
  return d ? hourOf(d, part ? CUTOFF_HOUR[part] : 24) : Number.NaN;
}

/**
 * A promise's moment for a part of its day: the part's start ("Friday morning", 9:00); one already begun when the promise
 * was made, an hour before it ends ("tonight", written at 19:00: 23:00), or in its last hour the moment before it ends, so
 * it's never due the moment it's sent and stays on its day; null when that part was over before it was made (the part says
 * nothing then: the day's own rules apply).
 */
export function partMoment(day: string, part: PartOfDay, sentAt: number): number | null {
  const d = localDay(day);
  if (!d) return null;
  const start = hourOf(d, START_HOUR[part]);
  if (start > sentAt) return start;
  const end = hourOf(d, CUTOFF_HOUR[part]);
  if (end <= sentAt) return null;
  const late = end - 60 * 60 * 1000;
  return late > sentAt ? late : end - 1;
}

/** Whether the words name this part of a day (a promise's quote, checked against the part the reader gave). */
export const saysPart = (words: string, part: PartOfDay): boolean => PART_WORDS[part].test(words);

/**
 * The words that name a part of a day, en and es. Spanish "mañana" alone is "tomorrow", and "tarde" alone is "late": only
 * "por la mañana", "en la mañana", "esta mañana" (and "mañana por la mañana") are a morning; "más tarde" is never an afternoon.
 */
const PART_WORDS: Readonly<Record<PartOfDay, RegExp>> = {
  morning: /\b(?:mornings?|first thing)\b|\b(?:por|en|esta) (?:la )?ma[ñn]ana\b|\ba primera hora\b/iu,
  afternoon: /\bafternoons?\b|\b(?:por|en) la tarde\b|\besta tarde\b/iu,
  evening: /\b(?:evenings?|tonight)\b|\b(?:por|en) la noche\b|\besta noche\b/iu,
};

/** A clock the words state: "4:00", "4 pm", "at 4", "noon", "a las 10", "mediodía". Lenient: it only lets a clock through. */
const CLOCK_WORDS = /\b\d{1,2}:\d{2}\b|\b\d{1,2}\s?[ap]\.?\s?m\b\.?|\b(?:at|by|before|until) \d{1,2}\b|\b(?:noon|midday|midnight|o'clock)\b|\ba las? \d{1,2}\b|\b(?:mediod[ií]a|medianoche)\b|\b\d{1,2}\s?h\b/iu;

export const statesClock = (words: string): boolean => CLOCK_WORDS.test(words);

/**
 * The part of the day the mail's own words name, read locally: exactly one part, and no clock (a clock is the time: "Friday
 * morning at 10" is 10:00). Null: none, two ("morning or afternoon"), or a clock.
 */
export function partOfDayIn(words: string): PartOfDay | null {
  if (statesClock(words)) return null;
  const found = PARTS_OF_DAY.filter((p) => PART_WORDS[p].test(words));
  return found.length === 1 ? found[0]! : null;
}
