import { defaultRemindAt, HANDED, refKey, type DatedRow, type FollowupRow, type ScheduleProposal, type ThreadDetail } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@terno/ui/components/dropdown-menu";
import { Popover, PopoverContent } from "@terno/ui/components/popover";
import { CalendarClock, ChevronDown } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { useEffect, useId, useRef, useState } from "react";
import { aiAllowed, followupsOffered } from "~/lib/ai";
import { changeItem, changeOfItem, proposalSaid, whenSaid, type ChangeTarget } from "~/lib/change";
import { itemLaterWindow, laterNote, laterPresets, laterStart, type LaterWindow } from "~/lib/dated";
import { readerItems, readerLine, readerText, type ReaderItem, type ReaderItems } from "~/lib/reader-items";
import { presetLabel, presetWhen } from "~/lib/reminders";
import { handTo, seenOfReaderItem } from "~/lib/hand-to";
import { historyWhen } from "~/lib/today-sentence";
import { actOnReaderItem, closeReaderLater, openReaderLater } from "~/lib/today-task";
import { client } from "~/rpc/connection";
import { getApp, useApp } from "~/state/app";
import { useFollowups } from "~/state/followups";
import { feedRowsOfItem, openFeedRow, useFeedTarget, useReaderChoice } from "~/state/today";
import { AI_CARD, AI_INSET, AI_TITLE } from "./ai-card";
import { ChangeForm } from "./change-form";
import { WhenForm } from "./when-fields";

/** What the reader knows of a conversation's items, and how one is chosen from the line under the top one. */
export interface ReaderModel extends ReaderItems {
  /** every read it needs has answered for this conversation: nothing is drawn before (no line that swaps on arrival) */
  ready: boolean;
  choose: (item: ReaderItem) => void;
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
  const targetKey = target.map(refKey).join(" ");
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
    now: Date.now(),
  });
  // (code review) the choice leads with no feed row of its own: D, b, ⇧D and the palette act on it, not the open row's item
  const held = ready && items.top?.open && items.top.key === chosenKey ? items.top : null;
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
  return { ...items, ready, choose };
}

/**
 * Later on the line: a dated item's presets in its window (a timed one still ahead, only what's before its moment; a Plan,
 * before its end; a Missed one, every preset), a promise's anywhere ahead (its Later is its own), and a moment of your own.
 * It goes through the row's flow: the feed's row leaves at once, Undo is exact, a failure brings it back.
 */
function ItemLater({ item, act }: { item: ReaderItem; act: (at: number) => void }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  // the app's (b opens it on a chosen item); an item that goes takes its open menu with it, and the app's keys come back
  const open = useReaderChoice((s) => s.later);
  useEffect(() => closeReaderLater, []);
  const [picking, setPicking] = useState(false);
  const now = Date.now();
  const span: LaterWindow = item.source === "dated" ? itemLaterWindow(item.row, now) : { before: null, limit: null };
  const presets = laterPresets(span, now);
  const back = () => triggerRef.current?.focus({ preventScroll: true });
  return (
    <>
      <DropdownMenu open={open} onOpenChange={(next) => (next ? openReaderLater() : closeReaderLater())}>
        <DropdownMenuTrigger render={<Button ref={triggerRef} variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" data-testid="thread-dated-later" aria-label={t("dated.laterItem", { text: readerText(item) })} />}>
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
            start={item.source === "dated" ? laterStart(span, now) : defaultRemindAt(new Date(now))}
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

/**
 * Plan 210 (iteration 3, Codex revision 10): the conversation's items on the AI card's surface at its top, one line on top in
 * one design for a dated item and a promise of yours ("Due Friday · Pay the electricity bill", "Due today · You told Jess
 * you'd send the script"), with its Done, Later and Remove; the conversation's other items as one quiet line under it, each
 * leading when chosen. The feed's open row's item leads (a history line's, closed, says what happened). Only while dates or
 * follow-ups are read; never in Trash or Spam.
 */
export default function ThreadItems({ detail, items }: { detail: ThreadDetail; items: ReaderModel }) {
  const { top, others, targeted, ready, choose } = items;
  const threadId = detail.thread.id;
  const alsoId = useId();
  const doneRef = useRef<HTMLButtonElement>(null);
  // chosen from the line under it: the keys go to the item that now leads (its button was the one chosen, and has gone)
  const moved = useRef<string | null>(null);
  useEffect(() => {
    if (top && moved.current === top.key) {
      moved.current = null;
      doneRef.current?.focus({ preventScroll: true });
    }
  }, [top]);
  if (!ready || !top) return null;
  const now = Date.now();
  const text = readerText(top);
  // plan 210 (iteration 4): an open item with a day to change (a person's ask has none)
  const change = changeOfItem(top);
  return (
    // the summary card's surface and inset (plan 181): a model's reading, not the sender's words
    <section aria-label={t("dated.section")} data-testid="thread-dated" className={cn(AI_CARD, AI_INSET, "mb-4")}>
      <div
        data-testid="thread-dated-item"
        data-source={top.source}
        data-kind={top.source === "dated" ? top.row.kind : "promise"}
        data-target={targeted || undefined}
        data-closed={!top.open || undefined}
        // plan 210 (iteration 5, R8): the sentence on a line of its own, the card's whole width, and its controls under it on
        // the same edge (Done's outline on the sentence's first letter), never five controls squeezing it into a column
        className="flex flex-col items-start gap-2 pt-3 pb-2.5 text-sm"
      >
        <span data-testid="thread-dated-text" className={cn(AI_TITLE, "w-full min-w-0 text-pretty wrap-anywhere tabular", !top.open && "text-muted-foreground")}>{readerLine(top, now)}</span>
        {top.open ? (
          // Done outlined (what's usually meant), Later and Remove quiet beside it; on a narrow card they wrap, never shrink
          <span data-testid="thread-dated-controls" className="flex flex-wrap items-center gap-1.5">
            <Button ref={doneRef} variant="outline" size="sm" className="text-foreground" data-testid="thread-dated-done" aria-label={t("dated.doneItem", { text })} onClick={() => void actOnReaderItem(threadId, top, "done")}>
              {t("dated.done")}
            </Button>
            <ItemLater key={top.key} item={top} act={(at) => void actOnReaderItem(threadId, top, "later", at)} />
            {change && <ItemChange key={`change:${top.key}`} item={top} target={change} />}
            {/* plan 210 (iteration 4): Hand to…, the forward opening under this line, in the reader */}
            <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" data-testid="thread-dated-hand" aria-label={t("whatMatters.handTo.item", { text })} onClick={() => void handTo(seenOfReaderItem(top))}>
              {t("whatMatters.handTo.action")}
            </Button>
            <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" data-testid="thread-dated-dismiss" aria-label={t("dated.removeItem", { text })} onClick={() => void actOnReaderItem(threadId, top, "dismiss")}>
              {t("dated.remove")}
            </Button>
          </span>
        ) : (
          // a history line opened: it's done, so what happened, no buttons
          <span data-testid="thread-dated-outcome" className="shrink-0 text-muted-foreground tabular">{outcomeOf(top)}</span>
        )}
      </div>
      {change && top.row.proposal && <ItemProposal item={top} target={change} proposal={top.row.proposal} />}
      {others.length > 0 && (
        // the label, then the items one under another on their own edge (wide); narrow, the label above them
        <div role="group" aria-labelledby={alsoId} data-testid="thread-dated-also" className="-mt-1 flex flex-col gap-1 pb-3 text-sm @min-[600px]:flex-row @min-[600px]:gap-x-3">
          <span id={alsoId} className="shrink-0 text-muted-foreground">{t("dated.also")}</span>
          <span className="flex min-w-0 flex-col items-start gap-1">
            {others.map((o) => (
              // quiet, as the label: the ink when pointed at, what can be chosen
              <Button
                key={o.key}
                variant="link-secondary"
                data-testid="thread-dated-also-item"
                data-key={o.key}
                className="justify-start text-start font-normal whitespace-normal text-muted-foreground tabular hover:text-foreground"
                onClick={() => {
                  moved.current = o.key;
                  choose(o);
                }}
              >
                {readerLine(o, now)}
              </Button>
            ))}
          </span>
        </div>
      )}
    </section>
  );
}
