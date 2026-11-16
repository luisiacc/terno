import { datedGroup, localDay, type TodayHistoryItem, type TodayItem } from "@terno/core";
import { getLocale, t } from "@terno/i18n";
import { listDate } from "~/lib/format";
import { datedDay, dueShort, dueTimeLeft, pastDay } from "~/lib/when";
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
  if (why.kind === "promise") {
    const text = verbFirst(bare(why.text ?? ""));
    return text ? tidy(t("whatMatters.say.promise", { text })) : ended(subject);
  }
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
 * and Today's dated tasks strong, what's undated in Today and its plans quiet; a day ahead and Coming up's rows (`ahead`) quiet.
 */
export function todayWhen(item: Pick<TodayItem, "thread" | "why">, now = Date.now(), group?: FeedGroupKind, ahead = false): { text: string | null; tone: TodayTone } {
  const when = whenOf(item, now);
  // plan 210 (iteration 1): a plan or a delivery sits under the day's tasks, drawn as quietly as a day ahead's
  const plan = item.why.kind === "dated" && item.why.item !== undefined && datedGroup(item.why.item.kind) === "plans";
  // (a promise broken and given a new day keeps the late mark wherever it sits: plan 210, iteration 2)
  // (Today's "Waiting on you" is quiet: who's waiting, and by when, not what's due today: plan 210, iteration 3)
  const tone: TodayTone = when.tone === "missed" ? "missed" : ahead || group?.startsWith("day:") || group?.startsWith("week:") || (plan && group !== "missed") ? "later" : group === "missed" ? "missed" : group === "waiting" ? "none" : group === "today" ? (when.tone === "none" ? "none" : "today") : when.tone;
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

/** …and the day it's needed by, after what the column already says ("Wed · needed Fri", "… · needed today"); before a day, as the mail said it ("… · needed before Mon"). */
function needed(when: string, day: number, now: number, before?: string | null): string {
  const by = before ? localDay(before)?.getTime() : undefined;
  if (by !== undefined && datedDay(day, now).near !== "today" && day > now) return datedDay(by, now).near === "tomorrow" ? t("whatMatters.neededBeforeTomorrow", { when }) : t("whatMatters.neededBefore", { when, day: dueShort(by, false, now) });
  const near = datedDay(day, now).near;
  if (near === "today") return t("whatMatters.neededToday", { when });
  if (near === "tomorrow") return t("whatMatters.neededTomorrow", { when });
  return t("whatMatters.needed", { when, day: dueShort(day, false, now) });
}

function whenOf(item: Pick<TodayItem, "thread" | "why">, now: number): { text: string | null; tone: TodayTone } {
  const { thread, why } = item;
  // plan 210 (iteration 2): one time per row, the reader's, and the mail's own in brackets when its zone isn't theirs
  const zoned = (text: string, note: string | null | undefined): string => (note ? t("whatMatters.zoned", { when: text, time: note }) : text);
  const was = (day: number): string => (datedDay(day, now).near === "yesterday" ? t("today.due.wasYesterday") : t("today.due.wasOn", { day: dueShort(day, false, now) }));
  const ahead = (day: number, at: number, timed: boolean): { text: string; tone: TodayTone } => {
    const time = dueTimeLeft(at, timed, now);
    const short = dueShort(timed ? at : day, timed, now);
    return { text: time ? `${short} ${time}` : short, tone: datedDay(day, now).near === "today" ? "today" : "later" };
  };
  // mid-phrase, "Yesterday" is a word like any other: "since yesterday", "desde ayer"
  const day = listDate(thread.lastDate, now);
  const came = { text: t("whatMatters.since", { day: day === t("date.yesterday") ? day.toLocaleLowerCase(getLocale()) : day }), tone: "none" as const };
  if (why.kind === "reminder" && why.dueAt !== undefined) return { text: dueShort(why.dueAt, true, now), tone: "none" };
  if (why.kind === "dated" && why.item) {
    const it = why.item;
    if (it.kind === "ask" || !it.dated) return came;
    const dueAt = why.dueAt ?? 0;
    const day = localDay(it.dueDay)?.getTime() ?? dueAt;
    if (why.missed) return { text: was(day), tone: "missed" };
    const at = ahead(day, dueAt, it.timed);
    // a person's request shown before its day (plan 210, iteration 2): what it's by, quietly, among the people; iteration 3:
    // with its time, and the mail's own in its zone when that isn't the reader's ("by Fri 5:00 PM (6:00 PM ET)")
    const before = beforeWords(it.before, day, now);
    if (it.early) {
      if (before) return { text: before, tone: "none" };
      // mid-phrase, "Tomorrow" is a word like any other: "by tomorrow 5:00 PM"
      const tomorrow = t("today.when.tomorrow");
      const by = at.text.startsWith(tomorrow) ? tomorrow.toLocaleLowerCase(getLocale()) + at.text.slice(tomorrow.length) : at.text;
      return { text: t("whatMatters.by", { day: zoned(by, it.timed ? it.note : null) }), tone: "none" };
    }
    if (before) return { ...at, text: before };
    return { ...at, text: zoned(at.text, it.timed ? it.note : null) };
  }
  if (why.kind === "promise") {
    const p = why.promise;
    if (p?.dated !== true || why.dueAt === undefined) return came;
    if (why.missed) return { text: was(why.dueAt), tone: "missed" };
    const at = ahead(why.dueAt, why.dueAt, p.timed === true);
    const text = zoned(at.text, p.timed ? p.note : null);
    // plan 210 (iteration 3, the owner): a day it was given and missed is said first, in Missed's weight, with the day it's
    // needed by, under that live day (never moved to Missed): "You said Tue 10 (missed) · needed Mon"
    if (p.said != null) return { text: needed(missedDay(p.said, now), p.needed ?? why.dueAt, now, p.neededBefore), tone: "missed" };
    // the request it answers needs it another day: "Wed · needed Fri"
    if (p.needed != null) return { ...at, text: needed(text, p.needed, now, p.neededBefore) };
    // plan 210 (iteration 4): its day is the one before a day its person named: "before Mon"
    return { ...at, text: beforeWords(p.before, why.dueAt, now) ?? text };
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
  if (line.kind === "promise") return tidy(t("whatMatters.say.promise", { text: verbFirst(text) }));
  return ended(line.kind === "alert" ? alertSays(text) : text);
}

/**
 * Plan 210: the history's right-hand column, what happened and when: "Done today", "Removed Wed", "Over Nov 2" (es "Hecho
 * el mié"). Iteration 4 (revision 7): settled by mail, the day that mail came ("Paid Mon", "Answered Tue"), never the day
 * it was read; a bill it settled is paid, a request your reply settled is answered.
 */
export function historyWhen(line: Pick<TodayHistoryItem, "outcome" | "kind" | "key" | "on" | "reason" | "handedTo">, now = Date.now()): string {
  const at = line.on ?? line.key.at;
  const near = datedDay(at, now).near;
  const day = near ? t(`today.also.${near}`) : t("today.also.on", { day: dueShort(at, false, now) });
  // plan 210 (iteration 4): handed on, to whom ("Handed to Jess Tue"), by first name as the reader's line says people
  if (line.outcome === "handed") return line.handedTo ? t("whatMatters.history.handed", { name: firstName(line.handedTo), day }) : t("whatMatters.history.done", { day });
  const settled = line.outcome !== "settled" ? null : line.reason === "answered" ? "answered" : line.kind === "pay" ? "paid" : "settled";
  // plan 210 (iteration 1, the owner): "Not a task" is "Remove", for an item and a promise alike
  return t(`whatMatters.history.${settled ?? (line.outcome === "dismissed" ? "removed" : line.outcome)}`, { day });
}

/** A person by their first name, else their address's local part. */
const firstName = (p: { name: string; email: string }): string => p.name.trim().split(/\s+/)[0] || p.email.split("@")[0] || p.email;

