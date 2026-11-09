import { todayAvailable } from "~/lib/ai";
import { addressKey, DIGEST_ROW_ID, NEEDS_GROUPS, needsGroup, type DigestItem, type DigestRow, type NeedsGroup, type TodayList, type ThreadSummary } from "@terno/core";
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
  /** plan 166: Needs you is two groups, Your turn and Waiting for your reply, under the page's "N need you" */
  kind: NeedsGroup | "reminders";
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
  /** owner's decisions (2): newsletters the reader sent to Trash or Spam on the way back, so their row says so, not "Archived" */
  movedTo: ReadonlyMap<number, "trash" | "spam">;
  /**
   * Plan 166: senders just said not to be newsletters (address keys), left out of every view of the digest at once, before
   * the backend's read agrees (and whatever an older read brings), until their Undo.
   */
  notNewsletters: ReadonlySet<string>;
}

export const useToday = create<TodayState>(() => ({ groups: [], more: 0, digest: null, fromDigest: null, pick: null, needsShown: 0, movedTo: new Map(), notNewsletters: new Set() }));

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

const whyLine = (item: TodayList["sections"][number]["items"][number]): string => {
  const { why, thread, summary } = item;
  if (why.kind === "promise") return t("today.why.promise", { text: why.text ?? "" });
  if (why.kind === "nudge") return t("today.why.nudge", { name: why.personName || thread.fromName, count: Math.max(1, Math.floor((Date.now() - (why.sentAt ?? Date.now())) / 86_400_000)) });
  if (why.kind === "reminder") return why.dueAt ? `${t("today.why.reminder", { when: listDate(why.dueAt) })} · ${thread.snippet}` : thread.snippet;
  return summary ?? thread.snippet;
};

const GROUP_ORDER: readonly TodayGroup["kind"][] = [...NEEDS_GROUPS, "reminders"];

/** The sections as one list; held rows stay where they were until the selection lets go (revision 9). */
export function flattenToday(list: TodayList, before: readonly ThreadSummary[]): ThreadSummary[] {
  const groups: TodayGroup[] = [];
  const items: ThreadSummary[] = [];
  let more = 0;
  let needsShown = 0;
  // plan 162 (after ai162-r02): the digest isn't a row: its way in is Today's header (TodayDigestEntry), above the fold and
  // never before a person (it led the list, under its own heading, on a page that says these need you)
  for (const section of list.sections) {
    if (section.kind === "needsYou") {
      more = section.more;
      needsShown = section.items.length;
      // plan 166: two groups, each in the backend's order; the 12 are still the backend's, shared. The heading says what
      // the row's reason said ("Your turn: they replied"), so the row leads with its own words; a promise's "You said" and
      // a nudge's "No reply from" say more than the heading and stay
      for (const kind of NEEDS_GROUPS) {
        const mine = section.items.filter((item) => needsGroup(item.why) === kind);
        if (!mine.length) continue;
        groups.push({ kind, at: items.length });
        for (const item of mine) items.push({ ...item.thread, snippet: whyLine(item) });
      }
      continue;
    }
    if (!section.items.length) continue;
    groups.push({ kind: section.kind, at: items.length });
    for (const item of section.items) items.push({ ...item.thread, snippet: whyLine(item) });
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
        const next = groups.find((g) => GROUP_ORDER.indexOf(g.kind) > GROUP_ORDER.indexOf(kind));
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
  useToday.setState(({ notNewsletters }) => ({ groups, more, digest: list.digest && withoutSenders(list.digest, notNewsletters), needsShown }));
  return items;
}
