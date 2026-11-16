import { DIGEST_ROW_ID, type FeedRowId, type FollowupRow } from "@terno/core";
import { feedPlace, focusedFeedItem, focusFeedItem } from "~/lib/feed-focus";
import type { LeftRows } from "~/lib/actions";
import { actOnDated, actOnTask, type DatedRef, type TodayTask } from "~/lib/dated";
import { actOnFollowup } from "~/lib/followups";
import { closePage, currentPage, listLayout } from "~/lib/page";
import type { ReaderItem } from "~/lib/reader-items";
import { getApp, setApp, setAppOpened } from "~/state/app";
import { listKey, noteEdit, reloadList } from "~/state/list";
import { feedRow, feedRowsOfItem, readerHeld, rowOfThread, useFeedRow, useReaderChoice, useToday, type FeedRow } from "~/state/today";

type TaskAction = "done" | "dismiss" | "later";

/**
 * Plan 210 (iteration 2): rows that leave the feed at once (Done, Remove, Later on them), never their conversation's other
 * rows. The open one moves on, as after Archive: the row after it opens (else the one before, else nothing). Undo (the
 * snack's, z) brings them back with the next read, and the open row with them, when nothing was opened since.
 */
function leaveFeedRows(ids: readonly FeedRowId[]): LeftRows | undefined {
  const s = getApp();
  const { rows } = useToday.getState();
  const gone = new Set(ids.filter((id) => rows.some((r) => r.id === id)));
  if (!s.today || !gone.size) return undefined;
  const { opened } = useFeedRow.getState();
  const before = { opened, selectedId: s.selectedId };
  const open = feedRow(opened);
  // a read that started before this act may bring the row back: the list asks again (as `patchRows` does)
  noteEdit();
  useToday.setState({ rows: rows.filter((r) => !gone.has(r.id)) });
  if (open && gone.has(open.id) && s.selectedId === open.threadId) {
    if (listLayout() && currentPage() === "thread") closePage({ focus: true });
    else {
      const at = rows.indexOf(open);
      // (plan 210, iteration 4: never the automated section's page, which sits between the open part and Coming up)
      const stays = (r: FeedRow) => !gone.has(r.id) && r.threadId !== DIGEST_ROW_ID;
      const next = rows.slice(at + 1).find(stays) ?? rows.slice(0, at).reverse().find(stays);
      useFeedRow.setState(({ moves }) => ({ opened: next?.id ?? null, moves: moves + 1 }));
      // opened by the app, as Archive's next is: not read until chosen (Codex code review of iteration 2)
      setAppOpened(next ? next.threadId : null);
    }
  }
  const moved = useFeedRow.getState().moves;
  const where = { key: listKey(), selectedId: getApp().selectedId };
  const back = async () => {
    // left for another mailbox, or another conversation opened there since: nothing of What matters' is put back (Codex
    // code review, round 2); its next read brings the row
    if (!getApp().today || listKey() !== where.key) return;
    await reloadList({ keepSelection: true });
    // the open row back, unless another was opened since (Codex's design: a newer selection wins, a sibling row included)
    if (useFeedRow.getState().moves !== moved || getApp().selectedId !== where.selectedId || listKey() !== where.key || before.opened === null || !useToday.getState().rows.some((r) => r.id === before.opened)) return;
    useFeedRow.setState(({ moves }) => ({ opened: before.opened, moves: moves + 1 }));
    setAppOpened(before.selectedId);
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

/** The keys on to `next` once the row has gone, as after D (a frame: the feed draws the rows that are left). */
const keysOnTo = (next: FeedRowId | undefined): void => {
  if (next !== undefined) requestAnimationFrame(() => focusFeedItem(next));
};

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
