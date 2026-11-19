import { dayKeyOf, DIGEST_ROW_ID, dueCutoff, promiseDay, type FeedRowId, type FollowupRow, type PartOfDay } from "@terno/core";
import { feedPlace, focusedFeedItem } from "~/lib/feed-focus";
import { dropFeedRows, feedBefore, keysOnTo, restoreFeedRow } from "~/lib/feed-leave";
import type { LeftRows } from "~/lib/actions";
import { actOnDated, actOnTask, type DatedRef, type TodayTask } from "~/lib/dated";
import { actOnFollowup } from "~/lib/followups";
import { changeOfItem, changeOfTask, openChange } from "~/lib/change";
import { handTo, othersOfTask, seenOfReaderItem, seenOfTask } from "~/lib/hand-to";
import type { ReaderItem } from "~/lib/reader-items";
import { getApp, setApp } from "~/state/app";
import { listKey, reloadList } from "~/state/list";
import { feedRow, feedRowsOfItem, readerHeld, rowOfThread, useFeedRow, useReaderChoice, useToday, type FeedRow } from "~/state/today";

type TaskAction = "done" | "dismiss" | "later";

/**
 * Rows that leave the feed at once (Done, Remove, Later on them), the open one moving on (`dropFeedRows`). Undo (the
 * snack's, z) brings them back with the next read, and the open row with them, when nothing was opened since.
 */
function leaveFeedRows(ids: readonly FeedRowId[]): LeftRows | undefined {
  // how it was open too (the user's own choice, or the app's; a Done that went on from the user's), so an Undo restores the
  // reader as the user had it and a Done after it goes on as it would have (Codex's code review of iteration 4)
  const before = feedBefore();
  if (!dropFeedRows(ids)) return undefined;
  const moved = useFeedRow.getState().moves;
  const where = { key: listKey(), selectedId: getApp().selectedId };
  const back = async () => {
    // left for another mailbox, or another conversation opened there since: nothing of What matters' is put back (Codex
    // code review, round 2); its next read brings the row
    if (!getApp().today || listKey() !== where.key) return;
    await reloadList({ keepSelection: true });
    if (listKey() === where.key) restoreFeedRow(before, moved, where.selectedId);
  };
  return {
    async undo(run) {
      await run();
      await back();
    },
    failed: () => void back(),
  };
}

/**
 * Plan 204 (after the second panel round): Done, Remove and Later on a What matters row's task. Done means gone: the row
 * leaves at once and the open one moves on, as after Archive (it isn't held in place as a row that leaves on its own is,
 * revision 9: this one the user finished). Undo brings it back in its place. Plan 210 (iteration 2): the row, by its id; a
 * merged row's act is on every item it is (the backend's one act).
 */
export function actOnTodayRow(rowId: FeedRowId, task: TodayTask, action: TaskAction, at?: number): Promise<void> {
  return actOnTask(task, action, at, leaveFeedRows([rowId]));
}

/** The feed's rows standing for this item, by their ids. */
const rowsOfItem = (source: "dated" | "promise", id: number): FeedRowId[] => feedRowsOfItem({ source, id }).map((r) => r.id);

/**
 * The conversation's line acts on its own item (Done, Remove, and Later to a moment); the feed's rows standing for it leave
 * as they would from the row's own act, with its Undo and a failure's way back.
 */
export function actOnThreadItem(_threadId: number, item: Pick<DatedRef, "id" | "revision"> & { text?: string | null }, action: TaskAction, at?: number): Promise<void> {
  return actOnDated(item, action, at, leaveFeedRows(rowsOfItem("dated", item.id)));
}

/**
 * The conversation's promise controls (Done, Later, Remove), as its item line (Codex code review): the feed's rows standing
 * for the promise leave as from the row's own Done; elsewhere, follow-ups' own act.
 */
export function actOnThreadPromise(row: FollowupRow, action: TaskAction, at?: number): Promise<void> {
  // the rows it is, its own or a merged one it's a member of (Codex code review of iteration 2), leave with its act
  const rows = rowsOfItem("promise", row.id);
  return actOnFollowup(row, action, at, rows.length ? leaveFeedRows(rows) : undefined);
}

/** Done, Later and Remove on the reader's item, its feed rows leaving with it (its line, and D, b and ⇧D while it leads by a choice made there). */
export function actOnReaderItem(threadId: number, item: ReaderItem, action: TaskAction, at?: number): Promise<void> {
  return item.source === "dated" ? actOnThreadItem(threadId, item.row, action, at) : actOnThreadPromise(item.row, action, at);
}

/**
 * Plan 210 (iteration 5, R7): the moment after which a reminder about the item in hand comes too late: its time, or its
 * day's end when it has none; null when it names no day or its moment has passed (any moment ahead will do). The palette's
 * Remind me never offers a preset past it ("Later today 1:00 PM" for a 12:30 reservation).
 */
export function remindLimit(target: { task: TodayTask } | { item: ReaderItem }, now = Date.now()): number | null {
  // iteration 5's code review: an untimed one's day ends at its part's end ("Friday morning": noon), as Missed reads it
  let at: { dueAt: number; timed: boolean; day: string; part: PartOfDay | null } | null = null;
  if ("task" in target) {
    const { task } = target;
    if (task.kind === "dated") at = task.item.dated ? { dueAt: task.dueAt, timed: task.item.timed, day: task.item.dueDay, part: task.item.part ?? null } : null;
    // plan 215: a conversation waiting on you has no moment of its own
    else if (task.kind === "waiting") at = null;
    else at = task.dated && task.dueAt !== undefined ? { dueAt: task.dueAt, timed: task.timed === true, day: dayKeyOf(task.dueAt), part: task.part ?? null } : null;
  } else if (target.item.source === "dated") {
    const r = target.item.row;
    at = r.dated && r.kind !== "ask" ? { dueAt: r.dueAt, timed: r.timed, day: r.dueDay, part: r.partOfDay ?? null } : null;
  } else {
    const r = target.item.row;
    const d = promiseDay(r, now);
    at = d.dated ? { dueAt: d.dueAt, timed: r.timed === true && d.dueAt === r.dueAt, day: dayKeyOf(d.dueAt), part: d.part } : null;
  }
  const limit = at === null ? null : at.timed ? at.dueAt : dueCutoff(at.day, at.part);
  return limit !== null && limit > now ? limit : null;
}

/** The reader's Later menu, opened (its button, b): it holds the app's keys while it's open, as the feed's does. */
export function openReaderLater(): void {
  useReaderChoice.setState({ later: true });
  setApp({ menuOpen: true });
}

/** The reader's Later menu closes (chosen, Esc, a click away, or its item gone). */
export function closeReaderLater(): void {
  if (!useReaderChoice.getState().later) return;
  useReaderChoice.setState({ later: false });
  setApp({ menuOpen: false });
}

/**
 * What D, b and ⇧D act on: What matters' row with a task (plan 204, after the panel, fix 2; plan 210's iteration 1 for b and
 * ⇧D), or the reader's item while it leads by a choice made there (iteration 3, code review). Anywhere else, on a row
 * without one, or among several checked, nothing (null: the key is left alone).
 */
function keyTarget(): { row: FeedRow & { task: TodayTask }; next: FeedRowId | undefined } | { threadId: number; item: ReaderItem } | null {
  const s = getApp();
  if (!s.today) return null;
  // plan 210 (Codex code review): in the feed, the row the keyboard is on (Tab to another, D finishes that one), else the
  // open one, else the one a conversation was just put away from
  const focused = focusedFeedItem();
  const one = (threadId: number) => !s.scope && (s.checked.size === 0 || (s.checked.size === 1 && s.checked.has(threadId)));
  // (iteration 3, code review) an item chosen in the reader with no row of its own leads there: the keys are its, never
  // the open row's item it took the place of, unless they're on another row of the feed
  const held = focused === null || focused === useFeedRow.getState().opened ? readerHeld(s.selectedId) : null;
  if (held && s.selectedId !== null) return one(s.selectedId) ? { threadId: s.selectedId, item: held } : null;
  const row = feedRow(focused ?? feedPlace()) ?? (s.selectedId !== null && s.selectedId !== DIGEST_ROW_ID ? rowOfThread(s.selectedId) : undefined);
  if (!row?.task || !one(row.threadId)) return null;
  // (Codex code review, round 2) the keyboard on another row than the open one: it goes on to the row after it (else the
  // one before), as the open one would, so a second D is that one's, never the open conversation's
  const { rows } = useToday.getState();
  const at = rows.indexOf(row);
  const elsewhere = focused === row.id && useFeedRow.getState().opened !== row.id;
  const next = elsewhere ? (rows[at + 1] ?? rows[at - 1])?.id : undefined;
  return { row: row as FeedRow & { task: TodayTask }, next };
}

/** D (Done) and ⇧D (Remove) on the key's row, the keys going on as from the open one. */
function actOnKeyTarget(action: "done" | "dismiss"): boolean {
  const target = keyTarget();
  if (!target) return false;
  if ("item" in target) void actOnReaderItem(target.threadId, target.item, action);
  else {
    void actOnTodayRow(target.row.id, target.row.task, action);
    keysOnTo(target.next);
  }
  return true;
}

export const doneOnSelected = (): boolean => actOnKeyTarget("done");

/** Plan 210 (iteration 1, the owner): ⇧D takes the item off What matters ("Remove"), with the same Undo as its menu's. */
export const removeOnSelected = (): boolean => actOnKeyTarget("dismiss");

/**
 * Plan 210 (iteration 1, the owner): b opens the row's Later, for the item as it is now. Opening it or leaving it changes
 * nothing; only a moment chosen there moves the item, as from its button.
 */
export function laterOnSelected(): boolean {
  const target = keyTarget();
  if (!target) return false;
  if ("item" in target) openReaderLater();
  else openLater(target.row.id, target.row.task, target.next);
  return true;
}

/**
 * Plan 210 (iteration 5): ⇧B opens Change… on the key's item, for it as it is now; one with no day to change (a person's
 * ask) leaves the key alone. Only a day set there moves the item, with its own Undo.
 */
export function changeOnSelected(): boolean {
  const target = keyTarget();
  const change = !target ? null : "item" in target ? changeOfItem(target.item) : changeOfTask(target.row.task);
  if (!change) return false;
  openChange(change);
  return true;
}

/** Plan 210 (iteration 5): ⇧F hands the key's item to someone, its forward opening in the reader as the menu's does. */
export function handOnSelected(): boolean {
  const target = keyTarget();
  if (!target) return false;
  if ("item" in target) {
    void handTo(seenOfReaderItem(target.item));
    return true;
  }
  const { task } = target.row;
  // plan 215: a conversation waiting on you is no item to hand on (⇧F left alone)
  if (task.kind === "waiting") return false;
  void handTo(seenOfTask(task), target.row.id, othersOfTask(task));
  return true;
}

/**
 * Plan 204 (after the panel, fix 10): Later's "Pick a date…", a moment of your own in its own window; `next`, where the
 * keys go once it's set (b from another row than the open one: Codex code review of plan 210's iteration 1).
 */
export function openTodayLater(rowId: FeedRowId, task: TodayTask, next?: FeedRowId): void {
  useToday.setState({ laterPick: { rowId, task, ...(next !== undefined ? { next } : {}) } });
  setApp({ dialog: "todayLater" });
}

/** The picker's moment: the act, for the task it opened for, and the keys on as from the menu's presets. */
export function laterFromPicker(pick: { rowId: FeedRowId; task: TodayTask; next?: FeedRowId }, at: number): void {
  void actOnTodayRow(pick.rowId, pick.task, "later", at);
  keysOnTo(pick.next);
}

const laterButton = (id: FeedRowId): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid=wm-feed] [data-row-id="${CSS.escape(id)}"] [data-testid=wm-later]`);

/**
 * Plan 210 (iteration 1): a row's Later, its presets where the feed draws the row (the menu its button opens), else the
 * picker a menu's "Pick a date…" opens. The task is kept as it is now (`laterMenu`, `laterPick`), so a reload while it's
 * open can't move the choice to another item; the act is revision-checked as any.
 */
export function openLater(rowId: FeedRowId, task: TodayTask, next?: FeedRowId): void {
  if (!laterButton(rowId)) return openTodayLater(rowId, task, next);
  // the menu holds the app's keys while it's open (D or e under it would reach the mail behind)
  useToday.setState({ laterMenu: { rowId, task, ...(next !== undefined ? { next } : {}) } });
  setApp({ menuOpen: true });
}

/** The Later menu closes (chosen, Esc, a click away, or its row gone): the app's keys are the app's again. */
export function closeLater(): void {
  if (!useToday.getState().laterMenu) return;
  useToday.setState({ laterMenu: null });
  setApp({ menuOpen: false });
}

/** A moment from the Later menu: the act, and the keys on to the next row when b came from another than the open one. */
export function laterFromMenu(rowId: FeedRowId, task: TodayTask, at: number): void {
  const next = useToday.getState().laterMenu?.next;
  closeLater();
  void actOnTodayRow(rowId, task, "later", at);
  keysOnTo(next);
}

/** The menu's "Pick a date…": the picker, for the same task, the keys' next row with it. */
export function pickFromMenu(rowId: FeedRowId, task: TodayTask): void {
  const next = useToday.getState().laterMenu?.next;
  closeLater();
  openTodayLater(rowId, task, next);
}
