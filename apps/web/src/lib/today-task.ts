import { leaveRows, type LeftRows } from "~/lib/actions";
import { actOnDated, actOnTask, type DatedRef, type TodayTask } from "~/lib/dated";
import { getApp } from "~/state/app";
import { listKey, useList } from "~/state/list";
import { useToday } from "~/state/today";

type TaskAction = "done" | "dismiss" | "later";

/** The row leaves Today's list at once, when Today is what's shown and the row is in it. */
function leaving(threadId: number): LeftRows | undefined {
  const list = useList.getState();
  return getApp().today && list.itemsKey === listKey() && list.index.has(threadId) ? leaveRows([threadId]) : undefined;
}

/**
 * Plan 204 (after the second panel round): Done, Not a task and Later on a Today row's task. Done means gone: the row
 * leaves Today at once and the cursor moves on, as after Archive (it isn't held in place as a row that leaves on its own
 * is, revision 9: this one the user finished). Undo (the snack's, z) brings it back in its place, selected.
 */
export function actOnTodayRow(threadId: number, task: TodayTask, action: TaskAction, at?: number): Promise<void> {
  return actOnTask(task, action, at, leaving(threadId));
}

/**
 * The conversation's line acts on its own item; when that item is the one its Today row stands for, the row leaves as
 * it would from the row's own Done.
 */
export function actOnThreadItem(threadId: number, item: Pick<DatedRef, "id" | "revision">, action: "done" | "dismiss"): Promise<void> {
  const task = useToday.getState().tasks.get(threadId);
  return actOnDated(item, action, undefined, task?.kind === "dated" && task.item.id === item.id ? leaving(threadId) : undefined);
}

/**
 * Plan 204 (after the panel, fix 2): D on Today's selected row with a task is its Done; anywhere else, on a row without
 * one, or among several checked, it does nothing (false: the key is left alone).
 */
export function doneOnSelected(): boolean {
  const s = getApp();
  if (!s.today || s.selectedId === null || s.scope || (s.checked.size > 0 && !(s.checked.size === 1 && s.checked.has(s.selectedId)))) return false;
  const task = useToday.getState().tasks.get(s.selectedId);
  if (!task) return false;
  void actOnTodayRow(s.selectedId, task, "done");
  return true;
}
