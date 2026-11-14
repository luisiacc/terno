import { askEnd, datedGroup, datedPlace, dayEnd, planEnd, type DatedRow, type ThreadDetail } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@terno/ui/components/dropdown-menu";
import { Popover, PopoverContent } from "@terno/ui/components/popover";
import { CalendarClock, ChevronDown } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { useEffect, useRef, useState } from "react";
import { aiAllowed } from "~/lib/ai";
import { datedLine, datedText, itemLaterWindow, laterNote, laterPresets, laterStart } from "~/lib/dated";
import { presetLabel, presetWhen } from "~/lib/reminders";
import { actOnThreadItem } from "~/lib/today-task";
import { client } from "~/rpc/connection";
import { useApp } from "~/state/app";
import { AI_CARD, AI_INSET, AI_TITLE } from "./ai-card";
import { WhenForm } from "./when-fields";

/** The reader shows this many of a conversation's dates, soonest first. */
const SHOWN = 3;

/** When an item stops being the conversation's: a Plan's end, an ask's window (never Missed), a deadline's day. */
const endOf = (r: DatedRow): number => (datedGroup(r.kind) === "plans" ? planEnd(r) : r.kind === "ask" ? askEnd(r) : dayEnd(r.dueDay));

/** Still to act on, shown or not yet in Today: not a Plan that's over, an ask past its window, nor a day Missed has let go of. */
function current(r: DatedRow, now: number): { missed: boolean } | null {
  if (r.state !== "open") return null;
  const place = datedPlace(r, now);
  if (place === "missed") return { missed: true };
  if (place !== "hidden") return { missed: false };
  // hidden: too far ahead (or put off with Later) is still the conversation's; over is not
  return now < endOf(r) ? { missed: false } : null;
}

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
            from={span.from}
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
 * electricity bill", Done, Later and Not a task), so a bill can be finished where it's read; an ask is its words alone
 * ("Answer Mariana about a rebranding quote"), and a reply on the thread answers it. Only while dates are read; never in
 * Trash or Spam; read again when Today changes (Done here, there, or a new message settling it).
 */
export default function ThreadDated({ detail }: { detail: ThreadDetail }) {
  const on = useApp((s) => aiAllowed(s) && s.settings?.dated?.enabled === true);
  const threadId = detail.thread.id;
  const hidden = detail.thread.inTrash || detail.thread.inSpam;
  const [rows, setRows] = useState<readonly DatedRow[]>([]);
  useEffect(() => {
    if (!on || hidden) return setRows([]);
    let live = true;
    const read = () => void client.call("dated.ofThread", { threadId }).then((r) => live && setRows(r.rows), () => {});
    read();
    const off = client.on("todayChanged", read);
    return () => {
      live = false;
      off();
    };
  }, [on, hidden, threadId]);
  const now = Date.now();
  const shown = rows
    .map((r) => ({ r, at: current(r, now) }))
    .filter((x): x is { r: DatedRow; at: { missed: boolean } } => x.at !== null)
    .sort((a, b) => a.r.dueAt - b.r.dueAt)
    .slice(0, SHOWN);
  if (!shown.length) return null;
  return (
    // the summary card's surface and inset (plan 181): a model's reading, not the sender's words
    <section aria-label={t("dated.section")} data-testid="thread-dated" className={cn(AI_CARD, AI_INSET, "mb-4")}>
      <ul>
        {shown.map(({ r, at }) => {
          const line = datedLine(r, at.missed, now);
          return (
            <li key={r.id} data-testid="thread-dated-item" data-kind={r.kind} className="flex min-h-11 items-center gap-3 text-sm">
              <span data-testid="thread-dated-text" className={cn(AI_TITLE, "min-w-0 flex-1 wrap-anywhere tabular")}>{line}</span>
              {/* after the panel: Not a task beside Done, quieter (Done is what's usually meant); the third panel round:
                  Later between them, as quiet */}
              <span className="flex shrink-0 items-center gap-1.5">
                <Button variant="outline" size="sm" className="text-foreground" data-testid="thread-dated-done" aria-label={t("dated.doneItem", { text: datedText(r) })} onClick={() => void actOnThreadItem(threadId, r, "done")}>
                  {t("dated.done")}
                </Button>
                <ItemLater threadId={threadId} row={r} />
                <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" data-testid="thread-dated-dismiss" aria-label={t("dated.notTaskItem", { text: datedText(r) })} onClick={() => void actOnThreadItem(threadId, r, "dismiss")}>
                  {t("dated.notTask")}
                </Button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
