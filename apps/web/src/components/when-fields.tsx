import { getLocale, t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Calendar, CALENDAR_LOCALES } from "@terno/ui/components/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@terno/ui/components/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@terno/ui/components/select";
import { cn } from "@terno/ui/lib/utils";
import { CalendarDays, Clock } from "@terno/ui/icons";
import { useState } from "react";

/** the time list's step (a reminder or a scheduled send needs no finer) */
const STEP = 15;
export const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const at = (day: Date, minutes: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(minutes / 60), minutes % 60).getTime();
const tag = () => (getLocale() === "en" ? "en-US" : getLocale());
export const dayText = (d: Date | number) => new Intl.DateTimeFormat(tag(), { weekday: "short", month: "short", day: "numeric" }).format(d).replace(/\./g, "");
const timeText = (minutes: number) =>
  new Intl.DateTimeFormat(tag(), getLocale() === "en" ? { hour: "numeric", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" }).format(new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60));
const TIMES = Array.from({ length: (24 * 60) / STEP }, (_, i) => i * STEP);

/** the field look both triggers share (a quiet filled control, like the search field) */
const FIELD = "h-8 gap-2 rounded-lg border-0 bg-tint px-2.5 text-sm font-normal text-foreground shadow-none hover:bg-accent hover:text-accent-foreground dark:bg-tint [&_svg]:text-muted-foreground";

/** A day and a time of day (local), starting at `start`; `chosen` is the moment they make. */
export function useWhen(start: number) {
  const s = new Date(start);
  const [day, setDay] = useState(midnight(s));
  const [minutes, setMinutes] = useState(s.getHours() * 60 + s.getMinutes());
  const chosen = at(day, minutes);
  return { day, setDay, minutes, setMinutes, chosen, past: chosen <= Date.now() };
}

/**
 * Plan 87's date and time, shared with plan 89's Send later: a themed
 * calendar (no day before today) and a 15-minute time list (today's gone
 * times dimmed, so the list keeps its shape). `testPrefix` names their
 * test ids (`remind` → remind-date, remind-time…).
 */
export function WhenFields({ when, testPrefix, describedBy }: { when: ReturnType<typeof useWhen>; testPrefix: string; describedBy?: string }) {
  const { day, setDay, minutes, setMinutes, past } = when;
  const [calendarOpen, setCalendarOpen] = useState(false);
  const today = midnight(new Date());
  const gone = (m: number) => day.getTime() === today.getTime() && at(day, m) <= Date.now();
  return (
    <div className="flex gap-1.5">
      <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
        <PopoverTrigger
          render={
            <Button type="button" variant="ghost" data-testid={`${testPrefix}-date`} aria-label={`${t("remind.date")}: ${dayText(day)}`} aria-invalid={past || undefined} aria-describedby={past ? describedBy : undefined} className={cn(FIELD, "min-w-0 flex-1 justify-start")}>
              <CalendarDays className="size-3.5" aria-hidden />
              <span className="truncate">{dayText(day)}</span>
            </Button>
          }
        />
        <PopoverContent side="bottom" align="start" sideOffset={6} className="w-auto p-2.5" data-testid={`${testPrefix}-calendar`}>
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
        <SelectTrigger data-testid={`${testPrefix}-time`} aria-label={t("remind.time")} aria-invalid={past || undefined} aria-describedby={past ? describedBy : undefined} className={cn(FIELD, "w-30 shrink-0")}>
          <Clock className="size-3.5" aria-hidden />
          <SelectValue className="tabular-nums" />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false} side="bottom" align="end" sideOffset={6} className="max-h-60 min-w-30 p-1" data-testid={`${testPrefix}-times`}>
          {TIMES.map((m) => (
            <SelectItem key={m} value={m} data-gone={gone(m) || undefined} className="tabular-nums data-gone:text-muted-foreground">
              {timeText(m)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
