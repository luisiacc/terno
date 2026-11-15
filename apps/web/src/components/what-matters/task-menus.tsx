import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@terno/ui/components/dropdown-menu";
import { Shortcut } from "@terno/ui/components/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { CalendarClock, ChevronDown } from "@terno/ui/icons";
import { laterChoices, type TodayTask } from "~/lib/dated";
import { presetLabel, presetWhen } from "~/lib/reminders";
import { actOnTodayRow } from "~/lib/today-task";
import { openTodayLater } from "../today-later-dialog";

/**
 * Plan 204, the UI experiment: a feed item's Done, Not a task and Later, the row menu's own (thread-menu's `TaskItems`):
 * the same acts, the same Undo, the same presets in Later's window. Here as a dropdown on the item, so they're a Tab away.
 */

/** Later's presets that apply now, then a moment of your own. */
function LaterItems({ threadId, task }: { threadId: number; task: TodayTask }) {
  const now = Date.now();
  const presets = laterChoices(task, now);
  return (
    <>
      {presets.map((p) => (
        <DropdownMenuItem key={p.id} data-testid={`wm-later-${p.id}`} onClick={() => void actOnTodayRow(threadId, task, "later", p.at)}>
          <span className="min-w-0 flex-1 truncate">{presetLabel(p.id)}</span>
          <DropdownMenuShortcut className="tracking-normal tabular-nums">{presetWhen(p, now)}</DropdownMenuShortcut>
        </DropdownMenuItem>
      ))}
      {presets.length > 0 && <DropdownMenuSeparator />}
      <DropdownMenuItem data-testid="wm-later-pick" onClick={() => openTodayLater(threadId, task)}>
        <CalendarClock />
        <span className="min-w-0 flex-1 truncate">{t("dated.pickDate")}</span>
      </DropdownMenuItem>
    </>
  );
}

/**
 * The briefing item's Done (D) and Later, in words (after the UI panel: "I wouldn't press a button I can't read"), as the
 * reader's line has them: Done the secondary button, Later the quiet one with its presets. Each is described by the item's
 * sentence, so a screen reader hears which Done it is.
 */
export function BriefTaskControls({ threadId, task, describedBy }: { threadId: number; task: TodayTask; describedBy: string }) {
  return (
    <>
      <Tooltip>
        <TooltipTrigger render={<Button variant="outline" size="xs" data-testid="wm-done" aria-describedby={describedBy} aria-keyshortcuts="d" onClick={() => void actOnTodayRow(threadId, task, "done")} />}>
          {t("dated.done")}
        </TooltipTrigger>
        <TooltipContent>
          {t("dated.done")} <Shortcut keys="d" />
        </TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="xs" data-testid="wm-later" aria-describedby={describedBy} className="text-muted-foreground hover:text-foreground aria-expanded:text-foreground" />}>
          {t("dated.later")}
          <ChevronDown data-icon="inline-end" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={4} className="w-max min-w-60" data-testid="wm-later-menu">
          <LaterItems threadId={threadId} task={task} />
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
