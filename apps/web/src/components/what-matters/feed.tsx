import { useVirtualizer } from "@tanstack/react-virtual";
import { DIGEST_ROW_ID, localDay, type ThreadSummary } from "@terno/core";
import { getLocale, t } from "@terno/i18n";
import { Skeleton } from "@terno/ui/components/skeleton";
import { Sun } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { memo, useEffect, useId, useMemo, useRef } from "react";
import type { TodayTask } from "~/lib/dated";
import { useDesign } from "~/lib/design";
import { listDate } from "~/lib/format";
import { dayHeading } from "~/lib/when";
import { LIST_TITLE } from "~/lib/list-title";
import { installScrollHairline } from "~/lib/scroll-hairline";
import { pressRow, releaseRow } from "~/lib/select";
import { historySentence, historyWhen, todaySentence, todayWhen, type TodayTone } from "~/lib/today-sentence";
import { useFeedCursor } from "~/lib/feed-focus";
import { closeFeedConversation } from "~/lib/feed-pane";
import { getApp, useApp } from "~/state/app";
import { listAnchor, loadMore, useList } from "~/state/list";
import { digestFrom, digestLabel, groupDay, useToday, type FeedGroupKind } from "~/state/today";
import { EmptyState } from "../empty-state";
import { listScroller } from "~/lib/list-scroller";
import { ThreadMenu } from "../thread-menu";
import { TodayDatedOffer } from "../today-dated-offer";
import { WhatMattersOptions } from "./options";
import { BriefTaskControls } from "./task-menus";
import { TodayLine } from "./today-line";

/**
 * Plan 204's briefing, which the owner made What matters' only view (plan 210): a feed drawn from the very rows the list
 * keeps (`useList`: the same order, held rows, the digest's place) and Today's own maps (each row's group, task and item),
 * so j/k, D, the right-click menu, Done's Undo and a reload all work as on any list. The headings, one plain sentence an
 * item, when in a column of its own, the whole item opening its conversation in the reader beside it (app.tsx). Under the
 * open part and the automated section, the history ("Earlier"), newest first, paged in as the feed nears its end.
 */

type FeedRow =
  | { type: "heading"; key: string; kind: FeedGroupKind }
  | { type: "item"; key: string; id: number; index: number; kind: FeedGroupKind | undefined }
  | { type: "digest"; key: string; index: number };

/** A group's heading: Missed, Today, a day ahead in the when column's day words (plan 210), Earlier. */
function headingName(kind: FeedGroupKind): string {
  const day = groupDay(kind);
  if (day !== null) return dayHeading(localDay(day)?.getTime() ?? Date.now());
  return t(kind === "missed" ? "today.missed" : kind === "today" ? "today.today" : "today.history");
}

/** The list's rows with a heading where each group begins (a held row keeps its group's), and the digest. */
function feedRows(items: readonly ThreadSummary[], kinds: ReadonlyMap<number, FeedGroupKind>): FeedRow[] {
  const rows: FeedRow[] = [];
  let prev: FeedGroupKind | undefined;
  items.forEach((it, index) => {
    if (it.id === DIGEST_ROW_ID) return void rows.push({ type: "digest", key: "digest", index });
    const kind = kinds.get(it.id) ?? prev;
    // keyed by the row it stands above: a group can begin twice while the rows and their groups are on their way
    if (kind && kind !== prev) rows.push({ type: "heading", key: `h-${kind}-${it.id}`, kind });
    prev = kind;
    rows.push({ type: "item", key: `t-${it.id}`, id: it.id, index, kind });
  });
  return rows;
}

/**
 * Opens the item's conversation beside the feed (List: as its page), as a click on a row does; on the item already open
 * beside it, puts it away again, as Esc does (the owner: one toggle).
 */
function openItem(id: number): void {
  if (getApp().selectedId === id && closeFeedConversation()) return;
  pressRow(id, { meta: false, ctrl: false, shift: false });
  releaseRow(id);
}

/** Who an item is from, as the feed says it: a promise's person (you sent its last message), else the sender. */
const senderOf = (thread: ThreadSummary, task: TodayTask | undefined): string => (task?.kind === "promise" && task.person ? task.person.name : thread.fromName || thread.fromEmail);

/** The right-click menu is a conversation's: the digest's item has none (its row on the list has none either). */
const menuId = (id: number): number | undefined => (id === DIGEST_ROW_ID ? undefined : id);

/** The column every line of the feed sits on: the same at any width, centred where the feed is wide. */
const COLUMN = "mx-auto w-full max-w-[44rem] px-5";

export function WhatMattersFeed() {
  const items = useList((s) => s.items);
  const loading = useList((s) => s.loading);
  const kinds = useToday((s) => s.kinds);
  const rows = useMemo(() => feedRows(items, kinds), [items, kinds]);
  const rowOf = useMemo(() => new Map(rows.flatMap((r, i) => (r.type === "item" || r.type === "digest" ? [[r.index, i] as const] : []))), [rows]);
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

  // j/k move the list's cursor (the app's selection): the item it lands on comes into view, a row of look-ahead kept
  useEffect(() => {
    listScroller.scrollToIndex = (i) => {
      const r = rowOf.get(i);
      if (r !== undefined) virtualizer.scrollToIndex(r, { align: "auto" });
    };
  }, [virtualizer, rowOf]);

  // the open item stays in view when the feed narrows beside the conversation (its notes rewrap to new heights)
  const selectedId = useApp((s) => s.selectedId);
  useEffect(() => {
    if (selectedId === null) return;
    useFeedCursor.setState({ id: null });
    const frame = requestAnimationFrame(() => {
      const i = useList.getState().index.get(selectedId);
      const r = i === undefined ? undefined : rowOf.get(i);
      if (r !== undefined) virtualizer.scrollToIndex(r, { align: "auto" });
    });
    return () => cancelAnimationFrame(frame);
    // only when the open item changes (the feed's width changes with it)
  }, [selectedId]);

  // plan 210 (Codex code review, round 2): where the feed was left, as the list's own rows say it (the first item on
  // screen and how far into it), so coming back from another mailbox pages down to it and shows it again
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  useEffect(() => {
    const firstShown = () => {
      const el = scrollRef.current;
      if (!el) return null;
      const v = virtualizer.getVirtualItems().find((x) => x.end > el.scrollTop && rowsRef.current[x.index]?.type === "item");
      if (!v) return null;
      const row = rowsRef.current[v.index] as Extract<FeedRow, { type: "item" }>;
      return { id: row.id, into: Math.max(0, (el.scrollTop - v.start) / Math.max(1, v.size)) };
    };
    const anchor: typeof listAnchor = {
      scrolled: () => (scrollRef.current?.scrollTop ?? 0) > 0,
      firstVisible: () => firstShown()?.id ?? null,
      scrollAt: () => ((scrollRef.current?.scrollTop ?? 0) > 0 ? firstShown() : null),
      scrollTo: (at) => {
        if (!at) return virtualizer.scrollToOffset(0);
        const i = useList.getState().index.get(at.id);
        const r = rowsRef.current.findIndex((x) => x.type === "item" && x.index === i);
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

  // leaving What matters, the place it was left at goes with it
  useEffect(() => () => useFeedCursor.setState({ id: null }), []);

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
    <section className="relative flex h-full min-h-0 flex-col bg-pane" data-testid="wm-feed">
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
          ) : items.length === 0 ? (
            <EmptyState icon={<Sun className="mb-2 size-7 text-muted-foreground" aria-hidden />} title={t("today.empty")} />
          ) : (
            <div aria-label={t("whatMatters.feed.label")} role="group" className="relative" style={{ height: virtualizer.getTotalSize() }}>
              {virtualItems.map((v) => {
                const row = rows[v.index]!;
                return (
                  <div key={v.key} data-index={v.index} ref={virtualizer.measureElement} className="absolute inset-x-0 top-0" style={{ transform: `translateY(${v.start}px)` }}>
                    <div className={COLUMN}>
                      {row.type === "heading" ? <Heading kind={row.kind} /> : row.type === "item" ? <FeedItem id={row.id} thread={items[row.index]!} group={row.kind} /> : <DigestItem />}
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

/** One item, its sentence made from what the backend said of it; a held row (no longer Today's) says its subject. */
const FeedItem = memo(function FeedItem({ id, thread, group }: { id: number; thread: ThreadSummary; group: FeedGroupKind | undefined }) {
  const open = useApp((s) => s.selectedId === id);
  const cursor = useFeedCursor((s) => s.id === id);
  // plan 210: a history line: its words quiet, what happened and when in the column, nothing to act on
  const line = useToday((s) => s.history.get(id));
  if (line) {
    const said = historySentence(line);
    const happened = historyWhen(line);
    const from = thread.fromName || thread.fromEmail;
    return <Item id={id} sentence={said} meta={from} when={happened} tone="none" task={undefined} open={open} cursor={cursor} later past />;
  }
  return <OpenItem id={id} thread={thread} group={group} open={open} cursor={cursor} />;
});

/** An open line: its sentence made from what the backend said of it; a held row (no longer Today's) says its subject. */
function OpenItem({ id, thread, group, open, cursor }: { id: number; thread: ThreadSummary; group: FeedGroupKind | undefined; open: boolean; cursor: boolean }) {
  const entry = useToday((s) => s.entries.get(id));
  const task = useToday((s) => s.tasks.get(id));
  // plan 210: one of Coming up's, under its day while Coming up is open: quiet
  const ahead = useToday((s) => s.ahead.has(id));
  const sentence = useMemo(() => (entry ? todaySentence(entry) : thread.subject || t("common.noSubject")), [entry, thread.subject]);
  // a held row (no longer Today's) says only the day it came, quietly
  // its weight by its group (plan 210: Missed and Today's dated items strong, a day ahead quiet), its column in the list's words
  const when = useMemo(() => (entry ? todayWhen(entry, Date.now(), group, ahead) : { text: listDate(thread.lastDate), tone: "none" as const }), [entry, group, ahead, thread.lastDate]);
  const sender = senderOf(thread, task);
  // the briefing's second line: who (whom a promise of yours was made to), and the conversation's next item; never the
  // email's date, which read as the due day (after the UI panel): the right column says when
  const who = task?.kind === "promise" && task.person ? t("whatMatters.to", { name: task.person.name }) : sender;
  return <Item id={id} sentence={sentence} meta={task?.also ? `${who} · ${task.also}` : who} when={when.text} tone={when.tone} task={task} open={open} cursor={cursor} later={ahead} />;
}

interface ItemProps {
  id: number;
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
 * After the UI panel: what's Missed or due today reads stronger than what's days away (the ink and a medium weight), and
 * its day in the right column is the accent at rest; days away, the day is quiet. No red: weight and one accent. On the
 * open item every word is the selection's ink (the pairs CONTRAST_PAIRS holds); under the pointer, the accent gives way
 * to the ink (the accent isn't held on the hover's fill).
 */
const SENTENCE_INK: Record<TodayTone, string> = { missed: "font-medium text-foreground", today: "font-medium text-foreground", later: "text-foreground", none: "text-foreground" };
const WHEN_INK: Record<TodayTone, string> = {
  missed: "font-medium text-foreground",
  today: "font-medium text-primary group-[:hover:not([data-open])]/item:text-foreground group-data-cursor/item:text-foreground",
  later: "text-muted-foreground",
  none: "text-muted-foreground",
};

/**
 * An item: one plain sentence (two lines at most, the rest in its name and title), who under it, and when in a column of its
 * own on the right, in the list's words. The whole item opens its conversation, the list staying where it is. Done and
 * Later, in words, on hover, on focus and on the open item, over the second line's end (they take no room while hidden);
 * D and the right-click menu as on the list.
 */
function Item({ id, sentence, meta, when, tone, task, open, cursor = false, later, past = false, digest = false }: ItemProps) {
  const textId = useId();
  return (
    <div data-thread-id={menuId(id)} data-item-id={id} data-testid="wm-item" data-open={open || undefined} data-cursor={cursor || undefined} data-history={past || undefined} data-digest={digest || undefined} data-ahead={(later && !past) || undefined} data-tone={tone} className="group/item relative rounded-lg not-data-open:hover:bg-row-hover data-cursor:bg-row-hover data-open:bg-row-selected">
      <button type="button" data-testid="wm-item-open" title={`${sentence}\n${meta}`} aria-expanded={open} onClick={() => openItem(id)} className="flex w-full min-w-0 items-start gap-4 rounded-lg px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="min-w-0 flex-1">
          <span id={textId} data-testid="wm-sentence" className={cn("line-clamp-2 text-base text-pretty group-data-open/item:text-row-selected-foreground", later ? "text-muted-foreground" : SENTENCE_INK[tone])}>
            {sentence}
          </span>
          {/* while Done and Later show over its end, it ends (in an ellipsis) before them: a little before, beside the right
              column (at least 5rem, so they reach no further into it), else their width */}
          <span data-testid="wm-meta" className={cn("mt-0.5 block truncate text-sm text-muted-foreground", task && (when ? "group-hover/item:pr-6 group-has-[:focus-visible]/item:pr-6 group-data-open/item:pr-6" : "group-hover/item:pr-28 group-has-[:focus-visible]/item:pr-28 group-data-open/item:pr-28"))}>
            {meta}
          </span>
        </span>
        {when && (
          <span data-testid="wm-when" className={cn("min-w-20 shrink-0 pt-px text-right text-sm whitespace-nowrap tabular group-data-open/item:text-row-selected-foreground", WHEN_INK[tone])}>
            {when}
          </span>
        )}
      </button>
      {task && (
        <div
          data-testid="wm-controls"
          className="pointer-events-none absolute right-2 bottom-1.5 flex items-center gap-1 rounded-md bg-pane pl-2 opacity-0 transition-opacity duration-fast group-hover/item:pointer-events-auto group-[:hover:not([data-open])]/item:bg-row-hover group-hover/item:opacity-100 group-data-open/item:pointer-events-auto group-data-open/item:bg-row-selected group-data-open/item:opacity-100 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100 has-[[aria-expanded=true]]:pointer-events-auto has-[[aria-expanded=true]]:opacity-100"
        >
          <BriefTaskControls threadId={id} task={task} describedBy={textId} />
        </div>
      )}
    </div>
  );
}

/** The digest's way in, the feed's last item: its count, who the newsletters are from, and the page beside the feed. */
function DigestItem() {
  const digest = useToday((s) => s.digest);
  const open = useApp((s) => s.selectedId === DIGEST_ROW_ID);
  if (!digest) return null;
  const from = digestFrom(digest, getLocale());
  const sentence = digestLabel(digest);
  return <Item id={DIGEST_ROW_ID} sentence={sentence} meta={from ?? t("today.newsletters")} when={null} tone="none" task={undefined} open={open} later={false} digest />;
}
