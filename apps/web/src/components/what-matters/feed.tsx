import { useVirtualizer } from "@tanstack/react-virtual";
import { DIGEST_ROW_ID, localDay, type FeedRowId, type ThreadSummary } from "@terno/core";
import { getLocale, t } from "@terno/i18n";
import { Skeleton } from "@terno/ui/components/skeleton";
import { Sun } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef } from "react";
import type { TodayTask } from "~/lib/dated";
import { useDesign } from "~/lib/design";
import { listDate } from "~/lib/format";
import { dayHeading } from "~/lib/when";
import { LIST_TITLE } from "~/lib/list-title";
import { installScrollHairline } from "~/lib/scroll-hairline";
import { pressRow, releaseRow } from "~/lib/select";
import { historySentence, historyWhen, todaySentence, todayWhen, type TodayTone } from "~/lib/today-sentence";
import { feedScroller } from "~/lib/feed-focus";
import { measureControls } from "~/lib/feed-controls";
import { closeFeedConversation } from "~/lib/feed-pane";
import { listLayout } from "~/lib/page";
import { getApp, useApp } from "~/state/app";
import { listAnchor, loadMore, useList } from "~/state/list";
import { digestLabel, feedRow, groupDay, openFeedRow, useFeedRow, useToday, type FeedGroupKind, type FeedRow } from "~/state/today";
import { EmptyState } from "../empty-state";
import { listScroller } from "~/lib/list-scroller";
import { ThreadMenu } from "../thread-menu";
import { TodayDatedOffer } from "../today-dated-offer";
import { WhatMattersOptions } from "./options";
import { BriefTaskControls } from "./task-menus";
import { TodayLine } from "./today-line";

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
  | { type: "digest"; key: string; row: FeedRow };

/** A group's heading: Missed, Today, a day ahead in the when column's day words (plan 210), Earlier. */
function headingName(kind: FeedGroupKind): string {
  const day = groupDay(kind);
  if (day !== null) return dayHeading(localDay(day)?.getTime() ?? Date.now());
  return t(kind === "missed" ? "today.missed" : kind === "today" ? "today.today" : "today.history");
}

/** The rows with a heading where each group begins (a held row keeps its group's), and the digest's. */
function drawn(rows: readonly FeedRow[]): Drawn[] {
  const out: Drawn[] = [];
  let prev: FeedGroupKind | undefined;
  for (const row of rows) {
    if (row.threadId === DIGEST_ROW_ID) {
      out.push({ type: "digest", key: row.id, row });
      continue;
    }
    const kind = row.group ?? prev;
    // keyed by the row it stands above: a group can begin twice while the rows and their groups are on their way
    if (kind && kind !== prev) out.push({ type: "heading", key: `h-${kind}-${row.id}`, kind });
    prev = kind;
    out.push({ type: "item", key: row.id, row });
  }
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

/** Who an item is from, as the feed says it: a promise's person (you sent its last message), else the sender. */
const senderOf = (thread: ThreadSummary, task: TodayTask | undefined): string => (task?.kind === "promise" && task.person ? task.person.name : thread.fromName || thread.fromEmail);

/** The right-click menu is a conversation's: the digest's item has none (its row on the list has none either). */
const menuId = (id: number): number | undefined => (id === DIGEST_ROW_ID ? undefined : id);

/** The column every line of the feed sits on: the same at any width, centred where the feed is wide. */
const COLUMN = "mx-auto w-full max-w-[44rem] px-5";

export function WhatMattersFeed() {
  const items = useList((s) => s.items);
  const index = useList((s) => s.index);
  const loading = useList((s) => s.loading);
  const feed = useToday((s) => s.rows);
  const rows = useMemo(() => drawn(feed), [feed]);
  /** each row's place among what's drawn, by its id */
  const placeOf = useMemo(() => new Map(rows.flatMap((r, i) => (r.type !== "heading" ? [[r.key, i] as const] : []))), [rows]);
  const design = useDesign();
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]!.type === "heading" ? 44 : 68),
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
  // plan 210: the history's next page as the feed nears its end, as the Inbox's (the list keeps its cursor)
  const last = virtualItems.at(-1)?.index;
  useEffect(() => {
    if (last !== undefined && last >= rows.length - 15) void loadMore();
  }, [last, rows.length]);
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
            <TodayDatedOffer />
          </div>
        </div>
      </header>
      <ThreadMenu>
        <div ref={scrollRef} data-keep-scroll="list" aria-busy={loading || undefined} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
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
          ) : rows.length === 0 ? (
            <EmptyState icon={<Sun className="mb-2 size-7 text-muted-foreground" aria-hidden />} title={t("today.empty")} />
          ) : (
            <div aria-label={t("whatMatters.feed.label")} role="group" className="relative" style={{ height: virtualizer.getTotalSize() }}>
              {virtualItems.map((v) => {
                const row = rows[v.index]!;
                return (
                  <div key={v.key} data-index={v.index} ref={virtualizer.measureElement} className="absolute inset-x-0 top-0" style={{ transform: `translateY(${v.start}px)` }}>
                    <div className={COLUMN}>
                      {row.type === "heading" ? <Heading kind={row.kind} /> : row.type === "item" ? <FeedItem row={row.row} thread={items[index.get(row.row.threadId) ?? -1]} /> : <DigestItem />}
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

/** A group's heading: its name, over a hairline. */
function Heading({ kind }: { kind: FeedGroupKind }) {
  return (
    <h2 data-testid="wm-heading" data-kind={groupDay(kind) === null ? kind : "day"} data-day={groupDay(kind) ?? undefined} className="hairline-b mx-3 mb-1 pt-5 pb-1.5 text-sm font-medium text-foreground">
      {headingName(kind)}
    </h2>
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
  const sender = senderOf(thread, task);
  // the briefing's second line: who (whom a promise of yours was made to), and its related detail (a return leg); never
  // the email's date, which read as the due day (after the UI panel): the right column says when
  const who = task?.kind === "promise" && task.person ? t("whatMatters.to", { name: task.person.name }) : sender;
  return <Item row={row} sentence={sentence} meta={task?.also ? `${who} · ${task.also}` : who} when={when.text} tone={when.tone} task={task} open={open} cursor={cursor} later={ahead} />;
}

/**
 * While Done and Later show (hover, focus, the open item, their Later menu open), the second line ends before them: they are
 * `--wm-controls` wide (measured) from 0.5rem in, and the line's end is 0.75rem in (the item's padding), or past the when
 * column (at least 5rem) and its 1rem gap; a wider column only leaves more room. Never under them (plan 210, iteration 1).
 */
const ROOM_BESIDE_WHEN =
  "group-hover/item:pr-[max(0px,calc(var(--wm-controls,7.5rem)-6rem))] group-has-focus-reveal/item:pr-[max(0px,calc(var(--wm-controls,7.5rem)-6rem))] group-data-open/item:pr-[max(0px,calc(var(--wm-controls,7.5rem)-6rem))] group-has-[[aria-expanded=true]]/item:pr-[max(0px,calc(var(--wm-controls,7.5rem)-6rem))]";
const ROOM = "group-hover/item:pr-(--wm-controls,7.5rem) group-has-focus-reveal/item:pr-(--wm-controls,7.5rem) group-data-open/item:pr-(--wm-controls,7.5rem) group-has-[[aria-expanded=true]]/item:pr-(--wm-controls,7.5rem)";

interface ItemProps {
  row: FeedRow;
  sentence: string;
  meta: string;
  task: TodayTask | undefined;
  /** its conversation is the one open beside the feed */
  open: boolean;
  /** Coming up's: quieter */
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
 * After the UI panel: what's Missed or due today reads stronger than what's days away (the ink and a medium weight), and
 * its day in the right column is the accent at rest; days away, the day is quiet. No red: weight and one accent. On the
 * open item every word is the selection's ink (the pairs CONTRAST_PAIRS holds); under the pointer, the accent gives way
 * to the ink (the accent isn't held on the hover's fill).
 */
const SENTENCE_INK: Record<TodayTone, string> = { missed: "font-medium text-foreground", today: "font-medium text-foreground", later: "text-foreground", none: "text-foreground" };
const WHEN_INK: Record<TodayTone, string> = {
  missed: "font-medium text-foreground",
  today: "font-medium text-primary group-[:hover:not([data-open])]/item:text-foreground group-data-cursor/item:text-foreground",
  later: "text-row-preview",
  none: "text-row-preview",
};

/**
 * An item: one plain sentence (two lines at most, the rest in its name and title), who under it, and when in a column of its
 * own on the right, in the list's words. The whole item opens its conversation, the list staying where it is. Done and
 * Later, in words, on hover, on focus and on the open item, over the second line's end (they take no room while hidden);
 * D and the right-click menu as on the list.
 */
function Item({ row, sentence, meta, when, tone, task, open, cursor = false, later, past = false, digest = false }: ItemProps) {
  const textId = useId();
  return (
    // the right-click menu is the conversation's, its task this row's (plan 210, iteration 2: `menuRow`)
    <div data-thread-id={menuId(row.threadId)} data-row-id={row.id} data-held={row.held || undefined} data-testid="wm-item" onContextMenu={() => useToday.setState({ menuRow: row.id })} data-open={open || undefined} data-cursor={cursor || undefined} data-history={past || undefined} data-digest={digest || undefined} data-ahead={(later && !past) || undefined} data-tone={tone} className="group/item relative rounded-lg not-data-open:hover:bg-row-hover data-cursor:bg-row-hover data-open:bg-row-selected">
      <button type="button" data-testid="wm-item-open" title={`${sentence}\n${meta}`} aria-expanded={open} onClick={() => openItem(row)} className="flex w-full min-w-0 items-start gap-4 rounded-lg px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="min-w-0 flex-1">
          <span id={textId} data-testid="wm-sentence" className={cn("line-clamp-2 text-base text-pretty group-data-open/item:text-row-selected-foreground", later ? (past ? "text-muted-foreground" : "text-row-preview") : SENTENCE_INK[tone])}>
            {sentence}
          </span>
          {/* while Done and Later show over its end, it ends (in an ellipsis) before them: a little before, beside the right
              column (at least 5rem, so they reach no further into it), else their width */}
          <span data-testid="wm-meta" className={cn("mt-0.5 block truncate text-sm group-data-open/item:text-row-selected-foreground", past ? "text-muted-foreground" : "text-row-preview", task && (when ? ROOM_BESIDE_WHEN : ROOM))}>
            {meta}
          </span>
        </span>
        {when && (
          <span data-testid="wm-when" className={cn("min-w-20 shrink-0 pt-px text-right text-sm whitespace-nowrap tabular group-data-open/item:text-row-selected-foreground", past ? "text-muted-foreground" : WHEN_INK[tone])}>
            {when}
          </span>
        )}
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
