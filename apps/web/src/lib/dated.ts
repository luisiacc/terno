import { datedGroup, defaultRemindAt, laterBefore, localDay, remindPresets, type DatedKind, type DatedRow, type RemindPreset, type TodayWhy } from "@terno/core";
import { getLocale, t } from "@terno/i18n";
import { useEffect, useState } from "react";
import { usd } from "~/lib/ai";
import type { LeftRows } from "~/lib/actions";
import { registerUndo, snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { datedDay, dueShort, reminderTime } from "~/lib/when";

/** Plan 204: a dated item as Today's row carries it, what Done and Later act on. */
export type DatedRef = NonNullable<TodayWhy["item"]>;

/** What a line says of an item: its own words, its kind and its day. */
export interface DatedFacts {
  kind: DatedKind;
  dueDay: string;
  dueAt: number;
  timed: boolean;
  /** false: an alert that named no day, or an ask (it has none): each reads as its words alone */
  dated: boolean;
  text: string;
}

const capital = (s: string): string => s.charAt(0).toLocaleUpperCase(getLocale()) + s.slice(1);

const dayOf = (o: Pick<DatedFacts, "dueDay" | "dueAt">): number => localDay(o.dueDay)?.getTime() ?? o.dueAt;

/**
 * "Was due Tuesday": a Missed day in words, an item's or a dated promise's. A timed one keeps its time (Codex code review of
 * the fixes): "Was due yesterday 1:00 PM".
 */
function wasDue(day: number, now: number, time: string | null): string {
  const d = datedDay(day, now);
  if (d.near === "yesterday") return time ? t("today.due.wasYesterdayAt", { time }) : t("today.due.wasYesterday");
  return time ? t("today.due.wasOnAt", { day: d.text, time }) : t("today.due.wasOn", { day: d.text });
}

/** "Due Friday", "Due today 1:00 PM" (after the panel: any timed item says its time, not only a Plan). */
function dueOn(day: number, time: string | null, now: number): string {
  const d = datedDay(day, now);
  if (d.near === "today") return time ? t("today.due.todayAt", { time }) : t("today.due.today");
  if (d.near === "tomorrow") return time ? t("today.due.tomorrowAt", { time }) : t("today.due.tomorrow");
  return time ? t("today.due.onAt", { day: d.text, time }) : t("today.due.on", { day: d.text });
}

/**
 * An item's words as they're shown: an alert is what the mail says happened, never a fact of ours, so it says whose word
 * it is ("Debit card frozen after a $412.18 charge, the email says"); the app adds it, after the model's words are cut
 * (the Codex code review of the fourth round: a cut lost the model's own). Every place an item's words show goes through it.
 */
export const datedText = (o: { kind: DatedKind; text: string }): string => (o.kind === "alert" && o.text ? t("dated.alertSays", { text: o.text }) : o.text);

/** A line: when, then the task ("Due Friday · Pay the electricity bill"); with no day, the task alone. */
const line = (when: string | null, text: string): string => (when ? t("today.why.line", { when, text }) : text);

/**
 * When an item is, in words: "Due Friday", "Due today 1:00 PM" (after the panel: any item with a time says it), "Tomorrow
 * 7:40" (a Plan), "Was due Tuesday" (Missed); null for an alert that named no day, and for an ask (the third panel round:
 * a person's question, never due, its row's date the day it came). A Today row's screen reader hears it after the task, the
 * right column (its short form) being hidden from it (after the second panel round).
 */
export function datedWhen(o: Omit<DatedFacts, "text">, missed: boolean, now = Date.now()): string | null {
  if (o.kind === "ask" || !o.dated) return null;
  const time = o.timed ? reminderTime(o.dueAt) : null;
  if (missed) return wasDue(dayOf(o), now, time);
  if (datedGroup(o.kind) === "plans") {
    const d = datedDay(dayOf(o), now);
    const when = d.near === "today" ? t("today.when.today") : d.near === "tomorrow" ? t("today.when.tomorrow") : capital(d.text);
    return time ? `${when} ${time}` : when;
  }
  return dueOn(dayOf(o), time, now);
}

/**
 * Plan 204 §8: an item's full line, as the conversation shows it: "Due Friday · Pay the electricity bill", "Tomorrow 7:40 ·
 * Flight to Madrid", "Was due Tuesday · Renew the domain"; an alert that named no day, its words alone. (A Today row says
 * the task alone, its day in the right column: after the second panel round.)
 */
export const datedLine = (o: DatedFacts, missed: boolean, now = Date.now()): string => line(datedWhen(o, missed, now), datedText(o));

/** When a promise of yours is due, in words ("Due today", "Was due Tuesday"); null for one that named no day. */
export function promiseWhen(o: { dueAt?: number; dated: boolean }, missed: boolean, now = Date.now()): string | null {
  if (!o.dueAt || !o.dated) return null;
  return missed ? wasDue(o.dueAt, now, null) : dueOn(o.dueAt, null, now);
}

/**
 * Plan 204 (after the panel, fix 8): a promise of yours, in your words: "Due today · You said: send the agenda", "Was due
 * Tuesday · You said: …"; one that named no day, "You said: …".
 */
export const promiseLine = (o: { text: string; dueAt?: number; dated: boolean }, missed: boolean, now = Date.now()): string => line(promiseWhen(o, missed, now), t("today.why.promise", { text: o.text }));

/**
 * Plan 204 (after the panel): what a Today row's Done, Not a task, Later and D act on: its dated item, or the promise of
 * yours it shows (`why.promise`, exactly: never the thread's most urgent). `when` is the right column's due day, `due`
 * the same in words for a screen reader (that column is hidden from it; after the second panel round); `dueAt`, what
 * Later's window is read from (`laterWindow`); a promise's `dated`, whether it names a day. The fourth panel round: a
 * promise's `noDay` (one that names none: its row's date stays empty, never the mail's) and `person` (whom you made it
 * to: the row's name and picture, the conversation's last sender being you). `text`, the task's words as the row showed
 * them, what its Undo names (null for a nudge: it has none of its own).
 */
export type TodayTask =
  | { kind: "dated"; item: DatedRef; when: string | null; due: string | null; dueAt: number; noDay?: boolean; text?: string | null }
  | { kind: "promise"; id: number; revision: number; when: string | null; due: string | null; dated?: boolean; noDay?: boolean; person?: TaskPerson; text?: string | null };
// a nudge (no reply to your mail) acts as a promise does: through follow-ups' act on the row it shows (Codex code review)

/** Who a promise or a nudge is with, as its row names and pictures them; no address, initials alone. */
export interface TaskPerson {
  name: string;
  email: string;
}

/** What a Today row shows of its task: when (or explicitly no day), and whose it is. */
export type TodayRowTask = { when: string | null; due: string | null; noDay?: boolean; person?: TaskPerson };

/** The fourth panel round (revision 9): the person a promise or nudge is with; with no name, their address's local part. */
function personOf(why: TodayWhy): TaskPerson | undefined {
  const email = why.personEmail?.trim() ?? "";
  const name = why.personName?.trim() || email.split("@")[0];
  return name ? { name, email } : undefined;
}

/** A Today row's task, from what the backend said of it: a dated item, a promise or a nudge; a waiting row or a reminder has none. */
export function taskOf(why: TodayWhy, now = Date.now()): TodayTask | null {
  if (why.kind === "dated" && why.item) {
    const item = why.item;
    const dueAt = why.dueAt ?? 0;
    // a Missed item says its day; one still ahead, its time today
    const timed = item.timed && !why.missed;
    const when = item.dated ? dueShort(timed ? dueAt : (localDay(item.dueDay)?.getTime() ?? dueAt), timed, now) : null;
    // the fifth panel round (change 3): an alert that named no day says none, as a promise with none doesn't (its made-up
    // day only says when it's Missed); an ask keeps the day it came
    const noDay = item.kind === "alert" && !item.dated;
    return { kind: "dated", item, when, due: datedWhen({ ...item, dueAt }, why.missed === true, now), dueAt, text: why.text ?? null, ...(noDay ? { noDay } : {}) };
  }
  if ((why.kind === "promise" || why.kind === "nudge") && why.promise) {
    const dated = why.kind === "promise" && why.promise.dated === true && why.dueAt !== undefined;
    const person = personOf(why);
    return {
      kind: "promise",
      id: why.promise.id,
      revision: why.promise.revision,
      when: dated ? dueShort(why.dueAt!, false, now) : null,
      due: dated ? promiseWhen({ dueAt: why.dueAt, dated }, why.missed === true, now) : null,
      dated,
      text: why.kind === "promise" ? (why.text ?? null) : null,
      // a promise with no day says none (the fourth panel round): the mail's date beside it would read as one
      ...(why.kind === "promise" && !dated ? { noDay: true } : {}),
      ...(person ? { person } : {}),
    };
  }
  return null;
}

/**
 * Where Later may go now (the third panel round): before `before` (a timed item still ahead: its own moment, `limit` "due"
 * or "starts"; a Plan: its end, "ends"). One rule for the row's menu, the conversation's line, the picker and the
 * backend's check (`laterBefore`). A promise of yours may go anywhere ahead: its Later is its own (the fifth panel round).
 */
export interface LaterWindow {
  before: number | null;
  limit: "due" | "starts" | "ends" | null;
}

/** A dated item's window: a Missed one, or one whose moment has passed, may go anywhere ahead. */
export function itemLaterWindow(item: Pick<DatedRow, "kind" | "dueDay" | "dueAt" | "timed">, now = Date.now()): LaterWindow {
  const before = laterBefore(item, now);
  const limit = before === null ? null : item.timed && item.dueAt > now ? (datedGroup(item.kind) === "plans" ? "starts" : "due") : "ends";
  return { before, limit };
}

export function laterWindow(task: TodayTask, now = Date.now()): LaterWindow {
  if (task.kind === "dated") return itemLaterWindow({ ...task.item, dueAt: task.dueAt }, now);
  return { before: null, limit: null };
}

/** Plan 204 (after the panel, fix 10; the third panel round): Later's choices now, the reminder's presets in its window. */
export function laterPresets(w: LaterWindow, now = Date.now()): RemindPreset[] {
  return remindPresets(new Date(now), "always").filter((p) => w.before === null || p.at < w.before);
}

export const laterChoices = (task: TodayTask, now = Date.now()): RemindPreset[] => laterPresets(laterWindow(task, now), now);

/** Why the picker's moment can't be set: too late for the item ("before it's due"). */
export const laterNote = (w: LaterWindow): { late: string } => ({ late: t(w.limit === "due" ? "dated.laterBeforeDue" : w.limit === "starts" ? "dated.laterBeforeStart" : "dated.laterPastEnd") });

const HOUR = 3_600_000;

/** Where the picker starts: the reminder picker's (tomorrow at 9), or, when that's past the window's end, an hour before it. */
export function laterStart(w: LaterWindow, now = Date.now()): number {
  const start = defaultRemindAt(new Date(now));
  if (w.before === null || start < w.before) return start;
  const minute = 60_000;
  return Math.ceil(Math.max(now + 15 * minute, w.before - HOUR) / minute) * minute;
}

const SAID = { done: "dated.snack.done", dismiss: "dated.snack.dismissed", later: "dated.snack.later" } as const;
const SAID_ITEM = { done: "dated.snack.doneItem", dismiss: "dated.snack.dismissedItem", later: "dated.snack.laterItem" } as const;
/** A task's words in the snack, at most: one line beside its Undo (the snack ellipsizes what's left over too) */
const SAID_MAX = 60;

/** A long task cut at a word, if one is near the end, with an ellipsis. */
function shortened(text: string): string {
  if (text.length <= SAID_MAX) return text;
  const cut = text.slice(0, SAID_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space >= SAID_MAX - 16 ? cut.slice(0, space) : cut).trimEnd().replace(/[,;:·-]$/, "")}…`;
}

/**
 * The fourth panel round (change 9, revision 11): what the snack says of Done, Not a task and Later, naming the task so
 * its Undo says what it undoes: "Done: Pay $187.42 for the utility bill", "Not a task: …", "Later: …". One formatter for
 * the row's menu, D, the palette, the conversation's line and the promise card. The words are the task's as it was acted
 * on (a reload can't name what replaced it); with none (a nudge), the plain "Marked done".
 */
export function taskSaid(action: "done" | "dismiss" | "later", text: string | null | undefined): string {
  const words = text?.trim();
  return words ? t(SAID_ITEM[action], { text: shortened(words) }) : t(SAID[action]);
}

/**
 * Done, Not a task and Later (plan 204 §5, after the panel), each with Undo that puts the exact item back, as follow-ups'
 * act. Today reloads on the backend's `todayChanged`. `left`: the Today row it took out of the list (after the second
 * panel round), which its Undo puts back selected, and a failure brings back.
 */
export async function actOnDated(item: Pick<DatedRef, "id" | "revision"> & { text?: string | null }, action: "done" | "dismiss" | "later", until?: number, left?: LeftRows): Promise<void> {
  // its words now, before the act's reload replaces them
  const text = item.text;
  try {
    const { undoId } = await client.call("dated.act", { id: item.id, revision: item.revision, action, ...(until !== undefined ? { until } : {}) });
    said(action, text, undoId === null ? null : () => client.call("dated.undo", { undoId }).then(() => undefined), "dated.undo", left);
  } catch (error) {
    left?.failed();
    snack.error((error as { message?: string }).message ?? t("dated.actFailed"));
  }
}

/** The same three on a Today row's task: a promise through follow-ups' act (its revision, its Undo), in Today's words. */
export async function actOnTask(task: TodayTask, action: "done" | "dismiss" | "later", at?: number, left?: LeftRows): Promise<void> {
  if (task.kind === "dated") return actOnDated({ ...task.item, text: task.text }, action, at, left);
  try {
    const { undoId } = await client.call("followups.act", { id: task.id, revision: task.revision, action, ...(at !== undefined ? { dueAt: at } : {}) });
    said(action, task.text, undoId === null ? null : () => client.call("followups.undo", { undoId }).then(() => undefined), "followup.undo", left);
  } catch (error) {
    left?.failed();
    snack.error((error as { message?: string }).message ?? t("followup.actFailed"));
  }
}

/** The snack, naming the task, with Undo when there's one (the row it took out back with it). */
function said(action: "done" | "dismiss" | "later", text: string | null | undefined, run: (() => Promise<void>) | null, name: "dated.undo" | "followup.undo", left?: LeftRows): void {
  const undo = run && registerUndo(() => (left ? left.undo(run) : run()));
  snack.success(taskSaid(action, text), undo ? { action: { label: t("common.undo"), name: t(name), undo } } : {});
}

/**
 * Plan 204 §6: the one-time check of the last 14 days, offered while the feature is on and the question unanswered, with
 * the count and the cost (none on a local model), as follow-ups' 30 days (plan 142). Today's header and Settings ask it
 * alike; `save` writes the answer the way each writes settings. Nothing old is read without a yes.
 */
export function useDatedScanOffer(offering: boolean, save: (patch: { scanAnswered: true }) => Promise<unknown>): { offer: { count: number; usd: number | null } | null; answer: (check: boolean) => Promise<boolean> } {
  const [offer, setOffer] = useState<{ count: number; usd: number | null } | null>(null);
  useEffect(() => {
    if (!offering) return setOffer(null);
    let current = true;
    void client.call("dated.scanOffer", {}).then((o) => current && setOffer(o), () => {});
    return () => {
      current = false;
    };
  }, [offering]);
  return { offer, answer: (check: boolean) => answerScan(check, save) };
}

/** The offer's answer. Codex code review: a yes is kept only once the check is queued; one that failed says so and stays offered. */
export async function answerScan(check: boolean, save: (patch: { scanAnswered: true }) => Promise<unknown>): Promise<boolean> {
  if (check) {
    try {
      await client.call("dated.scan", {});
    } catch (error) {
      snack.error((error as { message?: string }).message ?? t("dated.scanFailed"));
      return false;
    }
  }
  await save({ scanAnswered: true });
  return true;
}

/** The offer's words: "Check the last 14 days too? 23 messages, about $0.02."; no cost where it's free (a model of the user's own). */
export const scanOfferText = (offer: { count: number; usd: number | null }): string => (offer.usd !== null && offer.usd > 0 ? t("today.dated.scanCost", { count: offer.count, usd: usd(offer.usd) }) : t("today.dated.scan", { count: offer.count }));
