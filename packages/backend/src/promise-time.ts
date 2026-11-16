import { inZone } from "@terno/ai";
import { localDay, partMoment, partOfDayIn, saysPart, statedClock, statesClock, type PartOfDay } from "@terno/core";

/** The reader's zone, the machine's, read each time (a trip changes it), as the dated reader reads it. */
export function readerZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** A promise as follow-ups' checks place it: its moment, a stated time or not, its words, and the part of its day. */
export interface PromiseMoment {
  dueAt: number;
  timed: boolean;
  /** its words, without a clock its quote never stated */
  text: string;
  partOfDay: PartOfDay | null;
}

/**
 * Plan 210 (iteration 2, the panel's A7): a dated promise's moment when the person's own words state a time ("I'll call you
 * at 4"; its text "call Marcus at 4:00 PM PT"): that clock on its day, in the reader's zone (converted, across daylight
 * saving time, when its words name another), so the row's column says it and orders it; `timed` then. Otherwise, or when
 * it would be before the mail was sent, the day's default as `followupDue` gave it: never a clock made up from it.
 *
 * Iteration 5 (the Codex review's revision 4): the clock is read from the text only when the quote states one, so a time the
 * reader wrote itself ("by 12:00 PM" for "Friday morning": prompt v12) is never the promise's: it leaves the words, and the
 * part of the day the quote names is what was meant. A part of the day (the reader's, checked against the quote: it must name
 * it and state no clock) is stored, untimed, at that part's moment (`partMoment`).
 */
export function promiseMoment(o: { text: string; quote: string; day: string | null; part?: PartOfDay | null }, fallback: { dueAt: number; dated: boolean }, sentAt: number, zone = readerZone()): PromiseMoment {
  const dated = o.day !== null && fallback.dated;
  const stated = statesClock(o.quote);
  const clock = statedClock(o.text);
  // a clock the words have and the quote doesn't is the reader's own: out of the words, and the quote's part is what it meant
  const made = clock !== null && !stated;
  const text = made ? clock.rest : o.text;
  const part = !dated || stated ? null : o.part && saysPart(o.quote, o.part) ? o.part : made ? partOfDayIn(o.quote) : null;
  const untimed = (): PromiseMoment => {
    const at = part && o.day ? partMoment(o.day, part, sentAt) : null;
    return at === null ? { dueAt: fallback.dueAt, timed: false, text, partOfDay: null } : { dueAt: at, timed: false, text, partOfDay: part };
  };
  if (!dated || !clock || made || !o.day) return untimed();
  const at = clock.zone && clock.zone !== zone ? inZone({ due: o.day, time: clock.time }, clock.zone, zone) : { due: o.day, time: clock.time };
  const date = at.time ? localDay(at.due) : null;
  if (!date || !at.time) return untimed();
  const [h, m] = at.time.split(":").map(Number) as [number, number];
  date.setHours(h, m, 0, 0);
  return date.getTime() > sentAt ? { dueAt: date.getTime(), timed: true, text, partOfDay: null } : untimed();
}
