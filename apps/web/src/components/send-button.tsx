import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@terno/ui/components/popover";
import { Shortcut } from "@terno/ui/components/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { cn } from "@terno/ui/lib/utils";
import { Clock, Send } from "@terno/ui/icons";
import { create } from "zustand";
import { useFilesOnTheirWay } from "~/lib/attachments";
import { validRecipients, type LocalDraft } from "~/lib/drafts";
import { firstInvalid } from "~/lib/recipient-field";
import { SendLaterPicker } from "./send-later-picker";

/** Plan 94: which composer's Send later is open (⌘⇧↩ opens it from the keyboard). */
export const useSendLater = create<{ open: string | null }>(() => ({ open: null }));
export const openSendLater = (key: string) => useSendLater.setState({ open: key });

/** ⌘⇧↩ (before ⌘↩: both are a modified Enter) */
export const isSendLaterKey = (e: React.KeyboardEvent) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.shiftKey;

/** Whether the draft has what a send needs: somebody to go to, and nothing typed that isn't an address. */
export const canSendTo = (d: Pick<LocalDraft, "toText" | "ccText" | "bccText">): boolean =>
  validRecipients(d.toText).length > 0 && firstInvalid(d.toText) === null && firstInvalid(d.ccText) === null && firstInvalid(d.bccText) === null;

/**
 * Send, and joined to its right the clock that schedules it (plan 94): one
 * filled shape split by a short inset hairline, like a macOS split button.
 * The clock opens Send now, Tomorrow at 8:00 and Custom above it. With nobody
 * to send to yet it reads as unavailable, but a click still says why, at the
 * field (plan 158): aria-disabled, never disabled.
 */
export function SendButton({ d, onSend, className }: { d: LocalDraft; onSend: (sendAt?: number) => void; className?: string }) {
  const open = useSendLater((s) => s.open === d.key);
  const setOpen = (o: boolean) => useSendLater.setState({ open: o ? d.key : null });
  const disabled = d.sending || Boolean(d.recovery);
  const uploading = useFilesOnTheirWay(d.key);
  const ready = canSendTo(d) && !uploading;
  const invalid = firstInvalid(d.toText) ?? firstInvalid(d.ccText) ?? firstInvalid(d.bccText);
  // the group owns the fill (a primary button's, plan 118), radius and shadow, so the halves meet with no seam; each half
  // only tints on hover (bg-none: a half's own gradient would hide that), and keeps the group's look when unavailable (the
  // group fades instead).
  // The group clips, so focus is a ring inside each half, 2 px in so it doesn't read as the half's edge, in the
  // text's color (the ring token is primary itself, 1:1 here).
  const half =
    "border-0 bg-transparent bg-none shadow-none hover:bg-primary-hover aria-expanded:bg-primary-hover focus-visible:outline-none focus-visible:ring-0 focus-visible:shadow-[inset_0_0_0_2px_var(--primary),inset_0_0_0_3.5px_var(--primary-foreground)] active:not-aria-[haspopup]:scale-100 text-inherit unavailable:bg-transparent unavailable:text-inherit";
  return (
    <div
      className={cn(
        "flex shrink-0 items-stretch overflow-hidden rounded-[max(var(--cta-floor),min(var(--ds-radius-md),12px))] bg-primary bg-linear-to-b from-primary-hover to-primary text-primary-foreground dark:from-primary dark:to-primary-hover shadow-[inset_0_1px_var(--highlight),0_1px_2px_var(--shadow-color)]",
        // what a primary reads as when it can't go yet (plan 118's unavailable), in a color its label stays readable on; a click still says why
        "has-disabled:bg-none has-disabled:bg-transparent has-disabled:text-muted-foreground has-disabled:shadow-[inset_0_0_0_1px_var(--border)] has-[[aria-disabled=true]]:bg-none has-[[aria-disabled=true]]:bg-transparent has-[[aria-disabled=true]]:text-muted-foreground has-[[aria-disabled=true]]:shadow-[inset_0_0_0_1px_var(--border)]",
        className,
      )}
      data-testid="compose-send-group"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button type="submit" size="sm" data-testid="compose-send" aria-busy={d.sending} aria-disabled={!disabled && !ready ? true : undefined} disabled={disabled} className={cn(half, !ready && "hover:bg-muted", "peer gap-2 rounded-r-none pr-2")}>
              <Send /> {t("common.send")}
            </Button>
          }
        />
        <TooltipContent className="flex items-center gap-2">
          {ready ? t("common.send") : uploading ? t("compose.stillAdding") : invalid !== null ? t("compose.invalidRecipient", { entry: invalid }) : t("compose.noRecipient")}
          {ready && <Shortcut keys="mod+enter" />}
        </TooltipContent>
      </Tooltip>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <Button type="button" size="sm" aria-label={t("sendLater.button")} data-testid="compose-send-later" disabled={disabled} className={cn(half, !ready && "hover:bg-muted aria-expanded:bg-muted", "relative gap-0.5 rounded-l-none px-2 before:absolute before:inset-y-1.5 before:left-0 before:w-(--hairline-w) before:bg-current/25 peer-hover:before:opacity-0 hover:before:opacity-0 aria-expanded:before:opacity-0")} />
                }
              />
            }
          >
            <Clock />
          </TooltipTrigger>
          <TooltipContent className="flex items-center gap-2">
            {t("sendLater.button")}
            <Shortcut keys="mod+shift+enter" />
          </TooltipContent>
        </Tooltip>
        <PopoverContent side="top" align="end" sideOffset={6} className="w-72 gap-2 rounded-menu p-1.5" data-testid="send-later-popover" aria-label={t("sendLater.title")}>
          <SendLaterPicker sendKeys="mod+enter" done={() => setOpen(false)} onPick={(at) => onSend(at === "now" ? undefined : at)} />
        </PopoverContent>
      </Popover>
    </div>
  );
}
