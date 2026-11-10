import type { ScheduledInfo } from "@terno/core/rpc";
import { t } from "@terno/i18n";
import { Popover, PopoverContent, PopoverTrigger } from "@terno/ui/components/popover";
import { Clock } from "@terno/ui/icons";
import { useState, type RefObject } from "react";
import { reminderShort, reminderWhen } from "~/lib/when";
import { editScheduled, rescheduleScheduled, useScheduled } from "~/lib/scheduled";
import { SendLaterPicker } from "./send-later-picker";

/**
 * Plan 94: Send later on a scheduled send (Send now, a new time, Edit message), around the trigger `children` renders.
 * Plan 175: or opened by its owner (`open`), under `anchor`, when what was clicked was a menu's item that has gone.
 */
export function ScheduledPopover({ s, align, children, open: given, onOpenChange, anchor, finalFocus }: { s: ScheduledInfo; align: "start" | "end"; children?: (open: boolean) => React.ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void; anchor?: RefObject<HTMLElement | null>; finalFocus?: RefObject<HTMLElement | null> }) {
  const [own, setOwn] = useState(false);
  const open = given ?? own;
  const setOpen = (next: boolean) => (onOpenChange ?? setOwn)(next);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {children?.(open)}
      <PopoverContent side="bottom" align={align} sideOffset={4} anchor={anchor} finalFocus={finalFocus} className="w-72 gap-2 rounded-menu p-1.5" data-testid="scheduled-popover" aria-label={t("sendLater.title")}>
        <SendLaterPicker
          current={s}
          done={() => setOpen(false)}
          onPick={(at) => void (at === "now" ? rescheduleScheduled(s.draftId, Date.now(), true) : rescheduleScheduled(s.draftId, at))}
          onEdit={() => void editScheduled(s.draftId)}
        />
      </PopoverContent>
    </Popover>
  );
}

/** Plan 94: in a conversation, its scheduled reply (or forward), quietly above the reply bar: a click opens Send later on it. */
export function ScheduledReplyLine({ threadId }: { threadId: number }) {
  const s = useScheduled((x) => x.items.find((i) => i.threadId === threadId && i.mode !== "new"));
  if (!s) return null;
  return (
    <ScheduledPopover s={s} align="start">
      {() => (
        <PopoverTrigger
          render={
            <button
              type="button"
              data-testid="reader-scheduled"
              aria-label={t("sendLater.item", { recipients: s.to[0]?.name || s.to[0]?.email || "", when: reminderWhen(s.sendAt) })}
              className="mt-5 -ml-2.5 flex h-8 items-center gap-2 rounded-md px-2.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            />
          }
        >
          <Clock className="size-[1.15em] text-primary" aria-hidden />
          <span>{t("sendLater.reader")}</span>
          <span aria-hidden>·</span>
          <span className={s.error ? "text-destructive-ink tabular" : "tabular"}>{reminderShort(s.sendAt)}</span>
        </PopoverTrigger>
      )}
    </ScheduledPopover>
  );
}
