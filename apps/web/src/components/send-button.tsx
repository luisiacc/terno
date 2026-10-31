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
 * Send, and joined to its right the clock that schedules it (plan 94): the
 * same fill, split by a hairline. The clock opens Send now, Tomorrow at
 * 8:00 and Custom above it.
 */
export function SendButton({ d, onSend, className }: { d: LocalDraft; onSend: (sendAt?: number) => void; className?: string }) {
  const open = useSendLater((s) => s.open === d.key);
  const setOpen = (o: boolean) => useSendLater.setState({ open: o ? d.key : null });
  const disabled = d.sending || Boolean(d.recovery);
  const kbd = "[&_kbd]:bg-primary-foreground/15 [&_kbd]:text-primary-foreground [&_kbd]:shadow-none";
  return (
    <div className={cn("flex shrink-0 items-stretch", className)} data-testid="compose-send-group">
      <Button type="submit" size="sm" data-testid="compose-send" aria-busy={d.sending} disabled={disabled} className="gap-2 rounded-r-none">
        <Send /> {t("common.send")} <Shortcut keys="mod+enter" className={kbd} />
      </Button>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <Button type="button" size="sm" aria-label={t("sendLater.button")} data-testid="compose-send-later" disabled={disabled} className="gap-0.5 rounded-l-none border-l-primary-foreground/25 px-1.5" />
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
