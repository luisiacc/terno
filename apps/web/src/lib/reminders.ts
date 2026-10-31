import type { Reminder, ReminderKind, RemindPresetId } from "@terno/core";
import { getLocale, t } from "@terno/i18n";
import type { ReminderInfo, RemindersSnapshot } from "@terno/core/rpc";
import { create } from "zustand";
import { useReminders } from "~/state/reminders";
import { client } from "~/rpc/connection";
import { registerUndo, snack } from "~/lib/snack";
import { readerShown } from "~/lib/page";
import { getApp, inPlainInbox, setApp, useApp } from "~/state/app";
import { currentTargets } from "~/lib/select";
import { inboxTop, reloadList, useList } from "~/state/list";

/**
 * Plan 87: the reminders as the windows see them (the backend's snapshot:
 * at startup and on its `reminders` event), and what the UI does with them:
 * set and clear (with Undo), and the opening that ends a due one.
 */
export { anyDue, useReminders } from "~/state/reminders";
const dueIds = (m: ReadonlyMap<number, ReminderInfo>) => [...m.values()].filter((r) => r.due).map((r) => r.threadId).sort((a, b) => a - b).join();

/** A snapshot from the backend; the lists that show reminders follow what changed in them. */
export function applyReminders(snapshot: RemindersSnapshot): void {
  const before = useReminders.getState();
  const byThread = new Map(snapshot.reminders.map((r) => [r.threadId, r]));
  useReminders.setState({ byThread, due: snapshot.reminders.filter((r) => r.due).length, loaded: true });
  const s = getApp();
  // the Inbox's top is the due ones; the Reminders list is all of them (their order is their times); the first
  // snapshot, after a first page that didn't know of it, brings the top
  // the first snapshot at startup comes before the first list (boot waits for it): nothing to reload yet
  if (!before.loaded && useList.getState().itemsKey === "") return;
  const changed = s.reminders ? JSON.stringify(snapshot.reminders) !== JSON.stringify([...before.byThread.values()]) : inPlainInbox(s) && dueIds(byThread) !== dueIds(before.byThread);
  if (changed) void reloadList({ keepSelection: true });
}

export async function loadReminders(): Promise<void> {
  applyReminders(await client.call("reminders.list", {}));
}

// ───────────────────────────── when ─────────────────────────────

const DAY = 86_400_000;
const formats = new Map<string, { time: Intl.DateTimeFormat; weekday: Intl.DateTimeFormat; day: Intl.DateTimeFormat; year: Intl.DateTimeFormat }>();
function fmt() {
  const id = getLocale();
  let f = formats.get(id);
  if (!f) {
    const tag = id === "en" ? "en-US" : id;
    const time: Intl.DateTimeFormatOptions = id === "en" ? { hour: "numeric", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" };
    f = {
      time: new Intl.DateTimeFormat(tag, time),
      weekday: new Intl.DateTimeFormat(tag, { weekday: "short" }),
      day: new Intl.DateTimeFormat(tag, { day: "numeric", month: "short" }),
      year: new Intl.DateTimeFormat(tag, { day: "numeric", month: "short", year: "numeric" }),
    };
    formats.set(id, f);
  }
  return f;
}

/** Days from today to that day, in local calendar days. */
function daysAway(ms: number, now: number): number {
  const a = new Date(now);
  a.setHours(0, 0, 0, 0);
  const b = new Date(ms);
  b.setHours(0, 0, 0, 0);
  return Math.round((b.getTime() - a.getTime()) / DAY);
}

function dayOf(ms: number, now: number): string {
  const f = fmt();
  const out = (new Date(ms).getFullYear() === new Date(now).getFullYear() ? f.day : f.year).format(ms);
  return out.replace(".", "");
}

/** In a sentence: "tomorrow at 9:00 AM", "Sat at 9:00 AM", "on Nov 17 at 9:00 AM". */
export function reminderWhen(ms: number, now = Date.now()): string {
  const f = fmt();
  const time = f.time.format(ms);
  const days = daysAway(ms, now);
  if (days === 0) return t("remind.when.today", { time });
  if (days === 1) return t("remind.when.tomorrow", { time });
  if (days > 1 && days < 7) return t("remind.when.weekday", { day: f.weekday.format(ms).replace(".", ""), time });
  return t("remind.when.date", { date: dayOf(ms, now), time });
}

/** Compact (a menu's right side, a row's date): "Tomorrow 9:00 AM", "Sat 9:00 AM", "Nov 17 9:00 AM". */
export function reminderShort(ms: number, now = Date.now()): string {
  const f = fmt();
  const time = f.time.format(ms);
  const days = daysAway(ms, now);
  if (days === 0) return t("remind.short.today", { time });
  if (days === 1) return t("remind.short.tomorrow", { time });
  if (days > 1 && days < 7) return `${f.weekday.format(ms).replace(".", "")} ${time}`;
  return `${dayOf(ms, now)} ${time}`;
}

const PRESET_KEYS = {
  laterToday: "remind.preset.laterToday",
  tomorrow: "remind.preset.tomorrow",
  weekend: "remind.preset.weekend",
  nextWeek: "remind.preset.nextWeek",
  in1d: "remind.preset.in1d",
  in3d: "remind.preset.in3d",
  in1w: "remind.preset.in1w",
  in2w: "remind.preset.in2w",
} as const satisfies Record<RemindPresetId, string>;

export const presetLabel = (id: RemindPresetId): string => t(PRESET_KEYS[id]);

// ───────────────────────────── set and clear ─────────────────────────────

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Sets one reminder on these threads; a snack says when, with Undo (z) back to exactly what they had. */
export async function setReminder(threadIds: readonly number[], dueAt: number, kind: ReminderKind): Promise<boolean> {
  if (threadIds.length === 0) return false;
  let r: { rows: Reminder[]; replaced: Reminder[] };
  try {
    r = await client.call("reminders.set", { threadIds: [...threadIds], dueAt, kind });
  } catch (error) {
    snack.error(t("remind.failed"), { description: errorText(error) });
    return false;
  }
  const undo = registerUndo(() => client.call("reminders.restore", { drop: r.rows, put: r.replaced }).then(() => undefined));
  const count = r.rows.length;
  const when = reminderWhen(dueAt);
  snack.success(t(kind === "noReply" ? "remind.snack.setNoReply" : "remind.snack.set", { count, when }), {
    action: { label: t("common.undo"), name: t("remind.undoSet"), undo },
  });
  return true;
}

export async function clearReminder(threadIds: readonly number[]): Promise<void> {
  let cleared: Reminder[];
  try {
    cleared = (await client.call("reminders.clear", { threadIds: [...threadIds] })).cleared;
  } catch (error) {
    snack.error(t("remind.clearFailed"), { description: errorText(error) });
    return;
  }
  if (cleared.length === 0) return;
  const undo = registerUndo(() => client.call("reminders.restore", { drop: [], put: cleared }).then(() => undefined));
  snack.success(t("remind.snack.cleared", { count: cleared.length }), { action: { label: t("common.undo"), name: t("remind.undoClear"), undo } });
}

// ───────────────────────────── opening ends a due one ─────────────────────────────

/** what an open waits on before it counts (the mark-read dwell) */
export const OPEN_DWELL_MS = 450;
const opening: { timer: ReturnType<typeof setTimeout> | null } = { timer: null };

/**
 * The user opened this conversation (a click, Enter, j/k, a notification):
 * if its reminder is due, it ends once the conversation stayed on screen for
 * the dwell. A reload's first-row pick and the move to the next row after an
 * archive never call this: those aren't the user looking at it.
 */
export function noteOpen(id: number): void {
  if (opening.timer) clearTimeout(opening.timer);
  opening.timer = null;
  if (!useReminders.getState().byThread.get(id)?.due) return;
  opening.timer = setTimeout(() => {
    opening.timer = null;
    if (getApp().selectedId !== id || !readerShown() || !useReminders.getState().byThread.get(id)?.due) return;
    void client.call("reminders.clear", { threadIds: [id], dueOnly: true }).catch(() => {});
  }, OPEN_DWELL_MS);
}

/** The selection left a conversation the Inbox's top held only because it was open (its reminder ended): it goes to its place. */
useApp.subscribe((s, prev) => {
  if (prev.selectedId === null || s.selectedId === prev.selectedId || !inboxTop.ids.includes(prev.selectedId)) return;
  if (useReminders.getState().byThread.get(prev.selectedId)?.due) return;
  if (inPlainInbox(s)) void reloadList({ keepSelection: true });
});

// ───────────────────────────── the picker ─────────────────────────────

/** the reader's bell popover (h opens it while the reader shows the conversation) */
export const useRemindPopover = create<{ open: boolean }>(() => ({ open: false }));

/**
 * The picker for these threads (default: the selection), or for the open
 * conversation in the reader's popover. A "select all N" has no ids to set
 * reminders on: nothing opens.
 */
export function openRemind(o: { kind?: ReminderKind; custom?: boolean; ids?: number[] } = {}): void {
  let ids = o.ids;
  if (!ids) {
    const target = currentTargets();
    if ("scope" in target) return;
    ids = target.ids;
  }
  if (ids.length === 0) return;
  const s = getApp();
  if (!o.ids && !o.custom && ids.length === 1 && ids[0] === s.selectedId && readerShown() && document.querySelector("[data-testid=action-remind]")) {
    useRemindPopover.setState({ open: true });
    return;
  }
  setApp({ dialog: "remind", remindTarget: { ids, kind: o.kind ?? "always", custom: o.custom ?? false } });
}
