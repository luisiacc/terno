import { localDay, type ScheduleProposal } from "@terno/core";
import { t } from "@terno/i18n";
import { create } from "zustand";
import type { TodayTask } from "~/lib/dated";
import type { ReaderItem } from "~/lib/reader-items";
import { registerUndo, snack } from "~/lib/snack";
import { promiseSentence } from "~/lib/today-sentence";
import { dueShort, dueTimeLeft } from "~/lib/when";
import { client } from "~/rpc/connection";
import { setApp } from "~/state/app";

/**
 * Plan 210 (iteration 4, the owner's "Change…"): an item's day and time, the user's from then on. From the row's menu, the
 * palette (a dialog) and the reader's line (a popover there), one form: the day, and a time when it has one. Not the words,
 * not the kind; a person's ask has no day to change. Revision-checked, with its own Undo; a later mail's move of it is a
 * proposal the reader's line offers ("Elena says Mon now · Use").
 */

/** What a change acts on: the item, at the revision seen, its words as shown (the snack names it) and its schedule now. */
export interface ChangeTarget {
  source: "dated" | "promise";
  id: number;
  revision: number;
  text: string | null;
  /** its day ("YYYY-MM-DD"), its moment, and whether that's a time of its own */
  dueDay: string | null;
  dueAt: number;
  timed: boolean;
}

/**
 * What the form names it by (the claims ledger's second batch): a promise as its row says it ("You said you'd send Jess the
 * script."), never its stored words alone ("send Jess the script"); a dated item's own words. Null: nothing to name.
 */
export const changeSaid = (target: Pick<ChangeTarget, "source" | "text">): string | null => {
  const text = target.text?.trim();
  return !text ? null : target.source === "promise" ? promiseSentence(text) : text;
};

/** What the form gives: a local day, and a time ("HH:MM") or none. */
export interface ChangeTo {
  day: string;
  time: string | null;
}

/** A row's task, as Change… takes it; null for what has no day to change (a person's ask). */
export function changeOfTask(task: TodayTask): ChangeTarget | null {
  if (task.kind === "dated") {
    if (task.item.kind === "ask") return null;
    return { source: "dated", id: task.item.id, revision: task.item.revision, text: task.text ?? null, dueDay: task.item.dated ? task.item.dueDay : null, dueAt: task.dueAt, timed: task.item.timed };
  }
  return { source: "promise", id: task.id, revision: task.revision, text: task.text ?? null, dueDay: null, dueAt: task.dueAt ?? 0, timed: task.timed === true };
}

/** The reader's item, likewise (an open one only). */
export function changeOfItem(item: ReaderItem): ChangeTarget | null {
  if (!item.open) return null;
  if (item.source === "dated") {
    const r = item.row;
    return r.kind === "ask" ? null : { source: "dated", id: r.id, revision: r.revision, text: r.text, dueDay: r.dated ? r.dueDay : null, dueAt: r.dueAt, timed: r.timed };
  }
  const r = item.row;
  return { source: "promise", id: r.id, revision: r.revision, text: r.text, dueDay: null, dueAt: r.dated ? r.dueAt : 0, timed: r.timed === true };
}

/**
 * Where the form starts: the item's own day and time; a day already over (Missed) or none (a promise that named no day),
 * tomorrow, at the item's time or 9:00 (the calendar offers no day before today). `timed`: whether it has a time of its own.
 */
export function changeStart(target: Pick<ChangeTarget, "dueDay" | "dueAt" | "timed">, now = Date.now()): { at: number; timed: boolean } {
  const day = target.dueDay ? localDay(target.dueDay) : target.dueAt ? new Date(target.dueAt) : null;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const at = new Date(day ?? today);
  at.setHours(0, 0, 0, 0);
  if (at.getTime() < today.getTime() || !day) {
    at.setTime(today.getTime());
    at.setDate(at.getDate() + 1);
  }
  const timed = target.timed && target.dueAt > 0;
  const clock = timed ? new Date(target.dueAt) : null;
  at.setHours(clock ? clock.getHours() : 9, clock ? clock.getMinutes() : 0, 0, 0);
  return { at: at.getTime(), timed };
}

/** The day and time a proposal or a change names, as a row's column does: "Mon", "Mon 4:00 PM", "Nov 30", "Today". */
export function whenSaid(o: Pick<ScheduleProposal, "dueDay" | "dueAt" | "timed">, now = Date.now()): string {
  const ms = o.timed ? o.dueAt : (localDay(o.dueDay)?.getTime() ?? o.dueAt);
  return [dueShort(ms, o.timed, now), dueTimeLeft(ms, o.timed, now)].filter(Boolean).join(" ");
}

/** "Elena", from "Elena Ruiz"; an address stays whole. */
const firstName = (by: string): string => (by.includes("@") ? by : (by.trim().split(/\s+/)[0] ?? by));

/** The reader's line for a proposal: "Elena says Mon now". */
export const proposalSaid = (p: ScheduleProposal, now = Date.now()): string => t("dated.proposal", { name: firstName(p.by), when: whenSaid(p, now) });

/** The form's day ("YYYY-MM-DD") and time ("HH:MM") of a local moment. */
export function changeTo(at: number, timed: boolean): ChangeTo {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return { day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: timed ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : null };
}

/** A long task's words cut for the snack, as Done's are. */
const SAID_MAX = 60;
const shortened = (text: string): string => (text.length <= SAID_MAX ? text : `${text.slice(0, SAID_MAX - 1).trimEnd()}…`);

/**
 * The change (or, with `accept`, the item's proposal taken), its snack naming the new day and the task, with Undo. Today
 * reads again on the backend's `todayChanged`; a refusal says why in its own words (changed since, a day passed…).
 */
export async function changeItem(target: ChangeTarget, to: ChangeTo | { accept: true; when: string }): Promise<void> {
  try {
    const { undoId } = await client.call("today.schedule", { item: { source: target.source, id: target.id, revision: target.revision }, to: "accept" in to ? { accept: true } : to });
    const when = "accept" in to ? to.when : whenSaid({ dueDay: to.day, dueAt: momentOf(to), timed: to.time !== null });
    const words = target.text?.trim();
    const undo = registerUndo(() =>
      client.call("today.scheduleUndo", { undoId }).then(
        () => undefined,
        (error: unknown) => void snack.error((error as { message?: string }).message ?? t("dated.changeFailed")),
      ),
    );
    snack.success(words ? t("dated.snack.changedItem", { when, text: shortened(words) }) : t("dated.snack.changed", { when }), { action: { label: t("common.undo"), name: t("dated.changeUndo"), undo } });
  } catch (error) {
    snack.error((error as { message?: string }).message ?? t("dated.changeFailed"));
  }
}

const momentOf = (to: ChangeTo): number => {
  const d = localDay(to.day) ?? new Date();
  const [h, m] = to.time ? (to.time.split(":").map(Number) as [number, number]) : [9, 0];
  d.setHours(h, m, 0, 0);
  return d.getTime();
};

/** The form opened from the row's menu or the palette (a dialog), for the item as it is now. */
export const useChangePick = create<{ target: ChangeTarget | null }>(() => ({ target: null }));

export function openChange(target: ChangeTarget): void {
  useChangePick.setState({ target });
  setApp({ dialog: "todayChange" });
}

export function closeChange(): void {
  useChangePick.setState({ target: null });
  setApp({ dialog: null });
}
