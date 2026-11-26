import { alertUntil, askUntil, datedGroup, datedGroupAt, defaultRemindAt, dueCutoff, laterBefore, localDay, planEnd, remindPresets, undatedAlert, type DatedKind, type DatedRow, type DatedWall, type ItemSeen, type PartOfDay, type RemindPreset, type ThreadSummary, type TodayAlso, type TodayWhy } from "@terno/core";
import { getLocale, t } from "@terno/i18n";
import type { LeftRows } from "~/lib/actions";
import { muteOfferAction } from "~/lib/dated-mutes";
import { registerUndo, snack, type SnackAction } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { alertSays, attendsLine, backWhen, placeClock, withMailDay } from "~/lib/today-sentence";
import { datedDay, dueShort, partDay, partInSentence, reminderTime } from "~/lib/when";

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
  /** plan 210 (iteration 5, revision 4): the part of its day it's asked for ("Due Saturday morning"); absent, the whole day */
  partOfDay?: PartOfDay | null;
  /**
   * plan 210 (iteration 4, revision 10): the mail's own clock at a place it named away from the reader, as stored (`wall`,
   * a dated item's) or as Today's row carries it (`travel`)
   */
  wall?: DatedWall | null;
  travel?: { day: string; time: string; place: string } | null;
  /** round 17 (core's `mailDay`): the mail's own day for a deadline the user moved with Change…, said after theirs */
  mailDay?: string | null;
}

/**
 * Plan 210 (iteration 5, R1): a travel item's day and time as the place says them ("Mon 4:00 PM Austin"), never the reader's
 * zone's: the feed's column says it so, and the reader's line, the Also line and the screen reader's words follow it.
 */
function placeWhen(o: Pick<DatedFacts, "timed" | "wall" | "travel">): { day: number; time: string } | null {
  const at = o.timed ? (o.travel ?? (o.wall?.place ? { day: o.wall.day, time: o.wall.time, place: o.wall.place } : null)) : null;
  const day = at ? localDay(at.day)?.getTime() : undefined;
  return at && day !== undefined ? { day, time: placeClock(at) } : null;
}

const capital = (s: string): string => s.charAt(0).toLocaleUpperCase(getLocale()) + s.slice(1);

const dayOf = (o: Pick<DatedFacts, "dueDay" | "dueAt">): number => localDay(o.dueDay)?.getTime() ?? o.dueAt;

/**
 * "Was due Tuesday": a Missed day in words, an item's or a dated promise's. A timed one keeps its time (Codex code review of
 * the fixes): "Was due yesterday 1:00 PM".
 */
function wasDue(day: number, now: number, time: string | null, part?: PartOfDay | null): string {
  const d = datedDay(day, now);
  // plan 210 (iteration 5): its morning over, the day still today: "Was due this morning"
  if (part && !time && d.near === "today") return t("today.due.wasPart", { when: partInSentence(partDay(day, part, now).text) });
  if (d.near === "yesterday") return time ? t("today.due.wasYesterdayAt", { time }) : t("today.due.wasYesterday");
  return time ? t("today.due.wasOnAt", { day: d.text, time }) : t("today.due.wasOn", { day: d.text });
}

/** "Due Friday", "Due today 1:00 PM" (after the panel: any timed item says its time, not only a Plan). */
function dueOn(day: number, time: string | null, now: number, part?: PartOfDay | null): string {
  // plan 210 (iteration 5, revision 4): a part of its day, never a clock: "Due this morning", "Due Saturday morning"
  if (part && !time) {
    const p = partDay(day, part, now, true);
    return p.near ? t("today.due.part", { when: partInSentence(p.text) }) : t("today.due.partOn", { when: p.text });
  }
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
export const datedText = (o: { kind: DatedKind; text: string; wanted?: boolean }): string => (o.kind === "alert" && o.text && !o.wanted ? alertSays(o.text) : o.text);

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
  const place = placeWhen(o);
  const time = place ? place.time : o.timed ? reminderTime(o.dueAt) : null;
  const day = place ? place.day : dayOf(o);
  if (missed) return withMailDay(wasDue(day, now, time, o.partOfDay), o.mailDay, now);
  if (datedGroup(o.kind) === "plans") {
    const d = datedDay(day, now);
    const when = d.near === "today" ? t("today.when.today") : d.near === "tomorrow" ? t("today.when.tomorrow") : capital(d.text);
    return time ? `${when} ${time}` : when;
  }
  return withMailDay(dueOn(day, time, now, o.partOfDay), o.mailDay, now);
}

/**
 * Plan 204 §8: an item's full line, as the conversation shows it: "Due Friday · Pay the electricity bill", "Tomorrow 7:40 ·
 * Flight to Madrid", "Was due Tuesday · Renew the domain"; an alert that named no day, its words alone. (A Today row says
 * the task alone, its day in the right column: after the second panel round.)
 */
export const datedLine = (o: DatedFacts, missed: boolean, now = Date.now()): string => line(datedWhen(o, missed, now), datedText(o));

/**
 * When an item stops being its conversation's: a Plan's end, an ask's window, an undated alert's week (the sixth panel
 * round: never Missed), a deadline's day (Missed then says it, by `datedPlace`).
 */
const conversationEnd = (r: DatedRow): number => (datedGroup(r.kind) === "plans" ? planEnd(r) : r.kind === "ask" ? askUntil(r) : undatedAlert(r) ? alertUntil(r) : dueCutoff(r.dueDay, r.partOfDay));

/**
 * The conversation's line for an item, by Today's rule (`datedGroupAt`, the group its row would be in): still to act on,
 * shown in Today or not yet (too far ahead, or put off with Later); null once over (a Plan ended, an ask past its window,
 * an alert past its week, a day Missed has let go of). Its words are the item's own whichever group it's in.
 */
export function conversationItem(r: DatedRow, now: number): { missed: boolean } | null {
  if (r.state !== "open") return null;
  const group = datedGroupAt(r, now)?.group ?? null;
  if (group === "missed") return { missed: true };
  if (group !== null) return { missed: false };
  return now < conversationEnd(r) ? { missed: false } : null;
}

/**
 * The fifth panel round (change 6): a Today row's second line, its conversation's next item, with the row's own short
 * day ("Thu", "Nov 21") and time: "Also Thu 9:00 AM · Board meeting", "Also tomorrow · You said: send the deck"; one
 * that names no day, "Also: Answer Mariana about the quote". An alert says whose word it is, as everywhere.
 */
export function alsoLine(o: TodayAlso, now = Date.now()): string {
  // plan 210 (iteration 5, R9): your promise to attend the row's event, in your words, no day of its own
  if (o.attends) return attendsLine(o.text);
  const text = o.kind === "promise" ? t("today.why.promise", { text: o.text }) : datedText({ kind: o.kind, text: o.text });
  if (!o.dated) return t("today.also.bare", { text });
  const day = dayOf(o);
  const near = datedDay(day, now).near;
  const when = near ? t(`today.also.${near}`) : t("today.also.on", { day: dueShort(day, false, now) });
  return t("today.also.line", { when: o.timed ? `${when} ${reminderTime(o.dueAt)}` : when, text });
}

/** When a promise of yours is due, in words ("Due today", "Was due Tuesday"); null for one that named no day. */
export function promiseWhen(o: { dueAt?: number; dated: boolean; partOfDay?: PartOfDay | null }, missed: boolean, now = Date.now()): string | null {
  if (!o.dueAt || !o.dated) return null;
  return missed ? wasDue(o.dueAt, now, null, o.partOfDay) : dueOn(o.dueAt, null, now, o.partOfDay);
}

/**
 * Plan 204 (after the panel, fix 8): a promise of yours, in your words: "Due today · You said: send the agenda", "Was due
 * Tuesday · You said: …"; one that named no day, "You said: …".
 */
export const promiseLine = (o: { text: string; dueAt?: number; dated: boolean }, missed: boolean, now = Date.now()): string => line(promiseWhen(o, missed, now), t("today.why.promise", { text: o.text }));

/**
 * Plan 204 (after the panel): what a Today row's Done, Remove, Later and D act on: its dated item, or the promise of
 * yours it shows (`why.promise`, exactly: never the thread's most urgent). `when` is the right column's due day, `due`
 * the same in words for a screen reader (that column is hidden from it; after the second panel round); `dueAt`, what
 * Later's window is read from (`laterWindow`); a promise's `dated`, whether it names a day. The fourth panel round: a
 * promise's `noDay` (one that names none: its row's date stays empty, never the mail's) and `person` (whom you made it
 * to: the row's name and picture, the conversation's last sender being you). `text`, the task's words as the row showed
 * them, what its Undo names.
 */
export type TodayTask = (
  | { kind: "dated"; item: DatedRef; when: string | null; due: string | null; dueAt: number; noDay?: boolean; text?: string | null }
  | { kind: "promise"; id: number; revision: number; when: string | null; due: string | null; dated?: boolean; noDay?: boolean; person?: TaskPerson; text?: string | null; /** plan 210 (iteration 4): its moment and whether it's a time, where Change… starts */ dueAt?: number; timed?: boolean; /** plan 210 (iteration 5's code review): the part of its day it sits under, where its day ends */ part?: PartOfDay | null;/** plan 210 (iteration 4): the reply's other promises the row shows, acted on with it */ with?: ItemSeen[] }
  /**
   * plan 215: a conversation waiting on you: Done ("no reply needed"), Later and (plan 216) Remove, at its waiting date and
   * record's revision as drawn (`TodayWhy.reply`); `name`, who wrote, what its snack names; no day of its own
   */
  | { kind: "waiting"; threadId: number; since: number; message: number; rev: number; name: string; when?: null; due?: null; noDay: true; text?: null }
) & {
  /** the fifth panel round (change 6): its conversation's next item, in words ("Also Thu 9:00 AM · Board meeting"), never what it acts on */
  also?: string;
};
/** Who a promise is with, as its row names and pictures them; no address, initials alone. */
export interface TaskPerson {
  name: string;
  email: string;
}

/** The fourth panel round (revision 9): the person a promise is with; with no name, their address's local part. */
function personOf(why: TodayWhy): TaskPerson | undefined {
  const email = why.personEmail?.trim() ?? "";
  const name = why.personName?.trim() || email.split("@")[0];
  return name ? { name, email } : undefined;
}

/** A task that is an item (a dated item or a promise of yours): what Change… and Hand to… take. */
export type ItemTask = Exclude<TodayTask, { kind: "waiting" }>;

/**
 * A Today row's task, from what the backend said of it: a dated item, a promise, or (plan 215) a conversation waiting on you,
 * named by `thread`'s sender; a reminder has none.
 */
export function taskOf(why: TodayWhy, now = Date.now(), thread?: Pick<ThreadSummary, "id" | "fromName" | "fromEmail">): TodayTask | null {
  if (why.kind === "waiting") return why.reply && thread ? { kind: "waiting", threadId: thread.id, since: why.reply.since, message: why.reply.message, rev: why.reply.rev, name: thread.fromName || thread.fromEmail, noDay: true } : null;
  if (why.kind === "dated" && why.item) {
    const item = why.item;
    const dueAt = why.dueAt ?? 0;
    // a Missed item says its day; one still ahead, its time today
    const timed = item.timed && !why.missed;
    const when = item.dated ? dueShort(timed ? dueAt : (localDay(item.dueDay)?.getTime() ?? dueAt), timed, now) : null;
    // the fifth panel round (change 3): an alert that named no day says none, as a promise with none doesn't (its made-up
    // day only says when it's Missed); an ask keeps the day it came
    const noDay = item.kind === "alert" && !item.dated;
    return { kind: "dated", item, when, due: datedWhen({ ...item, dueAt, partOfDay: item.part ?? null }, why.missed === true, now), dueAt, text: why.text ?? null, ...(noDay ? { noDay } : {}) };
  }
  if (why.kind === "promise" && why.promise) {
    const dated = why.promise.dated === true && why.dueAt !== undefined;
    const person = personOf(why);
    return {
      kind: "promise",
      id: why.promise.id,
      revision: why.promise.revision,
      when: dated ? dueShort(why.dueAt!, why.promise.timed === true, now) : null,
      due: dated ? promiseWhen({ dueAt: why.dueAt, dated, partOfDay: why.promise.part ?? null }, why.missed === true, now) : null,
      dated,
      text: why.text ?? null,
      // a promise with no day says none (the fourth panel round): the mail's date beside it would read as one
      ...(!dated ? { noDay: true } : { dueAt: why.dueAt!, timed: why.promise.timed === true, ...(why.promise.part ? { part: why.promise.part } : {}) }),
      ...(person ? { person } : {}),
      ...(why.with?.length ? { with: why.with } : {}),
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
  // a promise of yours, and (plan 215) a conversation waiting on you: anywhere ahead
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

const SAID = { done: "dated.snack.done", dismiss: "dated.snack.removed", later: "dated.snack.later" } as const;
const SAID_ITEM = { done: "dated.snack.doneItem", dismiss: "dated.snack.removedItem", later: "dated.snack.laterItem" } as const;
/**
 * A task's words in the snack, at most: two lines beside its Undo (the snack ellipsizes what's left over too). The claims
 * ledger's second batch: the snack's message wraps to two lines now, so "Done: Pay $58.71 for the City of Millbrook water
 * and sewer service" is whole (60 and one line cut it at "water and s…")
 */
const SAID_MAX = 84;

/** A long task cut at a word, if one is near the end, with an ellipsis. */
function shortened(text: string): string {
  if (text.length <= SAID_MAX) return text;
  const cut = text.slice(0, SAID_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space >= SAID_MAX - 16 ? cut.slice(0, space) : cut).trimEnd().replace(/[,;:·-]$/, "")}…`;
}

/**
 * The fourth panel round (change 9, revision 11): what the snack says of Done, Remove and Later, naming the task so
 * its Undo says what it undoes: "Done: Pay $187.42 for the utility bill", "Removed from What matters: …", "Later: …". One formatter for
 * the row's menu, D, the palette, the conversation's line and the promise card. The words are the task's as it was acted
 * on (a reload can't name what replaced it); with none, the plain "Marked done".
 */
export function taskSaid(action: "done" | "dismiss" | "later", text: string | null | undefined): string {
  const words = text?.trim();
  return words ? t(SAID_ITEM[action], { text: shortened(words) }) : t(SAID[action]);
}

/**
 * Done, Remove and Later (plan 204 §5, after the panel), each with Undo that puts the exact item back, as follow-ups'
 * act. Today reloads on the backend's `todayChanged`. `left`: the Today row it took out of the list (after the second
 * panel round), which its Undo puts back selected, and a failure brings back.
 */
export async function actOnDated(item: Pick<DatedRef, "id" | "revision"> & { text?: string | null }, action: "done" | "dismiss" | "later", until?: number, left?: LeftRows): Promise<void> {
  // its words now, before the act's reload replaces them
  const text = item.text;
  try {
    const { undoId } = await client.call("dated.act", { id: item.id, revision: item.revision, action, ...(until !== undefined ? { until } : {}) });
    // plan 210 (iteration 4, the owner; iteration 5 narrows it): after Remove, once, the snack offers to hide that kind from that sender
    const offer = action === "dismiss" ? await muteOfferAction(item.id) : undefined;
    said(action, text, undoId === null ? null : () => client.call("dated.undo", { undoId }).then(() => undefined), "dated.undo", left, offer);
  } catch (error) {
    left?.failed();
    snack.error((error as { message?: string }).message ?? t("dated.actFailed"));
  }
}

/**
 * Plan 215: what the snack says of Done and Later on a conversation waiting on you, naming who wrote: "Done: Tomas
 * Santarcieri", "Later: Tomas Santarcieri, back Fri 9:00 AM"; plan 216, "Removed from What matters: Tomas Santarcieri".
 */
export function waitingSaid(action: "done" | "dismiss" | "later", name: string, at?: number, now = Date.now()): string {
  const who = shortened(name.trim());
  if (action === "dismiss") return t("whatMatters.waiting.removed", { name: who });
  return action === "later" && at !== undefined ? t("whatMatters.waiting.later", { name: who, when: backWhen(at, now) }) : t("whatMatters.waiting.done", { name: who });
}

/** Plan 215: Done, Later and (plan 216) Remove on a conversation waiting on you, with an Undo that puts it back exactly (or says it changed). */
async function actOnWaiting(task: Extract<TodayTask, { kind: "waiting" }>, action: "done" | "dismiss" | "later", at?: number, left?: LeftRows): Promise<void> {
  try {
    const { undoId } = await client.call("today.waitingAct", { threadId: task.threadId, since: task.since, message: task.message, rev: task.rev, action: action === "dismiss" ? "remove" : action, ...(at !== undefined ? { until: at } : {}) });
    const run = () => client.call("today.waitingUndo", { undoId }).then(() => undefined);
    const undo = registerUndo(() => (left ? left.undo(run) : run()));
    snack.success(waitingSaid(action, task.name, at), { action: { label: t("common.undo"), name: t("common.undo"), undo } });
  } catch (error) {
    left?.failed();
    snack.error((error as { message?: string }).message ?? t("dated.actFailed"));
  }
}

/** The same three on a Today row's task: a promise through follow-ups' act (its revision, its Undo), in Today's words. */
export async function actOnTask(task: TodayTask, action: "done" | "dismiss" | "later", at?: number, left?: LeftRows): Promise<void> {
  if (task.kind === "dated") return actOnDated({ ...task.item, text: task.text }, action, at, left);
  // plan 215: a conversation waiting on you, its own act (plan 216: Remove too, off What matters only)
  if (task.kind === "waiting") return actOnWaiting(task, action, at, left);
  try {
    const { undoId } = await client.call("followups.act", { id: task.id, revision: task.revision, action, ...(at !== undefined ? { dueAt: at } : {}), ...(task.with ? { with: task.with } : {}) });
    said(action, task.text, undoId === null ? null : () => client.call("followups.undo", { undoId }).then(() => undefined), "followup.undo", left);
  } catch (error) {
    left?.failed();
    snack.error((error as { message?: string }).message ?? t("followup.actFailed"));
  }
}

/** The snack, naming the task, with Undo when there's one (the row it took out back with it). */
function said(action: "done" | "dismiss" | "later", text: string | null | undefined, run: (() => Promise<void>) | null, name: "dated.undo" | "followup.undo", left?: LeftRows, secondary?: SnackAction): void {
  const undo = run && registerUndo(() => (left ? left.undo(run) : run()));
  const undoing = undo ? { action: { label: t("common.undo"), name: t(name), undo } } : {};
  // plan 210 (iteration 4): with Mute's offer beside Undo the first line has little room, so it says what happened and
  // the task's words go under it
  const words = text?.trim();
  // (iteration 5) the narrow offer names a kind and a sender, so the line before it is one word: "Removed"
  if (secondary) snack.success(t(action === "dismiss" ? "dated.snack.removedOffer" : SAID[action]), { ...undoing, secondary, ...(words ? { description: shortened(words) } : {}) });
  else snack.success(taskSaid(action, text), undoing);
}
