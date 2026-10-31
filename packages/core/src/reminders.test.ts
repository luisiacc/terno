import { describe, expect, it } from "vitest";
import { defaultRemindAt, remindPresets } from "./reminders";

// local time throughout (the presets are the user's clock); vitest runs with TZ from the environment
const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min);
const show = (ms: number) => {
  const d = new Date(ms);
  return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const presets = (now: Date, kind: "always" | "noReply" = "always") => remindPresets(now, kind).map((p) => `${p.id} ${show(p.at)}`);

describe("remindPresets (plan 87)", () => {
  it("a Tuesday morning: later today, tomorrow, the weekend, next week", () => {
    expect(presets(local(2026, 11, 3, 8, 10))).toEqual(["laterToday Tue 11/3 12:00", "tomorrow Wed 11/4 9:00", "weekend Sat 11/7 9:00", "nextWeek Mon 11/9 9:00"]);
  });

  it("on the hour stays on the hour; from 6 pm there is no later today", () => {
    expect(presets(local(2026, 11, 3, 14))[0]).toBe("laterToday Tue 11/3 17:00");
    expect(presets(local(2026, 11, 3, 17, 59))[0]).toBe("laterToday Tue 11/3 21:00");
    expect(presets(local(2026, 11, 3, 18))[0]).toBe("tomorrow Wed 11/4 9:00");
    expect(presets(local(2026, 11, 3, 23, 30)).map((p) => p.split(" ")[0])).toEqual(["tomorrow", "weekend", "nextWeek"]);
  });

  it("every weekday: the weekend Monday to Thursday, next week always (once on a Sunday)", () => {
    const ids = (d: number) => presets(local(2026, 11, d, 19)).map((p) => p.split(" ")[0]);
    // Nov 2 2026 is a Monday
    expect(ids(2)).toEqual(["tomorrow", "weekend", "nextWeek"]);
    expect(ids(5)).toEqual(["tomorrow", "weekend", "nextWeek"]);
    expect(ids(6)).toEqual(["tomorrow", "nextWeek"]);
    expect(ids(7)).toEqual(["tomorrow", "nextWeek"]);
    expect(presets(local(2026, 11, 8, 19))).toEqual(["tomorrow Mon 11/9 9:00"]);
    expect(presets(local(2026, 11, 6, 19))).toEqual(["tomorrow Sat 11/7 9:00", "nextWeek Mon 11/9 9:00"]);
  });

  it("if they don't answer: 1, 3, 7 and 14 days on, at the next whole hour", () => {
    expect(presets(local(2026, 11, 3, 8, 10), "noReply")).toEqual(["in1d Wed 11/4 9:00", "in3d Fri 11/6 9:00", "in1w Tue 11/10 9:00", "in2w Tue 11/17 9:00"]);
    expect(presets(local(2026, 12, 31, 23, 30), "noReply")[0]).toBe("in1d Sat 1/2 0:00");
  });

  it("days across a DST change keep their local hour", () => {
    // whatever the zone, setDate keeps 9:00 (US DST ends Nov 1 2026, EU Oct 25)
    expect(presets(local(2026, 10, 24, 20))).toEqual(["tomorrow Sun 10/25 9:00", "nextWeek Mon 10/26 9:00"]);
    expect(presets(local(2026, 10, 31, 20), "noReply")[0]).toBe("in1d Sun 11/1 20:00");
  });

  it("the custom picker starts at tomorrow 9:00", () => {
    expect(show(defaultRemindAt(local(2026, 11, 3, 22)))).toBe("Wed 11/4 9:00");
  });
});
