import { localDay, type TodayGroupKind, type TodayItem } from "@terno/core";
import { getLocale, t } from "@terno/i18n";
import { datedDay, reminderTime } from "~/lib/when";

/**
 * Plan 204, the UI experiment: one plain sentence for a Today item, made here from what the backend said of it (its kind,
 * its words, its day, Missed or not): "Pay $187.42 for the electricity bill. It was due Wednesday.", "You said you'd call
 * Marcus at 4:00 PM today.", "Tomorrow at 7:40 AM: Flight to Madrid." No model is asked. The item's own words are never
 * rewritten, only placed in a frame that says what we know; with nothing to frame, its words alone.
 */

/** The item's words without a closing full stop (the frame adds one), nor stray space. */
const bare = (s: string): string => s.trim().replace(/[\s.;,:]+$/u, "");

/** A frame's full stop after a question or an exclamation is one mark too many. */
const tidy = (s: string): string => s.replace(/([!?…])\.$/u, "$1").replace(/\s{2,}/gu, " ");

/** A sentence of its own: a full stop unless it ends in one already. */
const ended = (s: string): string => (/[.!?…]$/u.test(s) ? s : `${s}.`);

/** "Today", "Monday at 9:00 AM": a sentence that starts with the day. */
const capital = (s: string): string => s.charAt(0).toLocaleUpperCase(getLocale()) + s.slice(1);

/**
 * A promise's words are what you'll do ("send Jess the deck"); one written as a sentence ("Send Jess the deck") goes after
 * "You said you'd" in lower case. Only a plain capitalised word: "RSVP", "iPhone" and a name in capitals stay as they are.
 */
const verbFirst = (s: string): string => (/^\p{Lu}\p{Ll}+\b/u.test(s) ? s.charAt(0).toLocaleLowerCase(getLocale()) + s.slice(1) : s);

/** An item whose words already end in its verb ("BLS certification expires") takes its day straight after them. */
const ENDS_EXPIRING: Record<string, RegExp> = { en: /\b(expires?|expiring)$/iu, es: /(vence|caduca|expira)$/iu };

/** When, inside a sentence: "today", "tomorrow at 7:40 AM", "Wednesday", "Nov 30" (es: "el miércoles", "el 30 nov"). */
export function whenWords(day: number, time: string | null, now = Date.now()): string {
  const d = datedDay(day, now);
  const when = d.near ? t(`whatMatters.when.${d.near}`) : t("whatMatters.when.on", { day: d.text });
  return time ? t("whatMatters.when.at", { when, time }) : when;
}

/** The sentence for a Today item, in the app's language. */
export function todaySentence(item: Pick<TodayItem, "thread" | "why" | "summary">, now = Date.now()): string {
  const { thread, why } = item;
  const subject = thread.subject?.trim() || t("common.noSubject");
  if (why.kind === "dated") {
    const text = bare(why.text ?? "");
    const it = why.item;
    if (!text) return ended(subject);
    if (!it) return ended(text);
    const dueAt = why.dueAt ?? 0;
    const day = localDay(it.dueDay)?.getTime() ?? dueAt;
    const when = it.dated ? whenWords(day, it.timed ? reminderTime(dueAt) : null, now) : null;
    // an alert is what the mail says happened, never a fact of ours (plan 204, the fourth round): it says whose word it is
    if (it.kind === "alert") {
      const says = t("dated.alertSays", { text });
      if (!when) return ended(says);
      return tidy(t(why.missed ? "whatMatters.say.alertWas" : "whatMatters.say.alertBy", { text: says, when }));
    }
    // an ask has no day of its own: its words are the sentence
    if (it.kind === "ask" || !when) return ended(text);
    if (it.kind === "event" || it.kind === "delivery") return tidy(t("whatMatters.say.plan", { when: capital(when), text }));
    if (why.missed) return tidy(t("whatMatters.say.wasDue", { text, when }));
    if (it.kind === "renew") return tidy(t("whatMatters.say.renews", { text, when }));
    if (it.kind === "expire") return tidy(t(ENDS_EXPIRING[getLocale()]?.test(text) ? "whatMatters.say.expiresTail" : "whatMatters.say.expires", { text, when }));
    return tidy(t("whatMatters.say.due", { text, when }));
  }
  if (why.kind === "promise") {
    const text = verbFirst(bare(why.text ?? ""));
    if (!text) return ended(subject);
    // only a promise that named a day says one (the list's rule, `dayKnown`)
    if (why.promise?.dated !== true || why.dueAt === undefined) return tidy(t("whatMatters.say.promise", { text }));
    const near = datedDay(why.dueAt, now).near;
    const when = whenWords(why.dueAt, null, now);
    if (why.missed) return tidy(t("whatMatters.say.promiseWas", { text, when }));
    // today and tomorrow need no "by" ("be there at 7:30 AM tomorrow"); the words may already hold the day ("send it
    // today"): it isn't said twice
    if (near === "today" || near === "tomorrow") return tidy(text.toLocaleLowerCase(getLocale()).includes(when) ? t("whatMatters.say.promise", { text }) : t("whatMatters.say.promiseNear", { text, when }));
    return tidy(t("whatMatters.say.promiseBy", { text, when }));
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

/** The chat's quiet line above a group: "3 things you missed", "1 plan ahead". */
export const groupLine = (kind: TodayGroupKind, count: number): string => t(`whatMatters.group.${kind}`, { count });
