import type { ReminderKind } from "./types";

/**
 * Plan 87: the moments a reminder offers, in local time. "Remind me": later
 * today (3 hours on, on the hour; until 6 pm), tomorrow at 9, the weekend
 * (Saturday at 9, Monday to Thursday) and next week (Monday at 9). "If they
 * don't answer": in 1, 3, 7 and 14 days, at the next whole hour. Built with
 * setDate/setHours, so a day across a DST change keeps its local time.
 */
export type RemindPresetId = "laterToday" | "tomorrow" | "weekend" | "nextWeek" | "in1d" | "in3d" | "in1w" | "in2w";

export interface RemindPreset {
  id: RemindPresetId;
  at: number;
}

/** the morning presets' hour */
export const REMIND_MORNING = 9;
/** "Later today" stops being offered at this hour */
const LATER_TODAY_UNTIL = 18;

function at(base: Date, days: number, hour: number): number {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

/** `now` rounded up to the next whole hour (a whole hour stays) */
function nextHour(now: Date, plusHours = 0): Date {
  const d = new Date(now);
  d.setHours(d.getHours() + plusHours);
  if (d.getMinutes() || d.getSeconds() || d.getMilliseconds()) d.setHours(d.getHours() + 1, 0, 0, 0);
  return d;
}

export function remindPresets(now: Date, kind: ReminderKind): RemindPreset[] {
  if (kind === "noReply") {
    const base = nextHour(now);
    return ([["in1d", 1], ["in3d", 3], ["in1w", 7], ["in2w", 14]] as const).map(([id, days]) => ({ id, at: at(base, days, base.getHours()) }));
  }
  const out: RemindPreset[] = [];
  if (now.getHours() < LATER_TODAY_UNTIL) out.push({ id: "laterToday", at: nextHour(now, 3).getTime() });
  const tomorrow = at(now, 1, REMIND_MORNING);
  out.push({ id: "tomorrow", at: tomorrow });
  const day = now.getDay();
  // Monday to Thursday: the coming Saturday
  if (day >= 1 && day <= 4) out.push({ id: "weekend", at: at(now, 6 - day, REMIND_MORNING) });
  // the coming Monday (on a Sunday that's tomorrow: offered once)
  const monday = at(now, ((8 - day) % 7) || 7, REMIND_MORNING);
  if (monday !== tomorrow) out.push({ id: "nextWeek", at: monday });
  return out;
}

/** The custom picker's first value: tomorrow at 9. */
export function defaultRemindAt(now: Date): number {
  return at(now, 1, REMIND_MORNING);
}
