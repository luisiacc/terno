import { getLocale, t } from "@terno/i18n";

/** Plan 87's moments in words (plan 89's scheduled sends say theirs the same way); no imports of the app. */

const DAY = 86_400_000;
const formats = new Map<string, { time: Intl.DateTimeFormat; weekday: Intl.DateTimeFormat; day: Intl.DateTimeFormat; year: Intl.DateTimeFormat }>();
function fmt() {
  const id = getLocale();
  let f = formats.get(id);
  if (!f) {
    const tag = id === "en" ? "en-US" : id;
    const time: Intl.DateTimeFormatOptions = id === "en" ? { hour: "numeric", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" };
    f = {
      time: new Intl.DateTimeFormat(tag, time),
      weekday: new Intl.DateTimeFormat(tag, { weekday: "short" }),
      day: new Intl.DateTimeFormat(tag, { day: "numeric", month: "short" }),
      year: new Intl.DateTimeFormat(tag, { day: "numeric", month: "short", year: "numeric" }),
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
