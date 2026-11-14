import { getLocale, t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Calendar, CALENDAR_LOCALES } from "@terno/ui/components/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@terno/ui/components/popover";
import { Time, TimeField } from "@terno/ui/components/time-field";
import { cn } from "@terno/ui/lib/utils";
import { CalendarDays } from "@terno/ui/icons";
import { useId, useRef, useState } from "react";

export const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const at = (day: Date, minutes: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(minutes / 60), minutes % 60).getTime();
const tag = () => (getLocale() === "en" ? "en-US" : getLocale());
export const dayText = (d: Date | number) => new Intl.DateTimeFormat(tag(), { weekday: "short", month: "short", day: "numeric" }).format(d).replace(/\./g, "");

/**
 * BoardUI's date-picker trigger (plan 121): the secondary button's chrome (card, a 1 px border, a contact shadow)
 * around an icon and the day; corners and icon on the rows' line above it
 */
const TRIGGER = "h-8 gap-2 rounded-md px-2 text-sm font-normal text-foreground [&_svg]:text-muted-foreground";

/**
 * A day and a time of day (local), starting at `start`; `chosen` is the moment they make. The time is null while a
 * segment of it is cleared (plan 122): not `ready`, so nothing can be set until it is whole again.
 */
export function useWhen(start: number) {
  const s = new Date(start);
  const [day, setDay] = useState(midnight(s));
  const [minutes, setMinutes] = useState<number | null>(s.getHours() * 60 + s.getMinutes());
  const [complete, setComplete] = useState(true);
  const ready = minutes !== null && complete;
  const chosen = ready ? at(day, minutes) : Number.NaN;
  return { day, setDay, minutes, setMinutes, setComplete, chosen, ready, past: ready && chosen <= Date.now() };
}

/**
 * Plan 87's date and time, shared with plan 94's Send later: a themed
 * calendar (no day before today) and BoardUI's Time Field (plan 122), typed
 * segment by segment in the app's locale. `testPrefix` names their test ids
 * (`remind` → remind-date, remind-time…).
 */
export function WhenFields({ when, testPrefix, describedBy, onEnter }: { when: ReturnType<typeof useWhen>; testPrefix: string; describedBy?: string; onEnter?: () => void }) {
  const { day, setDay, minutes, setMinutes, setComplete, past } = when;
  const [calendarOpen, setCalendarOpen] = useState(false);
  const today = midnight(new Date());
  return (
    <div
      className="flex gap-1.5"
      // Enter in the time sets it, as it did from the list (a segment is no input, so no form submits on its own;
      // caught on the way down, since React Aria's segments stop the keys they see)
      onKeyDownCapture={(e) => {
        if (e.key !== "Enter" || (e.target as HTMLElement).getAttribute("role") !== "spinbutton") return;
        e.preventDefault();
        onEnter?.();
      }}
    >
      <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
        <PopoverTrigger
          render={
            <Button type="button" variant="outline" data-testid={`${testPrefix}-date`} aria-label={`${t("remind.date")}: ${dayText(day)}`} aria-invalid={past || undefined} aria-describedby={past ? describedBy : undefined} className={cn(TRIGGER, "min-w-0 flex-1 justify-start")}>
              <CalendarDays className="size-[1.15em]" aria-hidden />
              <span className="truncate">{dayText(day)}</span>
            </Button>
          }
        />
        <PopoverContent side="bottom" align="start" sideOffset={6} className="w-auto rounded-[calc(var(--radius-md)+var(--spacing)*2.5)] p-2.5" data-testid={`${testPrefix}-calendar`}>
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
      <TimeField
        data-testid={`${testPrefix}-time`}
        aria-label={t("remind.time")}
        locale={tag()}
        // the app's language decides, as the list did: 12-hour in English, 24-hour in Spanish (whatever es-MX's default)
        hourCycle={getLocale() === "en" ? 12 : 24}
        value={minutes === null ? null : new Time(Math.floor(minutes / 60), minutes % 60)}
        onChange={(v) => setMinutes(v ? v.hour * 60 + v.minute : null)}
        onCompleteChange={setComplete}
        isInvalid={past}
        aria-describedby={past ? describedBy : undefined}
        className="w-30 shrink-0"
      />
    </div>
  );
}

/**
 * A moment of your own, set with a button: the date and time above, why it can't be set yet under them (past, or after
 * `before`: a Plan's end), and the button. The clock is read again on submit, since the moment can pass while it's open.
 * Plan 87's reminder, plan 162's follow-up Later and plan 204's Today Later share it.
 */
export function WhenForm({ start, testPrefix, submit, onSet, before = null, formTestId, className, noteClassName }: { start: number; testPrefix: string; submit: string; onSet: (at: number) => void; /** the moment it must come before */ before?: number | null; formTestId?: string; className?: string; noteClassName?: string }) {
  const when = useWhen(start);
  const formRef = useRef<HTMLFormElement>(null);
  const noteId = useId();
  const [, recheck] = useState(0);
  const late = before !== null && when.ready && when.chosen >= before;
  const shown = { ...when, past: when.past || late };
  return (
    <form
      ref={formRef}
      className={cn("flex flex-col gap-2", className)}
      data-testid={formTestId}
      onSubmit={(e) => {
        e.preventDefault();
        if (!when.ready || late) return;
        if (when.chosen <= Date.now()) return recheck((n) => n + 1);
        onSet(when.chosen);
      }}
    >
      <WhenFields when={shown} testPrefix={testPrefix} describedBy={noteId} onEnter={() => formRef.current?.requestSubmit()} />
      {shown.past && (
        <p id={noteId} className={cn("text-xs text-destructive-ink", noteClassName)} data-testid={`${testPrefix}-past`}>
          {t(when.past ? "remind.past" : "dated.laterPastEnd")}
        </p>
      )}
      <Button type="submit" size="sm" data-testid={`${testPrefix}-set`} disabled={shown.past || !when.ready} className="self-end">
        {submit}
      </Button>
    </form>
  );
}
