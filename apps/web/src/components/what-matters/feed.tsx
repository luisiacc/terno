import { useVirtualizer } from "@tanstack/react-virtual";
import { DIGEST_ROW_ID, localDay, type FeedRowId, type ThreadSummary, type TodayItem } from "@terno/core";
import { getLocale, t } from "@terno/i18n";
import { Collapsible, CollapsibleTrigger } from "@terno/ui/components/collapsible";
import { Skeleton } from "@terno/ui/components/skeleton";
import { Sun } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef } from "react";
import type { TodayTask } from "~/lib/dated";
import { useDesign } from "~/lib/design";
import { listDate } from "~/lib/format";
import { dayHeading, weekHeading } from "~/lib/when";
import { LIST_TITLE } from "~/lib/list-title";
import { installScrollHairline } from "~/lib/scroll-hairline";
import { pressRow, releaseRow } from "~/lib/select";
import { historySentence, historyWhen, todaySentence, todayWhen, type TodayTone } from "~/lib/today-sentence";
import { feedScroller, placeFeedKeys } from "~/lib/feed-focus";
import { measureControls } from "~/lib/feed-controls";
import { closeFeedConversation } from "~/lib/feed-pane";
import { listLayout } from "~/lib/page";
import { getApp, useApp } from "~/state/app";
import { listAnchor, loadMore, useList } from "~/state/list";
import { comingBucket, digestLabel, feedRow, groupDay, groupWeek, openFeedRow, setComingUpOpen, useFeedRow, useToday, type FeedGroupKind, type FeedRow } from "~/state/today";
import { EmptyState } from "../empty-state";
import { listScroller } from "~/lib/list-scroller";
import { ThreadMenu } from "../thread-menu";
import { WhatMattersOptions } from "./options";
import { BriefTaskControls } from "./task-menus";
import { TodayLine } from "./today-line";

/** The feed's rows, what Coming up's disclosure shows more of (its rows join the feed there: no panel of its own) */
export const FEED_ROWS_ID = "wm-feed-rows";

/**
 * Plan 204's briefing, which the owner made What matters' only view (plan 210): a feed drawn from Today's rows (plan 210,
 * iteration 2: a row per item, each by its own id, held rows and the digest's in their places), their conversations the
 * list's (`useList`: once each, for what acts on conversations and pages the history), so j/k, D, the right-click menu,
 * Done's Undo and a reload work on rows. The headings, one plain sentence an
 * item, when in a column of its own, the whole item opening its conversation in the reader beside it (app.tsx). Under the
 * open part and the automated section, the history ("Earlier"), newest first, paged in as the feed nears its end.
 */

type Drawn =
  | { type: "heading"; key: string; kind: FeedGroupKind }
  | { type: "item"; key: string; row: FeedRow }
  | { type: "digest"; key: string; row: FeedRow }
  | { type: "comingUp"; key: string };

/** Plan 210 (iteration 4): Coming up's disclosure, one per feed, its key stable whatever's under it. */
const COMING_UP_KEY = "coming-up";

/** A group's heading: Missed, Today, its Waiting on you, a day ahead in the when column's day words (plan 210), Ahead (iteration 5), Earlier. */
function headingName(kind: FeedGroupKind): string {
  const day = groupDay(kind);
  if (day !== null) return dayHeading(localDay(day)?.getTime() ?? Date.now());
  const week = groupWeek(kind);
  if (week !== null) return weekHeading(localDay(week)?.getTime() ?? Date.now());
  return t(kind === "missed" ? "today.missed" : kind === "today" ? "today.today" : kind === "waiting" ? "whatMatters.waitingOnYou" : kind === "ahead" ? "whatMatters.ahead" : "today.history");
}

/**
 * The rows with a heading where each group begins (a held row keeps its group's), and the digest's. Plan 210 (iteration 4,
 * revision 9): Coming up's disclosure after the open part and the automated section, before the history, when anything is
 * coming up (`comingUp`), its buckets under it while it's open, each heading keyed by its bucket.
 */
function drawn(rows: readonly FeedRow[], comingUp: number): Drawn[] {
  const out: Drawn[] = [];
  let prev: FeedGroupKind | undefined;
  let disclosed = comingUp === 0;
  for (const row of rows) {
    if (row.threadId === DIGEST_ROW_ID) {
      out.push({ type: "digest", key: row.id, row });
      continue;
    }
    const kind = row.group ?? prev;
    if (!disclosed && (comingBucket(kind) !== null || kind === "history")) {
      out.push({ type: "comingUp", key: COMING_UP_KEY });
      disclosed = true;
    }
    if (comingBucket(kind) !== null && kind !== prev) {
      out.push({ type: "heading", key: `h-${kind}`, kind: kind! });
      prev = kind;
      out.push({ type: "item", key: row.id, row });
      continue;
    }
    // Waiting on you is a part of Today (plan 210, iteration 3): Today's heading stands above it even when Today has no
    // rows of its own
    if (kind === "waiting" && prev !== "today" && prev !== "waiting") out.push({ type: "heading", key: `h-today-${row.id}`, kind: "today" });
    // keyed by the row it stands above: a group can begin twice while the rows and their groups are on their way
    if (kind && kind !== prev) out.push({ type: "heading", key: `h-${kind}-${row.id}`, kind });
    prev = kind;
    out.push({ type: "item", key: row.id, row });
  }
  if (!disclosed) out.push({ type: "comingUp", key: COMING_UP_KEY });
  return out;
}

/**
 * Opens the row's conversation beside the feed (List: as its page), as a click on a list's row does; on the row already
 * open beside it, puts it away again, as Esc does (the owner: one toggle). Plan 210 (iteration 2): another row of the
 * conversation already open only moves the reader's line to its item, nothing reopened.
 */
function openItem(row: FeedRow): void {
  const open = useFeedRow.getState().opened === row.id && getApp().selectedId === row.threadId;
  if (open && closeFeedConversation()) return;
  openFeedRow(row.id);
  if (getApp().selectedId === row.threadId && !listLayout()) return;
  pressRow(row.threadId, { meta: false, ctrl: false, shift: false });
  releaseRow(row.threadId);
}

/**
 * Who an item is from, as the feed says it: a promise's person (you sent its last message); a dated item's own sender, from
 * its message (plan 210, iteration 3: not the conversation's latest, "Gary" on Lakeshore's premium); else the sender.
 */
const senderOf = (thread: ThreadSummary, task: TodayTask | undefined, entry: TodayItem | undefined): string =>
  task?.kind === "promise" && task.person ? task.person.name : entry?.from ? entry.from.name || entry.from.email : thread.fromName || thread.fromEmail;

/** The right-click menu is a conversation's: the digest's item has none (its row on the list has none either). */
const menuId = (id: number): number | undefined => (id === DIGEST_ROW_ID ? undefined : id);

/** The column every line of the feed sits on: the same at any width, centred where the feed is wide. */
const COLUMN = "mx-auto w-full max-w-[44rem] px-5";

export function WhatMattersFeed() {
  const items = useList((s) => s.items);
  const index = useList((s) => s.index);
  const loading = useList((s) => s.loading);
  const feed = useToday((s) => s.rows);
  const comingUp = useToday((s) => s.comingUp);
  const rows = useMemo(() => drawn(feed, comingUp), [feed, comingUp]);
  /** each row's place among what's drawn, by its id */
  const placeOf = useMemo(() => new Map(rows.flatMap((r, i) => (r.type === "item" || r.type === "digest" ? [[r.key, i] as const] : []))), [rows]);
  const design = useDesign();
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]!.type === "heading" || rows[i]!.type === "comingUp" ? 44 : 68),
    getItemKey: (i) => rows[i]!.key,
    overscan: 6,
    paddingEnd: 24,
  });

  // j/k move the feed's row: the row it lands on comes into view, a row of look-ahead kept. What scrolls the list by a
  // conversation (the reader's arrows, a menu) lands on that conversation's open row, else its first
  useEffect(() => {
    feedScroller.toRow = (id) => {
      const r = placeOf.get(id);
      if (r !== undefined) virtualizer.scrollToIndex(r, { align: "auto" });
    };
    listScroller.scrollToIndex = (i) => {
      const thread = useList.getState().items[i]?.id;
      const open = feedRow(useFeedRow.getState().opened);
      const id = open?.threadId === thread ? open?.id : useToday.getState().rows.find((r) => r.threadId === thread)?.id;
      if (id !== undefined) feedScroller.toRow?.(id);
    };
  }, [virtualizer, placeOf]);

  // the open row stays in view when the feed narrows beside the conversation (its notes rewrap to new heights)
  const opened = useFeedRow((s) => s.opened);
  useEffect(() => {
    if (opened === null) return;
    const frame = requestAnimationFrame(() => feedScroller.toRow?.(opened));
    return () => cancelAnimationFrame(frame);
    // only when the open row changes (the feed's width changes with it)
  }, [opened]);

  // plan 210 (Codex code review, round 2): where the feed was left, as the list's own terms say it (the first item's
  // conversation on screen and how far into it), so coming back from another mailbox pages down to it and shows it again;
  // iteration 2: the row itself is kept too (`shownRow`), so two rows of one conversation come back to the right one
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const shownRow = useRef<FeedRowId | null>(null);
  useEffect(() => {
    const firstShown = () => {
      const el = scrollRef.current;
      if (!el) return null;
      const v = virtualizer.getVirtualItems().find((x) => x.end > el.scrollTop && rowsRef.current[x.index]?.type === "item");
      if (!v) return null;
      const drawnRow = rowsRef.current[v.index] as Extract<Drawn, { type: "item" }>;
      shownRow.current = drawnRow.row.id;
      return { id: drawnRow.row.threadId, into: Math.max(0, (el.scrollTop - v.start) / Math.max(1, v.size)) };
    };
    const anchor: typeof listAnchor = {
      scrolled: () => (scrollRef.current?.scrollTop ?? 0) > 0,
      firstVisible: () => firstShown()?.id ?? null,
      scrollAt: () => ((scrollRef.current?.scrollTop ?? 0) > 0 ? firstShown() : null),
      scrollTo: (at) => {
        if (!at) return virtualizer.scrollToOffset(0);
        const kept = rowsRef.current.findIndex((x) => x.type === "item" && x.row.id === shownRow.current && x.row.threadId === at.id);
        const r = kept >= 0 ? kept : rowsRef.current.findIndex((x) => x.type === "item" && x.row.threadId === at.id);
        if (r < 0) return;
        virtualizer.scrollToIndex(r, { align: "start" });
        // and how far into it, once it's measured
        requestAnimationFrame(() => {
          const m = virtualizer.measurementsCache[r];
          if (m) virtualizer.scrollToOffset(m.start + at.into * m.size);
        });
      },
    };
    Object.assign(listAnchor, anchor);
    return () => {
      if (listAnchor.scrollAt === anchor.scrollAt) listAnchor.scrolled = listAnchor.firstVisible = listAnchor.scrollAt = listAnchor.scrollTo = undefined;
    };
  }, [virtualizer]);

  // plan 210 (iteration 1, Codex's critique point 10): Done and Later's width, the language's and the design's, so the
  // second line ends before them (`measureControls`: by the first drawn, and again when either changes)
  const sectionRef = useRef<HTMLElement>(null);
  const controlsKey = `${getLocale()}|${design.id}`;
  useLayoutEffect(() => measureControls(sectionRef.current?.querySelector<HTMLElement>("[data-testid=wm-controls]") ?? null, true), [controlsKey]);

  // leaving What matters, the place it was left at goes with it
  useEffect(
    () => () => {
      useFeedRow.setState({ cursor: null });
      feedScroller.toRow = undefined;
    },
    [],
  );

  // the header's hairline once the feed is scrolled, as the list's
  useEffect(() => {
    const [root, sentinel, header] = [scrollRef.current, sentinelRef.current, headerRef.current];
    return root && sentinel && header ? installScrollHairline(root, sentinel, header) : undefined;
  }, []);

  const virtualItems = virtualizer.getVirtualItems();
  // plan 210: the history's next page as the feed nears its end, as the Inbox's (the list keeps its cursor). Iteration 4
  // (revision 9): Earlier's own boundary: only as the drawn window comes near its end, and again once each page lands;
  // never because rows above it came or went (Coming up opened or closed), which moves no history line
  const last = virtualItems.at(-1)?.index;
  const nearEnd = last !== undefined && last >= rows.length - 15;
  const historyLines = useMemo(() => feed.reduce((n, r) => n + (r.line ? 1 : 0), 0), [feed]);
  useEffect(() => {
    if (nearEnd) void loadMore();
  }, [nearEnd, historyLines]);
  return (
    <section ref={sectionRef} className="relative flex h-full min-h-0 flex-col bg-pane" data-testid="wm-feed" data-controls-key={controlsKey}>
      <header ref={headerRef} className="drag-region scroll-hairline shrink-0 pb-2">
        <div className={cn(COLUMN, "pl-8")}>
          <div className="flex h-(--pane-bar) items-center">
            <h1 className={cn("min-w-0 flex-1 truncate", LIST_TITLE[design.variants.listHeader === "title" ? "title" : "display"])} data-testid="list-title">
              {t("today.title")}
            </h1>
            {/* plan 210 (the owner): its options where it is, on the title's row */}
            <WhatMattersOptions />
          </div>
          <div className="-mt-1.5">
            <TodayLine />
          </div>
        </div>
      </header>
      <ThreadMenu>
        <div ref={scrollRef} id={FEED_ROWS_ID} data-keep-scroll="list" aria-busy={loading || undefined} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div ref={sentinelRef} aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px" />
          {loading && items.length === 0 ? (
            <div className={cn(COLUMN, "space-y-4 pt-4")}>
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="space-y-1.5 px-3">
                  <Skeleton shape="text" className="w-5/6" />
                  <Skeleton shape="text" className="w-1/3" />
                </div>
              ))}
            </div>
          ) : feed.length === 0 ? (
            // (plan 210, iteration 4: nothing now, Coming up's disclosure under the words, so what's ahead is a click away)
            <EmptyState icon={<Sun className="mb-2 size-7 text-muted-foreground" aria-hidden />} title={t("today.empty")}>
              {comingUp > 0 && <ComingUpHeading empty />}
            </EmptyState>
          ) : (
            <div aria-label={t("whatMatters.feed.label")} role="group" className="relative" style={{ height: virtualizer.getTotalSize() }}>
              {virtualItems.map((v) => {
                const row = rows[v.index]!;
                return (
                  <div key={v.key} data-index={v.index} ref={virtualizer.measureElement} className="absolute inset-x-0 top-0" style={{ transform: `translateY(${v.start}px)` }}>
                    {/* (a query container: a row lays its when column out by the feed's own width, plan 210, iteration 4) */}
                    <div className={cn(COLUMN, "@container")}>
                      {row.type === "heading" ? <Heading kind={row.kind} /> : row.type === "comingUp" ? <ComingUpHeading /> : row.type === "item" ? <FeedItem row={row.row} thread={items[index.get(row.row.threadId) ?? -1]} /> : <DigestItem />}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </ThreadMenu>
    </section>
  );
}

/**
 * A group's heading: its name, over a hairline. Today's "Waiting on you" (plan 210, iteration 3) is a part of Today, not a
 * group of its own: a quiet sub-heading, no hairline, on the same line as the headings and the rows' words.
 */
function Heading({ kind }: { kind: FeedGroupKind }) {
  // plan 210 (iteration 4): a Coming up bucket, a quiet sub-heading under its disclosure, as Waiting on you is under Today
  if (comingBucket(kind) !== null)
    return (
      <h3 data-testid="wm-heading" data-kind="coming" data-day={groupDay(kind) ?? groupWeek(kind) ?? undefined} className="mx-3 mb-0.5 pt-4 pb-1 text-sm font-medium text-muted-foreground">
        {headingName(kind)}
      </h3>
    );
  if (kind === "waiting")
    return (
      <h3 data-testid="wm-heading" data-kind="waiting" className="mx-3 mb-0.5 pt-4 pb-1 text-sm font-medium text-muted-foreground">
        {headingName(kind)}
      </h3>
    );
  return (
    <h2 data-testid="wm-heading" data-kind={groupDay(kind) !== null ? "day" : groupWeek(kind) !== null ? "week" : kind} data-day={groupDay(kind) ?? groupWeek(kind) ?? undefined} className="hairline-b mx-3 mb-1 pt-5 pb-1.5 text-sm font-medium text-foreground">
      {headingName(kind)}
    </h2>
  );
}

/**
 * Plan 210 (iteration 4, the Codex review's revision 9; the owner: "Coming up as the feed's last heading, closed, with its
 * count"): a heading among the feed's, its words the catalog's disclosure ("Coming up · 3", its chevron turning, the same
 * words open or shut), closed until opened and remembered as left on this machine. Opening it draws its buckets in place
 * under it; the header keeps missed · to do today · waiting.
 */
function ComingUpHeading({ empty = false }: { /** under the empty feed's words, quietly, rather than among headings */ empty?: boolean }) {
  const count = useToday((s) => s.comingUp);
  const open = useToday((s) => s.comingUpOpen);
  return (
    <Collapsible
      open={open}
      onOpenChange={setComingUpOpen}
      render={<h2 data-testid="wm-heading" data-kind="comingUp" className={empty ? "mt-2 text-sm font-normal text-muted-foreground" : "hairline-b mx-3 mb-1 pt-5 pb-1.5 text-sm font-medium text-foreground"} />}
    >
      <CollapsibleTrigger data-testid="wm-coming-up" aria-controls={FEED_ROWS_ID} className={cn("w-auto gap-1 text-[length:inherit] leading-[inherit] [&>[data-slot=collapsible-chevron]]:ms-0 [&>[data-slot=collapsible-chevron]]:size-3.5", empty ? "font-normal text-muted-foreground hover:text-foreground" : "font-medium text-foreground")}>
        {t("whatMatters.comingUp", { count })}
      </CollapsibleTrigger>
    </Collapsible>
  );
}

/** One row, its sentence made from what the backend said of it; a held row (no longer the backend's) says its own words. */
const FeedItem = memo(function FeedItem({ row, thread }: { row: FeedRow; thread: ThreadSummary | undefined }) {
  const mine = useFeedRow((s) => s.opened === row.id);
  const shown = useApp((s) => s.selectedId === row.threadId);
  const open = mine && shown;
  const cursor = useFeedRow((s) => s.cursor === row.id);
  if (!thread) return null;
  // plan 210: a history line: its words quiet, what happened and when in the column, nothing to act on
  if (row.line) {
    const from = thread.fromName || thread.fromEmail;
    return <Item row={row} sentence={historySentence(row.line)} meta={from} when={historyWhen(row.line)} tone="none" task={undefined} open={open} cursor={cursor} later past />;
  }
  return <OpenItem row={row} thread={thread} open={open} cursor={cursor} />;
});

/** An open line: its sentence made from what the backend said of it. */
function OpenItem({ row, thread, open, cursor }: { row: FeedRow; thread: ThreadSummary; open: boolean; cursor: boolean }) {
  const { entry, task, group } = row;
  // plan 210: one of Coming up's, under its day while Coming up is open: quiet
  const ahead = row.ahead === true;
  const sentence = useMemo(() => (entry ? todaySentence(entry) : thread.subject || t("common.noSubject")), [entry, thread.subject]);
  // its weight by its group (plan 210: Missed and Today's dated items strong, a day ahead quiet), its column in the list's words
  const when = useMemo(() => (entry ? todayWhen(entry, Date.now(), group, ahead) : { text: listDate(thread.lastDate), tone: "none" as const }), [entry, group, ahead, thread.lastDate]);
  const sender = senderOf(thread, task, entry);
  // the briefing's second line: who (whom a promise of yours was made to), and its related detail (a return leg); never
  // the email's date, which read as the due day (after the UI panel): the right column says when
  const who = task?.kind === "promise" && task.person ? t("whatMatters.to", { name: task.person.name }) : sender;
  return <Item row={row} sentence={sentence} meta={task?.also ? `${who} · ${task.also}` : who} when={when.text} tone={when.tone} task={task} open={open} cursor={cursor} later={ahead} />;
}

/**
 * While Done and Later show (hover, focus, the open item, their Later menu open), the second line ends before them: they are
 * `--wm-controls` wide (measured) from 0.5rem in, and the line's end is 0.75rem in (the item's padding), or past the when
 * column (at least 5rem) and its 1rem gap; a wider column only leaves more room. Never under them (plan 210, iteration 1).
 * Iteration 4: in a narrow feed the when column is under the sentence, so the second line is the row's whole width: their
 * width (`ROOM_NARROW`); else beside the column (`ROOM_BESIDE_WHEN`, the feed's width wide enough).
 */
const ROOM_BESIDE_WHEN =
  "@min-[30rem]:group-hover/item:pr-[max(0px,calc(var(--wm-controls,7.5rem)-6rem))] @min-[30rem]:group-has-focus-reveal/item:pr-[max(0px,calc(var(--wm-controls,7.5rem)-6rem))] @min-[30rem]:group-data-open/item:pr-[max(0px,calc(var(--wm-controls,7.5rem)-6rem))] @min-[30rem]:group-has-[[aria-expanded=true]]/item:pr-[max(0px,calc(var(--wm-controls,7.5rem)-6rem))]";
const ROOM_NARROW =
  "@max-[30rem]:group-hover/item:pr-(--wm-controls,7.5rem) @max-[30rem]:group-has-focus-reveal/item:pr-(--wm-controls,7.5rem) @max-[30rem]:group-data-open/item:pr-(--wm-controls,7.5rem) @max-[30rem]:group-has-[[aria-expanded=true]]/item:pr-(--wm-controls,7.5rem)";
const ROOM = "group-hover/item:pr-(--wm-controls,7.5rem) group-has-focus-reveal/item:pr-(--wm-controls,7.5rem) group-data-open/item:pr-(--wm-controls,7.5rem) group-has-[[aria-expanded=true]]/item:pr-(--wm-controls,7.5rem)";

interface ItemProps {
  row: FeedRow;
  sentence: string;
  meta: string;
  task: TodayTask | undefined;
  /** its conversation is the one open beside the feed */
  open: boolean;
  /** Coming up's: its column quieter (its words the row's ink: plan 210, iteration 3) */
  later: boolean;
  /** plan 210: a history line (done, removed, settled, over) */
  past?: boolean;
  /** the item a conversation was just put away from: marked quietly (the hover's fill), where j/k go on from */
  cursor?: boolean;
  /** the right column: a short day, a time, "Was due Wed", or nothing */
  when: string | null;
  tone: TodayTone;
  /** the digest's way in (no conversation of its own) */
  digest?: boolean;
}

/**
 * Plan 210 (iteration 1, Codex's critique point 10): the quiet words (who, "since Wed", a day ahead's column, Coming up's
 * sentences) are the row's preview ink, a step stronger than the muted one and held to AA on every fill a row has (rest,
 * hover, the cursor: CONTRAST_PAIRS' row-preview); on the open item, the selection's ink. The history alone stays muted.
 *
 * After the UI panel: what's Missed or due today reads stronger than what's days away (the ink and a medium weight); days
 * away, the day is quiet. No red: weight alone (plan 210, iteration 3: the accent on today's day read as a meaning of its
 * own beside the grey ones, so it went). On the open item every word is the selection's ink (the pairs CONTRAST_PAIRS
 * holds).
 */
const SENTENCE_INK: Record<TodayTone, string> = { missed: "font-medium text-foreground", today: "font-medium text-foreground", later: "text-foreground", none: "text-foreground" };
const WHEN_INK: Record<TodayTone, string> = {
  missed: "font-medium text-foreground",
  // plan 210 (iteration 3, the panel): one treatment for "Today", the ink and weight, never an accent beside the quiet ones
  today: "font-medium text-foreground",
  later: "text-row-preview",
  none: "text-row-preview",
};

/**
 * An item: one plain sentence (three lines at most, the open one whole, the rest in its title), who under it, and when in a column of its
 * own on the right, in the list's words. The whole item opens its conversation, the list staying where it is. Done and
 * Later, in words, on hover, on focus and on the open item, over the second line's end (they take no room while hidden);
 * D and the right-click menu as on the list.
 */
function Item({ row, sentence, meta, when, tone, task, open, cursor = false, later, past = false, digest = false }: ItemProps) {
  const textId = useId();
  return (
    // the right-click menu is the conversation's, its task this row's (plan 210, iteration 2: `menuRow`)
    <div data-thread-id={menuId(row.threadId)} data-row-id={row.id} data-held={row.held || undefined} data-testid="wm-item" onContextMenu={() => useToday.setState({ menuRow: row.id })} data-open={open || undefined} data-cursor={cursor || undefined} data-history={past || undefined} data-digest={digest || undefined} data-ahead={(later && !past) || undefined} data-tone={tone} className="group/item relative rounded-lg not-data-open:hover:bg-row-hover data-cursor:bg-row-hover data-open:bg-row-selected">
      {/* plan 210 (iteration 4, design point 2): the sentence keeps at least two thirds of the row: the when column is at
          most a third (its words wrap there); in a narrow feed (the reader open beside it) it goes under the sentence, on a
          line of its own above who, so "You said you'd…" is never crushed beside it */}
      <button type="button" data-testid="wm-item-open" title={`${sentence}\n${meta}`} aria-expanded={open} onFocus={() => placeFeedKeys(row.id)} onClick={() => openItem(row)} className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 rounded-lg px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring @max-[30rem]:grid-cols-1">
        {/* plan 210 (iteration 3): Coming up's sentences in the row ink, not a fade (its column stays quiet). The claims
            ledger's second batch: three lines at most, the open item's whole (two cut an alert's ", the email says" and a
            promise's second deliverable, worst beside the reader); the whole sentence is the button's title and, unclamped in
            the DOM, what a screen reader reads */}
        <span id={textId} data-testid="wm-sentence" className={cn("col-start-1 row-start-1 line-clamp-3 text-base text-pretty group-data-open/item:line-clamp-none group-data-open/item:text-row-selected-foreground", past ? "text-muted-foreground" : SENTENCE_INK[tone])}>
          {sentence}
        </span>
        {when && (
          <span
            data-testid="wm-when"
            className={cn(
              "col-start-2 row-span-2 row-start-1 max-w-[calc(100cqw/3-1.5rem)] min-w-20 pt-px text-right text-sm text-balance tabular group-data-open/item:text-row-selected-foreground @max-[30rem]:col-start-1 @max-[30rem]:row-span-1 @max-[30rem]:row-start-2 @max-[30rem]:mt-0.5 @max-[30rem]:max-w-none @max-[30rem]:min-w-0 @max-[30rem]:pt-0 @max-[30rem]:text-left",
              past ? "text-muted-foreground" : WHEN_INK[tone],
            )}
          >
            {when}
          </span>
        )}
        {/* while Done and Later show over its end, it ends (in an ellipsis) before them: a little before, beside the right
            column (at least 5rem, so they reach no further into it), else their width */}
        <span data-testid="wm-meta" className={cn("col-start-1 row-start-2 mt-0.5 block min-w-0 truncate text-sm group-data-open/item:text-row-selected-foreground @max-[30rem]:row-start-3", past ? "text-muted-foreground" : "text-row-preview", task && (when ? cn(ROOM_BESIDE_WHEN, ROOM_NARROW) : ROOM))}>
          {meta}
        </span>
      </button>
      {task && (
        <div
          data-testid="wm-controls"
          ref={(el) => measureControls(el)}
          className="pointer-events-none absolute right-2 bottom-1.5 flex items-center gap-1 rounded-md bg-pane pl-2 opacity-0 transition-opacity duration-fast group-hover/item:pointer-events-auto group-[:hover:not([data-open])]/item:bg-row-hover group-hover/item:opacity-100 group-data-open/item:pointer-events-auto group-data-open/item:bg-row-selected group-data-open/item:opacity-100 has-focus-reveal:pointer-events-auto has-focus-reveal:opacity-100 has-[[aria-expanded=true]]:pointer-events-auto has-[[aria-expanded=true]]:opacity-100"
        >
          <BriefTaskControls rowId={row.id} task={task} describedBy={textId} />
        </div>
      )}
    </div>
  );
}

/**
 * The digest's way in, the feed's last item: its count, and the page beside the feed. Its second line says what it holds in
 * general words (plan 210, iteration 1; Codex's critique point 9): senders' names there read as people the feed already
 * shows (a calendar invitation's, a biller's line above), and guessing which are on screen is no rule.
 */
function DigestItem() {
  const digest = useToday((s) => s.digest);
  const row = useToday((s) => s.rows.find((r) => r.threadId === DIGEST_ROW_ID));
  const open = useApp((s) => s.selectedId === DIGEST_ROW_ID);
  if (!digest || !row) return null;
  const sentence = digestLabel(digest);
  return <Item row={row} sentence={sentence} meta={t("whatMatters.automatedLine")} when={null} tone="none" task={undefined} open={open} later={false} digest />;
}
