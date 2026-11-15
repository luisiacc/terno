import { localDay, type TodayGroupKind, type TodayItem } from "@terno/core";
import { getLocale, t } from "@terno/i18n";
import { listDate } from "~/lib/format";
import { datedDay, dueShort, dueTimeLeft } from "~/lib/when";

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

/** A sentence of its own: a full stop unless it ends in one already. */
const ended = (s: string): string => (/[.!?…]$/u.test(s) ? s : `${s}.`);

/**
 * A promise's words are what you'll do ("send Jess the deck"); one written as a sentence ("Send Jess the deck") goes after
 * "You said you'd" in lower case. Only a plain capitalised word: "RSVP", "iPhone" and a name in capitals stay as they are.
 */
const verbFirst = (s: string): string => (/^\p{Lu}\p{Ll}+\b/u.test(s) ? s.charAt(0).toLocaleLowerCase(getLocale()) + s.slice(1) : s);

/** The sentence for a Today item, in the app's language. */
export function todaySentence(item: Pick<TodayItem, "thread" | "why" | "summary">, now = Date.now()): string {
  const { thread, why } = item;
  const subject = thread.subject?.trim() || t("common.noSubject");
  if (why.kind === "dated") {
    const text = bare(why.text ?? "");
    if (!text) return ended(subject);
    // an alert is what the mail says happened, never a fact of ours (plan 204, the fourth round): it says whose word it is
    return ended(why.item?.kind === "alert" ? t("dated.alertSays", { text }) : text);
  }
  if (why.kind === "promise") {
    const text = verbFirst(bare(why.text ?? ""));
    return text ? tidy(t("whatMatters.say.promise", { text })) : ended(subject);
  }
  if (why.kind === "nudge") {
    const name = why.personName || thread.fromName;
    return ended(t("today.why.nudge", { name, count: Math.max(1, Math.floor((now - (why.sentAt ?? now)) / 86_400_000)) }));
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
 * The briefing's right column (after the UI panel), in the list's own words: its short day ("Wed", "Tomorrow", "Nov 30")
 * and a timed item's time ("2:00 PM", "Mon 7:40 AM"); Missed's "Was due Wed"; nothing for an alert that named no day;
 * for what has no day of its own, the day it came, which the column shows quietly.
 */
export function todayWhen(item: Pick<TodayItem, "thread" | "why">, now = Date.now()): { text: string | null; tone: TodayTone } {
  const { thread, why } = item;
  const was = (day: number): string => (datedDay(day, now).near === "yesterday" ? t("today.due.wasYesterday") : t("today.due.wasOn", { day: dueShort(day, false, now) }));
  const ahead = (day: number, at: number, timed: boolean): { text: string; tone: TodayTone } => {
    const time = dueTimeLeft(at, timed, now);
    const short = dueShort(timed ? at : day, timed, now);
    return { text: time ? `${short} ${time}` : short, tone: datedDay(day, now).near === "today" ? "today" : "later" };
  };
  const came = { text: listDate(thread.lastDate, now), tone: "none" as const };
  if (why.kind === "dated" && why.item) {
    const it = why.item;
    if (it.kind === "ask") return came;
    if (!it.dated) return { text: null, tone: it.kind === "alert" ? "today" : "none" };
    const dueAt = why.dueAt ?? 0;
    const day = localDay(it.dueDay)?.getTime() ?? dueAt;
    if (why.missed) return { text: was(day), tone: "missed" };
    return ahead(day, dueAt, it.timed);
  }
  if (why.kind === "promise") {
    if (why.promise?.dated !== true || why.dueAt === undefined) return { text: null, tone: "none" };
    if (why.missed) return { text: was(why.dueAt), tone: "missed" };
    return ahead(why.dueAt, why.dueAt, false);
  }
  return came;
}

/** The chat's quiet line above a group: "3 things you missed", "1 plan ahead". */
export const groupLine = (kind: TodayGroupKind, count: number): string => t(`whatMatters.group.${kind}`, { count });
