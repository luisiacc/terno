import { defaultRemindAt, refKey, type DatedRow, type FollowupRow, type ThreadDetail } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@terno/ui/components/dropdown-menu";
import { Popover, PopoverContent } from "@terno/ui/components/popover";
import { CalendarClock, ChevronDown } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { useEffect, useId, useRef, useState } from "react";
import { aiAllowed, followupsOffered } from "~/lib/ai";
import { itemLaterWindow, laterNote, laterPresets, laterStart, type LaterWindow } from "~/lib/dated";
import { readerItems, readerLine, readerText, type ReaderItem, type ReaderItems } from "~/lib/reader-items";
import { presetLabel, presetWhen } from "~/lib/reminders";
import { historyWhen } from "~/lib/today-sentence";
import { actOnThreadItem, actOnThreadPromise } from "~/lib/today-task";
import { client } from "~/rpc/connection";
import { getApp, useApp } from "~/state/app";
import { useFollowups } from "~/state/followups";
import { feedRowsOfItem, openFeedRow, useFeedTarget } from "~/state/today";
import { AI_CARD, AI_INSET, AI_TITLE } from "./ai-card";
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
  const datedOn = useApp((s) => aiAllowed(s) && s.settings?.dated?.enabled === true) && !hidden;
  const promisesOn = useApp(followupsOffered) && !hidden;
  const target = useFeedTarget(threadId);
  const targetKey = target.map(refKey).join(" ");
  // a history line's closed item: its own read, as the feed opened it
  const datedTarget = target.filter((r) => r.source === "dated").map((r) => r.id);
  const include = datedTarget.length === 1 ? datedTarget[0] : undefined;
  const [read, setRead] = useState<{ threadId: number; rows: readonly DatedRow[] } | null>(null);
  useEffect(() => {
    if (!datedOn) return;
    let live = true;
    let seq = 0;
    const ask = () => {
      const mine = ++seq;
      const keep = (rows: readonly DatedRow[] | null) => live && mine === seq && setRead((held) => ({ threadId, rows: rows ?? (held?.threadId === threadId ? held.rows : []) }));
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
  const ready = (!datedOn || read?.threadId === threadId) && (closedId === undefined || closed?.id === closedId);
  const closedRow = closedId !== undefined && closed?.id === closedId ? closed.row : null;
  const items = readerItems({
    dated: datedOn && read?.threadId === threadId ? read.rows : [],
    followups: promisesOn ? [...(followups ?? []), ...(closedRow ? [closedRow] : [])] : [],
    target,
    chosen: chosen?.threadId === threadId && chosen.target === targetKey ? chosen.key : null,
    now: Date.now(),
  });
  const choose = (item: ReaderItem) => {
    // the feed's row for it, when the feed has one: opening it there keeps the feed, the keys (D, b, ⇧D) and the reader on
    // one item; else (another mailbox, behind Coming up) it leads here alone
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
  const [picking, setPicking] = useState(false);
  const now = Date.now();
  const span: LaterWindow = item.source === "dated" ? itemLaterWindow(item.row, now) : { before: null, limit: null };
  const presets = laterPresets(span, now);
  const back = () => triggerRef.current?.focus({ preventScroll: true });
  return (
    <>
      <DropdownMenu>
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

/** What happened to a closed item, as its history line says it ("Done Tuesday"). */
function outcomeOf(item: ReaderItem): string {
  const state = item.row.state;
  const outcome = state === "done" ? "done" : state === "settled" ? "settled" : "dismissed";
  return historyWhen({ outcome, kind: item.source === "dated" ? item.row.kind : "promise", key: { at: item.row.closedAt ?? item.row.createdAt, src: item.source === "dated" ? 0 : 1, id: item.row.id } });
}

/** Done, Later and Remove act on the item, its feed rows leaving with it (a merged row's every member, the backend's one act). */
function act(threadId: number, item: ReaderItem, action: "done" | "dismiss" | "later", at?: number): void {
  if (item.source === "dated") void actOnThreadItem(threadId, item.row, action, at);
  else void actOnThreadPromise(item.row, action, at);
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
  return (
    // the summary card's surface and inset (plan 181): a model's reading, not the sender's words
    <section aria-label={t("dated.section")} data-testid="thread-dated" className={cn(AI_CARD, AI_INSET, "mb-4")}>
      <div
        data-testid="thread-dated-item"
        data-source={top.source}
        data-kind={top.source === "dated" ? top.row.kind : "promise"}
        data-target={targeted || undefined}
        data-closed={!top.open || undefined}
        className="flex min-h-11 items-center gap-3 py-1.5 text-sm"
      >
        <span data-testid="thread-dated-text" className={cn(AI_TITLE, "min-w-0 flex-1 wrap-anywhere tabular", !top.open && "text-muted-foreground")}>{readerLine(top, now)}</span>
        {top.open ? (
          // Done outlined (what's usually meant), Later and Remove quiet beside it
          <span className="flex shrink-0 items-center gap-1.5">
            <Button ref={doneRef} variant="outline" size="sm" className="text-foreground" data-testid="thread-dated-done" aria-label={t("dated.doneItem", { text })} onClick={() => act(threadId, top, "done")}>
              {t("dated.done")}
            </Button>
            <ItemLater key={top.key} item={top} act={(at) => act(threadId, top, "later", at)} />
            <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" data-testid="thread-dated-dismiss" aria-label={t("dated.removeItem", { text })} onClick={() => act(threadId, top, "dismiss")}>
              {t("dated.remove")}
            </Button>
          </span>
        ) : (
          // a history line opened: it's done, so what happened, no buttons
          <span data-testid="thread-dated-outcome" className="shrink-0 text-muted-foreground tabular">{outcomeOf(top)}</span>
        )}
      </div>
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
