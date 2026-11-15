import type { DatedRow, ThreadDetail } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@terno/ui/components/dropdown-menu";
import { Popover, PopoverContent } from "@terno/ui/components/popover";
import { CalendarClock, ChevronDown } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { useEffect, useRef, useState } from "react";
import { aiAllowed } from "~/lib/ai";
import { conversationItem, datedLine, datedText, itemLaterWindow, laterNote, laterPresets, laterStart } from "~/lib/dated";
import { presetLabel, presetWhen } from "~/lib/reminders";
import { actOnThreadItem } from "~/lib/today-task";
import { client } from "~/rpc/connection";
import { useApp } from "~/state/app";
import { useFeedTarget } from "~/state/today";
import { AI_CARD, AI_INSET, AI_TITLE } from "./ai-card";
import { WhenForm } from "./when-fields";

/** The reader shows this many of a conversation's dates, soonest first. */
const SHOWN = 3;

/**
 * The third panel round (change 6): Later on the conversation's line, as the row's menu offers it: the presets in Later's
 * window (a timed item still ahead, only what's before its moment; a Plan, before its end; a Missed one, every preset)
 * and a moment of your own. It goes through the row's flow (`actOnThreadItem`): the Today row leaves at once, Undo is
 * exact, a failure brings it back.
 */
function ItemLater({ threadId, row }: { threadId: number; row: DatedRow }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [picking, setPicking] = useState(false);
  const now = Date.now();
  const span = itemLaterWindow(row, now);
  const presets = laterPresets(span, now);
  const back = () => triggerRef.current?.focus({ preventScroll: true });
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button ref={triggerRef} variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" data-testid="thread-dated-later" aria-label={t("dated.laterItem", { text: datedText(row) })} />}>
          {t("dated.later")}
          <ChevronDown aria-hidden />
        </DropdownMenuTrigger>
        {/* as wide as what it holds, each moment in the shortcut's place, as the follow-up's Later */}
        <DropdownMenuContent align="end" className="w-max" data-testid="thread-dated-later-menu">
          {presets.map((p) => (
            <DropdownMenuItem key={p.id} data-testid={`thread-dated-later-${p.id}`} onClick={() => void actOnThreadItem(threadId, row, "later", p.at)}>
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
              void actOnThreadItem(threadId, row, "later", at);
            }}
          />
        </PopoverContent>
      </Popover>
    </>
  );
}

/**
 * Plan 204 §5: the conversation's open dates, a quiet line each on the AI card's surface at its top ("Due Friday · Pay the
 * electricity bill", Done, Later and Remove), so a bill can be finished where it's read; an ask is its words alone
 * ("Answer Mariana about a rebranding quote"), and a reply on the thread answers it. Only while dates are read; never in
 * Trash or Spam; read again when Today changes (Done here, there, or a new message settling it).
 */
export default function ThreadDated({ detail }: { detail: ThreadDetail }) {
  const on = useApp((s) => aiAllowed(s) && s.settings?.dated?.enabled === true);
  const threadId = detail.thread.id;
  const hidden = detail.thread.inTrash || detail.thread.inSpam;
  const [rows, setRows] = useState<readonly DatedRow[]>([]);
  // plan 210 (iteration 2): the item the feed's open row is (its every member), highlighted, shown whatever the limit; a
  // history line's closed item read too
  const target = useFeedTarget(threadId);
  const targetIds = target.filter((r) => r.source === "dated").map((r) => r.id);
  const include = targetIds.length === 1 ? targetIds[0] : undefined;
  useEffect(() => {
    if (!on || hidden) return setRows([]);
    let live = true;
    const read = () => void client.call("dated.ofThread", { threadId, ...(include !== undefined ? { include } : {}) }).then((r) => live && setRows(r.rows), () => {});
    read();
    const off = client.on("todayChanged", read);
    return () => {
      live = false;
      off();
    };
  }, [on, hidden, threadId, include]);
  const now = Date.now();
  const targeted = (r: DatedRow) => targetIds.includes(r.id);
  const open = rows
    .map((r) => ({ r, at: conversationItem(r, now) }))
    .filter((x): x is { r: DatedRow; at: { missed: boolean } } => x.at !== null)
    .sort((a, b) => a.r.dueAt - b.r.dueAt);
  const closed = rows.filter((r) => r.state !== "open" && targeted(r)).map((r) => ({ r, at: null }));
  const shown = [...open.filter((x, i) => i < SHOWN || targeted(x.r)), ...closed];
  if (!shown.length) return null;
  return (
    // the summary card's surface and inset (plan 181): a model's reading, not the sender's words
    <section aria-label={t("dated.section")} data-testid="thread-dated" className={cn(AI_CARD, AI_INSET, "mb-4")}>
      <ul>
        {shown.map(({ r, at }) => {
          const line = at ? datedLine(r, at.missed, now) : datedText(r);
          return (
            // plan 210 (iteration 2): the feed's open row's item, marked as the hover's fill marks a row
            <li key={r.id} data-testid="thread-dated-item" data-kind={r.kind} data-target={targeted(r) || undefined} data-closed={at === null || undefined} className="-mx-2 flex min-h-11 items-center gap-3 rounded-md px-2 text-sm data-target:bg-row-hover">
              <span data-testid="thread-dated-text" className={cn(AI_TITLE, "min-w-0 flex-1 wrap-anywhere tabular", at === null && "text-muted-foreground")}>{line}</span>
              {/* after the panel: Remove beside Done, quieter (Done is what's usually meant); the third panel round:
                  Later between them, as quiet. A closed one (a history line opened) has none: it's done */}
              {at !== null && <span className="flex shrink-0 items-center gap-1.5">
                <Button variant="outline" size="sm" className="text-foreground" data-testid="thread-dated-done" aria-label={t("dated.doneItem", { text: datedText(r) })} onClick={() => void actOnThreadItem(threadId, r, "done")}>
                  {t("dated.done")}
                </Button>
                <ItemLater threadId={threadId} row={r} />
                <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" data-testid="thread-dated-dismiss" aria-label={t("dated.removeItem", { text: datedText(r) })} onClick={() => void actOnThreadItem(threadId, r, "dismiss")}>
                  {t("dated.remove")}
                </Button>
              </span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
