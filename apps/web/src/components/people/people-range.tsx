import { getLocale, t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Calendar, CALENDAR_LOCALES } from "@terno/ui/components/calendar";
import { Popover, PopoverContent, PopoverFooter, PopoverTitle } from "@terno/ui/components/popover";
import { useRef, useState, type RefObject } from "react";
import { setPeopleFilter } from "~/lib/people";
import { dayKey, dayOf, FIRST_DAY, rangeDays, rangeLabel, type PeopleRange } from "~/lib/people-filter";
import { usePeople } from "~/state/people";

const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/**
 * Plan 287: Last email's custom range, BoardUI's Date Picker in its range form on our Calendar: two months (the current
 * one last), no day after today (a last email isn't in the future), what's chosen and how many days under them, Cancel
 * and Apply. Nothing changes until Apply; Cancel, Esc and a click outside leave the filter as it was. Opened from the
 * filter's menu, under its button (`anchor`), the keyboard back on it when it closes. Kept mounted through its close
 * (its exit runs); each opening starts from the filter as it is.
 */
export function PeopleRangePicker({ open, onOpenChange, anchor }: { open: boolean; onOpenChange: (open: boolean) => void; anchor: RefObject<HTMLButtonElement | null> }) {
  const popup = useRef<HTMLDivElement>(null);
  const [opening, setOpening] = useState(0);
  const [shown, setShown] = useState(open);
  if (open !== shown) {
    setShown(open);
    if (open) setOpening((n) => n + 1);
  }
  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      // opened by the menu, it has no trigger to take the keyboard from: once it's shown, the range's first day, else today
      onOpenChangeComplete={(isOpen) => {
        const el = popup.current;
        // (the day's button: its cell carries the same data-day)
        if (isOpen) (el?.querySelector<HTMLElement>("button[data-range-end], button[data-today]:not(:disabled)") ?? el?.querySelector<HTMLElement>("button[data-day]:not(:disabled)"))?.focus({ preventScroll: true });
      }}
    >
      <PopoverContent
        ref={popup}
        anchor={anchor}
        align="end"
        // (the keyboard is put on a day once it's shown, above)
        initialFocus={false}
        finalFocus={anchor}
        data-testid="people-range"
        // never taller than the window: the months scroll, the footer stays
        className="max-h-(--available-height) w-auto max-w-(--available-width)"
      >
        {opening > 0 && <Picker key={opening} close={() => onOpenChange(false)} />}
      </PopoverContent>
    </Popover>
  );
}

function Picker({ close }: { close: () => void }) {
  const choice = usePeople((s) => s.filter);
  const today = midnight(new Date());
  // what's chosen so far, and which end the next day is: a new pick always starts a range (BoardUI's), the next ends it
  const [draft, setDraft] = useState<{ from: Date; to: Date } | null>(() => (choice.range ? { from: dayOf(choice.range.from), to: dayOf(choice.range.to) } : null));
  const [end, setEnd] = useState(false);
  // two months: the range's first one first (so its first day takes the keyboard), never past this one; else this one last
  const [month, setMonth] = useState(() => {
    const before = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const from = draft?.from;
    return from && from < before ? new Date(from.getFullYear(), from.getMonth(), 1) : before;
  });
  const chosen: PeopleRange | null = draft ? { from: dayKey(draft.from), to: dayKey(draft.to) } : null;
  const pick = (day: Date) => {
    if (!end || !draft) {
      setDraft({ from: day, to: day });
      setEnd(true);
      return;
    }
    setDraft(day < draft.from ? { from: day, to: draft.from } : { from: draft.from, to: day });
    setEnd(false);
  };
  const apply = () => {
    if (!chosen) return;
    setPeopleFilter({ ...choice, within: null, range: chosen });
    close();
  };
  return (
    <>
      <PopoverTitle>{t("people.filter.rangeTitle")}</PopoverTitle>
      <div className="min-h-0 overflow-y-auto">
        <Calendar
          mode="range"
          numberOfMonths={2}
          month={month}
          onMonthChange={setMonth}
          selected={draft ?? undefined}
          // (the day picked, by our own rule above: react-day-picker's would move an end of a whole range)
          onSelect={(_, day) => pick(midnight(day))}
          // no day after today; none before 1970 (what the filter can say)
          disabled={[{ after: today }, { before: FIRST_DAY }]}
          startMonth={FIRST_DAY}
          endMonth={today}
          locale={CALENDAR_LOCALES[getLocale() as keyof typeof CALENDAR_LOCALES] ?? CALENDAR_LOCALES.en}
          // (two months side by side: another month's days would show twice)
          showOutsideDays={false}
          classNames={{ months: "relative flex flex-col gap-6 sm:flex-row" }}
        />
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        {/* what's chosen so far, said as it changes */}
        <p data-testid="people-range-said" aria-live="polite" className="text-sm tabular">
          {!chosen ? (
            <span className="text-muted-foreground">{t("people.filter.rangeStart")}</span>
          ) : (
            <>
              {rangeLabel(chosen)}
              <span className="text-muted-foreground"> · {end ? t("people.filter.rangeEnd") : t("people.filter.rangeDays", { count: rangeDays(chosen) })}</span>
            </>
          )}
        </p>
        <PopoverFooter>
          <Button variant="outline" size="sm" data-testid="people-range-cancel" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" data-testid="people-range-apply" disabled={!chosen} onClick={apply}>
            {t("people.filter.apply")}
          </Button>
        </PopoverFooter>
      </div>
    </>
  );
}
