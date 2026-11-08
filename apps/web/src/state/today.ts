import { todayAvailable } from "~/lib/ai";
import { DIGEST_ROW_ID, type DigestRow, type TodayList, type ThreadSummary } from "@terno/core";
import { t } from "@terno/i18n";
import { create } from "zustand";
import { listDate } from "~/lib/format";
import { client } from "~/rpc/connection";
import { getApp, navigate, useApp } from "./app";
import { reloadList } from "./list";

/**
 * Plan 145: Today's shape on the list: which rows begin a section, and the digest. Rows themselves are the ordinary
 * thread rows, with what they say in the snippet's place.
 */
export interface TodayGroup {
  kind: "needsYou" | "reminders" | "newsletters";
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
}

export const useToday = create<TodayState>(() => ({ groups: [], more: 0, digest: null, fromDigest: null, pick: null, needsShown: 0 }));

/** The page's pick for this day: what was left, or nothing toggled. */
export function digestPick(day: string): DigestPick {
  const held = useToday.getState().pick;
  return held?.day === day ? held : { day, toggled: new Set(), scroll: 0 };
}

export const keepDigestPick = (pick: DigestPick): void => useToday.setState({ pick });

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

/** the digest as a row of the list; no thread has this id (revision 10: it can't be checked or acted on) */
/** What the digest's row says, and the header's way to it (plan 161). */
export const digestLabel = (digest: DigestRow): string =>
  digest.state === "pending" ? t("today.digest.preparing") : digest.state === "failed" ? t("today.digest.failedShort") : digest.automated ? t("today.digest.automatedRow", { count: digest.liveIds.length }) : digest.liveIds.length ? t("today.digest.row", { count: digest.liveIds.length }) : t("today.digest.archivedRow", { count: digest.items.length });

function digestThread(digest: DigestRow): ThreadSummary {
  return { id: DIGEST_ROW_ID, accountId: 0, subject: digestLabel(digest), snippet: "", fromName: t("today.newsletters"), fromEmail: "", lastDate: 0, messageCount: 1, unread: false, starred: false, hasAttachments: false, categoryIds: [], inInbox: false, inSpam: false, inTrash: false } as unknown as ThreadSummary;
}

const whyLine = (item: TodayList["sections"][number]["items"][number]): string => {
  const { why, thread, summary } = item;
  // plan 161: why it's here first, from what let it in (`needsYou`'s two reasons), then what it says
  if (why.kind === "waiting" && why.wrote !== undefined) return `${t(why.wrote ? "today.why.yourTurn" : "today.why.newFrom")} · ${summary ?? thread.snippet}`;
  if (why.kind === "promise") return t("today.why.promise", { text: why.text ?? "" });
  if (why.kind === "nudge") return t("today.why.nudge", { name: why.personName || thread.fromName, count: Math.max(1, Math.floor((Date.now() - (why.sentAt ?? Date.now())) / 86_400_000)) });
  if (why.kind === "reminder") return why.dueAt ? `${t("today.why.reminder", { when: listDate(why.dueAt) })} · ${thread.snippet}` : thread.snippet;
  return summary ?? thread.snippet;
};

/** The sections as one list; held rows stay where they were until the selection lets go (revision 9). */
export function flattenToday(list: TodayList, before: readonly ThreadSummary[]): ThreadSummary[] {
  const groups: TodayGroup[] = [];
  const items: ThreadSummary[] = [];
  let more = 0;
  let needsShown = 0;
  for (const section of list.sections) {
    groups.push({ kind: section.kind, at: items.length });
    if (section.kind === "needsYou") {
      more = section.more;
      needsShown = section.items.length;
    }
    for (const item of section.items) items.push({ ...item.thread, snippet: whyLine(item) });
  }
  for (const thread of list.held) {
    const at = before.findIndex((t) => t.id === thread.id);
    items.splice(at < 0 ? items.length : Math.min(at, items.length), 0, thread);
    for (const g of groups) if (g.at > at && at >= 0) g.at++;
  }
  if (list.digest) {
    groups.push({ kind: "newsletters", at: items.length });
    items.push(digestThread(list.digest));
  }
  useToday.setState({ groups, more, digest: list.digest, needsShown });
  return items;
}
