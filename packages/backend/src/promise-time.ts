import { inZone } from "@terno/ai";
import { localDay, statedClock } from "@terno/core";

/** The reader's zone, the machine's, read each time (a trip changes it), as the dated reader reads it. */
export function readerZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Plan 210 (iteration 2, the panel's A7): a dated promise's moment when its words state a time ("call Marcus at 4:00 PM PT"):
 * that clock on its day, in the reader's zone (converted, across daylight saving time, when its words name another), so the
 * row's column says it and orders it; `timed` then. Otherwise, or when it would be before the mail was sent, the day's
 * default as `followupDue` gave it: never a clock made up from it.
 */
export function promiseMoment(text: string, day: string | null, fallback: { dueAt: number; dated: boolean }, sentAt: number, zone = readerZone()): { dueAt: number; timed: boolean } {
  const clock = day && fallback.dated ? statedClock(text) : null;
  if (!clock || !day) return { dueAt: fallback.dueAt, timed: false };
  const at = clock.zone && clock.zone !== zone ? inZone({ due: day, time: clock.time }, clock.zone, zone) : { due: day, time: clock.time };
  const date = at.time ? localDay(at.due) : null;
  if (!date || !at.time) return { dueAt: fallback.dueAt, timed: false };
  const [h, m] = at.time.split(":").map(Number) as [number, number];
  date.setHours(h, m, 0, 0);
  return date.getTime() > sentAt ? { dueAt: date.getTime(), timed: true } : { dueAt: fallback.dueAt, timed: false };
}
