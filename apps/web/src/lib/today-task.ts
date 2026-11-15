import type { FollowupRow } from "@terno/core";
import { focusedFeedItem, focusFeedItem, useFeedCursor } from "~/lib/feed-focus";
import { leaveRows, type LeftRows } from "~/lib/actions";
import { actOnDated, actOnTask, type DatedRef, type TodayTask } from "~/lib/dated";
import { actOnFollowup } from "~/lib/followups";
import { getApp, setApp } from "~/state/app";
import { listKey, useList } from "~/state/list";
import { useToday } from "~/state/today";

type TaskAction = "done" | "dismiss" | "later";

/** The row leaves Today's list at once, when Today is what's shown and the row is in it. */
function leaving(threadId: number): LeftRows | undefined {
  const list = useList.getState();
  return getApp().today && list.itemsKey === listKey() && list.index.has(threadId) ? leaveRows([threadId]) : undefined;
}

/**
 * Plan 204 (after the second panel round): Done, Remove and Later on a Today row's task. Done means gone: the row
 * leaves Today at once and the cursor moves on, as after Archive (it isn't held in place as a row that leaves on its own
 * is, revision 9: this one the user finished). Undo (the snack's, z) brings it back in its place, selected.
 */
export function actOnTodayRow(threadId: number, task: TodayTask, action: TaskAction, at?: number): Promise<void> {
  return actOnTask(task, action, at, leaving(threadId));
}

/**
 * The conversation's line acts on its own item (Done, Remove, and Later to a moment); when that item is the one its
 * Today row stands for, the row leaves as it would from the row's own act, with its Undo and a failure's way back.
 */
export function actOnThreadItem(threadId: number, item: Pick<DatedRef, "id" | "revision"> & { text?: string | null }, action: TaskAction, at?: number): Promise<void> {
  const task = useToday.getState().tasks.get(threadId);
  return actOnDated(item, action, at, task?.kind === "dated" && task.item.id === item.id ? leaving(threadId) : undefined);
}

/**
 * The conversation's promise controls (Done, Later, Remove), as its item line (Codex code review): on the promise
 * its Today row stands for, the row leaves as from the row's own Done; on any other, follow-ups' own act.
 */
export function actOnThreadPromise(row: FollowupRow, action: TaskAction, at?: number): Promise<void> {
  const task = useToday.getState().tasks.get(row.threadId);
  if (task?.kind === "promise" && task.id === row.id) return actOnTask({ ...task, revision: row.revision, text: row.kind === "promise" ? row.text : null }, action, at, leaving(row.threadId));
  return actOnFollowup(row, action, at);
}

/**
 * What D, b and ⇧D act on: What matters' item with a task (plan 204, after the panel, fix 2; plan 210's iteration 1 for
 * b and ⇧D). Anywhere else, on a row without one, or among several checked, nothing (null: the key is left alone).
 */
function keyTarget(): { id: number; task: TodayTask; next: number | undefined } | null {
  const s = getApp();
  // plan 210 (Codex code review): in the feed, the item the keyboard is on (Tab to another, D finishes that one), else
  // the open one, else the one a conversation was just put away from
  const id = s.today ? (focusedFeedItem() ?? s.selectedId ?? useFeedCursor.getState().id) : null;
  if (id === null || s.scope || (s.checked.size > 0 && !(s.checked.size === 1 && s.checked.has(id)))) return null;
  const task = useToday.getState().tasks.get(id);
  if (!task) return null;
  // (Codex code review, round 2) the keyboard on another item than the open one: it goes on to the item after it (else
  // the one before), as the open one would, so a second D is that one's, never the open conversation's
  const focused = id !== s.selectedId && focusedFeedItem() === id;
  const { items, index } = useList.getState();
  const at = index.get(id);
  const next = focused && at !== undefined ? (items[at + 1] ?? items[at - 1])?.id : undefined;
  return { id, task, next };
}

/** D (Done) and ⇧D (Remove) on the key's item, the keys going on as from the open one. */
function actOnKeyTarget(action: "done" | "dismiss"): boolean {
  const target = keyTarget();
  if (!target) return false;
  void actOnTodayRow(target.id, target.task, action);
  keysOnTo(target.next);
  return true;
}

export const doneOnSelected = (): boolean => actOnKeyTarget("done");

/** Plan 210 (iteration 1, the owner): ⇧D takes the item off What matters ("Remove"), with the same Undo as its menu's. */
export const removeOnSelected = (): boolean => actOnKeyTarget("dismiss");

/**
 * Plan 210 (iteration 1, the owner): b opens the item's Later, for the item as it is now. Opening it or leaving it changes
 * nothing; only a moment chosen there moves the item, as from its button.
 */
export function laterOnSelected(): boolean {
  const target = keyTarget();
  if (!target) return false;
  openLater(target.id, target.task, target.next);
  return true;
}

/** The keys on to `next` once the item has gone, as after D (a frame: the feed draws the rows that are left). */
const keysOnTo = (next: number | undefined): void => {
  if (next !== undefined) requestAnimationFrame(() => focusFeedItem(next));
};

/**
 * Plan 204 (after the panel, fix 10): Later's "Pick a date…", a moment of your own in its own window; `next`, where the
 * keys go once it's set (b from another item than the open one: Codex code review of plan 210's iteration 1).
 */
export function openTodayLater(threadId: number, task: TodayTask, next?: number): void {
  useToday.setState({ laterPick: { threadId, task, ...(next !== undefined ? { next } : {}) } });
  setApp({ dialog: "todayLater" });
}

/** The picker's moment: the act, for the task it opened for, and the keys on as from the menu's presets. */
export function laterFromPicker(pick: { threadId: number; task: TodayTask; next?: number }, at: number): void {
  void actOnTodayRow(pick.threadId, pick.task, "later", at);
  keysOnTo(pick.next);
}

const laterButton = (id: number): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid=wm-feed] [data-item-id="${id}"] [data-testid=wm-later]`);

/**
 * Plan 210 (iteration 1): an item's Later, its presets where the feed draws the item (the menu its button opens), else the
 * picker a menu's "Pick a date…" opens. The task is kept as it is now (`laterMenu`, `laterPick`), so a reload while it's
 * open can't move the choice to another item; the act is revision-checked as any.
 */
export function openLater(threadId: number, task: TodayTask, next?: number): void {
  if (!laterButton(threadId)) return openTodayLater(threadId, task, next);
  // the menu holds the app's keys while it's open (D or e under it would reach the mail behind)
  useToday.setState({ laterMenu: { threadId, task, ...(next !== undefined ? { next } : {}) } });
  setApp({ menuOpen: true });
}

/** The Later menu closes (chosen, Esc, a click away, or its item gone): the app's keys are the app's again. */
export function closeLater(): void {
  if (!useToday.getState().laterMenu) return;
  useToday.setState({ laterMenu: null });
  setApp({ menuOpen: false });
}

/** A moment from the Later menu: the act, and the keys on to the next item when b came from another than the open one. */
export function laterFromMenu(threadId: number, task: TodayTask, at: number): void {
  const next = useToday.getState().laterMenu?.next;
  closeLater();
  void actOnTodayRow(threadId, task, "later", at);
  keysOnTo(next);
}

/** The menu's "Pick a date…": the picker, for the same task, the keys' next item with it. */
export function pickFromMenu(threadId: number, task: TodayTask): void {
  const next = useToday.getState().laterMenu?.next;
  closeLater();
  openTodayLater(threadId, task, next);
}
