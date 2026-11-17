import { datedGroup, localDay, type PartOfDay, type TodayHistoryItem, type TodayItem } from "@terno/core";
import { getLocale, t } from "@terno/i18n";
import { listDate } from "~/lib/format";
import { datedDay, dueShort, dueTimeLeft, partDay, partInSentence, pastDay, reminderTime } from "~/lib/when";
import type { FeedGroupKind } from "~/state/today";

/**
 * Plan 204, the UI experiment: a Today item said in one plain sentence, made here from what the backend said of it, no
 * model asked. The item's own words are never rewritten, only framed with what we know ("You said you'd call Marcus at
 * 4:00 PM PT.", "Payment declined for $142.67, the email says."). When it's due isn't in the sentence: the briefing's
 * column says it, in the list's own words (after the UI panel: a date read mid-sentence can't be scanned down a column).
 */

/** The item's words without a closing full stop (the frame adds one), nor stray space. */
const bare = (s: string): string => s.trim().replace(/[\s.;,:]+$/u, "");

/** A frame's full stop after a question or an exclamation is one mark too many. */
const tidy = (s: string): string => s.replace(/([!?…])\.$/u, "$1").replace(/\s{2,}/gu, " ");

/**
 * An alert's words with whose word they are (plan 204, the fourth round). Plan 210 (iteration 3): a text the app cut ends in
 * an ellipsis and never gains ", the email says" after it: its attribution comes first ("The email says: …").
 */
export const alertSays = (text: string): string => t(text.endsWith("…") ? "dated.alertSaysCut" : "dated.alertSays", { text });

/** A sentence of its own: a full stop unless it ends in one already. */
const ended = (s: string): string => (/[.!?…]$/u.test(s) ? s : `${s}.`);

/**
 * A promise's words are what you'll do ("send Jess the deck"); one written as a sentence ("Send Jess the deck") goes after
 * "You said you'd" in lower case. Only a plain capitalised word: "RSVP", "iPhone" and a name in capitals stay as they are.
 */
const verbFirst = (s: string): string => (/^\p{Lu}\p{Ll}+\b/u.test(s) ? s.charAt(0).toLocaleLowerCase(getLocale()) + s.slice(1) : s);

/**
 * Plan 210 (iteration 5, R9): your promise to come to an event, or bring someone, on that event's row in your words, as a
 * line rather than a sentence ("You said you'd bring Nina and the SE").
 */
export const attendsLine = (text: string): string => t("whatMatters.also.attends", { text: verbFirst(bare(text)) });

/** A promise of yours as its row says it: "You said you'd send Jess the deck." */
export const promiseSentence = (text: string): string => tidy(t("whatMatters.say.promise", { text: verbFirst(bare(text)) }));

/** The sentence for a Today item, in the app's language. */
export function todaySentence(item: Pick<TodayItem, "thread" | "why" | "summary">): string {
  const { thread, why } = item;
  const subject = thread.subject?.trim() || t("common.noSubject");
  if (why.kind === "dated") {
    const text = bare(why.text ?? "");
    if (!text) return ended(subject);
    // an alert is what the mail says happened, never a fact of ours (plan 204, the fourth round): it says whose word it is
    return ended(why.item?.kind === "alert" ? alertSays(text) : text);
  }
  if (why.kind === "promise") return bare(why.text ?? "") ? promiseSentence(why.text!) : ended(subject);
  if (why.kind === "reminder") return t("whatMatters.say.reminder", { subject });
  // waiting on you: the summary's first sentence where there's one, else who wrote and about what
  const summary = item.summary?.trim();
  if (summary) return ended(summary);
  return t(why.wrote ? "whatMatters.say.replied" : "whatMatters.say.wrote", { name: thread.fromName || thread.fromEmail, subject });
}

/**
 * How pressing an item is, for its weight: Missed, due or happening today (an alert with no day is a heads up now), on a
 * later day, or with no day of its own (an ask, a reply you owe, a promise that named none).
 */
export type TodayTone = "missed" | "today" | "later" | "none";

/**
 * The feed's right column (after the UI panel), in the list's own words: its short day ("Wed", "Tomorrow", "Nov 30")
 * and a timed item's time ("2:00 PM", "Mon 7:40 AM"); Missed's "Was due Wed"; for what has no date (plan 210, the owner:
 * it sits in Today), when it came, "since Wed", quietly; a reminder, its time. Its weight follows the item's group: Missed
 * and Today's dated tasks strong, what's undated in Today and its plans quiet; a day ahead, Ahead's (iteration 5: each its
 * own date) and Coming up's rows (`ahead`) quiet.
 */
export function todayWhen(item: Pick<TodayItem, "thread" | "why">, now = Date.now(), group?: FeedGroupKind, ahead = false): { text: string | null; tone: TodayTone } {
  const own = whenOf(item, now);
  const mail = item.why.kind === "dated" ? item.why.item?.mailDay : undefined;
  const when = own.text && mail ? { ...own, text: withMailDay(own.text, mail, now) } : own;
  // plan 210 (iteration 1): a plan or a delivery sits under the day's tasks, drawn as quietly as a day ahead's
  const plan = item.why.kind === "dated" && item.why.item !== undefined && datedGroup(item.why.item.kind) === "plans";
  // (a promise broken and given a new day keeps the late mark wherever it sits: plan 210, iteration 2)
  // (Today's "Waiting on you" is quiet: who's waiting, and by when, not what's due today: plan 210, iteration 3)
  const tone: TodayTone = when.tone === "missed" ? "missed" : ahead || group === "ahead" || group?.startsWith("day:") || group?.startsWith("week:") || (plan && group !== "missed") ? "later" : group === "missed" ? "missed" : group === "waiting" ? "none" : group === "today" ? (when.tone === "none" ? "none" : "today") : when.tone;
  return { text: when.text, tone };
}

/** Plan 210 (iteration 3): a promise's missed day, past for certain ("You said Tue 10 (missed)", "You said yesterday (missed)"). */
const missedDay = (day: number, now: number): string => (datedDay(day, now).near === "yesterday" ? t("whatMatters.saidMissedYesterday") : t("whatMatters.saidMissed", { day: pastDay(day, now) }));

/**
 * Plan 210 (iteration 4, revision 11): the day the mail asked for it before, said as the mail said it ("before Mon", never
 * the Sunday it sorts under), while that Sunday is still ahead; null on the day itself ("Today" says it plainly).
 */
function beforeWords(before: string | null | undefined, due: number, now: number): string | null {
  const day = before ? localDay(before)?.getTime() : undefined;
  if (day === undefined || datedDay(due, now).near === "today" || due <= now) return null;
  return datedDay(day, now).near === "tomorrow" ? t("whatMatters.beforeTomorrow") : t("whatMatters.before", { day: dueShort(day, false, now) });
}

/**
 * Plan 210 (iteration 4, revision 10): an event away from the reader, in the place's own time, as the mail gives it: "Mon
 * 4:00 PM Austin", "4:00 PM Austin" today. Its day is the place's (a late hour there can be tomorrow here).
 */
function travelWhen(travel: { day: string; time: string; place: string }, now: number): string {
  const day = localDay(travel.day)?.getTime() ?? now;
  const clock = wallClock(travel.time);
  const when = datedDay(day, now).near === "today" ? clock : `${dueShort(day, false, now)} ${clock}`;
  return t("whatMatters.travel", { when, place: travel.place });
}

/** A wall clock ("HH:MM") as the app writes times ("4:00 PM", "16:00"), whatever the reader's zone. */
const wallClock = (time: string): string => {
  const [h, m] = time.split(":").map(Number) as [number, number];
  return reminderTime(new Date(2000, 0, 1, h, m).getTime());
};

/**
 * Plan 210 (iteration 5, R1): a travel time in its place's clock, with the place ("4:00 PM Austin", es "16:00 en Austin"),
 * wherever a travel item's time is said (the reader's line too), so one item is never said on two clocks.
 */
export const placeClock = (travel: { time: string; place: string }): string => t("whatMatters.travel", { when: wallClock(travel.time), place: travel.place });

/** …and the day it's needed by, after what the column already says ("Wed · needed Fri", "… · needed today"); before a day, as the mail said it ("… · needed before Mon"). */
function needed(when: string, day: number, now: number, before?: string | null, part?: PartOfDay | null): string {
  const by = before ? localDay(before)?.getTime() : undefined;
  if (by !== undefined && datedDay(day, now).near !== "today" && day > now) return datedDay(by, now).near === "tomorrow" ? t("whatMatters.neededBeforeTomorrow", { when }) : t("whatMatters.neededBefore", { when, day: dueShort(by, false, now) });
  // plan 210 (iteration 5): the part of that day it's asked for ("… · needed Sat morning", "… · needed this morning")
  if (part) {
    const p = partDay(day, part, now);
    return p.near ? t("whatMatters.neededPart", { when, part: partInSentence(p.text) }) : t("whatMatters.needed", { when, day: p.text });
  }
  const near = datedDay(day, now).near;
  if (near === "today") return t("whatMatters.neededToday", { when });
  if (near === "tomorrow") return t("whatMatters.neededTomorrow", { when });
  return t("whatMatters.needed", { when, day: dueShort(day, false, now) });
}

/**
 * Round 17 (`CHANGED-DAY-READS-AS-DEADLINE`): a deadline moved with Change… says the mail's own day after the user's, as a
 * promise says the day it's needed ("Mon · due Tue", "Due Monday · due Tuesday", es "lun · vence el mar"); a day gone,
 * "was due Sun". The feed's column, the reader's line and the screen reader's words say it alike.
 */
export function withMailDay(when: string, mailDay: string | null | undefined, now: number): string {
  const day = mailDay ? localDay(mailDay)?.getTime() : undefined;
  if (day === undefined) return when;
  const near = datedDay(day, now).near;
  if (near === "today") return t("whatMatters.mailDueToday", { when });
  if (near === "tomorrow") return t("whatMatters.mailDueTomorrow", { when });
  if (near === "yesterday") return t("whatMatters.mailWasDueYesterday", { when });
  return day < now ? t("whatMatters.mailWasDue", { when, day: pastDay(day, now) }) : t("whatMatters.mailDue", { when, day: dueShort(day, false, now) });
}

/**
 * A promise's days beyond its own, from `promiseDay`'s facts, after its own day as the caller says it (`own`: the feed's
 * "Wed", the reader's "Due Wednesday"): a day it was given and missed first, in Missed's weight ("You said Tue 10 (missed) ·
 * needed Mon"), else the request's other day ("Wed · needed Fri"), else the day it's asked before ("before Mon"). The
 * feed's column and the reader's line say it alike (iteration 4, merge).
 */
export function promiseDayWords(p: { said?: number | null; needed?: number | null; neededBefore?: string | null; before?: string | null; neededPart?: PartOfDay | null }, dueAt: number, own: string, now: number): { text: string; missed: boolean } {
  // plan 210 (iteration 3, the owner): a day it was given and missed is said first, in Missed's weight, with the day it's
  // needed by, under that live day (never moved to Missed): "You said Tue 10 (missed) · needed Mon"
  if (p.said != null) return { text: needed(missedDay(p.said, now), p.needed ?? dueAt, now, p.neededBefore, p.neededPart), missed: true };
  // the request it answers needs it another day: "Wed · needed Fri"
  if (p.needed != null) return { text: needed(own, p.needed, now, p.neededBefore, p.neededPart), missed: false };
  // plan 210 (iteration 4): its day is the one before a day its person named: "before Mon"
  return { text: beforeWords(p.before, dueAt, now) ?? own, missed: false };
}

function whenOf(item: Pick<TodayItem, "thread" | "why">, now: number): { text: string | null; tone: TodayTone } {
  const { thread, why } = item;
  // plan 210 (iteration 2): one time per row, the reader's, and the mail's own in brackets when its zone isn't theirs
  const zoned = (text: string, note: string | null | undefined): string => (note ? t("whatMatters.zoned", { when: text, time: note }) : text);
  const was = (day: number): string => (datedDay(day, now).near === "yesterday" ? t("today.due.wasYesterday") : t("today.due.wasOn", { day: dueShort(day, false, now) }));
  const ahead = (day: number, at: number, timed: boolean, part?: PartOfDay | null): { text: string; tone: TodayTone } => {
    const tone = datedDay(day, now).near === "today" ? "today" : "later";
    // plan 210 (iteration 5, revision 4): a part of the day, never a clock ("This morning", "Tomorrow morning", "Fri morning")
    if (part && !timed) return { text: partDay(day, part, now).text, tone };
    const time = dueTimeLeft(at, timed, now);
    const short = dueShort(timed ? at : day, timed, now);
    return { text: time ? `${short} ${time}` : short, tone };
  };
  // plan 210 (iteration 5): missed after this morning's noon, the day still today: "Was due this morning"
  const wasPart = (day: number, part: PartOfDay | null | undefined): string | null => (part && datedDay(day, now).near === "today" ? t("today.due.wasPart", { when: partInSentence(partDay(day, part, now).text) }) : null);
  // mid-phrase, "Yesterday" is a word like any other: "since yesterday", "desde ayer". Round 15's second morning: since the
  // item's own moment (the ask's mail, your promise's), never the conversation's last message: your own holding reply or
  // their thanks made a Nov 8 ask "since yesterday"; a conversation waiting on you, since its last message
  const day = listDate((why.kind === "dated" ? why.came : why.kind === "promise" ? why.sentAt : undefined) ?? thread.lastDate, now);
  const came = { text: t("whatMatters.since", { day: day === t("date.yesterday") ? day.toLocaleLowerCase(getLocale()) : day }), tone: "none" as const };
  if (why.kind === "reminder" && why.dueAt !== undefined) return { text: dueShort(why.dueAt, true, now), tone: "none" };
  // round 15's second morning: put off with Later and drawn before then (Coming up open), when it's back ("back Mon 9:00 AM")
  if (why.back !== undefined) {
    const back = ahead(why.back, why.back, true).text;
    const tomorrow = t("today.when.tomorrow");
    return { text: t("whatMatters.back", { when: back.startsWith(tomorrow) ? tomorrow.toLocaleLowerCase(getLocale()) + back.slice(tomorrow.length) : back }), tone: "none" };
  }
  if (why.kind === "dated" && why.item) {
    const it = why.item;
    if (it.kind === "ask" || !it.dated) return came;
    const dueAt = why.dueAt ?? 0;
    const day = localDay(it.dueDay)?.getTime() ?? dueAt;
    if (why.missed) return { text: (!it.timed && wasPart(day, it.part)) || was(day), tone: "missed" };
    const at = ahead(day, dueAt, it.timed, it.part);
    // a person's request shown before its day (plan 210, iteration 2): what it's by, quietly, among the people; iteration 3:
    // with its time, and the mail's own in its zone when that isn't the reader's ("by Fri 5:00 PM (6:00 PM ET)")
    const before = beforeWords(it.before, day, now);
    if (it.early) {
      if (before) return { text: before, tone: "none" };
      // plan 210 (iteration 5): "by tomorrow morning", "by Sat morning" (es "para mañana por la mañana", "para el sáb por la mañana")
      const part = it.part && !it.timed ? partDay(day, it.part, now) : null;
      if (part) return { text: part.near ? t("whatMatters.byNear", { when: partInSentence(part.text) }) : t("whatMatters.by", { day: part.text }), tone: "none" };
      // mid-phrase, "Tomorrow" is a word like any other: "by tomorrow 5:00 PM"
      const tomorrow = t("today.when.tomorrow");
      const by = at.text.startsWith(tomorrow) ? tomorrow.toLocaleLowerCase(getLocale()) + at.text.slice(tomorrow.length) : at.text;
      return { text: t("whatMatters.by", { day: zoned(by, it.timed ? it.note : null) }), tone: "none" };
    }
    if (before) return { ...at, text: before };
    // plan 210 (iteration 4, revision 10): travel says the mail's clock at the place, the reader's own left to the reader
    if (it.timed && it.travel) return { ...at, text: travelWhen(it.travel, now) };
    return { ...at, text: zoned(at.text, it.timed ? it.note : null) };
  }
  if (why.kind === "promise") {
    const p = why.promise;
    if (p?.dated !== true || why.dueAt === undefined) return came;
    if (why.missed) return { text: (p.timed !== true && wasPart(why.dueAt, p.part)) || was(why.dueAt), tone: "missed" };
    const at = ahead(why.dueAt, why.dueAt, p.timed === true, p.part);
    const words = promiseDayWords(p, why.dueAt, zoned(at.text, p.timed ? p.note : null), now);
    return words.missed ? { text: words.text, tone: "missed" } : { ...at, text: words.text };
  }
  return came;
}

/**
 * Plan 210: a history line in the open part's words: an item's own ("Pay $187.42 for the electricity bill."), an alert's
 * with whose word it is, a promise of yours as "You said you'd …".
 */
export function historySentence(line: Pick<TodayHistoryItem, "kind" | "text" | "thread">): string {
  const text = bare(line.text);
  if (!text) return ended(line.thread.subject?.trim() || t("common.noSubject"));
  if (line.kind === "promise") return promiseSentence(text);
  return ended(line.kind === "alert" ? alertSays(text) : text);
}

/**
 * Plan 210: the history's right-hand column, what happened and when: "Done today", "Removed Wed", "Over Nov 2" (es "Hecho
 * el mié"). Iteration 4 (revision 7): settled by mail, the day that mail came ("Paid Mon", "Answered Tue"), never the day
 * it was read; a bill it settled is paid, a request your reply settled is answered. The claims ledger's second batch: a plan
 * its mail cancelled is cancelled, a parcel it said arrived arrived (`SettledHow`, its `reason`), never "Settled".
 */
export function historyWhen(line: Pick<TodayHistoryItem, "outcome" | "kind" | "key" | "on" | "reason" | "handedTo">, now = Date.now()): string {
  const at = line.on ?? line.key.at;
  const near = datedDay(at, now).near;
  const day = near ? t(`today.also.${near}`) : t("today.also.on", { day: dueShort(at, false, now) });
  // plan 210 (iteration 4): handed on, to whom ("Handed to Jess Tue"), by first name as the reader's line says people
  if (line.outcome === "handed") return line.handedTo ? t("whatMatters.history.handed", { name: firstName(line.handedTo), day }) : t("whatMatters.history.done", { day });
  const settled = line.outcome !== "settled" ? null : line.reason === "answered" || line.reason === "cancelled" || line.reason === "arrived" ? line.reason : line.kind === "pay" ? "paid" : "settled";
  // plan 210 (iteration 1, the owner): "Not a task" is "Remove", for an item and a promise alike
  return t(`whatMatters.history.${settled ?? (line.outcome === "dismissed" ? "removed" : line.outcome)}`, { day });
}

/** A person by their first name, else their address's local part. */
const firstName = (p: { name: string; email: string }): string => p.name.trim().split(/\s+/)[0] || p.email.split("@")[0] || p.email;

