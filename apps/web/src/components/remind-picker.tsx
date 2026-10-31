import { defaultRemindAt, remindPresets, type ReminderKind } from "@terno/core";
import { getLocale, t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Calendar, CALENDAR_LOCALES } from "@terno/ui/components/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@terno/ui/components/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@terno/ui/components/select";
import { ToggleGroup, ToggleGroupItem } from "@terno/ui/components/toggle-group";
import { cn } from "@terno/ui/lib/utils";
import { BellOff, CalendarClock, CalendarDays, Clock } from "lucide-react";
import { useId, useRef, useState } from "react";
import { clearReminder, presetLabel, reminderShort, reminderWhen, setReminder, useReminders } from "~/lib/reminders";

/** the time list's step (a reminder needs no finer) */
const STEP = 15;
const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const at = (day: Date, minutes: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(minutes / 60), minutes % 60).getTime();
const tag = () => (getLocale() === "en" ? "en-US" : getLocale());
const dayText = (d: Date) => new Intl.DateTimeFormat(tag(), { weekday: "short", month: "short", day: "numeric" }).format(d).replace(/\./g, "");
const timeText = (minutes: number) =>
  new Intl.DateTimeFormat(tag(), getLocale() === "en" ? { hour: "numeric", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" }).format(new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60));
const TIMES = Array.from({ length: (24 * 60) / STEP }, (_, i) => i * STEP);

/** the field look both triggers share (a quiet filled control, like the search field) */
const FIELD = "h-8 gap-2 rounded-lg border-0 bg-tint px-2.5 text-sm font-normal text-foreground shadow-none hover:bg-accent hover:text-accent-foreground dark:bg-tint [&_svg]:text-muted-foreground";

/**
 * Plan 87's picker: Remind me or If no reply, its presets with their
 * moments, a date and time of your own, and the reminder there is now (with
 * Clear). The reader's bell opens it in a popover; the menu's "Pick date &
 * time…" and h (without a reader) in a dialog. Arrow keys move through the
 * choices; `done` closes whatever holds it.
 */
export function RemindPicker({ threadIds, initialKind, custom = false, done }: { threadIds: readonly number[]; initialKind?: ReminderKind; custom?: boolean; done: () => void }) {
  const current = useReminders((s) => (threadIds.length === 1 ? s.byThread.get(threadIds[0]!) : undefined));
  // the kind asked for ("Remind me if no reply ▸ Pick…") wins; else the reminder there is; else Remind me
  const [kind, setKind] = useState<ReminderKind>(initialKind ?? current?.kind ?? "always");
  const [picking, setPicking] = useState(custom);
  const start = new Date(defaultRemindAt(new Date()));
  const [day, setDay] = useState(midnight(start));
  const [minutes, setMinutes] = useState(start.getHours() * 60 + start.getMinutes());
  const [calendarOpen, setCalendarOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const pastId = useId();
  const presets = remindPresets(new Date(), kind);
  const today = midnight(new Date());
  const chosen = at(day, minutes);
  const past = chosen <= Date.now();
  // today: the times already gone are offered, dimmed (the list keeps its shape)
  const gone = (m: number) => day.getTime() === today.getTime() && at(day, m) <= Date.now();

  const set = (dueAt: number) => {
    done();
    void setReminder(threadIds, dueAt, kind);
  };
  // ↑/↓ between the choices (the segmented control keeps its own ←/→)
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-remind-choice]") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (i === -1) return;
    e.preventDefault();
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };

  const choice = "flex h-8 w-full items-center gap-3 rounded-md px-2 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground";
  return (
    <div className="flex flex-col gap-2" data-testid="remind-picker" onKeyDown={onKeyDown}>
      {current && (
        <p className="px-1 text-xs text-muted-foreground" data-testid="remind-current">
          {t(current.kind === "noReply" ? "remind.currentNoReply" : "remind.current", { when: reminderWhen(current.dueAt) })}
        </p>
      )}
      <ToggleGroup
        aria-label={t("remind.kind.label")}
        value={[kind]}
        onValueChange={(v: string[]) => v[0] && setKind(v[0] as ReminderKind)}
        spacing={0}
        className="flex w-full rounded-lg bg-muted p-0.5"
        data-testid="remind-kind"
      >
        {(["always", "noReply"] as const).map((k) => (
          <ToggleGroupItem
            key={k}
            value={k}
            data-testid={`remind-kind-${k}`}
            className="h-7 flex-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:text-foreground data-pressed:bg-background data-pressed:text-foreground data-pressed:shadow-sm"
          >
            {t(k === "noReply" ? "remind.kind.noReply" : "remind.kind.always")}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <div ref={listRef} className="-mx-1 flex flex-col" role="group" aria-label={t("remind.title")}>
        {presets.map((p) => (
          <button key={p.id} type="button" data-remind-choice data-testid={`remind-preset-${p.id}`} className={choice} onClick={() => set(p.at)}>
            <span className="min-w-0 flex-1 truncate">{presetLabel(p.id)}</span>
            <span className="shrink-0 text-xs text-muted-foreground tabular">{reminderShort(p.at)}</span>
          </button>
        ))}
        <button type="button" data-remind-choice data-testid="remind-pick" aria-expanded={picking} className={choice} onClick={() => setPicking((v) => !v)}>
          <CalendarClock className="size-3.5 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{t("remind.pick")}</span>
        </button>
        {picking && (
          <form
            className="flex flex-col gap-2 px-1 pt-1 pb-1"
            data-testid="remind-custom"
            onSubmit={(e) => {
              e.preventDefault();
              if (!past) set(chosen);
            }}
          >
            <div className="flex gap-1.5">
              <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
                <PopoverTrigger
                  render={
                    <Button type="button" variant="ghost" data-testid="remind-date" aria-label={`${t("remind.date")}: ${dayText(day)}`} aria-invalid={past || undefined} aria-describedby={past ? pastId : undefined} className={cn(FIELD, "min-w-0 flex-1 justify-start")}>
                      <CalendarDays className="size-3.5" aria-hidden />
                      <span className="truncate">{dayText(day)}</span>
                    </Button>
                  }
                />
                <PopoverContent side="bottom" align="start" sideOffset={6} className="w-auto p-2.5" data-testid="remind-calendar">
                  <Calendar
                    mode="single"
                    required
                    selected={day}
                    defaultMonth={day}
                    locale={CALENDAR_LOCALES[getLocale() as keyof typeof CALENDAR_LOCALES] ?? CALENDAR_LOCALES.en}
                    disabled={{ before: today }}
                    startMonth={today}
                    onSelect={(d) => {
                      setDay(midnight(d));
                      setCalendarOpen(false);
                    }}
                  />
                </PopoverContent>
              </Popover>
              <Select value={minutes} onValueChange={(v) => v !== null && setMinutes(v)} items={TIMES.map((m) => ({ value: m, label: timeText(m) }))}>
                <SelectTrigger data-testid="remind-time" aria-label={t("remind.time")} aria-invalid={past || undefined} aria-describedby={past ? pastId : undefined} className={cn(FIELD, "w-30 shrink-0")}>
                  <Clock className="size-3.5" aria-hidden />
                  <SelectValue className="tabular-nums" />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false} side="bottom" align="end" sideOffset={6} className="max-h-60 min-w-30 p-1" data-testid="remind-times">
                  {TIMES.map((m) => (
                    <SelectItem key={m} value={m} data-gone={gone(m) || undefined} className="tabular-nums data-gone:text-muted-foreground">
                      {timeText(m)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {past && (
              <p id={pastId} className="px-1 text-xs text-destructive-ink" data-testid="remind-past">
                {t("remind.past")}
              </p>
            )}
            <Button type="submit" size="sm" data-testid="remind-set" disabled={past} className="self-end">
              {t("remind.set")}
            </Button>
          </form>
        )}
        {current && (
          <>
            <div className="my-1 h-(--hairline-w) bg-hairline" aria-hidden />
            <button
              type="button"
              data-remind-choice
              data-testid="remind-clear"
              className={cn(choice)}
              onClick={() => {
                done();
                void clearReminder(threadIds);
              }}
            >
              <BellOff className="size-3.5 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{t("remind.clear")}</span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
