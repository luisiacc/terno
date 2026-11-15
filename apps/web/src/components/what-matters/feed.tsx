import { useVirtualizer } from "@tanstack/react-virtual";
import { DIGEST_ROW_ID, type ThreadSummary, type TodayGroupKind } from "@terno/core";
import { getLocale, t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { SeparatorLabel } from "@terno/ui/components/separator";
import { Skeleton } from "@terno/ui/components/skeleton";
import { ArrowRight, Sun } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { memo, useEffect, useId, useMemo, useRef } from "react";
import type { TodayTask } from "~/lib/dated";
import { useDesign } from "~/lib/design";
import { listDate } from "~/lib/format";
import { LIST_TITLE } from "~/lib/list-title";
import { installScrollHairline } from "~/lib/scroll-hairline";
import { pressRow, releaseRow } from "~/lib/select";
import { groupLine, todaySentence } from "~/lib/today-sentence";
import { listLayout } from "~/lib/page";
import { feedLook, useWmLook, type WmLook } from "~/lib/what-matters-look";
import { getApp, setApp, useApp } from "~/state/app";
import { useList } from "~/state/list";
import { digestFrom, digestLabel, useToday } from "~/state/today";
import { EmptyState } from "../empty-state";
import { listScroller, TodayLine } from "../thread-list";
import { ThreadMenu } from "../thread-menu";
import { TodayDatedOffer } from "../today-dated-offer";
import { BriefTaskControls, NoteTaskMenu } from "./task-menus";

/**
 * Plan 204, the UI experiment: Today as a feed rather than thread rows, drawn from the very rows the list has (`useList`:
 * the same order, held rows, the digest's place) and Today's own maps (each row's group, task and item). So j/k, D, the
 * right-click menu, Done's Undo and a reload all work as they do on the list; only the drawing differs. `chat` is the
 * owner's read-only feed of short notes, each with a small way to its email; `brief` keeps the headings, one plain
 * sentence an item, the whole item opening it. The conversation opens in the reader beside it (app.tsx).
 */

type FeedRow =
  | { type: "heading"; key: string; kind: TodayGroupKind; count: number }
  | { type: "item"; key: string; id: number; index: number; kind: TodayGroupKind | undefined }
  | { type: "digest"; key: string; index: number }
  | { type: "end"; key: string };

const SECTION_NAME = { missed: "today.missed", deadlines: "today.deadlines", plans: "today.plans", needsYou: "today.needsYou", reminders: "today.reminders", comingUp: "today.comingUp" } as const satisfies Record<TodayGroupKind, string>;

/** The list's rows with a heading where each group begins (a held row keeps its group's), the digest, and the chat's end. */
function feedRows(items: readonly ThreadSummary[], kinds: ReadonlyMap<number, TodayGroupKind>, chat: boolean): FeedRow[] {
  const counts = new Map<TodayGroupKind, number>();
  for (const it of items) {
    const k = kinds.get(it.id);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const rows: FeedRow[] = [];
  let prev: TodayGroupKind | undefined;
  items.forEach((it, index) => {
    if (it.id === DIGEST_ROW_ID) return void rows.push({ type: "digest", key: "digest", index });
    const kind = kinds.get(it.id) ?? prev;
    // keyed by the row it stands above: a group can begin twice while the rows and their groups are on their way
    if (kind && kind !== prev) rows.push({ type: "heading", key: `h-${kind}-${it.id}`, kind, count: counts.get(kind) ?? 0 });
    prev = kind;
    rows.push({ type: "item", key: `t-${it.id}`, id: it.id, index, kind });
  });
  if (chat && items.length) rows.push({ type: "end", key: "end" });
  return rows;
}

/** Opens the item's conversation beside the feed (List: as its page), as a click on a row does. */
function openItem(id: number): void {
  pressRow(id, { meta: false, ctrl: false, shift: false });
  releaseRow(id);
}

/**
 * Esc in Split: the conversation open beside the feed goes, and the feed has the room again; the keyboard is back on the
 * item it was opened from (quietly: no ring after a key, plan 54). False where there's none to put away.
 */
export function closeFeedConversation(): boolean {
  const s = getApp();
  const id = s.selectedId;
  if (id === null || listLayout() || !feedLook(s.today, useWmLook.getState().look)) return false;
  setApp({ selectedId: null });
  requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-testid=wm-feed] [data-thread-id="${id}"] button`)?.focus({ preventScroll: true }));
  return true;
}

/** Who an item is from, as the feed says it: a promise's person (you sent its last message), else the sender. */
const senderOf = (thread: ThreadSummary, task: TodayTask | undefined): string => (task?.kind === "promise" && task.person ? task.person.name : thread.fromName || thread.fromEmail);

/** The right-click menu is a conversation's: the digest's item has none (its row on the list has none either). */
const menuId = (id: number): number | undefined => (id === DIGEST_ROW_ID ? undefined : id);

/** The column every line of the feed sits on: the same at any width, centred where the feed is wide. */
const COLUMN = "mx-auto w-full max-w-[44rem] px-5";

export function WhatMattersFeed({ look }: { look: Exclude<WmLook, "list"> }) {
  const chat = look === "chat";
  const items = useList((s) => s.items);
  const loading = useList((s) => s.loading);
  const kinds = useToday((s) => s.kinds);
  const rows = useMemo(() => feedRows(items, kinds, chat), [items, kinds, chat]);
  const rowOf = useMemo(() => new Map(rows.flatMap((r, i) => (r.type === "item" || r.type === "digest" ? [[r.index, i] as const] : []))), [rows]);
  const design = useDesign();
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]!.type === "heading" ? 44 : chat ? 112 : 68),
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
    const frame = requestAnimationFrame(() => {
      const i = useList.getState().index.get(selectedId);
      const r = i === undefined ? undefined : rowOf.get(i);
      if (r !== undefined) virtualizer.scrollToIndex(r, { align: "auto" });
    });
    return () => cancelAnimationFrame(frame);
    // only when the open item changes (the feed's width changes with it)
  }, [selectedId]);

  // the header's hairline once the feed is scrolled, as the list's
  useEffect(() => {
    const [root, sentinel, header] = [scrollRef.current, sentinelRef.current, headerRef.current];
    return root && sentinel && header ? installScrollHairline(root, sentinel, header) : undefined;
  }, []);

  const virtualItems = virtualizer.getVirtualItems();
  return (
    <section className="relative flex h-full min-h-0 flex-col bg-pane" data-testid="wm-feed" data-look={look}>
      <header ref={headerRef} className="drag-region scroll-hairline shrink-0 pb-2">
        <div className={cn(COLUMN, chat ? "pl-9" : "pl-8")}>
          <div className="flex h-(--pane-bar) items-center">
            <h1 className={cn("min-w-0 truncate", LIST_TITLE[design.variants.listHeader === "title" ? "title" : "display"])} data-testid="list-title">
              {t("today.title")}
            </h1>
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
                      {row.type === "heading" ? (
                        chat ? <ChatDivider kind={row.kind} count={row.count} /> : <BriefHeading kind={row.kind} />
                      ) : row.type === "item" ? (
                        <FeedItem id={row.id} thread={items[row.index]!} chat={chat} later={row.kind === "comingUp"} />
                      ) : row.type === "digest" ? (
                        <DigestItem chat={chat} />
                      ) : (
                        <p className="py-6 text-center text-xs text-muted-foreground">{t("whatMatters.feed.end")}</p>
                      )}
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

/** The chat's quiet line where a group begins: "3 things you missed", between hairlines, read as the group's heading. */
function ChatDivider({ kind, count }: { kind: TodayGroupKind; count: number }) {
  return (
    <SeparatorLabel role="heading" aria-level={2} data-testid="wm-divider" data-kind={kind} className="pt-5 pb-2">
      {groupLine(kind, count)}
    </SeparatorLabel>
  );
}

/** The briefing's heading: the list's section names, over a hairline. */
function BriefHeading({ kind }: { kind: TodayGroupKind }) {
  return (
    <h2 data-testid="wm-heading" data-kind={kind} className="hairline-b mx-3 pt-6 pb-1.5 text-sm font-medium text-foreground">
      {t(SECTION_NAME[kind])}
    </h2>
  );
}

/** One item, its sentence made from what the backend said of it; a held row (no longer Today's) says its subject. */
const FeedItem = memo(function FeedItem({ id, thread, chat, later }: { id: number; thread: ThreadSummary; chat: boolean; later: boolean }) {
  const entry = useToday((s) => s.entries.get(id));
  const task = useToday((s) => s.tasks.get(id));
  const open = useApp((s) => s.selectedId === id);
  const sentence = useMemo(() => (entry ? todaySentence(entry) : thread.subject || t("common.noSubject")), [entry, thread.subject]);
  const meta = `${senderOf(thread, task)} · ${listDate(thread.lastDate)}`;
  return chat ? <ChatNote id={id} sentence={sentence} meta={meta} also={task?.also} task={task} open={open} later={later} /> : <BriefItem id={id} sentence={sentence} meta={meta} also={task?.also} task={task} open={open} later={later} />;
});

interface ItemProps {
  id: number;
  /** the chat's button: "Open email", or the digest's plain "Open" */
  openLabel?: string;
  sentence: string;
  meta: string;
  also: string | undefined;
  task: TodayTask | undefined;
  /** its conversation is the one open beside the feed */
  open: boolean;
  /** Coming up's: quieter */
  later: boolean;
}

/**
 * A: a note, as an assistant's message would be, with nothing to answer: what it is in plain words, the conversation's
 * next item under it, a small button to its email, and its task's menu. Who it's from and when sit under the note, as a
 * chat's time does.
 */
function ChatNote({ id, openLabel, sentence, meta, also, task, open, later }: ItemProps) {
  const textId = useId();
  return (
    <article data-thread-id={menuId(id)} data-testid="wm-note" data-open={open || undefined} aria-labelledby={textId} className="py-1.5">
      <div className={cn("w-fit max-w-full rounded-2xl rounded-bl-md px-4 pt-3 pb-2.5", open ? "bg-row-selected" : "ai-card")}>
        <p id={textId} className={cn("text-base text-pretty", later ? "text-muted-foreground" : "text-foreground")}>
          {sentence}
        </p>
        {also && <p className="mt-1 text-sm text-muted-foreground">{also}</p>}
        <div className="mt-2.5 flex items-center gap-1">
          <Button variant="outline" size="sm" data-testid="wm-open" aria-describedby={textId} onClick={() => openItem(id)}>
            {openLabel ?? t("whatMatters.open")}
            <ArrowRight data-icon="inline-end" />
          </Button>
          {task && <NoteTaskMenu threadId={id} task={task} />}
        </div>
      </div>
      <p className="mt-1 truncate pl-4 text-xs text-muted-foreground">{meta}</p>
    </article>
  );
}

/**
 * B: one plain sentence, who and when quietly under it; the whole item opens its conversation, the list staying where it
 * is. Done and Later on hover and focus (D and the right-click menu as on the list).
 */
function BriefItem({ id, sentence, meta, also, task, open, later }: ItemProps) {
  return (
    <div data-thread-id={menuId(id)} data-testid="wm-item" data-open={open || undefined} className="group/item relative flex items-center gap-1 rounded-lg pr-2 hover:bg-row-hover data-open:bg-row-selected">
      <button type="button" data-testid="wm-item-open" aria-current={open || undefined} onClick={() => openItem(id)} className="min-w-0 flex-1 rounded-lg px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className={cn("block text-base text-pretty", later ? "text-muted-foreground" : "text-foreground")}>{sentence}</span>
        <span className="mt-0.5 block truncate text-sm text-muted-foreground">{meta}</span>
        {also && <span className="block truncate text-sm text-muted-foreground">{also}</span>}
      </button>
      {task && (
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-fast group-hover/item:opacity-100 group-data-open/item:opacity-100 has-[:focus-visible]:opacity-100 has-[[aria-expanded=true]]:opacity-100">
          <BriefTaskControls threadId={id} task={task} />
        </div>
      )}
    </div>
  );
}

/** The digest's way in, the feed's last item: its count, who the newsletters are from, and the page beside the feed. */
function DigestItem({ chat }: { chat: boolean }) {
  const digest = useToday((s) => s.digest);
  const open = useApp((s) => s.selectedId === DIGEST_ROW_ID);
  if (!digest) return null;
  const from = digestFrom(digest, getLocale());
  const sentence = digestLabel(digest);
  return chat ? <ChatNote id={DIGEST_ROW_ID} openLabel={t("common.open")} sentence={sentence} meta={from ?? t("today.newsletters")} also={undefined} task={undefined} open={open} later={false} /> : <BriefItem id={DIGEST_ROW_ID} sentence={sentence} meta={from ?? t("today.newsletters")} also={undefined} task={undefined} open={open} later={false} />;
}
