import { datedGroup, localDay, planEnd, remindPresets, type DatedKind, type RemindPreset, type TodayWhy } from "@terno/core";
import { getLocale, t } from "@terno/i18n";
import { useEffect, useState } from "react";
import { usd } from "~/lib/ai";
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
  /** false: an alert that named no day, which reads as its words alone */
  dated: boolean;
  text: string;
}

const capital = (s: string): string => s.charAt(0).toLocaleUpperCase(getLocale()) + s.slice(1);

const dayOf = (o: Pick<DatedFacts, "dueDay" | "dueAt">): number => localDay(o.dueDay)?.getTime() ?? o.dueAt;

/**
 * "Was due Tuesday · …": a Missed line, an item's or a dated promise's (its text already in its own words). A timed one
 * keeps its time (Codex code review of the fixes): "Was due yesterday 1:00 PM · Wire payroll".
 */
export function wasDueLine(day: number, text: string, now = Date.now(), time: string | null = null): string {
  const d = datedDay(day, now);
  if (d.near === "yesterday") return time ? t("today.why.wasDueYesterdayAt", { time, text }) : t("today.why.wasDueYesterday", { text });
  return time ? t("today.why.wasDueOnAt", { day: d.text, time, text }) : t("today.why.wasDueOn", { day: d.text, text });
}

/** "Due Friday · …", "Due today 1:00 PM · …" (after the panel: any timed item says its time, not only a Plan). */
function dueLine(day: number, time: string | null, text: string, now: number): string {
  const d = datedDay(day, now);
  if (d.near === "today") return time ? t("today.why.dueTodayAt", { time, text }) : t("today.why.dueToday", { text });
  if (d.near === "tomorrow") return time ? t("today.why.dueTomorrowAt", { time, text }) : t("today.why.dueTomorrow", { text });
  return time ? t("today.why.dueOnAt", { day: d.text, time, text }) : t("today.why.dueOn", { day: d.text, text });
}

/**
 * Plan 204 §8: an item's line, in Today's row and the reader alike: "Due Friday · Pay the electricity bill" (Deadlines and
 * Coming up), "Due today 1:00 PM · Wire payroll" (after the panel: any item with a time says it), "Tomorrow 7:40 · Flight
 * to Madrid" (a Plan), "Was due Tuesday · Renew the domain" (Missed); an alert that named no day, its words alone.
 */
export function datedLine(o: DatedFacts, missed: boolean, now = Date.now()): string {
  if (!o.dated) return o.text;
  const time = o.timed ? reminderTime(o.dueAt) : null;
  if (missed) return wasDueLine(dayOf(o), o.text, now, time);
  if (datedGroup(o.kind) === "plans") {
    const d = datedDay(dayOf(o), now);
    const when = d.near === "today" ? t("today.when.today") : d.near === "tomorrow" ? t("today.when.tomorrow") : capital(d.text);
    return t("today.why.plan", { when: time ? `${when} ${time}` : when, text: o.text });
  }
  return dueLine(dayOf(o), time, o.text, now);
}

/**
 * Plan 204 (after the panel, fix 8): a promise of yours, in your words: "Due today · You said: send the agenda", "Due
 * Tuesday · You said: …" (Coming up), "Was due Tuesday · You said: …" (Missed); one that named no day, "You said: …".
 */
export function promiseLine(o: { text: string; dueAt?: number; dated: boolean }, missed: boolean, now = Date.now()): string {
  const said = t("today.why.promise", { text: o.text });
  if (!o.dueAt || !o.dated) return said;
  return missed ? wasDueLine(o.dueAt, said, now) : dueLine(o.dueAt, null, said, now);
}

/**
 * Plan 204 (after the panel): what a Today row's Done, Not a task, Later and D act on: its dated item, or the promise of
 * yours it shows (`why.promise`, exactly: never the thread's most urgent). `when` is the right column's due day; `end`, a
 * Plan's end, the last moment Later may choose.
 */
export type TodayTask =
  | { kind: "dated"; item: DatedRef; when: string | null; end: number | null }
  | { kind: "promise"; id: number; revision: number; when: string | null };
// a nudge (no reply to your mail) acts as a promise does: through follow-ups' act on the row it shows (Codex code review)

/** A Today row's task, from what the backend said of it: a dated item, a promise or a nudge; a waiting row or a reminder has none. */
export function taskOf(why: TodayWhy, now = Date.now()): TodayTask | null {
  if (why.kind === "dated" && why.item) {
    const item = why.item;
    const dueAt = why.dueAt ?? 0;
    // a Missed item says its day; one still ahead, its time today
    const timed = item.timed && !why.missed;
    const when = item.dated ? dueShort(timed ? dueAt : (localDay(item.dueDay)?.getTime() ?? dueAt), timed, now) : null;
    return { kind: "dated", item, when, end: datedGroup(item.kind) === "plans" ? planEnd({ dueDay: item.dueDay, dueAt, timed: item.timed }) : null };
  }
  if ((why.kind === "promise" || why.kind === "nudge") && why.promise) {
    const dated = why.kind === "promise" && why.promise.dated === true && why.dueAt !== undefined;
    return { kind: "promise", id: why.promise.id, revision: why.promise.revision, when: dated ? dueShort(why.dueAt!, false, now) : null };
  }
  return null;
}

/** Plan 204 (after the panel, fix 10): Later's choices now, the reminder's presets; on a Plan, only those before it ends. */
export function laterChoices(task: TodayTask, now = Date.now()): RemindPreset[] {
  const presets = remindPresets(new Date(now), "always");
  return task.kind === "dated" && task.end !== null ? presets.filter((p) => p.at < task.end!) : presets;
}

const SAID = { done: "dated.snack.done", dismiss: "dated.snack.dismissed", later: "dated.snack.later" } as const;

/**
 * Done, Not a task and Later (plan 204 §5, after the panel), each with Undo that puts the exact item back, as follow-ups'
 * act. Today reloads on the backend's `todayChanged`.
 */
export async function actOnDated(item: Pick<DatedRef, "id" | "revision">, action: "done" | "dismiss" | "later", until?: number): Promise<void> {
  try {
    const { undoId } = await client.call("dated.act", { id: item.id, revision: item.revision, action, ...(until !== undefined ? { until } : {}) });
    const undo = undoId === null ? null : registerUndo(() => client.call("dated.undo", { undoId }).then(() => undefined));
    snack.success(t(SAID[action]), undo ? { action: { label: t("common.undo"), name: t("dated.undo"), undo } } : {});
  } catch (error) {
    const e = error as { message?: string };
    snack.error(e.message ?? t("dated.actFailed"));
  }
}

/** The same three on a Today row's task: a promise through follow-ups' act (its revision, its Undo), in Today's words. */
export async function actOnTask(task: TodayTask, action: "done" | "dismiss" | "later", at?: number): Promise<void> {
  if (task.kind === "dated") return actOnDated(task.item, action, at);
  try {
    const { undoId } = await client.call("followups.act", { id: task.id, revision: task.revision, action, ...(at !== undefined ? { dueAt: at } : {}) });
    const undo = undoId === null ? null : registerUndo(() => client.call("followups.undo", { undoId }).then(() => undefined));
    snack.success(t(SAID[action]), undo ? { action: { label: t("common.undo"), name: t("followup.undo"), undo } } : {});
  } catch (error) {
    const e = error as { message?: string };
    snack.error(e.message ?? t("followup.actFailed"));
  }
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
