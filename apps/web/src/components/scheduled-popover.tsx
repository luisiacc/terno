import type { ScheduledInfo } from "@terno/core/rpc";
import { t } from "@terno/i18n";
import { Popover, PopoverContent, PopoverTrigger } from "@terno/ui/components/popover";
import { Clock } from "@terno/ui/icons";
import { lazy, Suspense, useState } from "react";
import { reminderShort, reminderWhen } from "~/lib/when";
import { editScheduled, rescheduleScheduled, useScheduled } from "~/lib/scheduled";

const SendLaterPicker = lazy(() => import("./send-later-picker").then((m) => ({ default: m.SendLaterPicker })));

/** Plan 89: Send later on a scheduled send (Send now, a new time, Edit message), around the trigger `children` renders. */
export function ScheduledPopover({ s, align, children }: { s: ScheduledInfo; align: "start" | "end"; children: (open: boolean) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {children(open)}
      <PopoverContent side="bottom" align={align} sideOffset={4} className="w-72 gap-2 p-2" data-testid="scheduled-popover" aria-label={t("sendLater.title")}>
        <Suspense fallback={<div className="h-32" />}>
          <SendLaterPicker
            current={s}
            done={() => setOpen(false)}
            onPick={(at) => void (at === "now" ? rescheduleScheduled(s.draftId, Date.now(), true) : rescheduleScheduled(s.draftId, at))}
            onEdit={() => void editScheduled(s.draftId)}
          />
        </Suspense>
      </PopoverContent>
    </Popover>
  );
}

/** Plan 89: in a conversation, its scheduled reply (or forward), quietly above the reply bar: a click opens Send later on it. */
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
          <Clock className="size-3.5 text-primary" aria-hidden />
          <span>{t("sendLater.reader")}</span>
          <span aria-hidden>·</span>
          <span className={s.error ? "text-destructive-ink tabular" : "tabular"}>{reminderShort(s.sendAt)}</span>
        </PopoverTrigger>
      )}
    </ScheduledPopover>
  );
}
