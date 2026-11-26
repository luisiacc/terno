import type { PartOfDay } from "@terno/core";
import { getLocale, t } from "@terno/i18n";

/** Plan 87's moments in words (plan 94's scheduled sends say theirs the same way); no imports of the app. */

const DAY = 86_400_000;
const formats = new Map<string, { time: Intl.DateTimeFormat; weekday: Intl.DateTimeFormat; weekdayLong: Intl.DateTimeFormat; day: Intl.DateTimeFormat; year: Intl.DateTimeFormat; dated: Intl.DateTimeFormat; datedYear: Intl.DateTimeFormat }>();
function fmt() {
  const id = getLocale();
  let f = formats.get(id);
  if (!f) {
    const tag = id === "en" ? "en-US" : id;
    const time: Intl.DateTimeFormatOptions = id === "en" ? { hour: "numeric", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" };
    f = {
      time: new Intl.DateTimeFormat(tag, time),
      weekday: new Intl.DateTimeFormat(tag, { weekday: "short" }),
      weekdayLong: new Intl.DateTimeFormat(tag, { weekday: "long" }),
      day: new Intl.DateTimeFormat(tag, { day: "numeric", month: "short" }),
      year: new Intl.DateTimeFormat(tag, { day: "numeric", month: "short", year: "numeric" }),
      dated: new Intl.DateTimeFormat(tag, { weekday: "short", day: "numeric", month: "short" }),
      datedYear: new Intl.DateTimeFormat(tag, { weekday: "short", day: "numeric", month: "short", year: "numeric" }),
    };
    formats.set(id, f);
  }
  return f;
}

/** Days from today to that day, in local calendar days. */
function daysAway(ms: number, now: number): number {
  const a = new Date(now);
  a.setHours(0, 0, 0, 0);
  const b = new Date(ms);
  b.setHours(0, 0, 0, 0);
  return Math.round((b.getTime() - a.getTime()) / DAY);
}

function dayOf(ms: number, now: number): string {
  const f = fmt();
  const out = (new Date(ms).getFullYear() === new Date(now).getFullYear() ? f.day : f.year).format(ms);
  return out.replace(".", "");
}

/** In a sentence: "tomorrow at 9:00 AM", "Sat at 9:00 AM", "on Nov 17 at 9:00 AM". */
export function reminderWhen(ms: number, now = Date.now()): string {
  const f = fmt();
  const time = f.time.format(ms);
  const days = daysAway(ms, now);
  if (days === 0) return t("remind.when.today", { time });
  if (days === 1) return t("remind.when.tomorrow", { time });
  if (days > 1 && days < 7) return t("remind.when.weekday", { day: f.weekday.format(ms).replace(".", ""), time });
  return t("remind.when.date", { date: dayOf(ms, now), time });
}

/** The time alone, where something beside it already says the day. */
export const reminderTime = (ms: number): string => fmt().time.format(ms);

/** Compact (a menu's right side, a row's date): "Tomorrow 9:00 AM", "Sat 9:00 AM", "Nov 17 9:00 AM". */
export function reminderShort(ms: number, now = Date.now()): string {
  const f = fmt();
  const time = f.time.format(ms);
  const days = daysAway(ms, now);
  if (days === 0) return t("remind.short.today", { time });
  if (days === 1) return t("remind.short.tomorrow", { time });
  if (days > 1 && days < 7) return `${f.weekday.format(ms).replace(".", "")} ${time}`;
  return `${dayOf(ms, now)} ${time}`;
}

/** Plan 280 (the second QA round): a day as its date, always ("Nov 16"): a weekday read as last week's or next */
export const dayDate = (ms: number, now = Date.now()): string => dayOf(ms, now);

/** Plan 280 (the QA panel): a day alone, as a row's date says one: "Today", "Tomorrow", "Yesterday", a weekday within a week, else "Nov 16". */
export function dayShort(ms: number, now = Date.now()): string {
  const days = daysAway(ms, now);
  if (days === 0) return t("date.today");
  if (days === 1) return t("date.tomorrow");
  if (days === -1) return t("date.yesterday");
  if (days > 1 && days < 7) return fmt().weekday.format(ms).replace(".", "");
  return dayOf(ms, now);
}

/**
 * Plan 161, pass 2: a moment a line promises, never a bare weekday: "Today 5:00 PM", "Tomorrow 9:00 AM", and from the day
 * after, its date: "Wed, Oct 28, 9:00 AM" ("mié, 28 oct, 09:00").
 */
export function reminderDated(ms: number, now = Date.now()): string {
  const f = fmt();
  const time = f.time.format(ms);
  const days = daysAway(ms, now);
  if (days === 0) return t("remind.short.today", { time });
  if (days === 1) return t("remind.short.tomorrow", { time });
  const date = (new Date(ms).getFullYear() === new Date(now).getFullYear() ? f.dated : f.datedYear).format(ms);
  return `${date}, ${time}`;
}

/**
 * Plan 162: a past moment said in a sentence, the one shape AI surfaces use for it (the provenance, the digest's coverage):
 * "Thu, Oct 22, 4:00 PM", with the year only when it isn't this one. A row or a list says `listDate`; a moment ahead,
 * `reminderDated`.
 */
export function whenDate(ms: number, now = Date.now()): string {
  return `${whenDay(ms, now)}, ${fmt().time.format(ms)}`;
}

/** Plan 162: the day alone, in the same shape: "Mon, Oct 19". */
export function whenDay(ms: number, now = Date.now()): string {
  const f = fmt();
  return (new Date(ms).getFullYear() === new Date(now).getFullYear() ? f.dated : f.datedYear).format(ms);
}

/**
 * Plan 210 (iteration 3): a past day said beside a day ahead, so it can't be read as the next one: its weekday and date
 * within the week ("Tue 10", "mar 10"), further its date ("Nov 2", "2 nov").
 */
export function pastDay(ms: number, now = Date.now()): string {
  return Math.abs(daysAway(ms, now)) < 7 ? `${fmt().weekday.format(ms).replace(".", "")} ${new Date(ms).getDate()}` : dayOf(ms, now);
}

/** Plan 162: a boundary in time, never ambiguous: the day with its year, "Apr 25, 2026" (what a search went back to). */
export function boundaryDay(ms: number): string {
  return fmt().year.format(ms);
}

/**
 * Plan 210 (iteration 3, revision 9): a week's heading in What matters past its first two weeks, by its Monday: "Week of
 * Dec 7", the year when it isn't this one's ("Week of Jan 4, 2027"; es "Semana del 7 dic").
 */
export function weekHeading(monday: number, now = Date.now()): string {
  return t("whatMatters.weekOf", { day: dayOf(monday, now) });
}

/**
 * Plan 210: a day's heading in What matters, in the when column's day words, as a heading: "Tomorrow"; the weekday this
 * week ("Wednesday", "Miércoles"); further, the day with its date ("Mon, Nov 30", "Lun, 30 nov").
 */
export function dayHeading(ms: number, now = Date.now()): string {
  const days = daysAway(ms, now);
  const text = days === 1 ? t("today.when.tomorrow") : days > 1 && days < 7 ? fmt().weekdayLong.format(ms) : whenDay(ms, now).replace(".", "");
  return text.charAt(0).toLocaleUpperCase(getLocale()) + text.slice(1);
}

/**
 * Plan 204: the day a dated line names, near or not: today, tomorrow, yesterday; the weekday within 6 days either way
 * ("Friday", "viernes"); further, its date ("Nov 21", "21 nov"). The words for the near three are the line's own.
 */
export function datedDay(ms: number, now = Date.now()): { near: "today" | "tomorrow" | "yesterday" | null; text: string } {
  const days = daysAway(ms, now);
  const near = days === 0 ? "today" : days === 1 ? "tomorrow" : days === -1 ? "yesterday" : null;
  return { near, text: Math.abs(days) < 7 ? fmt().weekdayLong.format(ms) : dayOf(ms, now) };
}

/**
 * Plan 204 (after the panel): a Today task's day where a row's received date usually is, as short as that date: its time
 * today ("1:00 PM") or "Today", "Tomorrow", "Yesterday" (a Missed one), the weekday within 6 days either way ("Fri"),
 * further its date ("Nov 21"). The row's line says the rest ("Due Friday 1:00 PM · …").
 */
export function dueShort(ms: number, timed: boolean, now = Date.now()): string {
  const days = daysAway(ms, now);
  if (days === 0) return timed ? fmt().time.format(ms) : t("today.when.today");
  if (days === 1) return t("today.when.tomorrow");
  if (days === -1) return t("date.yesterday");
  return Math.abs(days) < 7 ? fmt().weekday.format(ms).replace(".", "") : dayOf(ms, now);
}

/**
 * Plan 210 (iteration 5, revision 4): a part of a day, as the column says a day: "This morning", "Tomorrow morning", "Fri
 * morning", "Nov 21 afternoon" (es "Esta mañana", "Mañana por la mañana", "vie por la mañana"); `long`, a line's weekday
 * ("Friday morning", "viernes por la mañana"). `near`: today's or tomorrow's, which a sentence lowercases ("Due this
 * morning"); the others go after "el" in Spanish ("Vence el viernes por la mañana"). Never a clock: a part isn't one.
 */
export function partDay(ms: number, part: PartOfDay, now = Date.now(), long = false): { text: string; near: boolean } {
  const days = daysAway(ms, now);
  if (days === 0) return { text: t(`whatMatters.part.today.${part}`), near: true };
  if (days === 1) return { text: t(`whatMatters.part.tomorrow.${part}`), near: true };
  const day = long ? datedDay(ms, now).text : dueShort(ms, false, now);
  return { text: t(`whatMatters.part.on.${part}`, { day }), near: false };
}

/** A near part's words inside a sentence: "this morning", "mañana por la mañana". */
export const partInSentence = (text: string): string => text.charAt(0).toLocaleLowerCase(getLocale()) + text.slice(1);

/** What `dueShort` can't say: the time of a timed one not due today (Codex code review: "Tomorrow" alone lost "7:40"). */
export const dueTimeLeft = (ms: number, timed: boolean, now = Date.now()): string | null => (timed && daysAway(ms, now) !== 0 ? fmt().time.format(ms) : null);

/**
 * Plan 222: what a clear What matters says, by the next moment ahead (`nextUp`): its time later today ("You're free until
 * 3:00 PM."), tomorrow, its weekday within 6 days ("until Thursday"), further its date ("until Dec 3"). An untimed item
 * today leaves the day as it was ("Nothing needs you today."); nothing ahead at all, "Nothing on the horizon."
 */
export function freeUntil(next: { at: number; timed: boolean } | "today" | null, now = Date.now()): string {
  if (next === null) return t("whatMatters.clear.nothingAhead");
  if (next === "today") return t("today.empty");
  const days = daysAway(next.at, now);
  if (days <= 0) return next.timed ? t("whatMatters.clear.untilTime", { time: fmt().time.format(next.at) }) : t("today.empty");
  if (days === 1) return t("whatMatters.clear.untilTomorrow");
  if (days < 7) return t("whatMatters.clear.untilDay", { day: fmt().weekdayLong.format(next.at) });
  return t("whatMatters.clear.untilDate", { date: dayOf(next.at, now) });
}
