import { datedGroup, datedGroupAt, dayKeyOf, displayBucket, promiseGroupAt, shownEarly, todayCounted, type DatedRow, type TaskPlace, type TodayGroupKind } from "./dated";
import type { FollowupRow } from "./followups";
import { sortInDay, waitsOnYou, type TodayAlso, type TodayCounts, type TodayPart, type TodayWhy } from "./today";
import { clockHolds, refKey, reminderRowId, splitZoneNote, statedClock, waitingRowId, type FeedRowId, type ItemRef } from "./today-items";

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
  /** plan 210 (iteration 3, revision 8): Today's "Waiting on you" part (`waitsOnYou`); its id stays as its tier changes */
  part?: TodayPart;
  /**
   * plan 210 (iteration 3, revision 9): a day ahead's or Coming up's heading (`displayBucket`), apart from its own `day`: the
   * day for the first two weeks, then its week ("week:YYYY-MM-DD")
   */
  bucket?: string;
}

/** One item, or the true duplicates of one: its id the canonical's key, shown as `lead`. */
export interface Logical {
  id: FeedRowId;
  lead: { source: "dated"; row: DatedRow } | { source: "promise"; row: FollowupRow };
  members: ItemRef[];
  /** every open member, the lead first: another shows it when the lead's conversation is in Spam or Trash */
  entries: Logical["lead"][];
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
    if (!g) return void groups.set(key, { id: key, lead: entry, members: [ref], entries: [entry] });
    // the canonical leads; else the first open member, a dated item before a promise, the lower id first
    if (isCanonical) {
      g.lead = entry;
      g.members.unshift(ref);
      g.entries.unshift(entry);
    } else {
      g.members.push(ref);
      g.entries.push(entry);
    }
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
  const note = clock?.zone && clock.zone !== zone && clockHolds(r.dueAt, clock) ? clock.note : null;
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

/** A canonical item in its group, before anything of its conversation is known (`placeItems`). */
export interface PlacedItem {
  item: Logical;
  at: TaskPlace;
  /** its related detail, shown as its Also while it shows */
  detail?: DatedRow;
}

/**
 * The projection's first step: the canonical items (`logicalItems`) and where each sits (`datedGroupAt`, `promiseGroupAt`),
 * a related detail folded under its item while that item shows (a trip outlives its outbound flight: then it's a row of
 * its own). Needs no store: the caller then reads which of their conversations may show (`placedThreads`). `count`: Coming
 * up is never counted nor says a conversation, so it's left out.
 */
export function placeItems(dated: readonly DatedRow[], promises: readonly FollowupRow[], now: number, o: { count?: boolean } = {}): PlacedItem[] {
  const today = dayKeyOf(now);
  // most mailboxes link nothing: each item is its own, placed where it is, and nothing is grouped (every count runs this
  // over the 1,000-item bound)
  if (!dated.some((r) => r.sameAs != null || r.detailOf != null) && !promises.some((r) => r.sameAs != null)) {
    const out: PlacedItem[] = [];
    const keep = (at: TaskPlace | null): at is TaskPlace => at !== null && !(o.count && at.group === "comingUp");
    for (const row of dated) {
      const at = datedGroupAt(row, now, today);
      const lead = { source: "dated" as const, row };
      if (keep(at)) out.push({ item: { id: own("dated", row.id), lead, members: [{ source: "dated", id: row.id }], entries: [lead] }, at });
    }
    for (const row of promises) {
      const at = promiseGroupAt(row, now, today);
      const lead = { source: "promise" as const, row };
      if (keep(at)) out.push({ item: { id: own("promise", row.id), lead, members: [{ source: "promise", id: row.id }], entries: [lead] }, at });
    }
    return out;
  }
  const where = new Map<number, TaskPlace | null>();
  const placeOf = (r: DatedRow) => {
    if (!where.has(r.id)) where.set(r.id, datedGroupAt(r, now, today));
    return where.get(r.id)!;
  };
  const parents = new Map(dated.map((r) => [r.id, r]));
  const details = new Map<number, DatedRow>();
  const items = logicalItems(
    dated.filter((r) => {
      const parent = r.detailOf == null ? undefined : parents.get(r.detailOf);
      if (!parent || placeOf(parent) === null) return true;
      const was = details.get(parent.id);
      if (!was || r.dueAt < was.dueAt || (r.dueAt === was.dueAt && r.id < was.id)) details.set(parent.id, r);
      return false;
    }),
    promises,
  );
  const out: PlacedItem[] = [];
  for (const item of items) {
    const { lead } = item;
    const at = lead.source === "dated" ? placeOf(lead.row) : promiseGroupAt(lead.row, now, today);
    if (at === null || (o.count && at.group === "comingUp")) continue;
    const detail = lead.source === "dated" ? details.get(lead.row.id) : undefined;
    out.push({ item, at, ...(detail ? { detail } : {}) });
  }
  return out;
}

/**
 * The conversations placed items are in, every member's (one shows a merged row when the canonical's is in Spam or Trash:
 * Codex code review): what the caller asks the store about, one read.
 */
export const placedThreads = (items: readonly PlacedItem[]): number[] => [...new Set(items.flatMap((p) => p.item.entries.map((e) => e.row.threadId)))];

/**
 * Plan 210 (iteration 2): every row, in `TODAY_GROUP_ORDER` (Missed by the most recently due; Today by `sortInDay`; each
 * day ahead and Coming up by their day, then the same order), and the counts. `count`: only the counts are wanted (nothing
 * ordered, no words made, no reminders).
 */
export function projectToday(f: ProjectionFacts, o: { count?: boolean } = {}): { rows: ProjectedRow[]; counts: TodayCounts } {
  return projectRows(placeItems(f.dated, f.promises, f.now, o), f, o);
}

/** The projection's second step: placed items, what's waiting and your reminders as rows, and the counts' buckets. */
export function projectRows(items: readonly PlacedItem[], f: Pick<ProjectionFacts, "now" | "waiting" | "reminders" | "live" | "zone">, o: { count?: boolean } = {}): { rows: ProjectedRow[]; counts: TodayCounts } {
  const today = dayKeyOf(f.now);
  const placed: Placed[] = [];
  // each day's heading once (most rows share a few days)
  const buckets = new Map<string, string>();
  const bucketOf = (day: string): string => buckets.get(day) ?? (buckets.set(day, displayBucket(day, today)), buckets.get(day)!);
  // conversations an item of theirs shown now stands for: their ask, request or bill, or your promise to them (a Plan isn't
  // what they asked), so a waiting row there would say the same thing twice. One behind Coming up says nothing yet: the
  // conversation waiting on you is a row of its own meanwhile (their nudge on a promise due next week)
  const represented = new Set<number>();
  for (const placedItem of items) {
    const { item, detail } = placedItem;
    let { at } = placedItem;
    let { lead } = item;
    // (Codex code review of iteration 2) the canonical's conversation in Spam or Trash: a live member shows the same row
    if (!f.live(lead.row.threadId)) {
      const alt = item.entries.find((e) => e !== lead && f.live(e.row.threadId));
      const altAt = !alt ? null : alt.source === "dated" ? datedGroupAt(alt.row, f.now, today) : promiseGroupAt(alt.row, f.now, today);
      if (!alt || !altAt || (o.count && altAt.group === "comingUp")) continue;
      lead = alt;
      at = altAt;
    }
    const plan = lead.source === "dated" && datedGroup(lead.row.kind) === "plans";
    if (!plan && at.group !== "comingUp") represented.add(lead.row.threadId);
    const early = lead.source === "dated" && at.group === "today" && shownEarly(lead.row, today);
    // the count needs only what `todayCounted` and `waitsOnYou` read: no words made
    const why: TodayWhy = o.count
      ? lead.source === "dated" ? { kind: "dated", item: { id: lead.row.id, revision: 0, kind: lead.row.kind, dueDay: "", timed: false, dated: true, ...(early ? { early } : {}) } } : { kind: "promise" }
      : lead.source === "dated"
        ? datedWhy(lead.row, at.group === "missed", early, item.members)
        : promiseWhy(lead.row, at.group === "missed", item.members, f.zone);
    const came = lead.source === "dated" ? lead.row.arrivedAt : lead.row.sentAt;
    placed.push({ id: item.id, threadId: lead.row.threadId, group: at.group, day: at.day, why, dueAt: lead.row.dueAt, came, ...(at.group === "today" && waitsOnYou(why) ? { part: "waiting" as const } : {}), ...(at.day !== null && !o.count ? { bucket: bucketOf(at.day) } : {}), ...(detail && !o.count ? { also: alsoOf(detail) } : {}) });
  }
  // what's waiting on you (the owner's round 10: only when something is asked; the stores' `stillWaiting` says so), unless
  // an item of the conversation already says it
  const waiting: Placed[] = [];
  for (const w of f.waiting) {
    if (represented.has(w.id)) continue;
    waiting.push({ id: waitingRowId(w.id), threadId: w.id, group: "today", day: null, why: { kind: "waiting", wrote: w.hasSent }, waiting: true, part: "waiting", dueAt: w.lastDate, came: w.lastDate });
  }
  const all = placed.concat(waiting);
  const counts = countsOf(all);
  if (o.count) return { rows: [], counts };
  // your reminder on a conversation with no row of its own (one that has one already brings it to you)
  const shown = new Set<number>();
  for (const p of all) shown.add(p.threadId);
  const reminders: Placed[] = [...f.reminders]
    .sort((a, b) => a.dueAt - b.dueAt)
    .filter((r) => !shown.has(r.threadId) && f.live(r.threadId))
    .map((r) => ({ id: reminderRowId(r.threadId), threadId: r.threadId, group: "today", day: null, why: { kind: "reminder", dueAt: r.dueAt }, dueAt: r.dueAt, came: r.dueAt }));
  return { rows: ordered(all.concat(reminders)), counts };
}

/** The header's and the badge's buckets (`TodayCounts`), disjoint: what `todayCounted` counts, by its group and Today's part. */
function countsOf(rows: readonly Placed[]): TodayCounts {
  const counts: TodayCounts = { missed: 0, today: 0, waiting: 0 };
  for (const r of rows) {
    if (!todayCounted(r.group, r.why)) continue;
    if (r.group === "missed") counts.missed++;
    else if (r.part === "waiting") counts.waiting++;
    else counts.today++;
  }
  return counts;
}

/**
 * The feed's order: Missed, the most recently due first; Today in `sortInDay`'s order, then its "Waiting on you" part (plan
 * 210, iteration 3, revision 8: requests shown early by their own day, soonest first, then what has none, asks and waiting
 * conversations as they came, newest first); each day ahead, then Coming up, by its day and then the same order, a timed
 * row by its time of day (two put off to one day). The quiet rows (a plan happening today, your reminder) stay Today's own,
 * above the part: a sub-heading holds only its own rows.
 */
function ordered(rows: readonly Placed[]): ProjectedRow[] {
  const groups = new Map<TodayGroupKind, Placed[]>();
  for (const r of rows) {
    const list = groups.get(r.group);
    if (list) list.push(r);
    else groups.set(r.group, [r]);
  }
  const of = (g: TodayGroupKind) => groups.get(g) ?? [];
  const missed = of("missed").sort((a, b) => b.dueAt - a.dueAt);
  const todays = of("today");
  const own = todays.filter((r) => r.part !== "waiting");
  // Waiting on you: what has a day by it, soonest first; then the rest as it came, newest first
  const dated = todays.filter((r) => r.part === "waiting" && r.why.item?.early).sort((a, b) => a.dueAt - b.dueAt);
  const undated = todays.filter((r) => r.part === "waiting" && !r.why.item?.early).sort((a, b) => b.came - a.came);
  const today = sortInDay(own, (r) => r.why, false).concat(dated, undated);
  const byItsDay = (list: Placed[]) => sortInDay(list, (r) => r.why, true, (r) => r.day!);
  // (the ordering's own fields ride along, unread: no copy of every row at the 1,000-item bound)
  return missed.concat(today, byItsDay(of("day")), byItsDay(of("comingUp")));
}
