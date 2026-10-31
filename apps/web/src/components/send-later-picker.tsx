import { sendLaterTomorrow } from "@terno/core";
import type { ScheduledInfo } from "@terno/core/rpc";
import { getLocale, t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Shortcut } from "@terno/ui/components/shortcut";
import { CalendarClock, PenLine, Send, Sunrise } from "@terno/ui/icons";
import { useEffect, useId, useRef, useState } from "react";
import { reminderWhen } from "~/lib/when";
import { dayText, useWhen, WhenFields } from "./when-fields";

const timeOf = (ms: number) => new Intl.DateTimeFormat(getLocale() === "en" ? "en-US" : getLocale(), getLocale() === "en" ? { hour: "numeric", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" }).format(ms);

/**
 * Plan 89's picker: Send now, Tomorrow at 8:00, or a date and time of your
 * own (plan 87's fields), with the line that says the send leaves from this
 * device. For a scheduled one (the strip's, the reader's) it says when it
 * goes, why the last try didn't, and offers Edit message. Not a form: it is
 * portaled out of a composer whose submit would send at once. ↑/↓ move
 * through the choices; `done` closes whatever holds it.
 */
export function SendLaterPicker({ current, onPick, onEdit, sendKeys, done }: { current?: ScheduledInfo; onPick: (at: number | "now") => void; onEdit?: () => void; sendKeys?: string; done: () => void }) {
  const tomorrow = sendLaterTomorrow(new Date());
  const [picking, setPicking] = useState(false);
  const when = useWhen(current?.sendAt && current.sendAt > Date.now() ? current.sendAt : tomorrow);
  const listRef = useRef<HTMLDivElement>(null);
  const pastId = useId();
  // loaded after its popover opened (and focused itself): the keyboard starts on the first choice
  useEffect(() => listRef.current?.querySelector<HTMLElement>("[data-send-later-choice]")?.focus(), []);

  const pick = (at: number | "now") => {
    done();
    onPick(at);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-send-later-choice]") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (i === -1) return;
    e.preventDefault();
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };

  const choice = "flex h-8 w-full items-center gap-3 rounded-md px-2 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground [&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-muted-foreground";
  return (
    <div className="flex flex-col gap-2" data-testid="send-later-picker" onKeyDown={onKeyDown}>
      {current && (
        <div className="flex flex-col gap-0.5 px-1">
          <p className="text-xs text-muted-foreground" data-testid="send-later-current">
            {t("sendLater.current", { when: reminderWhen(current.sendAt) })}
          </p>
          {current.error && (
            <p className="text-xs text-destructive-ink" data-testid="send-later-error">
              {t("sendLater.retrying", { error: current.error, when: reminderWhen(current.retryAt ?? current.sendAt) })}
            </p>
          )}
        </div>
      )}
      <div ref={listRef} className="-mx-1 flex flex-col" role="group" aria-label={t("sendLater.title")}>
        <button type="button" data-send-later-choice data-testid="send-later-now" className={choice} onClick={() => pick("now")}>
          <Send aria-hidden />
          <span className="min-w-0 flex-1 truncate">{t("sendLater.now")}</span>
          {sendKeys && <Shortcut keys={sendKeys} />}
        </button>
        <button type="button" data-send-later-choice data-testid="send-later-tomorrow" className={choice} onClick={() => pick(tomorrow)}>
          <Sunrise aria-hidden />
          <span className="min-w-0 flex-1 truncate">{t("sendLater.tomorrow", { time: timeOf(tomorrow) })}</span>
          <span className="shrink-0 text-xs text-muted-foreground tabular">{dayText(tomorrow)}</span>
        </button>
        <button type="button" data-send-later-choice data-testid="send-later-custom" aria-expanded={picking} className={choice} onClick={() => setPicking((v) => !v)}>
          <CalendarClock aria-hidden />
          <span className="min-w-0 flex-1 truncate">{t("sendLater.custom")}</span>
        </button>
        {picking && (
          <div className="flex flex-col gap-2 px-1 pt-1 pb-1" data-testid="send-later-fields">
            <WhenFields when={when} testPrefix="send-later" describedBy={pastId} />
            {when.past && (
              <p id={pastId} className="px-1 text-xs text-destructive-ink" data-testid="send-later-past">
                {t("remind.past")}
              </p>
            )}
            <Button type="button" size="sm" data-testid="send-later-set" disabled={when.past} className="self-end" onClick={() => !when.past && pick(when.chosen)}>
              {t("sendLater.schedule")}
            </Button>
          </div>
        )}
        {onEdit && (
          <>
            <div className="my-1 h-(--hairline-w) bg-hairline" aria-hidden />
            <button
              type="button"
              data-send-later-choice
              data-testid="send-later-edit"
              className={choice}
              onClick={() => {
                done();
                onEdit();
              }}
            >
              <PenLine aria-hidden />
              <span className="min-w-0 flex-1 truncate">{t("sendLater.edit")}</span>
            </button>
          </>
        )}
      </div>
      <p className="hairline-t px-1 pt-2 text-xs text-muted-foreground" data-testid="send-later-local">
        {t("sendLater.local")}
      </p>
    </div>
  );
}
