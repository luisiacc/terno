import { datedGroup, datedGroupAt, dayKeyOf, promiseGroupAt, shownEarly, todayCounted, type DatedRow, type TaskPlace, type TodayGroupKind } from "./dated";
import type { FollowupRow } from "./followups";
import { sortInDay, type TodayAlso, type TodayCounts, type TodayWhy } from "./today";
import { refKey, reminderRowId, splitZoneNote, statedClock, waitingRowId, weekEndDay, type FeedRowId, type ItemRef } from "./today-items";

/**
 * Plan 210 (iteration 2, the owner: "a row per item"; Codex's design): What matters is one projection, the list's, the
 * sidebar's count's and the morning notice's alike. Bounded facts (the open dated items and promises with their duplicate
 * membership and related details, the conversations waiting on you, your reminders, which threads are in Spam or Trash) →
 * canonical items (one per set of true duplicates) → placement and order (`datedGroupAt`, `promiseGroupAt`, `sortInDay`) →
 * rows and the counts' buckets. Pure: both stores give the facts, nothing here reads a store, and nothing is subtracted from
 * a thread count any more.
 */

export interface ProjectionFacts {
  now: number;
  /** the open dated items the open part may show (the dated setting on, untrusted senders left out), at their bound */
  dated: readonly DatedRow[];
  /** your open promises (follow-ups on); a nudge isn't one */
  promises: readonly FollowupRow[];
  /** conversations waiting on your answer (`waitingPage`), newest first: in the Inbox, so never Spam or Trash */
  waiting: readonly { id: number; lastDate: number; hasSent: boolean }[];
  /** your reminders due by the end of today (the list's only: never counted) */
  reminders: readonly { threadId: number; dueAt: number }[];
  /** whether an item's conversation may show: not in Spam or Trash (it comes back with it) */
  live: (threadId: number) => boolean;
  /** the reader's zone: a promise's stated time in another is said in brackets */
  zone: string;
}

export interface ProjectedRow {
  id: FeedRowId;
  threadId: number;
  group: TodayGroupKind;
  /** a day of its own's, or Coming up's */
  day: string | null;
  why: TodayWhy;
  also?: TodayAlso;
  /** a conversation waiting on you, whose line is its summary's */
  waiting?: boolean;
}

/** One item, or the true duplicates of one: its id the canonical's key, shown as `lead`. */
interface Logical {
  id: FeedRowId;
  lead: { source: "dated"; row: DatedRow } | { source: "promise"; row: FollowupRow };
  members: ItemRef[];
}

const own = (source: "dated" | "promise", id: number): string => refKey({ source, id });

/**
 * True duplicates as one item each: grouped by their canonical (`sameAs`, or their own key). The row is the canonical's id
 * whatever happens to its members, so the feed's selection and an act's target never move; it shows the canonical while
 * that's open, else its first open member (a merged dinner whose restaurant mail was settled shows the friend's).
 */
function logicalItems(dated: readonly DatedRow[], promises: readonly FollowupRow[]): Logical[] {
  const groups = new Map<string, Logical>();
  const add = (key: string, entry: Logical["lead"], ref: ItemRef) => {
    const g = groups.get(key);
    const isCanonical = own(entry.source, entry.row.id) === key;
    if (!g) return void groups.set(key, { id: key, lead: entry, members: [ref] });
    // the canonical leads; else the first open member, a dated item before a promise, the lower id first
    if (isCanonical) {
      g.lead = entry;
      g.members.unshift(ref);
    } else g.members.push(ref);
  };
  for (const row of dated) add(row.sameAs ?? own("dated", row.id), { source: "dated", row }, { source: "dated", id: row.id });
  for (const row of promises) add(row.sameAs ?? own("promise", row.id), { source: "promise", row }, { source: "promise", id: row.id });
  return [...groups.values()];
}

/** The mail's own time out of an item's words when the column says it (one time per row, A7). */
function datedWhy(row: DatedRow, missed: boolean, early: boolean, members: ItemRef[]): TodayWhy {
  const split = row.timed ? splitZoneNote(row.text) : { text: row.text, note: null };
  return {
    kind: "dated",
    text: split.text,
    dueAt: row.dueAt,
    ...(missed ? { missed } : {}),
    item: { id: row.id, revision: row.revision, kind: row.kind, dueDay: row.dueDay, timed: row.timed, dated: row.dated, ...(early ? { early } : {}), ...(split.note ? { note: split.note } : {}) },
    ...(members.length > 1 ? { members } : {}),
  };
}

function promiseWhy(r: FollowupRow, missed: boolean, members: ItemRef[], zone: string): TodayWhy {
  // a time its words state is the column's (its zone's words in brackets when that isn't the reader's); never in the sentence
  const clock = r.timed ? statedClock(r.text) : null;
  const note = clock?.zone && clock.zone !== zone ? clock.note : null;
  return {
    kind: "promise",
    text: clock ? clock.rest : r.text,
    dueAt: r.dueAt,
    personName: r.personName,
    personEmail: r.personEmail,
    sentAt: r.sentAt,
    ...(missed ? { missed } : {}),
    promise: { id: r.id, revision: r.revision, dated: r.dated, ...(r.timed ? { timed: true } : {}), ...(note ? { note } : {}), ...(r.brokenDueAt != null ? { promisedAt: r.brokenDueAt } : {}) },
    ...(members.length > 1 ? { members } : {}),
  };
}

/** A related detail as the row's second line says it. */
const alsoOf = (r: DatedRow): TodayAlso => ({ kind: r.kind, text: r.timed ? splitZoneNote(r.text).text : r.text, dueDay: r.dueDay, dueAt: r.dueAt, timed: r.timed, dated: r.dated });

interface Placed extends ProjectedRow {
  /** the moment it's ordered by in Missed (the most recently due first) */
  dueAt: number;
  /** when it came: Today's people go newest first */
  came: number;
}

/**
 * Plan 210 (iteration 2): every row, in `TODAY_GROUP_ORDER` (Missed by the most recently due; Today by `sortInDay`; each
 * day ahead and Coming up by their day, then the same order), and the counts. `count`: only the counts are wanted (nothing
 * ordered, no reminders).
 */
export function projectToday(f: ProjectionFacts, o: { count?: boolean } = {}): { rows: ProjectedRow[]; counts: TodayCounts } {
  const today = dayKeyOf(f.now);
  // a related detail stands under its item while that item shows; its own row once it doesn't (a trip outlives its outbound flight)
  const parents = new Map<number, DatedRow>();
  for (const r of f.dated) parents.set(r.id, r);
  const details = new Map<number, DatedRow[]>();
  const items = logicalItems(
    f.dated.filter((r) => {
      const parent = r.detailOf == null ? undefined : parents.get(r.detailOf);
      if (!parent || !f.live(parent.threadId) || datedGroupAt(parent, f.now, today) === null) return true;
      details.set(parent.id, [...(details.get(parent.id) ?? []), r]);
      return false;
    }),
    f.promises,
  );
  const placed: Placed[] = [];
  // conversations an item of theirs stands for: their ask, request or bill, or your promise to them (a Plan isn't what
  // they asked), so a waiting row there would say the same thing twice
  const represented = new Set<number>();
  for (const item of items) {
    const { lead } = item;
    if (!f.live(lead.row.threadId)) continue;
    let at: TaskPlace | null;
    let why: TodayWhy;
    if (lead.source === "dated") {
      at = datedGroupAt(lead.row, f.now, today);
      if (at === null) continue;
      why = datedWhy(lead.row, at.group === "missed", at.group === "today" && shownEarly(lead.row, today), item.members);
      if (datedGroup(lead.row.kind) !== "plans") represented.add(lead.row.threadId);
    } else {
      at = promiseGroupAt(lead.row, f.now, today);
      if (at === null) continue;
      why = promiseWhy(lead.row, at.group === "missed", item.members, f.zone);
      represented.add(lead.row.threadId);
    }
    const detail = lead.source === "dated" ? details.get(lead.row.id)?.sort((a, b) => a.dueAt - b.dueAt || a.id - b.id)[0] : undefined;
    const came = lead.source === "dated" ? lead.row.arrivedAt : lead.row.sentAt;
    placed.push({ id: item.id, threadId: lead.row.threadId, group: at.group, day: at.day, why, dueAt: lead.row.dueAt, came, ...(detail ? { also: alsoOf(detail) } : {}) });
  }
  // what's waiting on you (the owner's round 10: only when something is asked; the stores' `stillWaiting` says so), unless
  // an item of the conversation already says it
  const waiting: Placed[] = [];
  for (const w of f.waiting) {
    if (represented.has(w.id)) continue;
    waiting.push({ id: waitingRowId(w.id), threadId: w.id, group: "today", day: null, why: { kind: "waiting", wrote: w.hasSent }, waiting: true, dueAt: w.lastDate, came: w.lastDate });
  }
  const counts = countsOf([...placed, ...waiting], f.now);
  if (o.count) return { rows: [], counts };
  // your reminder on a conversation with no row of its own (one that has one already brings it to you)
  const shown = new Set([...placed, ...waiting].map((p) => p.threadId));
  const reminders: Placed[] = [...f.reminders]
    .sort((a, b) => a.dueAt - b.dueAt)
    .filter((r) => !shown.has(r.threadId) && f.live(r.threadId))
    .map((r) => ({ id: reminderRowId(r.threadId), threadId: r.threadId, group: "today", day: null, why: { kind: "reminder", dueAt: r.dueAt }, dueAt: r.dueAt, came: r.dueAt }));
  return { rows: ordered([...placed, ...waiting, ...reminders]), counts };
}

/** The header's and the badge's buckets (`TodayCounts`): what `todayCounted` counts, by the group it's under. */
function countsOf(rows: readonly Placed[], now: number): TodayCounts {
  const end = weekEndDay(now);
  const counts: TodayCounts = { missed: 0, today: 0, thisWeek: 0 };
  for (const r of rows) {
    if (!todayCounted(r.group, r.why)) continue;
    if (r.group === "missed") counts.missed++;
    else if (r.group === "today") counts.today++;
    else if (r.group === "day" && r.day !== null && r.day <= end) counts.thisWeek++;
  }
  return counts;
}

/**
 * The feed's order: Missed, the most recently due first; Today in `sortInDay`'s order (asks and waiting conversations as
 * they came, newest first); each day ahead, then Coming up, by its day and then the same order, a timed row by its time of
 * day (two put off to one day).
 */
function ordered(rows: readonly Placed[]): ProjectedRow[] {
  const of = (g: TodayGroupKind) => rows.filter((r) => r.group === g);
  const missed = of("missed").sort((a, b) => b.dueAt - a.dueAt);
  // Today's people as they came: a person's ask newest first, then waiting conversations newest first
  const todays = of("today");
  const asks = todays.filter((r) => r.why.kind === "dated" && (r.why.item?.kind === "ask" || r.why.item?.early)).sort((a, b) => b.came - a.came);
  const rest = todays.filter((r) => !asks.includes(r));
  const today = sortInDay([...rest.filter((r) => !r.waiting), ...asks, ...rest.filter((r) => r.waiting)], (r) => r.why, false);
  const byItsDay = (list: Placed[]) => sortInDay(list, (r) => r.why, true, (r) => r.day!);
  return [...missed, ...today, ...byItsDay(of("day")), ...byItsDay(of("comingUp"))].map(({ dueAt: _dueAt, came: _came, ...r }) => r);
}
