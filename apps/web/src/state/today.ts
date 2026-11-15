import { todayAvailable } from "~/lib/ai";
import { addressKey, dayKeyOf, DIGEST_FEED_ROW, DIGEST_ROW_ID, inDayOrder, type DigestItem, type DigestRow, type FeedRowId, type HistoryKey, type ItemRef, type TodayCounts, type TodayGroupKind, type TodayHistoryItem, type TodayItem, type TodayList, type TodayWhy, type ThreadSummary } from "@terno/core";
import { t } from "@terno/i18n";
import { create } from "zustand";
import { alsoLine, taskOf, type TodayTask } from "~/lib/dated";
import { client } from "~/rpc/connection";
import type { Undo } from "~/lib/snack";
import { getApp, navigate, setApp, useApp } from "./app";
import { reloadList } from "./list";

/**
 * Plan 145: Today's shape on the list: which rows begin a section, and the digest. Rows themselves are the ordinary
 * thread rows, with what they say in the snippet's place.
 */
/**
 * Plan 210: the feed's headings: Missed, Today, a day ahead (`day:YYYY-MM-DD`, Coming up's joining their day while it's
 * open: the owner, by day, not by kind), and the history below them.
 */
export type FeedGroupKind = "missed" | "today" | `day:${string}` | "history";

/** A feed heading's day ("YYYY-MM-DD"), or null for Missed, Today and the history. */
export const groupDay = (kind: FeedGroupKind): string | null => (kind.startsWith("day:") ? kind.slice(4) : null);

/** The headings' order: Missed, Today, the days in theirs, the history (as text: a day's key sorts as its day). */
const rankOf = (kind: FeedGroupKind): string => (kind === "missed" ? "0" : kind === "today" ? "1" : kind === "history" ? "3" : `2${kind.slice(4)}`);

/**
 * Plan 210 (iteration 2, the owner: "a row per item"): one of the feed's rows, by its own identity (`FeedRowId`: an item's,
 * a waiting conversation's, a reminder's, the digest's), never its conversation's: two items of one conversation are two
 * rows, each opened, walked by j/k, held and acted on apart. Its conversation is what opening it shows.
 */
export interface FeedRow {
  id: FeedRowId;
  /** the conversation it opens (the digest's row: `DIGEST_ROW_ID`) */
  threadId: number;
  /** its heading; none for the digest's */
  group?: FeedGroupKind;
  /** an open-part row: what the backend said of it */
  entry?: TodayItem;
  /** a history line */
  line?: TodayHistoryItem;
  /** what its Done, Remove, Later and D act on; none for a waiting row, a reminder, a history line or a held row */
  task?: TodayTask;
  /** one of Coming up's, under its day while Coming up is open: drawn quietly */
  ahead?: boolean;
  /** no longer the backend's (done, settled, moved) but kept where it was while it's open or checked: words only */
  held?: boolean;
}

/**
 * Plan 161: what the digest page was left as, so opening a newsletter and coming back finds it so: the rows unticked
 * (ticked, for automated mail) and where it was scrolled. Its day's: a new digest starts afresh.
 */
export interface DigestPick {
  day: string;
  toggled: ReadonlySet<number>;
  scroll: number;
  /** what this page archived, an entry per Archive: those rows leave it, and its header says it's done (plan 161, pass 2) */
  done?: readonly DigestDone[] | null;
  /** the row a newsletter was opened from: the cursor again on the way back */
  from?: number | null;
  /**
   * Plan 162 (after ai162-r02): what was opened from the page, recorded the moment it opens. Opened is read and stays in
   * the Inbox (plan 145), so it's out of Archive whichever way the page is come back to; it was learnt from the backend's
   * read mark, which lands after the reader's dwell and reached the page only on a list refresh.
   */
  opened?: ReadonlySet<number>;
}

/** One Archive from the page: the ids it really archived (they stay out of its list until its Undo), and that Undo (the snack's runs the same one). */
export interface DigestDone {
  ids: readonly number[];
  undo: Undo | null;
}

interface TodayState {
  /**
   * plan 210 (iteration 2): the feed's rows in order (the open part, held rows where they were, the digest's, the history),
   * each by its own id; the list keeps their conversations once each (`useList`), for what acts on conversations
   */
  rows: readonly FeedRow[];
  /** plan 210 (iteration 2): the header's numbers ("6 today · 8 this week"), the backend's projection's */
  counts: TodayCounts;
  /** plan 204: what Coming up holds, shown or not (never counted) */
  comingUp: number;
  /** plan 204: Coming up open under the rest (closed by default; remembered on this machine) */
  comingUpOpen: boolean;
  /** plan 204 (after the panel, fix 10): the row whose task Later's "Pick a date…" is choosing a moment for */
  laterPick: { rowId: FeedRowId; task: TodayTask; next?: FeedRowId } | null;
  /**
   * plan 210 (iteration 1): the feed item whose Later menu is open (its button, or b), with the task as it was when it
   * opened: a reload meanwhile can't move its presets to another item; `next`, where the keys go once it's acted on
   */
  laterMenu: { rowId: FeedRowId; task: TodayTask; next?: FeedRowId } | null;
  /** plan 210 (iteration 2): the row the right-click menu was opened on, whose task its Done, Remove and Later are */
  menuRow: FeedRowId | null;
  digest: DigestRow | null;
  /** the conversation opened from the digest page: its Back returns there, and only it shows one (plan 161) */
  fromDigest: number | null;
  pick: DigestPick | null;
  /** owner's decisions (2): newsletters the reader sent to Trash or Spam on the way back, so their row says so, not "Archived" */
  movedTo: ReadonlyMap<number, "trash" | "spam">;
  /**
   * Plan 166: senders just said not to be newsletters (address keys), left out of every view of the digest at once, before
   * the backend's read agrees (and whatever an older read brings), until their Undo.
   */
  notNewsletters: ReadonlySet<string>;
}

/** Plan 204: Coming up's open or closed, a convenience of this machine's: storage can be missing or refuse. */
const COMING_UP_KEY = "terno.today.comingUp";
function storedComingUp(): boolean {
  try {
    return localStorage.getItem(COMING_UP_KEY) === "open";
  } catch {
    return false;
  }
}

export const useToday = create<TodayState>(() => ({ rows: [], counts: { missed: 0, today: 0, thisWeek: 0 }, comingUp: 0, comingUpOpen: storedComingUp(), laterPick: null, laterMenu: null, menuRow: null, digest: null, fromDigest: null, pick: null, movedTo: new Map(), notNewsletters: new Set() }));

/**
 * Plan 210 (iteration 2): which row the feed has open, and the one a conversation was put away from (Esc, the reader's
 * Close, a second click), where j/k go on from. The app's `selectedId` stays the open conversation; this says which of its
 * rows. `moves` counts the feed's own selections, so an Undo restores its row only when none came since.
 */
export const useFeedRow = create<{ opened: FeedRowId | null; cursor: FeedRowId | null; moves: number }>(() => ({ opened: null, cursor: null, moves: 0 }));

/** The feed opens this row (its conversation is the app's to open), or none. */
export function openFeedRow(id: FeedRowId | null): void {
  useFeedRow.setState(({ moves }) => ({ opened: id, ...(id !== null ? { cursor: null } : {}), moves: moves + 1 }));
}

/** A row by its id, from the rows loaded. */
export const feedRow = (id: FeedRowId | null | undefined): FeedRow | undefined => (id == null ? undefined : useToday.getState().rows.find((r) => r.id === id));

/**
 * The row of this conversation the feed means: the right-click menu's (`menuRow`), else the open one, else its first with
 * a task. Plan 210 (iteration 2): what the menu's, the palette's and the reader's Done, Remove and Later act on.
 */
function pickRow(rows: readonly FeedRow[], threadId: number | null | undefined, prefer: readonly (FeedRowId | null)[]): FeedRow | undefined {
  if (threadId == null) return undefined;
  for (const id of prefer) {
    const r = id === null ? undefined : rows.find((x) => x.id === id);
    if (r?.threadId === threadId) return r;
  }
  return rows.find((r) => r.threadId === threadId && r.task);
}

export const rowOfThread = (threadId: number | null | undefined): FeedRow | undefined => pickRow(useToday.getState().rows, threadId, [useToday.getState().menuRow, useFeedRow.getState().opened]);

/**
 * Plan 204 (after the panel): a What matters row's task for a conversation, with its row, only while What matters is shown.
 * Plan 210 (iteration 2): the right-click menu's is the row it was opened on (`from: "menu"`); the palette's, the open row.
 */
export function useTodayTask(threadId: number | null | undefined, from: "menu" | "open" = "open"): { rowId: FeedRowId; task: TodayTask } | undefined {
  const opened = useFeedRow((s) => s.opened);
  const row = useToday((s) => pickRow(s.rows, threadId, from === "menu" ? [s.menuRow, opened] : [opened]));
  const today = useApp((s) => s.today);
  return today && row?.task ? { rowId: row.id, task: row.task } : undefined;
}

/**
 * Plan 210 (iteration 2): the items the feed's open row is, while it's this conversation's: what the reader's line
 * highlights (a merged row's every member; a history line's closed item). Empty otherwise.
 */
export function useFeedTarget(threadId: number): readonly ItemRef[] {
  const opened = useFeedRow((s) => s.opened);
  const row = useToday((s) => (opened === null ? undefined : s.rows.find((r) => r.id === opened)));
  const today = useApp((s) => s.today);
  if (!today || row?.threadId !== threadId) return NO_TARGET;
  if (row.line) return [row.line.item];
  const members = row.entry?.why.members;
  if (members) return members;
  const task = row.task;
  return task?.kind === "dated" ? [{ source: "dated", id: task.item.id }] : task?.kind === "promise" ? [{ source: "promise", id: task.id }] : NO_TARGET;
}
const NO_TARGET: readonly ItemRef[] = [];

/** Plan 204: Coming up opens under the rest, or closes; the list is read again with it (held rows and the selection kept). */
export function setComingUpOpen(open: boolean): void {
  try {
    localStorage.setItem(COMING_UP_KEY, open ? "open" : "closed");
  } catch {
    // remembered for this session only
  }
  useToday.setState({ comingUpOpen: open });
  if (getApp().today) void reloadList({ keepSelection: true });
}

/** Plan 166: an item's sender, as the list of senders that aren't newsletters keys it. */
export const senderKey = (item: Pick<DigestItem, "fromEmail">): string => addressKey(item.fromEmail ?? "");

/** Plan 166: the digest without these senders: its items, and what it counts (still to archive, opened). */
export function withoutSenders(digest: DigestRow, keys: ReadonlySet<string>): DigestRow {
  if (!keys.size) return digest;
  const gone = new Set(digest.items.filter((i) => keys.has(senderKey(i))).map((i) => i.threadId));
  if (!gone.size) return digest;
  return { ...digest, items: digest.items.filter((i) => !gone.has(i.threadId)), liveIds: digest.liveIds.filter((id) => !gone.has(id)), readIds: digest.readIds?.filter((id) => !gone.has(id)) };
}

/** Plan 166: "Not a newsletter": out of the digest everywhere at once (the page, Today's header), until `letBackIn`. */
export function leaveOut(key: string): void {
  useToday.setState(({ notNewsletters, digest }) => ({ notNewsletters: new Set([...notNewsletters, key]), digest: digest && withoutSenders(digest, new Set([key])) }));
}

/** Plan 166: its Undo, or Settings' Remove: the rows come back with the next read. */
export function letBackIn(key: string): void {
  useToday.setState(({ notNewsletters }) => {
    const next = new Set(notNewsletters);
    next.delete(key);
    return { notNewsletters: next };
  });
}

/** The page's pick for this day: what was left, or nothing toggled. */
export function digestPick(day: string): DigestPick {
  const held = useToday.getState().pick;
  return held?.day === day ? held : { day, toggled: new Set(), scroll: 0 };
}

/** What the page was left as; the day's other parts (what it archived, where it was opened from) stay unless given. */
export const keepDigestPick = (pick: DigestPick): void => useToday.setState((s) => ({ pick: s.pick?.day === pick.day ? { ...s.pick, ...pick } : pick }));

/**
 * Plan 162 (after ai162-r02): the digest page's own keys, the list's (j/k move, x ticks, Enter opens; Esc puts the
 * page away, as What matters' feed puts away a conversation, plan 210), while it has them: focus in the page, or nowhere with the page on screen. Set by the page while it's mounted.
 */
export const digestKeys: { current: { has: () => boolean; step: (delta: 1 | -1) => void; toggle: () => void; open: () => void } | null } = { current: null };

/** The digest page's keys, when it has them. */
export const digestHasKeys = (): boolean => digestKeys.current?.has() === true;

/** Plan 162 (after ai162-r02): a newsletter opened from the page: kept, where the page was kept, then shown. */
export function openFromDigest(day: string, threadId: number, scroll: number, toggled: ReadonlySet<number>): void {
  const pick = digestPick(day);
  keepDigestPick({ day, toggled, scroll, from: threadId, opened: new Set([...(pick.opened ?? []), threadId]) });
  useToday.setState({ fromDigest: threadId });
  setApp({ selectedId: threadId });
}

/** Plan 161: Esc, or "Back to the digest", from the newsletter the digest opened: back to the page. */
export function backToDigest(): boolean {
  const back = useToday.getState().fromDigest;
  const s = getApp();
  if (back === null || !s.today || s.selectedId !== back) return false;
  useToday.setState({ fromDigest: null });
  setApp({ selectedId: DIGEST_ROW_ID });
  return true;
}

/**
 * Plan 145, owner's decisions (2): Archive, Trash or Spam on the newsletter the digest opened goes back to the page, not
 * on to Today's first conversation: its row is shown archived at once (the page's read and the list's refresh confirm
 * it), and the way back restores where the page was and focus on that row. False when the reader holds anything else.
 */
export function leaveToDigest(targets: readonly number[], action: "archive" | "trash" | "spam"): boolean {
  const back = useToday.getState().fromDigest;
  const s = getApp();
  if (back === null || !s.today || s.selectedId !== back || !targets.includes(back)) return false;
  useToday.setState(({ digest, movedTo }) => {
    const moved = new Map(movedTo);
    if (action === "archive") moved.delete(back);
    else moved.set(back, action);
    return { movedTo: moved, digest: digest && { ...digest, liveIds: digest.liveIds.filter((id) => id !== back), readIds: digest.readIds?.filter((id) => id !== back) } };
  });
  return backToDigest();
}

/** Its Undo, exact: the newsletter open again from the digest, with its way back, the row it came from, and what that row said before. */
export function reopenFromDigest(threadId: number, was?: "trash" | "spam"): void {
  useToday.setState(({ pick, movedTo }) => {
    const moved = new Map(movedTo);
    if (was) moved.set(threadId, was);
    else moved.delete(threadId);
    return { fromDigest: threadId, pick: pick && { ...pick, from: threadId, opened: new Set([...(pick.opened ?? []), threadId]) }, movedTo: moved };
  });
  setApp({ selectedId: threadId });
}

/** At boot, once there's a connection to listen on. */
export function installToday(): void {
  // the digest moved on, or what's automated did: only Today shows it
  client.on("todayDigest", () => {
    if (getApp().today) void reloadList({ keepSelection: true });
  });
  // plan 204: a dated item came, was done, moved, or its time came round (the backend's one timer)
  client.on("todayChanged", () => {
    if (getApp().today) void reloadList({ keepSelection: true });
  });

  // plan 210 (iteration 2): the feed's open row is one of the open conversation's: another conversation opened by other
  // means (the reader's arrows, a search, a link) opens its first row; none open, none
  useApp.subscribe((s, prev) => {
    if (s.selectedId === prev.selectedId) return;
    const { opened } = useFeedRow.getState();
    // the digest's page (however it came back: Esc from a newsletter it opened too) is the digest's row
    const want = s.selectedId === null ? null : s.selectedId === DIGEST_ROW_ID ? DIGEST_FEED_ROW : undefined;
    if (want !== undefined) {
      if (opened !== want) useFeedRow.setState({ opened: want });
      return;
    }
    if (feedRow(opened)?.threadId === s.selectedId) return;
    useFeedRow.setState(({ moves }) => ({ opened: useToday.getState().rows.find((r) => r.threadId === s.selectedId)?.id ?? null, moves: moves + 1 }));
  });
  // no provider any more: no row, no list. The digest's data stays until Clear AI data.
  useApp.subscribe((s) => {
    // plan 147: a way back to the digest goes with it, and whatever brings Today back (a preview's Cancel) leaves again.
    // Plan 161: so does leaving Today, or opening anything but the newsletter it was for
    const back = useToday.getState().fromDigest;
    if (back !== null && ((s.settings && !todayAvailable(s)) || !s.today || (s.selectedId !== back && s.selectedId !== DIGEST_ROW_ID))) useToday.setState({ fromDigest: null });
    if (!s.today) return;
    if (s.settings && !todayAvailable(s)) navigate({ view: "inbox" });
  });
}

/** Plan 162 (after ai162-r02): what's still in the Inbox, read or not: the page lists them all (the row counted the unread, "1" beside 4) */
const inInbox = (digest: DigestRow): number => digest.liveIds.length + (digest.readIds?.length ?? 0);

/** What the digest's row says, and the header's way to it (plan 161). */
export const digestLabel = (digest: DigestRow): string =>
  digest.state === "pending" ? t("today.digest.preparing") : digest.state === "failed" ? t("today.digest.failedShort") : digest.automated ? t("today.digest.automatedRow", { count: digest.liveIds.length }) : inInbox(digest) ? t("today.digest.row", { count: inInbox(digest) }) : t("today.digest.archivedRow", { count: Math.max(0, digest.items.length - (digest.readIds?.length ?? 0)) });

/** A promise in Coming up or Missed names a day (only dated ones are placed there), whatever an older backend said of it. */
const dayKnown = (why: TodayWhy, kind: TodayGroupKind): TodayWhy => (why.promise && why.promise.dated === undefined && (kind === "comingUp" || why.missed) ? { ...why, promise: { ...why.promise, dated: true } } : why);

/** Plan 204 (after the panel, revision 10): the digest's place in the list, its last option; no thread has its id (it's never checked or acted on). */
function digestThread(): ThreadSummary {
  return { id: DIGEST_ROW_ID, accountId: 0, subject: t("today.newsletters"), snippet: "", fromName: t("today.newsletters"), fromEmail: "", lastDate: 0, messageCount: 1, unread: false, starred: false, hasAttachments: false, categoryIds: [], inInbox: false, inSpam: false, inTrash: false } as unknown as ThreadSummary;
}

/**
 * Plan 210: the sections as the feed's groups, in order: Missed, Today, then a group per day ahead; while it's open, Coming
 * up's rows join their day's (one whose day is already here, Today's), in the day's one order (`inDayOrder`).
 */
function feedGroups(list: TodayList, open: boolean): { kind: FeedGroupKind; items: { item: TodayItem; section: TodayGroupKind }[] }[] {
  const today = dayKeyOf(list.now || Date.now());
  const groups = new Map<FeedGroupKind, { item: TodayItem; section: TodayGroupKind }[]>();
  for (const section of list.sections) {
    if (section.kind === "comingUp" && !open) continue;
    const day = section.day ?? null;
    const kind: FeedGroupKind = section.kind === "missed" ? "missed" : day === null || day <= today ? "today" : `day:${day}`;
    const rows = groups.get(kind) ?? [];
    for (const item of section.items) rows.push({ item, section: section.kind });
    groups.set(kind, rows);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (rankOf(a) < rankOf(b) ? -1 : rankOf(a) > rankOf(b) ? 1 : 0))
    .map(([kind, items]) => {
      // a day with Coming up's rows in it: the backend's one order inside a day (plan 210, iteration 1: tasks, your
      // promises, people, then plans by their time), ties as they came
      if (kind !== "missed" && items.some((r) => r.section === "comingUp") && items.some((r) => r.section !== "comingUp")) {
        const order = new Map(items.map((r, i) => [r, i]));
        items.sort((a, b) => inDayOrder(a.item.why, b.item.why, kind !== "today") || order.get(a)! - order.get(b)!);
      }
      return { kind, items };
    });
}

/**
 * The sections as one list, in their groups and all of them (plan 204: no cap); Coming up only while it's open (plan 210:
 * under their days). Held rows stay where they were until the selection lets go (revision 9).
 */
export function flattenToday(list: TodayList, before: readonly ThreadSummary[]): ThreadSummary[] {
  const answer = todayAnswer(list, before);
  answer.publish();
  return answer.items;
}

/**
 * The rows the feed holds where they are while they leave the backend's answer (revision 9): the open one, and the rows of
 * checked conversations. Plan 210 (iteration 2): by their ids; a history line is the history's, never held.
 */
export function heldRows(): FeedRowId[] {
  const s = getApp();
  const { opened } = useFeedRow.getState();
  const open = feedRow(opened);
  const ids = new Set<FeedRowId>();
  if (open && !open.line && open.threadId === s.selectedId && open.threadId !== DIGEST_ROW_ID) ids.add(open.id);
  if (s.checked.size) for (const r of useToday.getState().rows) if (!r.line && s.checked.has(r.threadId) && r.threadId !== DIGEST_ROW_ID) ids.add(r.id);
  return [...ids].slice(0, 500);
}

/**
 * Plan 210 (iteration 2): an answer as the feed's rows and the list's threads (each conversation once, in the rows' order),
 * its rows published only when asked (Codex code review of plan 210): the list publishes them with its threads, in the
 * commit that shows them, so an answer it drops changes nothing.
 */
export function todayAnswer(list: TodayList, before: readonly ThreadSummary[]): { items: ThreadSummary[]; publish: () => void } {
  const open = useToday.getState().comingUpOpen;
  const comingUp = list.sections.reduce((n, x) => n + (x.kind === "comingUp" ? x.items.length : 0), 0);
  const rows: FeedRow[] = [];
  for (const group of feedGroups(list, open)) {
    for (const { item, section } of group.items) {
      const why = dayKnown(item.why, section);
      const task = taskOf(why);
      const entry = why === item.why ? item : { ...item, why };
      rows.push({ id: item.id, threadId: item.thread.id, group: group.kind, entry, ...(task ? { task: item.also ? { ...task, also: alsoLine(item.also) } : task } : {}), ...(section === "comingUp" ? { ahead: true } : {}) });
    }
  }
  // held rows where they were: after the nearest row before them that's still here, in their own group (a row the
  // selection keeps, words only: what it was is no longer the backend's to act on)
  const prior = useToday.getState().rows;
  const keep = new Set(heldRows());
  const here = new Set(rows.map((r) => r.id));
  prior.forEach((was, i) => {
    if (!keep.has(was.id) || here.has(was.id)) return;
    let at = 0;
    for (let k = i - 1; k >= 0; k--) {
      const idx = rows.findIndex((r) => r.id === prior[k]!.id);
      if (idx >= 0) {
        at = idx + 1;
        break;
      }
    }
    const { task: _task, ...words } = was;
    rows.splice(at, 0, { ...words, held: true });
    here.add(was.id);
  });
  // plan 204 (after the panel, revision 10): the digest is the open part's last row, under no heading of its own
  if (list.digest) rows.push({ id: DIGEST_FEED_ROW, threadId: DIGEST_ROW_ID });
  // plan 210: the history after the automated section, its first page (or as deep as the list had it): a line per item
  for (const line of list.history?.items ?? []) {
    if (here.has(line.id)) continue;
    here.add(line.id);
    rows.push({ id: line.id, threadId: line.thread.id, group: "history", line });
  }
  // the list's threads: each once, in the rows' order, as the backend or the list had them
  const threads = new Map<number, ThreadSummary>();
  const had = new Map(before.map((t) => [t.id, t]));
  for (const section of list.sections) for (const item of section.items) threads.set(item.thread.id, item.thread);
  for (const line of list.history?.items ?? []) if (!threads.has(line.thread.id)) threads.set(line.thread.id, line.thread);
  const items: ThreadSummary[] = [];
  const listed = new Set<number>();
  for (const r of rows) {
    if (listed.has(r.threadId)) continue;
    const thread = r.threadId === DIGEST_ROW_ID ? digestThread() : (threads.get(r.threadId) ?? had.get(r.threadId));
    if (!thread) continue;
    listed.add(r.threadId);
    items.push(thread);
  }
  const shown = rows.filter((r) => listed.has(r.threadId));
  const publish = () => useToday.setState(({ notNewsletters }) => ({ rows: shown, counts: list.counts, comingUp, digest: list.digest && withoutSenders(list.digest, notNewsletters) }));
  return { items, publish };
}

/**
 * Conversations left the list before it reloads (Archive, anything `patchRows` takes out): their rows go with them, every
 * row of each (Codex code review: the headings follow the rows that are left).
 */
export function todayRowsLeft(items: readonly ThreadSummary[]): void {
  if (!getApp().today) return;
  const here = new Set(items.map((t) => t.id));
  useToday.setState(({ rows }) => ({ rows: rows.filter((r) => here.has(r.threadId)) }));
}

/**
 * Plan 210: lines of a history page the list has just taken (in the commit that shows their threads): they join the rows
 * once each, by their ids, whatever conversation they're of. A page's key travels as the list's cursor, never kept here,
 * so a page the list drops moves nothing (Codex code review).
 */
export function publishHistory(fresh: readonly TodayHistoryItem[]): void {
  if (!fresh.length) return;
  useToday.setState(({ rows }) => {
    const have = new Set(rows.map((r) => r.id));
    const more = fresh.filter((line) => !have.has(line.id) && (have.add(line.id), true)).map((line): FeedRow => ({ id: line.id, threadId: line.thread.id, group: "history", line }));
    return more.length ? { rows: [...rows, ...more] } : {};
  });
}

/** Plan 210: the deepest history line the feed holds, what a reload asks down to (so it keeps the depth it had). */
export function historyThrough(): HistoryKey | null {
  const { rows } = useToday.getState();
  for (let i = rows.length - 1; i >= 0; i--) {
    const line = rows[i]!.line;
    if (line) return line.key;
  }
  return null;
}

/** Plan 210: the list's cursor for a history key, and back (the list's cursor carries the key's three parts). */
export const historyCursor = (key: HistoryKey | null | undefined): { lastDate: number; id: number; src: 0 | 1 } | null => (key ? { lastDate: key.at, id: key.id, src: key.src } : null);
export const cursorKey = (c: { lastDate: number; id: number; src?: 0 | 1 }): HistoryKey => ({ at: c.lastDate, id: c.id, src: c.src ?? 0 });
