import { todayAvailable } from "~/lib/ai";
import { addressKey, dayKeyOf, DIGEST_ROW_ID, todayCounted, type DigestItem, type DigestRow, type HistoryKey, type TodayGroupKind, type TodayHistoryItem, type TodayItem, type TodayList, type TodayWhy, type ThreadSummary } from "@terno/core";
import { t } from "@terno/i18n";
import { create } from "zustand";
import { listDate } from "~/lib/format";
import { alsoLine, datedLine, datedText, promiseLine, taskOf, type TodayTask } from "~/lib/dated";
import { dueTimeLeft } from "~/lib/when";
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

export interface TodayGroup {
  /** plan 166, after the owner's second look: Needs you is one group again ("they're really the same"); plan 204 adds Missed and Coming up; plan 210 the history, and groups by day */
  kind: FeedGroupKind;
  /** the row it begins at */
  at: number;
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
  groups: TodayGroup[];
  /** plan 204: the threads the list's counted groups hold (the sidebar's count until its own arrives): no cap, so it's all of them */
  counted: number;
  /** plan 204: what Coming up holds, shown or not (never counted) */
  comingUp: number;
  /** plan 210: Coming up's rows while it's open, under their days: drawn quietly */
  ahead: ReadonlySet<number>;
  /** plan 204: Coming up open under the rest (closed by default; remembered on this machine) */
  comingUpOpen: boolean;
  /**
   * plan 204 (after the panel): the task each row stands for, a dated item or a promise of yours: what its Done, Not a
   * task, Later and D act on, and what leads the row (its line first, its due day where the date is)
   */
  tasks: ReadonlyMap<number, TodayTask>;
  /** plan 204, the UI experiment: each row's item as the backend said it (a promise's day known), what a feed's sentence is made from */
  entries: ReadonlyMap<number, TodayItem>;
  /** plan 210: the history's lines loaded so far, by thread (what each says, and its key) */
  history: ReadonlyMap<number, TodayHistoryItem>;
  /** each row's group, by thread (held rows keep theirs): the feed's headings follow the rows, whatever leaves */
  kinds: ReadonlyMap<number, FeedGroupKind>;
  /** plan 204 (after the panel, fix 10): the row whose task Later's "Pick a date…" is choosing a moment for */
  laterPick: { threadId: number; task: TodayTask } | null;
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

export const useToday = create<TodayState>(() => ({ groups: [], counted: 0, comingUp: 0, ahead: new Set(), comingUpOpen: storedComingUp(), tasks: new Map(), entries: new Map(), history: new Map(), kinds: new Map(), laterPick: null, digest: null, fromDigest: null, pick: null, movedTo: new Map(), notNewsletters: new Set() }));

/** Plan 204 (after the panel): a Today row's task, only while Today is what's shown (one Map read: other rows never re-render). */
export function useTodayTask(threadId: number | null | undefined): TodayTask | undefined {
  const task = useToday((s) => (threadId == null ? undefined : s.tasks.get(threadId)));
  return useApp((s) => s.today) ? task : undefined;
}

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

/**
 * Plan 162 (after ai162-r05): the digest's way in is a row, its count line its title; under it, who the newsletters still
 * in the Inbox are from, the first three by the digest's order and how many more, from the digest's own items (no model).
 * Nothing while it's preparing, failed, or all gone.
 */
export function digestFrom(digest: DigestRow, locale: string): string | null {
  if (digest.state !== "ready") return null;
  const live = new Set([...digest.liveIds, ...(digest.readIds ?? [])]);
  const names: string[] = [];
  for (const item of digest.items) if (live.has(item.threadId) && item.from && !names.includes(item.from)) names.push(item.from);
  if (!names.length) return null;
  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  return new Intl.ListFormat(locale, { type: "conjunction" }).format(rest > 0 ? [...shown, t("action.found.more", { count: rest })] : shown);
}

const whyLine = (item: TodayList["sections"][number]["items"][number], why: TodayWhy, task: TodayTask | null): string => {
  const { thread, summary } = item;
  // after the second panel round: where the right column says when, the line is the task alone ("Pay $187.42 for the
  // electricity bill", "You said: send the agenda"), so the amount fits; the conversation's line keeps the whole wording
  const bare = task?.when != null;
  // plan 204: "Due Friday · Pay the electricity bill", "Tomorrow 7:40 · Flight to Madrid", "Was due Tuesday · …"
  if (why.kind === "dated") {
    if (why.item && !bare) return datedLine({ ...why.item, dueAt: why.dueAt ?? 0, text: why.text ?? "" }, why.missed === true);
    // the right column says the day; a timed one not due today keeps its time here: "7:40 AM · Flight to Madrid"
    const time = why.item && why.dueAt != null ? dueTimeLeft(why.dueAt, why.item.timed) : null;
    const text = why.text && why.item ? datedText({ kind: why.item.kind, text: why.text }) : why.text;
    return time && text ? t("today.why.line", { when: time, text }) : (text ?? thread.snippet);
  }
  // after the panel: "Due today · You said: send the agenda", "Was due Tuesday · You said: …"
  if (why.kind === "promise") return bare ? t("today.why.promise", { text: why.text ?? "" }) : promiseLine({ text: why.text ?? "", dueAt: why.dueAt, dated: why.promise?.dated ?? why.missed === true }, why.missed === true);
  if (why.kind === "reminder") return why.dueAt ? `${t("today.why.reminder", { when: listDate(why.dueAt) })} · ${thread.snippet}` : thread.snippet;
  return summary ?? thread.snippet;
};

/** A promise in Coming up or Missed names a day (only dated ones are placed there), whatever an older backend said of it. */
const dayKnown = (why: TodayWhy, kind: TodayGroupKind): TodayWhy => (why.promise && why.promise.dated === undefined && (kind === "comingUp" || why.missed) ? { ...why, promise: { ...why.promise, dated: true } } : why);

/** Plan 204 (after the panel, revision 10): the digest's place in the list, its last option; no thread has its id (it's never checked or acted on). */
function digestThread(): ThreadSummary {
  return { id: DIGEST_ROW_ID, accountId: 0, subject: t("today.newsletters"), snippet: "", fromName: t("today.newsletters"), fromEmail: "", lastDate: 0, messageCount: 1, unread: false, starred: false, hasAttachments: false, categoryIds: [], inInbox: false, inSpam: false, inTrash: false } as unknown as ThreadSummary;
}

/** A row's time of day if it's timed (a timed dated item's): a day's timed rows come first, by it (put off, it may have been due another day). */
function timedAt(item: TodayItem): number | null {
  if (item.why.kind !== "dated" || !item.why.item?.timed || item.why.dueAt === undefined) return null;
  const d = new Date(item.why.dueAt);
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * Plan 210: the sections as the feed's groups, in order: Missed, Today, then a group per day ahead; while it's open, Coming
 * up's rows join their day's (one whose day is already here, Today's), the timed first by time, then the rest as they came.
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
      // a day with Coming up's rows in it: the timed by time, then the rest in the order they came (the backend's)
      if (kind !== "missed" && items.some((r) => r.section === "comingUp") && items.some((r) => r.section !== "comingUp")) {
        const order = new Map(items.map((r, i) => [r, i]));
        items.sort((a, b) => {
          const [x, y] = [timedAt(a.item), timedAt(b.item)];
          if (x !== null && y !== null) return x - y || order.get(a)! - order.get(b)!;
          if (x !== null || y !== null) return x !== null ? -1 : 1;
          return order.get(a)! - order.get(b)!;
        });
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
 * The same, its maps published only when asked (Codex code review of plan 210): the list publishes them with the rows,
 * in the commit that shows them, so an answer it drops (a newer one came, the list moved on) changes nothing.
 */
export function todayAnswer(list: TodayList, before: readonly ThreadSummary[]): { items: ThreadSummary[]; publish: () => void } {
  const groups: TodayGroup[] = [];
  const items: ThreadSummary[] = [];
  const counted = new Set<number>();
  const tasks = new Map<number, TodayTask>();
  const entries = new Map<number, TodayItem>();
  const open = useToday.getState().comingUpOpen;
  const comingUp = list.sections.reduce((n, x) => n + (x.kind === "comingUp" ? x.items.length : 0), 0);
  const ahead = new Set<number>();
  for (const group of feedGroups(list, open)) {
    if (!group.items.length) continue;
    groups.push({ kind: group.kind, at: items.length });
    for (const { item, section } of group.items) {
      const why = dayKnown(item.why, section);
      const task = taskOf(why);
      items.push({ ...item.thread, snippet: whyLine(item, why, task) });
      entries.set(item.thread.id, why === item.why ? item : { ...item, why });
      if (section === "comingUp") ahead.add(item.thread.id);
      // the header's "N need you", what the sidebar's number counts (the backend's own rule: never a Plan's kind, nor a reminder)
      if (todayCounted(section, item.why)) counted.add(item.thread.id);
      // the fifth panel round (change 6): the conversation's next item, said on the row's second line
      if (task) tasks.set(item.thread.id, item.also ? { ...task, also: alsoLine(item.also) } : task);
    }
  }
  // plan 166: a held row stays in the group it was in. At a group's first place it sits above that group's heading (it
  // went under the next one's), and a group it was the last of keeps its heading for it
  const prior = useToday.getState().groups;
  for (const thread of list.held) {
    const was = before.findIndex((t) => t.id === thread.id);
    const kind = was < 0 ? undefined : prior.filter((g) => g.at <= was).at(-1)?.kind;
    let at = was < 0 ? items.length : Math.min(was, items.length);
    if (kind !== undefined) {
      const mine = groups.findIndex((g) => g.kind === kind);
      if (mine >= 0) at = Math.max(groups[mine]!.at, Math.min(at, groups[mine + 1]?.at ?? items.length));
      else {
        // its group has gone: where that group would be, under its own heading again
        const next = groups.find((g) => rankOf(g.kind) > rankOf(kind));
        at = next?.at ?? items.length;
      }
    }
    items.splice(at, 0, thread);
    if (was < 0) continue;
    for (const g of groups) if (g.at > at || (g.at === at && g.kind !== kind)) g.at++;
    if (kind !== undefined && !groups.some((g) => g.kind === kind)) {
      groups.push({ kind, at });
      groups.sort((a, b) => a.at - b.at);
    }
  }
  // plan 204 (after the panel, revision 10, superseding plan 162's place in the header): the digest is the list's last
  // option again, after held rows and never before a person, under no heading of its own (a gap sets it apart)
  if (list.digest) items.push(digestThread());
  // plan 210: the history after the automated section, its first page (or as deep as the list had it)
  const history = new Map<number, TodayHistoryItem>();
  const listed = new Set(items.map((t) => t.id));
  if (list.history?.items.length) {
    groups.push({ kind: "history", at: items.length });
    for (const line of list.history.items) {
      if (listed.has(line.thread.id)) continue;
      history.set(line.thread.id, line);
      items.push(line.thread);
    }
  }
  // what each row's heading is: where a group starts, a held row in its own group's run
  const kinds = new Map<number, FeedGroupKind>();
  for (let i = 0, g = 0; i < items.length; i++) {
    while (g + 1 < groups.length && groups[g + 1]!.at <= i) g++;
    if (groups[g] && groups[g]!.at <= i && items[i]!.id !== DIGEST_ROW_ID) kinds.set(items[i]!.id, groups[g]!.kind);
  }
  const publish = () => useToday.setState(({ notNewsletters }) => ({ groups, counted: counted.size, comingUp, ahead, tasks, entries, history, kinds, digest: list.digest && withoutSenders(list.digest, notNewsletters) }));
  return { items, publish };
}

/**
 * Rows left Today's list before it reloads (Done, Archive, anything `patchRows` takes out): its groups' starts, which are
 * positions (where a held row goes next time), are found again from the rows that are left (Codex code review). A group
 * goes with its last row.
 */
export function todayRowsLeft(items: readonly ThreadSummary[]): void {
  if (!getApp().today) return;
  const { kinds } = useToday.getState();
  const groups: TodayGroup[] = [];
  let prev: FeedGroupKind | undefined;
  for (let i = 0; i < items.length; i++) {
    const id = items[i]!.id;
    if (id === DIGEST_ROW_ID) continue;
    const kind = kinds.get(id) ?? prev;
    if (kind !== undefined && kind !== prev) groups.push({ kind, at: i });
    prev = kind;
  }
  useToday.setState({ groups });
}

/**
 * Plan 210: lines of a history page the list has just taken (in the commit that shows their rows): they join the
 * history's map and group. A page's key travels as the list's cursor, never kept here, so a page the list drops moves
 * nothing (Codex code review).
 */
export function publishHistory(fresh: readonly TodayHistoryItem[]): void {
  if (!fresh.length) return;
  useToday.setState(({ history, kinds }) => {
    const nextHistory = new Map(history);
    const nextKinds = new Map(kinds);
    for (const line of fresh) {
      nextHistory.set(line.thread.id, line);
      nextKinds.set(line.thread.id, "history");
    }
    return { history: nextHistory, kinds: nextKinds };
  });
}

/** Plan 210: the deepest history line these rows hold, what a reload asks down to (so it keeps the depth it had). */
export function historyThrough(items: readonly ThreadSummary[]): HistoryKey | null {
  const { history } = useToday.getState();
  for (let i = items.length - 1; i >= 0; i--) {
    const line = history.get(items[i]!.id);
    if (line) return line.key;
  }
  return null;
}

/** Plan 210: the list's cursor for a history key, and back (the list's cursor carries the key's three parts). */
export const historyCursor = (key: HistoryKey | null | undefined): { lastDate: number; id: number; src: 0 | 1 } | null => (key ? { lastDate: key.at, id: key.id, src: key.src } : null);
export const cursorKey = (c: { lastDate: number; id: number; src?: 0 | 1 }): HistoryKey => ({ at: c.lastDate, id: c.id, src: c.src ?? 0 });

