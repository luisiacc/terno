import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@terno/ui/components/popover";
import { Switch } from "@terno/ui/components/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { Settings2 } from "@terno/ui/icons";
import { useId, useState } from "react";
import { datedReaderLine } from "~/lib/ai";
import { useDatedMutes } from "~/lib/dated-mutes";
import { reconcileSettings } from "~/lib/appearance";
import { snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { setApp, useApp } from "~/state/app";
import { openFound } from "../settings/find-open";
import { MutedList } from "./muted-list";

/** The finished items' switch, saved at once wherever it's changed (Settings has the same row: `general.todayFinished`). */
async function saveFinished(finished: boolean): Promise<void> {
  try {
    setApp({ settings: reconcileSettings(await client.call("settings.update", { today: { finished } })) });
  } catch (error) {
    snack.error(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Plan 210 (iteration 4): what's muted, with Unmute, while the popover is open (read only then); nothing muted, nothing
 * shown here (Settings says how muting comes about).
 */
function MutedSection({ fallback }: { fallback: () => HTMLElement | null }) {
  const [mutes, setMutes] = useDatedMutes();
  const titleId = useId();
  if (!mutes?.length) return null;
  return (
    <section aria-labelledby={titleId} data-testid="wm-options-muted" className="flex flex-col gap-1 border-t border-hairline pt-2">
      <p id={titleId} className="text-sm font-medium">
        {t("dated.mute.title")}
      </p>
      <MutedList mutes={mutes} setMutes={setMutes} testId="wm-muted" labelledBy={titleId} fallback={fallback} />
    </section>
  );
}

/**
 * Plan 210 (the owner): What matters' own options where it is, a quiet gear on the title's row: finished items shown or
 * hidden (an inbox-zero feeling), the same switch as Settings', and the way to the rest of its settings.
 */
export function WhatMattersOptions() {
  const [open, setOpen] = useState(false);
  const finished = useApp((s) => s.settings?.today?.finished !== false);
  // plan 210 (iteration 1): who reads the mail for it, where its options are
  const reader = useApp((s) => datedReaderLine(s.settings?.ai));
  const labelId = useId();
  const hintId = useId();
  const more = () => {
    setOpen(false);
    setApp({ dialog: "settings", settingsTab: "general" });
    // once Settings is there, at the row itself
    requestAnimationFrame(() => openFound({ id: "general.todayFinished", tab: "general", page: null, scope: null, under: null }));
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={<PopoverTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("whatMatters.options")} data-testid="wm-options" className="no-drag mr-1 shrink-0 text-muted-foreground hover:text-foreground" />} />}
        >
          <Settings2 />
        </TooltipTrigger>
        <TooltipContent>{t("whatMatters.options")}</TooltipContent>
      </Tooltip>
      {/* its keys are its own (Codex code review): D, j/k or e never reach the mail behind it; Esc closes it here (in the
          popup's portal it wouldn't reach Base UI's listener), as ai-provenance's does */}
      <PopoverContent
        align="end"
        data-testid="wm-options-panel"
        aria-label={t("whatMatters.options")}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            setOpen(false);
          }
        }}
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p id={labelId} className="text-sm font-medium">
              {t("today.settings.finished")}
            </p>
            <p id={hintId} className="mt-0.5 text-xs text-muted-foreground">
              {t("today.settings.finishedHint")}
            </p>
          </div>
          <Switch aria-labelledby={labelId} aria-describedby={hintId} checked={finished} data-testid="wm-options-finished" onCheckedChange={(on) => void saveFinished(on)} />
        </div>
        <MutedSection fallback={() => document.querySelector<HTMLElement>("[data-testid=wm-options-finished]")} />
        {reader && (
          <p data-testid="wm-options-privacy" className="text-xs text-muted-foreground">
            {reader}
          </p>
        )}
        <Button variant="link" size="xs" className="self-start" data-testid="wm-options-more" onClick={more}>
          {t("whatMatters.moreSettings")}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
