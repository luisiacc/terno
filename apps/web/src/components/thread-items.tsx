import { HANDED, refKey, type DatedRow, type FollowupRow, type ScheduleProposal, type ThreadDetail } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@terno/ui/components/dropdown-menu";
import { Popover, PopoverContent } from "@terno/ui/components/popover";
import { CalendarClock, ChevronDown } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { useEffect, useId, useLayoutEffect, useRef, useState, type Ref, type RefObject } from "react";
import { aiAllowed, followupsOffered } from "~/lib/ai";
import { changeItem, changeOfItem, proposalSaid, whenSaid, type ChangeTarget } from "~/lib/change";
import { itemLaterWindow, laterNote, laterPresets, laterStart, laterWindow, type LaterWindow, type TodayTask } from "~/lib/dated";
import { keysOnTo } from "~/lib/feed-leave";
import { setFollowupsShown, useFollowupsShown } from "~/lib/followups-shown";
import { readerItems, readerLine, readerText, waitingLine, type ReaderItem, type ReaderItems } from "~/lib/reader-items";
import { presetLabel, presetWhen } from "~/lib/reminders";
import { handTo, seenOfReaderItem } from "~/lib/hand-to";
import { historyWhen, todayWhen } from "~/lib/today-sentence";
import { actOnReaderItem, actOnTodayRow, closeReaderLater, openReaderLater } from "~/lib/today-task";
import { client } from "~/rpc/connection";
import { getApp, useApp } from "~/state/app";
import { useFollowups } from "~/state/followups";
import { feedRowsOfItem, openFeedRow, useFeedRow, useFeedTarget, useFeedWaiting, useReaderChoice, type FeedRow } from "~/state/today";
import { AI_CARD, AI_INSET, AI_TITLE } from "./ai-card";
import { ChangeForm } from "./change-form";
import { WhenForm } from "./when-fields";

/** What the reader knows of a conversation's items, and how one is chosen from the line under the top one. */
export interface ReaderModel extends ReaderItems {
  /** every read it needs has answered for this conversation: nothing is drawn before (no line that swaps on arrival) */
  ready: boolean;
  choose: (item: ReaderItem) => void;
  /** plan 216: the feed's open row while it's this conversation's waiting row (its task while it's the backend's) */
  waitingRow: FeedRow | null;
  /** plan 216: the waiting line chosen from the Also line: it leads again (the choice and its Later menu let go) */
  chooseWaiting: () => void;
  /**
   * plan 296: the conversation's follow-up cards shown: the reader's choice, or the feed's open row asking for one of them
   * (an item opened from What matters shows, until hidden there)
   */
  shown: boolean;
  setShown: (shown: boolean) => void;
}

/**
 * Plan 210 (iteration 3, Codex revision 10): the reader's items, resolved once for the conversation (its dated items, read
 * here, and its promises, follow-ups' own), the summary reading the same model. Every read is the latest for this
 * conversation and the item it was asked about: an answer that comes back after another was asked, or for a conversation
 * left, is dropped.
 */
export function useReaderItems(detail: ThreadDetail): ReaderModel {
  const threadId = detail.thread.id;
  const hidden = detail.thread.inTrash || detail.thread.inSpam;
  // plan 211: and the conversation's account's AI
  const datedOn = useApp((s) => aiAllowed(s, detail.thread.accountId) && s.settings?.dated?.enabled === true) && !hidden;
  const promisesOn = useApp((s) => followupsOffered(s, detail.thread.accountId)) && !hidden;
  const target = useFeedTarget(threadId);
  const waitingRow = useFeedWaiting(threadId);
  // a choice holds for the open row it was made under, by its identity (a waiting row has no items: its own id)
  const targetKey = waitingRow ? waitingRow.id : target.map(refKey).join(" ");
  // a history line's closed item: its own read, as the feed opened it
  const datedTarget = target.filter((r) => r.source === "dated").map((r) => r.id);
  const include = datedTarget.length === 1 ? datedTarget[0] : undefined;
  // an answer is this conversation's and this item's (Codex code review of iteration 3: a history line's closed item opened
  // beside an open sibling waits for its own read, so the sibling's Done is never on top meanwhile)
  const [read, setRead] = useState<{ threadId: number; include: number | undefined; rows: readonly DatedRow[] } | null>(null);
  useEffect(() => {
    if (!datedOn) return;
    let live = true;
    let seq = 0;
    const ask = () => {
      const mine = ++seq;
      // the last answer is kept through a re-read of the same conversation and item, never another's
      const keep = (rows: readonly DatedRow[] | null) => live && mine === seq && setRead((held) => ({ threadId, include, rows: rows ?? (held?.threadId === threadId && held.include === include ? held.rows : []) }));
      void client.call("dated.ofThread", { threadId, ...(include !== undefined ? { include } : {}) }).then((r) => keep(r.rows), () => keep(null));
    };
    ask();
    // read again when What matters changes (Done here, there, or a new message settling it)
    const off = client.on("todayChanged", ask);
    return () => {
      live = false;
      off();
    };
  }, [datedOn, threadId, include]);
  const followups = useFollowups((s) => s.byThread.get(threadId));
  const closedId = promisesOn ? target.find((r) => r.source === "promise" && !followups?.some((x) => x.id === r.id))?.id : undefined;
  const [closed, setClosed] = useState<{ id: number; row: FollowupRow | null } | null>(null);
  useEffect(() => {
    if (closedId === undefined) return;
    let live = true;
    const keep = (row: FollowupRow | null) => live && setClosed({ id: closedId, row: row && row.threadId === threadId && row.state !== "open" && row.state !== "due" ? row : null });
    void client.call("followups.get", { id: closedId }).then((r) => keep(r.row), () => keep(null));
    return () => {
      live = false;
    };
  }, [closedId, threadId]);
  // chosen from the line under the top one, while the feed's open row is the same (another row opened: its item leads)
  const [chosen, setChosen] = useState<{ threadId: number; target: string; key: string } | null>(null);
  const chosenKey = chosen?.threadId === threadId && chosen.target === targetKey ? chosen.key : null;
  const readNow = read?.threadId === threadId && read.include === include;
  const ready = (!datedOn || readNow) && (closedId === undefined || closed?.id === closedId);
  const closedRow = closedId !== undefined && closed?.id === closedId ? closed.row : null;
  const items = readerItems({
    dated: datedOn && readNow ? read.rows : [],
    followups: promisesOn ? [...(followups ?? []), ...(closedRow ? [closedRow] : [])] : [],
    target,
    chosen: chosenKey,
    waiting: waitingRow !== null,
    now: Date.now(),
  });
  // (code review) the choice leads with no feed row of its own: D, b, ⇧D and the palette act on it, not the open row's item;
  // whichever member of its line shows (Codex review of plan 216, #3)
  // plan 296: hidden, the choice goes with its card (no keys for a line that isn't there)
  const pref = useFollowupsShown((s) => s.shown);
  const asked = target.length > 0 || waitingRow !== null ? targetKey : null;
  const [hiddenAsked, setHiddenAsked] = useState<{ threadId: number; key: string } | null>(null);
  const shown = pref || (asked !== null && !(hiddenAsked?.threadId === threadId && hiddenAsked.key === asked));
  const setShown = (next: boolean) => {
    setFollowupsShown(next);
    setHiddenAsked(next || asked === null ? null : { threadId, key: asked });
    if (!next) closeReaderLater();
  };
  const held = shown && ready && items.chose && items.top?.open ? items.top : null;
  useEffect(() => {
    const was = useReaderChoice.getState().held;
    const same = held ? was?.threadId === threadId && was.item.key === held.key && was.item.row.revision === held.row.revision : was === null;
    if (!same) useReaderChoice.setState({ held: held ? { threadId, item: held } : null });
  });
  useEffect(
    () => () => {
      if (useReaderChoice.getState().held?.threadId === threadId) useReaderChoice.setState({ held: null });
    },
    [threadId],
  );
  const choose = (item: ReaderItem) => {
    // the feed's row for it, when the feed has one: opening it there keeps the feed, the keys (D, b, ⇧D) and the reader on
    // one item; else (another mailbox, behind Coming up) it leads here, the keys and the palette with it (`useReaderChoice`)
    const row = feedRowsOfItem(item.ref).find((r) => r.threadId === threadId && !r.held && !r.line);
    if (row && getApp().today) return openFeedRow(row.id);
    setChosen({ threadId, target: targetKey, key: item.key });
  };
  const chooseWaiting = () => {
    closeReaderLater();
    setChosen(null);
  };
  return { ...items, ready, choose, waitingRow, chooseWaiting, shown, setShown };
}

/**
 * Later on the line: a dated item's presets in its window (a timed one still ahead, only what's before its moment; a Plan,
 * before its end; a Missed one, every preset), a promise's and (plan 216) a person waiting's anywhere ahead, and a moment of
 * your own. It goes through the row's flow: the feed's row leaves at once, Undo is exact, a failure brings it back. `text`,
 * the words its button names.
 */
function ItemLater({ text, span, act }: { text: string; span: LaterWindow; act: (at: number) => void }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  // the app's (b opens it on a chosen item); an item that goes takes its open menu with it, and the app's keys come back
  const open = useReaderChoice((s) => s.later);
  useEffect(() => closeReaderLater, []);
  const [picking, setPicking] = useState(false);
  const now = Date.now();
  const presets = laterPresets(span, now);
  const back = () => triggerRef.current?.focus({ preventScroll: true });
  return (
    <>
      <DropdownMenu open={open} onOpenChange={(next) => (next ? openReaderLater() : closeReaderLater())}>
        <DropdownMenuTrigger render={<Button ref={triggerRef} variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" data-testid="thread-dated-later" aria-label={t("dated.laterItem", { text })} />}>
          {t("dated.later")}
          <ChevronDown aria-hidden />
        </DropdownMenuTrigger>
        {/* as wide as what it holds, each moment in the shortcut's place */}
        <DropdownMenuContent align="end" className="w-max" data-testid="thread-dated-later-menu">
          {presets.map((p) => (
            <DropdownMenuItem key={p.id} data-testid={`thread-dated-later-${p.id}`} onClick={() => act(p.at)}>
              <span className="whitespace-nowrap">{presetLabel(p.id)}</span>
              <DropdownMenuShortcut className="tracking-normal whitespace-nowrap tabular-nums">{presetWhen(p, now)}</DropdownMenuShortcut>
            </DropdownMenuItem>
          ))}
          {presets.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuItem data-testid="thread-dated-later-pick" onClick={() => setPicking(true)}>
            <CalendarClock aria-hidden />
            <span className="whitespace-nowrap">{t("dated.pickDate")}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Popover
        open={picking}
        onOpenChange={(open) => {
          setPicking(open);
          if (!open) back();
        }}
      >
        <PopoverContent anchor={triggerRef} align="end" className="w-80" data-testid="thread-dated-later-custom" aria-label={t("dated.later")}>
          <WhenForm
            start={laterStart(span, now)}
            before={span.before}
            notes={laterNote(span)}
            testPrefix="thread-dated-later"
            submit={t("dated.laterSet")}
            onSet={(at) => {
              setPicking(false);
              back();
              act(at);
            }}
          />
        </PopoverContent>
      </Popover>
    </>
  );
}

/** An item's Later window on the line: a dated item's own, a promise of yours anywhere ahead (its Later is its own). */
const itemSpan = (item: ReaderItem, now = Date.now()): LaterWindow => (item.source === "dated" ? itemLaterWindow(item.row, now) : { before: null, limit: null });

/**
 * Plan 216 (Codex review, #6; code review, #4): a line that goes while it holds the focus (its item or row acted on, here or
 * elsewhere, at once or once the reply comes), or after the focus already fell to the page (its menu's item gone with it),
 * leaves the keys on the feed's row that's open now, or holds its place: never on the page. Focus moved elsewhere on purpose
 * stays where it is.
 */
const LINE_PORTALS = "[data-testid=thread-dated-later-menu], [data-testid=thread-dated-later-custom]";

function useKeysWhenGone(): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    return () => {
      const lost = () => !document.activeElement || document.activeElement === document.body;
      // (its Later's menu and picker are portals: focus there is the line's too, Codex code review of plan 216, round 2)
      const held = el?.contains(document.activeElement) || document.activeElement?.closest(LINE_PORTALS);
      if (!held && !lost()) return;
      // a frame for the line's portals to go (their focus with them), a few at most
      let frames = 0;
      const after = () => {
        if (document.activeElement?.closest(LINE_PORTALS) && ++frames < 5) return void requestAnimationFrame(after);
        if (!lost() || !getApp().today) return;
        const { opened, cursor } = useFeedRow.getState();
        keysOnTo(opened ?? cursor ?? undefined);
      };
      requestAnimationFrame(after);
    };
  }, []);
  return ref;
}

/**
 * Plan 210 (iteration 4, the owner's "Change…"): the item's own day and time, in the shared form beside its Later, quiet as
 * Later is. Its schedule is the user's from then on.
 */
function ItemChange({ item, target }: { item: ReaderItem; target: ChangeTarget }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const back = () => triggerRef.current?.focus({ preventScroll: true });
  return (
    <>
      <Button ref={triggerRef} variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" data-testid="thread-dated-change" aria-haspopup="dialog" aria-expanded={open} aria-label={t("dated.changeItem", { text: readerText(item) })} onClick={() => setOpen(true)}>
        {t("dated.change")}
      </Button>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) back();
        }}
      >
        <PopoverContent anchor={triggerRef} align="end" className="w-80" data-testid="thread-dated-change-custom" aria-label={t("dated.changeTitle")}>
          <ChangeForm
            target={target}
            testPrefix="thread-dated-change"
            onSet={(to) => {
              setOpen(false);
              back();
              void changeItem(target, to);
            }}
          />
        </PopoverContent>
      </Popover>
    </>
  );
}

/**
 * Plan 210 (iteration 4): a later mail's move of an item whose day the user chose, under its line: who says what now, and
 * Use, which takes it (a change like the user's own, with its Undo). Quiet, on the line's edge.
 */
function ItemProposal({ item, target, proposal }: { item: ReaderItem; target: ChangeTarget; proposal: ScheduleProposal }) {
  const now = Date.now();
  const when = whenSaid(proposal, now);
  return (
    <p data-testid="thread-dated-proposal" className="-mt-1 flex flex-wrap items-baseline gap-x-1.5 pb-2 text-sm text-muted-foreground tabular">
      <span data-testid="thread-dated-proposal-text">{proposalSaid(proposal, now)}</span>
      <span aria-hidden>·</span>
      <Button variant="link-secondary" size="xs" className="text-sm font-medium" data-testid="thread-dated-proposal-use" aria-label={t("dated.proposalUseItem", { when, text: readerText(item) })} onClick={() => void changeItem(target, { accept: true, when })}>
        {t("dated.proposalUse")}
      </Button>
    </p>
  );
}

/** What happened to a closed item, as its history line says it ("Done Tuesday"). */
function outcomeOf(item: ReaderItem): string {
  const state = item.row.state;
  // plan 210 (iteration 3): a promise its person replaced says so
  // (iteration 4) one handed on by a confirmed forward says to whom
  const handed = state === "done" && item.row.closedReason === HANDED && item.row.handedTo ? item.row.handedTo : undefined;
  const outcome = item.source === "promise" && item.row.closedReason === "replaced" ? "replaced" : handed ? "handed" : state === "done" ? "done" : state === "settled" ? "settled" : "dismissed";
  // (plan 210, iteration 4, revision 7: settled by mail, that mail's day and how)
  return historyWhen({ outcome, kind: item.source === "dated" ? item.row.kind : "promise", key: { at: item.row.closedAt ?? item.row.createdAt, src: item.source === "dated" ? 0 : 1, id: item.row.id }, ...(handed && { handedTo: handed }), on: item.row.settledAt ?? undefined, reason: item.row.closedReason });
}

/** The Also line's key for the waiting line (plan 216): what the keys go to when it's chosen there. */
const WAITING_KEY = "waiting";

/** (a waiting row held after an act elsewhere is words only: nothing to say or do here for it) */
const waitingTaskOf = (row: FeedRow | null) => (row?.task?.kind === "waiting" ? row.task : null);

/** Plan 296: how many lines `ThreadItems` draws (the lead and its Also line), by the same conditions; 0, nothing drawn. */
export function readerItemCount({ ready, top, others, waiting, waitingRow }: ReaderModel): number {
  const task = waitingTaskOf(waitingRow);
  if (!ready || (waiting === "top" ? !task : !top)) return 0;
  return 1 + others.length + (waiting === "also" && task ? 1 : 0);
}

/**
 * Plan 210 (iteration 3, Codex revision 10): the conversation's items on the AI card's surface at its top, one line on top in
 * one design for a dated item and a promise of yours ("Due Friday · Pay the electricity bill", "Due today · You told Jess
 * you'd send the script"), with its Done, Later and Remove; the conversation's other items as one quiet line under it, each
 * leading when chosen. The feed's open row's item leads (a history line's, closed, says what happened). Only while dates or
 * follow-ups are read; never in Trash or Spam. Plan 216: the feed's open row a person waiting on you, its line leads in the
 * same design ("Lucas is waiting on your reply · since Oct 21") with the row's own Done, Later and Remove.
 */
export default function ThreadItems({ detail, items }: { detail: ThreadDetail; items: ReaderModel }) {
  const { top, others, targeted, choose, waiting, waitingRow, chooseWaiting } = items;
  const threadId = detail.thread.id;
  const alsoId = useId();
  const doneRef = useRef<HTMLButtonElement>(null);
  // chosen from the line under it: the keys go to the line that now leads (its button was the one chosen, and has gone)
  const moved = useRef<string | null>(null);
  const leadKey = waiting === "top" ? WAITING_KEY : (top?.key ?? null);
  useEffect(() => {
    if (leadKey !== null && moved.current === leadKey) {
      moved.current = null;
      doneRef.current?.focus({ preventScroll: true });
    }
  }, [leadKey]);
  const task = waitingTaskOf(waitingRow);
  if (!readerItemCount(items)) return null;
  const now = Date.now();
  return (
    // the summary card's surface and inset (plan 181): a model's reading, not the sender's words
    <section aria-label={t("dated.section")} data-testid="thread-dated" className={cn(AI_CARD, AI_INSET, "mb-4")}>
      {waiting === "top" ? <WaitingLine row={waitingRow!} task={task!} doneRef={doneRef} now={now} /> : <ItemLine threadId={threadId} item={top!} targeted={targeted} doneRef={doneRef} now={now} />}
      {(others.length > 0 || (waiting === "also" && task)) && (
        // the label, then the items one under another on their own edge (wide); narrow, the label above them
        <div role="group" aria-labelledby={alsoId} data-testid="thread-dated-also" className="-mt-1 flex flex-col gap-1 pb-3 text-sm @min-[600px]:flex-row @min-[600px]:gap-x-3">
          <span id={alsoId} className="shrink-0 text-muted-foreground">{t("dated.also")}</span>
          <span className="flex min-w-0 flex-col items-start gap-1">
            {waiting === "also" && task && (
              <AlsoButton
                lineKey={WAITING_KEY}
                onClick={() => {
                  moved.current = WAITING_KEY;
                  chooseWaiting();
                }}
              >
                {waitingWords(waitingRow!, task, now)}
              </AlsoButton>
            )}
            {others.map((o) => (
              <AlsoButton
                key={o.key}
                lineKey={o.key}
                onClick={() => {
                  moved.current = o.key;
                  choose(o);
                }}
              >
                {readerLine(o, now)}
              </AlsoButton>
            ))}
          </span>
        </div>
      )}
    </section>
  );
}

/** One of the Also line's: quiet, as the label; the ink when pointed at, what can be chosen. */
function AlsoButton({ lineKey, onClick, children }: { lineKey: string; onClick: () => void; children: string }) {
  return (
    <Button variant="link-secondary" data-testid="thread-dated-also-item" data-key={lineKey} className="justify-start text-start font-normal whitespace-normal text-muted-foreground tabular hover:text-foreground" onClick={onClick}>
      {children}
    </Button>
  );
}

/** The lead line's layout: the sentence on a line of its own, its controls (or what happened) under it on the same edge. */
const LINE = "flex flex-col items-start gap-2 pt-3 pb-2.5 text-sm";
const LINE_TEXT = cn(AI_TITLE, "w-full min-w-0 text-pretty wrap-anywhere tabular");
const QUIET = "text-muted-foreground hover:text-foreground";

/** An item leading the card: its line, and Done · Later · Change… · Hand to… · Remove (a history line's: what happened). */
function ItemLine({ threadId, item, targeted, doneRef, now }: { threadId: number; item: ReaderItem; targeted: boolean; doneRef: Ref<HTMLButtonElement>; now: number }) {
  const text = readerText(item);
  // plan 210 (iteration 4): an open item with a day to change (a person's ask has none)
  const change = changeOfItem(item);
  const lineRef = useKeysWhenGone();
  return (
    <>
      <div
        ref={lineRef}
        data-testid="thread-dated-item"
        data-source={item.source}
        data-kind={item.source === "dated" ? item.row.kind : "promise"}
        data-target={targeted || undefined}
        data-closed={!item.open || undefined}
        // plan 210 (iteration 5, R8): the sentence on a line of its own, the card's whole width, and its controls under it on
        // the same edge (Done's outline on the sentence's first letter), never five controls squeezing it into a column
        className={LINE}
      >
        <span data-testid="thread-dated-text" className={cn(LINE_TEXT, !item.open && "text-muted-foreground")}>{readerLine(item, now)}</span>
        {item.open ? (
          // Done outlined (what's usually meant), Later and Remove quiet beside it; on a narrow card they wrap, never shrink
          <span data-testid="thread-dated-controls" className="flex flex-wrap items-center gap-1.5">
            <Button ref={doneRef} variant="outline" size="sm" className="text-foreground" data-testid="thread-dated-done" aria-label={t("dated.doneItem", { text })} onClick={() => void actOnReaderItem(threadId, item, "done")}>
              {t("dated.done")}
            </Button>
            <ItemLater key={item.key} text={text} span={itemSpan(item, now)} act={(at) => void actOnReaderItem(threadId, item, "later", at)} />
            {change && <ItemChange key={`change:${item.key}`} item={item} target={change} />}
            {/* plan 210 (iteration 4): Hand to…, the forward opening under this line, in the reader */}
            <Button variant="ghost" size="sm" className={QUIET} data-testid="thread-dated-hand" aria-label={t("whatMatters.handTo.item", { text })} onClick={() => void handTo(seenOfReaderItem(item))}>
              {t("whatMatters.handTo.action")}
            </Button>
            <Button variant="ghost" size="sm" className={QUIET} data-testid="thread-dated-dismiss" aria-label={t("dated.removeItem", { text })} onClick={() => void actOnReaderItem(threadId, item, "dismiss")}>
              {t("dated.remove")}
            </Button>
          </span>
        ) : (
          // a history line opened: it's done, so what happened, no buttons
          <span data-testid="thread-dated-outcome" className="shrink-0 text-muted-foreground tabular">{outcomeOf(item)}</span>
        )}
      </div>
      {change && item.row.proposal && <ItemProposal item={item} target={change} proposal={item.row.proposal} />}
    </>
  );
}

/** Plan 216: who's waiting, and the feed row's own when ("since Oct 21", "back Fri 9:00 AM"). */
const waitingWords = (row: FeedRow, task: Extract<TodayTask, { kind: "waiting" }>, now: number): string => waitingLine(task.name, (row.entry && todayWhen(row.entry, now).text) ?? "");

/**
 * Plan 216: the feed's open row a person waiting on you, leading the card: its line, then the row's own Done · Later ·
 * Remove (`actOnTodayRow`, as its hover controls, D, b, ⇧D, the menu and the palette). Its Later is the task's as drawn: a
 * newer message or another window's choice is another task, and remounts it (closing what was open: Codex review, #4).
 */
function WaitingLine({ row, task, doneRef, now }: { row: FeedRow; task: Extract<TodayTask, { kind: "waiting" }>; doneRef: Ref<HTMLButtonElement>; now: number }) {
  const act = (action: "done" | "dismiss" | "later", at?: number) => void actOnTodayRow(row.id, task, action, at);
  const lineRef = useKeysWhenGone();
  return (
    <div ref={lineRef} data-testid="thread-dated-item" data-source="waiting" data-target className={LINE}>
      <span data-testid="thread-dated-text" className={LINE_TEXT}>{waitingWords(row, task, now)}</span>
      <span data-testid="thread-dated-controls" className="flex flex-wrap items-center gap-1.5">
        <Button ref={doneRef} variant="outline" size="sm" className="text-foreground" data-testid="thread-dated-done" aria-label={t("dated.doneItem", { text: task.name })} onClick={() => act("done")}>
          {t("dated.done")}
        </Button>
        <ItemLater key={`${row.id}:${task.message}:${task.rev}`} text={task.name} span={laterWindow(task, now)} act={(at) => act("later", at)} />
        <Button variant="ghost" size="sm" className={QUIET} data-testid="thread-dated-dismiss" aria-label={t("dated.removeItem", { text: task.name })} onClick={() => act("dismiss")}>
          {t("dated.remove")}
        </Button>
      </span>
    </div>
  );
}
