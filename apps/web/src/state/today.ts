import { todayAvailable } from "~/lib/ai";
import { DIGEST_ROW_ID, type DigestRow, type TodayList, type ThreadSummary } from "@terno/core";
import { t } from "@terno/i18n";
import { create } from "zustand";
import { listDate } from "~/lib/format";
import { client } from "~/rpc/connection";
import type { Undo } from "~/lib/snack";
import { getApp, navigate, setApp, useApp } from "./app";
import { reloadList } from "./list";

/**
 * Plan 145: Today's shape on the list: which rows begin a section, and the digest. Rows themselves are the ordinary
 * thread rows, with what they say in the snippet's place.
 */
export interface TodayGroup {
  kind: "needsYou" | "reminders";
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
  more: number;
  digest: DigestRow | null;
  /** the conversation opened from the digest page: its Back returns there, and only it shows one (plan 161) */
  fromDigest: number | null;
  pick: DigestPick | null;
  /** the rows Needs you shows (the sidebar's count can be more) */
  needsShown: number;
  /** plan 161, pass 2: why a waiting row is here ("Your turn"), a label of its own before its words */
  reasons: ReadonlyMap<number, string>;
  /** owner's decisions (2): newsletters the reader sent to Trash or Spam on the way back, so their row says so, not "Archived" */
  movedTo: ReadonlyMap<number, "trash" | "spam">;
}

export const useToday = create<TodayState>(() => ({ groups: [], more: 0, digest: null, fromDigest: null, pick: null, needsShown: 0, reasons: new Map(), movedTo: new Map() }));

/** The page's pick for this day: what was left, or nothing toggled. */
export function digestPick(day: string): DigestPick {
  const held = useToday.getState().pick;
  return held?.day === day ? held : { day, toggled: new Set(), scroll: 0 };
}

/** What the page was left as; the day's other parts (what it archived, where it was opened from) stay unless given. */
export const keepDigestPick = (pick: DigestPick): void => useToday.setState((s) => ({ pick: s.pick?.day === pick.day ? { ...s.pick, ...pick } : pick }));

/**
 * Plan 162 (after ai162-r02): the digest page's own keys, the list's (j/k move, x ticks, Enter opens, Esc leaves), while
 * it has them: focus in the page, or nowhere with the page on screen. Set by the page while it's mounted.
 */
export const digestKeys: { current: { has: () => boolean; step: (delta: 1 | -1) => void; toggle: () => void; open: () => void; leave: () => void } | null } = { current: null };

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
    return { fromDigest: threadId, pick: pick && { ...pick, opened: threadId }, movedTo: moved };
  });
  setApp({ selectedId: threadId });
}

/** At boot, once there's a connection to listen on. */
export function installToday(): void {
  // the digest moved on, or what's automated did: only Today shows it
  client.on("todayDigest", () => {
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

/** What the digest's row says, and the header's way to it (plan 161). */
export const digestLabel = (digest: DigestRow): string =>
  digest.state === "pending" ? t("today.digest.preparing") : digest.state === "failed" ? t("today.digest.failedShort") : digest.automated ? t("today.digest.automatedRow", { count: digest.liveIds.length }) : digest.liveIds.length ? t("today.digest.row", { count: digest.liveIds.length }) : t("today.digest.archivedRow", { count: Math.max(0, digest.items.length - (digest.readIds?.length ?? 0)) });

/** Plan 161: why a waiting row is here, from what let it in (`needsYou`'s two reasons): the row shows it as a label */
const reasonOf = (item: TodayList["sections"][number]["items"][number]): string | null =>
  item.why.kind === "waiting" && item.why.wrote !== undefined ? t(item.why.wrote ? "today.why.yourTurn" : "today.why.newFrom") : null;

const whyLine = (item: TodayList["sections"][number]["items"][number]): string => {
  const { why, thread, summary } = item;
  if (why.kind === "promise") return t("today.why.promise", { text: why.text ?? "" });
  if (why.kind === "nudge") return t("today.why.nudge", { name: why.personName || thread.fromName, count: Math.max(1, Math.floor((Date.now() - (why.sentAt ?? Date.now())) / 86_400_000)) });
  if (why.kind === "reminder") return why.dueAt ? `${t("today.why.reminder", { when: listDate(why.dueAt) })} · ${thread.snippet}` : thread.snippet;
  return summary ?? thread.snippet;
};

/** The sections as one list; held rows stay where they were until the selection lets go (revision 9). */
export function flattenToday(list: TodayList, before: readonly ThreadSummary[]): ThreadSummary[] {
  const groups: TodayGroup[] = [];
  const items: ThreadSummary[] = [];
  const reasons = new Map<number, string>();
  let more = 0;
  let needsShown = 0;
  // plan 162 (after ai162-r02): the digest isn't a row: its way in is Today's header (TodayDigestEntry), above the fold and
  // never before a person (it led the list, under its own heading, on a page that says these need you)
  for (const section of list.sections) {
    groups.push({ kind: section.kind, at: items.length });
    if (section.kind === "needsYou") {
      more = section.more;
      needsShown = section.items.length;
    }
    for (const item of section.items) {
      const reason = reasonOf(item);
      if (reason) reasons.set(item.thread.id, reason);
      items.push({ ...item.thread, snippet: whyLine(item) });
    }
  }
  for (const thread of list.held) {
    const was = before.findIndex((t) => t.id === thread.id);
    const at = was < 0 ? items.length : Math.min(was, items.length);
    items.splice(at, 0, thread);
    for (const g of groups) if (g.at > at && was >= 0) g.at++;
  }
  useToday.setState({ groups, more, digest: list.digest, needsShown, reasons });
  return items;
}
