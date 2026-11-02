import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@terno/ui/components/popover";
import { Shortcut } from "@terno/ui/components/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { cn } from "@terno/ui/lib/utils";
import { ChevronDown, Clock, Send } from "@terno/ui/icons";
import { lazy, Suspense } from "react";
import { create } from "zustand";
import type { LocalDraft } from "~/lib/drafts";

const SendLaterPicker = lazy(() => import("./send-later-picker").then((m) => ({ default: m.SendLaterPicker })));

/** Plan 94: which composer's Send later is open (⌘⇧↩ opens it from the keyboard). */
export const useSendLater = create<{ open: string | null }>(() => ({ open: null }));
export const openSendLater = (key: string) => useSendLater.setState({ open: key });

/** ⌘⇧↩ (before ⌘↩: both are a modified Enter) */
export const isSendLaterKey = (e: React.KeyboardEvent) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.shiftKey;

/**
 * Send, and joined to its right the clock that schedules it (plan 94): one
 * filled shape split by a short inset hairline, like a macOS split button.
 * The clock opens Send now, Tomorrow at 8:00 and Custom above it.
 */
export function SendButton({ d, onSend, className }: { d: LocalDraft; onSend: (sendAt?: number) => void; className?: string }) {
  const open = useSendLater((s) => s.open === d.key);
  const setOpen = (o: boolean) => useSendLater.setState({ open: o ? d.key : null });
  const disabled = d.sending || Boolean(d.recovery);
  const kbd = "[&_kbd]:bg-primary-foreground/15 [&_kbd]:text-primary-foreground [&_kbd]:shadow-none";
  // the group owns the fill (a primary button's, plan 118), radius and shadow, so the halves meet with no seam; each half
  // only tints on hover (bg-none: a half's own gradient would hide that).
  // The group clips, so focus is a ring inside each half, 2 px in so it doesn't read as the half's edge, in the
  // text's color (the ring token is primary itself, 1:1 here).
  const half =
    "border-0 bg-transparent bg-none shadow-none hover:bg-primary-hover aria-expanded:bg-primary-hover focus-visible:outline-none focus-visible:ring-0 focus-visible:shadow-[inset_0_0_0_2px_var(--primary),inset_0_0_0_3.5px_var(--primary-foreground)] active:not-aria-[haspopup]:scale-100 disabled:opacity-100";
  return (
    <div
      className={cn("flex shrink-0 items-stretch overflow-hidden rounded-[min(var(--radius-md),12px)] bg-primary bg-linear-to-b from-primary-hover to-primary text-primary-foreground dark:from-primary dark:to-primary-hover shadow-[inset_0_1px_var(--highlight),0_1px_2px_var(--shadow-color)] has-disabled:opacity-50", className)}
      data-testid="compose-send-group"
    >
      <Button type="submit" size="sm" data-testid="compose-send" aria-busy={d.sending} disabled={disabled} className={cn(half, "peer gap-2 rounded-r-none pr-2")}>
        <Send /> {t("common.send")} <Shortcut keys="mod+enter" className={kbd} />
      </Button>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <Button type="button" size="sm" aria-label={t("sendLater.button")} data-testid="compose-send-later" disabled={disabled} className={cn(half, "relative gap-0.5 rounded-l-none px-1.5 before:absolute before:inset-y-1.5 before:left-0 before:w-(--hairline-w) before:bg-primary-foreground/25 peer-hover:before:opacity-0 hover:before:opacity-0 aria-expanded:before:opacity-0")} />
                }
              />
            }
          >
            <Clock />
            <ChevronDown className="size-3" />
          </TooltipTrigger>
          <TooltipContent className="flex items-center gap-2">
            {t("sendLater.button")}
            <Shortcut keys="mod+shift+enter" />
          </TooltipContent>
        </Tooltip>
        <PopoverContent side="top" align="end" sideOffset={6} className="w-72 gap-2 p-2" data-testid="send-later-popover" aria-label={t("sendLater.title")}>
          <Suspense fallback={<div className="h-32" />}>
            <SendLaterPicker sendKeys="mod+enter" done={() => setOpen(false)} onPick={(at) => onSend(at === "now" ? undefined : at)} />
          </Suspense>
        </PopoverContent>
      </Popover>
    </div>
  );
}
