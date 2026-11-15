import { shortcutFor, type FeedRowId } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@terno/ui/components/dropdown-menu";
import { Shortcut } from "@terno/ui/components/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { CalendarClock, ChevronDown } from "@terno/ui/icons";
import { useEffect } from "react";
import { laterChoices, type TodayTask } from "~/lib/dated";
import { presetLabel, presetWhen } from "~/lib/reminders";
import { actOnTodayRow, closeLater, laterFromMenu, openLater, pickFromMenu } from "~/lib/today-task";
import { useToday } from "~/state/today";

/**
 * Plan 204, the UI experiment: a feed item's Done and Later, the row menu's own (thread-menu's `TaskItems`): the same
 * acts, the same Undo, the same presets in Later's window. Here as a dropdown on the item, so they're a Tab away.
 */

/** Later's presets that apply now, then a moment of your own, for the task as it was when the menu opened. */
function LaterItems({ rowId, task }: { rowId: FeedRowId; task: TodayTask }) {
  const now = Date.now();
  const presets = laterChoices(task, now);
  return (
    <>
      {presets.map((p) => (
        <DropdownMenuItem key={p.id} data-testid={`wm-later-${p.id}`} onClick={() => laterFromMenu(rowId, task, p.at)}>
          <span className="min-w-0 flex-1 truncate">{presetLabel(p.id)}</span>
          <DropdownMenuShortcut className="tracking-normal tabular-nums">{presetWhen(p, now)}</DropdownMenuShortcut>
        </DropdownMenuItem>
      ))}
      {presets.length > 0 && <DropdownMenuSeparator />}
      <DropdownMenuItem
        data-testid="wm-later-pick"
        onClick={() => pickFromMenu(rowId, task)}
      >
        <CalendarClock />
        <span className="min-w-0 flex-1 truncate">{t("dated.pickDate")}</span>
      </DropdownMenuItem>
    </>
  );
}

const DONE_KEY = shortcutFor("today.done") ?? "d";
const LATER_KEY = shortcutFor("today.later") ?? "b";

/**
 * The briefing item's Done (D) and Later (B), in words (after the UI panel: "I wouldn't press a button I can't read"), as
 * the reader's line has them: Done the secondary button, Later the quiet one with its presets; each tooltip says its key
 * (plan 210, iteration 1). Each is described by the item's sentence, so a screen reader hears which Done it is. Later's
 * menu is the app's (`laterMenu`): its button and b open the same one, for the task as it was then.
 */
export function BriefTaskControls({ rowId, task, describedBy }: { rowId: FeedRowId; task: TodayTask; describedBy: string }) {
  const menu = useToday((s) => (s.laterMenu?.rowId === rowId ? s.laterMenu : null));
  // an item that goes (a reload, the feed scrolled) takes its open menu with it, and the app's keys come back
  useEffect(
    () => () => {
      if (useToday.getState().laterMenu?.rowId === rowId) closeLater();
    },
    [rowId],
  );
  return (
    <>
      <Tooltip>
        <TooltipTrigger render={<Button variant="outline" size="xs" data-testid="wm-done" aria-describedby={describedBy} aria-keyshortcuts={DONE_KEY} onClick={() => void actOnTodayRow(rowId, task, "done")} />}>
          {t("dated.done")}
        </TooltipTrigger>
        <TooltipContent>
          {t("dated.done")} <Shortcut keys={DONE_KEY} />
        </TooltipContent>
      </Tooltip>
      <DropdownMenu open={menu !== null} onOpenChange={(open) => (open ? openLater(rowId, task) : closeLater())}>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="xs" data-testid="wm-later" aria-describedby={describedBy} aria-keyshortcuts={LATER_KEY} className="text-muted-foreground hover:text-foreground aria-expanded:text-foreground" />}
              />
            }
          >
            {t("dated.later")}
            <ChevronDown data-icon="inline-end" />
          </TooltipTrigger>
          <TooltipContent>
            {t("dated.later")} <Shortcut keys={LATER_KEY} />
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" sideOffset={4} className="w-max min-w-60" data-testid="wm-later-menu">
          {/* (closing, it fades with what it showed) */}
          <LaterItems rowId={rowId} task={menu?.task ?? task} />
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
