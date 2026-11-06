import { getLocale, t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Calendar, CALENDAR_LOCALES } from "@terno/ui/components/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@terno/ui/components/popover";
import { Time, TimeField } from "@terno/ui/components/time-field";
import { cn } from "@terno/ui/lib/utils";
import { CalendarDays } from "@terno/ui/icons";
import { useState } from "react";
import { dayText, midnight, whenTag, type useWhen } from "./when-lazy";

/**
 * BoardUI's date-picker trigger (plan 121): the secondary button's chrome (card, a 1 px border, a contact shadow)
 * around an icon and the day; corners and icon on the rows' line above it
 */
const TRIGGER = "h-8 gap-2 rounded-md px-2 text-sm font-normal text-foreground [&_svg]:text-muted-foreground";

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
        locale={whenTag()}
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
