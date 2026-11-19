import { DIGEST_ROW_ID, type FeedRowId, type ThreadAction, type TodayWhy } from "@terno/core";
import { focusedFeedItem, focusFeedItem } from "~/lib/feed-focus";
import { closePage, currentPage, listLayout } from "~/lib/page";
import { getApp, getSelectionWriteRevision, openedByApp, setApp, setAppOpened, useApp } from "~/state/app";
import { listKey, noteEdit } from "~/state/list";
import { feedRow, useFeedRow, useToday, type FeedRow } from "~/state/today";

/** How the feed was before rows left it: what an Undo puts back (the open row, and whether the user or the app opened it). */
export interface FeedBefore {
  opened: FeedRowId | null;
  carried: FeedRowId | null;
  /** the feed's place with nothing open: the row the keys are on */
  cursor: FeedRowId | null;
  selectedId: number | null;
  byApp: boolean;
}

export function feedBefore(): FeedBefore {
  const s = getApp();
  const { opened, carried, cursor } = useFeedRow.getState();
  return { opened, carried, cursor, selectedId: s.selectedId, byApp: s.selectedId !== null && openedByApp(s.selectedId) };
}

/**
 * Plan 210 (iteration 2): rows leave What matters' feed at once, never their conversation's other rows. The open one moves
 * on, as after Archive: the row after it opens (else the one before, else nothing). Iteration 4 (the owner): the next row's
 * mail opens only when the user had the reader open by their own choice (a click, Enter, j/k, or a Done that went on from
 * such a one); one the app opened, the reader is put away and the feed is on the next row, its mail unopened. The row the
 * feed was put away on moves to the next likewise. False when none of them was in the feed.
 */
export function dropFeedRows(ids: readonly FeedRowId[]): boolean {
  const s = getApp();
  const { rows } = useToday.getState();
  const listed = new Set(rows.map((r) => r.id));
  const gone = new Set(ids.filter((id) => listed.has(id)));
  if (!s.today || !gone.size) return false;
  const open = feedRow(useFeedRow.getState().opened);
  // the keys on a row that's leaving go on with the feed's place (never to the page, the row's button gone)
  const focused = focusedFeedItem();
  const keysLeave = focused !== null && gone.has(focused);
  // a read that started before this act may bring the row back: the list asks again (as `patchRows` does)
  noteEdit();
  useToday.setState({ rows: rows.filter((r) => !gone.has(r.id)) });
  // (plan 210, iteration 4: never the automated section's page, which sits between the open part and Coming up)
  const stays = (r: FeedRow) => !gone.has(r.id) && r.threadId !== DIGEST_ROW_ID;
  const after = (at: number) => rows.slice(at + 1).find(stays) ?? rows.slice(0, at).reverse().find(stays);
  if (open && gone.has(open.id) && s.selectedId === open.threadId) {
    if (listLayout() && currentPage() === "thread") {
      closePage({ focus: true });
      return true;
    }
    const next = after(rows.indexOf(open));
    const byUser = !openedByApp(open.threadId) || useFeedRow.getState().carried === open.id;
    if (byUser || !next) {
      useFeedRow.setState(({ moves }) => ({ opened: next?.id ?? null, carried: next?.id ?? null, moves: moves + 1 }));
      // opened by the app, as Archive's next is: not read until chosen (Codex code review of iteration 2)
      setAppOpened(next ? next.threadId : null);
      if (keysLeave) keysOnTo(next?.id);
    } else {
      useFeedRow.setState(({ moves }) => ({ opened: null, cursor: next.id, carried: null, moves: moves + 1 }));
      setApp({ selectedId: null });
      keysOnTo(next.id);
    }
  } else {
    // the keys' row gone with nothing open (or the keys on another row than the open one): the keys and the place go on to
    // the next row, as from the open one
    const { cursor } = useFeedRow.getState();
    const from = keysLeave ? focused : cursor !== null && gone.has(cursor) ? cursor : null;
    if (from !== null) {
      const next = after(rows.findIndex((r) => r.id === from));
      if (from === cursor || s.selectedId === null) useFeedRow.setState({ cursor: next?.id ?? null });
      if (keysLeave) keysOnTo(next?.id);
    }
  }
  return true;
}

/**
 * The open row back as it was before rows left, once the list holds it again: unless another was opened since (Codex's
 * design: a newer selection wins, a sibling row included). `moved`: the feed's moves when they left; `selectedId`, the
 * conversation the act left open.
 */
export function restoreFeedRow(before: FeedBefore, moved: number, selectedId: number | null): void {
  if (useFeedRow.getState().moves !== moved || getApp().selectedId !== selectedId || before.opened === null) return;
  reopenFeedRow(before, () => {
    // the keys the act moved on to the next row come back with the open one: D is its own again, as the reader and the
    // palette say (Codex code review of plan 216, #1)
    const keys = focusedFeedItem();
    if (keys !== null && keys !== before.opened) keysOnTo(before.opened ?? undefined);
  });
}

/** How many of the feed's answers a put-back waits through for its row before it gives up. */
const BACK_WITHIN = 3;

/**
 * The feed as it was before rows left (an Undo, once the list holds them again; the caller has checked nothing newer was
 * chosen): the open row and its conversation, opened as it was (by the user, or the app), else, with nothing open, the
 * keys' row; then `then` (the keys back). The read after an Undo can answer before the backend has the conversation in
 * What matters again (its facts follow the mailbox): the put-back waits for the answer that holds the row, a few at
 * most, and only while nothing newer is chosen (a row, a check, the keys' place, another mailbox): the first of those
 * ends it, whatever store it's in.
 */
export function reopenFeedRow(before: FeedBefore, then?: () => void): void {
  const want = before.opened ?? before.cursor;
  const here = () => want === null || useToday.getState().rows.some((r) => r.id === want);
  const apply = () => {
    useFeedRow.setState(({ moves, cursor }) => ({ opened: before.opened, carried: before.carried, cursor: before.opened === null && want !== null ? want : cursor, moves: moves + 1 }));
    if (before.byApp) setAppOpened(before.selectedId);
    else setApp({ selectedId: before.selectedId });
    then?.();
  };
  if (here()) return apply();
  const app = getApp();
  const was = { key: listKey(), revision: getSelectionWriteRevision(), checked: app.checked, scope: app.scope, selectedId: app.selectedId, ...useFeedRow.getState() };
  const still = () => {
    const s = getApp();
    const f = useFeedRow.getState();
    return s.today && listKey() === was.key && getSelectionWriteRevision() === was.revision && s.checked === was.checked && s.scope === was.scope && s.selectedId === was.selectedId && f.moves === was.moves && f.cursor === was.cursor && f.opened === was.opened;
  };
  let answers = 0;
  const offs: (() => void)[] = [];
  const stop = () => offs.splice(0).forEach((off) => off());
  const check = () => {
    if (!still()) stop();
  };
  offs.push(
    useApp.subscribe(check),
    useFeedRow.subscribe(check),
    useToday.subscribe((state, prior) => {
      if (state.rows === prior.rows) return;
      if (!still() || ++answers > BACK_WITHIN) return stop();
      if (!here()) return;
      stop();
      apply();
    }),
  );
}

/** The keys on to `next` once the row has gone, as after D (a frame: the feed draws the rows that are left). */
export const keysOnTo = (next: FeedRowId | undefined): void => {
  if (next !== undefined) requestAnimationFrame(() => focusFeedItem(next));
};

/**
 * What matters' rows a thread action takes out of it (plan 204): Trash and Spam end everything of the conversation (Today
 * shows nothing in them, the history neither); Archive what's there because it's in the Inbox, a person waiting on your
 * answer, and (plan 218) a promise of yours, whose follow-up an archive ends: a row all of whose members are promises. A
 * task (a bill), a reminder and a history line stay: the bill still has to be paid after its mail is filed.
 */
export function feedRowsLeaving(action: ThreadAction, threadIds: readonly number[]): FeedRowId[] {
  if (action !== "archive" && action !== "trash" && action !== "spam") return [];
  const acted = new Set(threadIds);
  return useToday
    .getState()
    .rows.filter((r) => acted.has(r.threadId) && r.threadId !== DIGEST_ROW_ID && (action !== "archive" || (!r.line && (r.entry?.why.kind === "waiting" || archivedPromise(r.entry?.why)))))
    .map((r) => r.id);
}

/** Plan 218: a row of your promises only (a merged bill or request stays, its dated member then leads it). */
const archivedPromise = (why: TodayWhy | undefined): boolean => why?.kind === "promise" && (why.members ?? []).every((m) => m.source === "promise");

/**
 * A conversation open beside the feed that is none of its rows (opened from elsewhere), taken away by an action: on to the
 * feed's first open row, opened by the app as Archive's next is (unread until chosen), else nothing open.
 */
export function onToFirstRow(): void {
  const first = useToday.getState().rows.find((r) => r.threadId !== DIGEST_ROW_ID && !r.line);
  useFeedRow.setState(({ moves }) => ({ opened: first?.id ?? null, carried: null, moves: moves + 1 }));
  setAppOpened(first?.threadId ?? null);
}
