import * as React from "react"
import { cn } from "cn"
import { DateLib, DayPicker, getDefaultClassNames, labelDayButton, type DayButton } from "react-day-picker"
import { ChevronLeft as ChevronLeftIcon, ChevronRight as ChevronRightIcon } from "@terno/ui/icons"
import { enUS, es } from "react-day-picker/locale"

/** the app's languages, for `locale` (names, the week's first day); another falls back to English */
export const CALENDAR_LOCALES = { en: enUS, es } as const

/**
 * shadcn's Calendar (react-day-picker), in Terno's tokens and BoardUI's date picker (plans 120, 125): the month
 * between quiet arrows, medium days as soft rounded cells 4 px apart (BoardUI's 12 would outgrow the 320 px popover),
 * today marked by a dot in the primary under its number, the chosen day filled, other months' days muted (a chosen day
 * next week may be in the next month), unavailable days struck through. Focus paints only while moving with the
 * keyboard (plan 54); motion: none. Plan 287, BoardUI's range form (`mode="range"`): its two ends filled in the primary,
 * the days between on a band of the primary's wash that joins across the gaps (drawn by the day's cell, under its day).
 */
function Calendar({ className, classNames, showOutsideDays = true, components, labels, ...props }: React.ComponentProps<typeof DayPicker>) {
  const d = getDefaultClassNames()
  // a day's name holds the number it shows ("Tuesday, September 1, 2026", never "1st"), so what's said is what's seen (axe);
  // the locale's own words around it stay ("Today, …, selected", "Hoy, …, seleccionado")
  const dayName = React.useMemo(() => new Intl.DateTimeFormat(props.locale?.code ?? "en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" }), [props.locale?.code])
  const own = props.locale?.labels?.labelDayButton
  const localeLabel = typeof own === "function" ? own : labelDayButton
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn("group/calendar w-fit select-none [--cell:--spacing(8)]", className)}
      classNames={{
        root: cn("w-fit", d.root),
        months: cn("relative flex flex-col", d.months),
        month: cn("flex w-full flex-col gap-2", d.month),
        // BoardUI's date picker (plan 120): the month centered between the arrows
        nav: cn("absolute inset-x-0 top-0 flex items-center justify-between", d.nav),
        button_previous: cn(
          "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-disabled:pointer-events-none aria-disabled:opacity-40",
          d.button_previous
        ),
        button_next: cn(
          "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-disabled:pointer-events-none aria-disabled:opacity-40",
          d.button_next
        ),
        month_caption: cn("flex h-7 items-center justify-center", d.month_caption),
        caption_label: cn("text-sm font-medium", d.caption_label),
        month_grid: cn("w-full border-collapse", d.month_grid),
        weekdays: cn("flex gap-1", d.weekdays),
        weekday: cn("w-(--cell) pb-1 text-center text-sm font-medium text-muted-foreground", d.weekday),
        week: cn("mt-1 flex w-full gap-1", d.week),
        // (the band's piece: the cell's own, and the gap before it; none before a week's first day, none for a one-day range)
        day: cn("relative size-(--cell) p-0 text-center before:absolute before:inset-y-0 first:before:left-0 [&.rdp-range\\_end.rdp-range\\_start]:before:hidden", d.day),
        // (the chosen day's own wash: foreground on it is a tested pair)
        range_start: cn("before:right-0 before:left-1/2 before:bg-primary/15", d.range_start),
        range_middle: cn("before:right-0 before:-left-1 before:bg-primary/15", d.range_middle),
        range_end: cn("before:right-1/2 before:-left-1 before:bg-primary/15", d.range_end),
        today: cn("today", d.today),
        outside: cn("outside", d.outside),
        disabled: cn("disabled", d.disabled),
        hidden: cn("invisible", d.hidden),
        ...classNames,
      }}
      labels={{
        labelDayButton: (date, modifiers, options, dateLib) => {
          const lib = dateLib ?? new DateLib(options)
          return localeLabel(date, modifiers, options, lib).replace(lib.format(date, "PPPP"), dayName.format(date))
        },
        ...labels,
      }}
      components={{
        Root: ({ className, rootRef, ...rest }) => <div data-slot="calendar" ref={rootRef} className={className} {...rest} />,
        Chevron: ({ className, orientation, ...rest }) =>
          orientation === "left" ? <ChevronLeftIcon className={cn("size-4", className)} {...rest} /> : <ChevronRightIcon className={cn("size-4", className)} {...rest} />,
        DayButton: CalendarDayButton,
        ...components,
      }}
      {...props}
    />
  )
}

function CalendarDayButton({ className, day, modifiers, ...props }: React.ComponentProps<typeof DayButton>) {
  const ref = React.useRef<HTMLButtonElement>(null)
  // arrow keys move the grid's focus (react-day-picker marks the day); the button follows it
  React.useEffect(() => {
    if (modifiers.focused) ref.current?.focus()
  }, [modifiers.focused])
  return (
    <button
      ref={ref}
      type="button"
      data-day={day.isoDate}
      // (in a range, its ends and the days between say so instead: plan 287)
      data-selected={(modifiers.selected && !modifiers.range_start && !modifiers.range_middle && !modifiers.range_end) || undefined}
      data-range-end={modifiers.range_start || modifiers.range_end || undefined}
      data-range-middle={modifiers.range_middle || undefined}
      data-today={modifiers.today || undefined}
      data-outside={modifiers.outside || undefined}
      className={cn(
        "relative inline-flex size-(--cell) items-center justify-center rounded-md text-sm font-medium tabular-nums outline-none",
        // BoardUI's day (plan 120): a neutral hover; the chosen day in a wash of the primary with the ink's text (contrast.ts)
        "hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
        "data-outside:text-muted-foreground data-outside:data-selected:text-foreground",
        // today: a 4 px dot in the primary under the number, its text the ink like any day's (plan 125)
        "data-today:after:absolute data-today:after:bottom-1 data-today:after:left-1/2 data-today:after:size-1 data-today:after:-translate-x-1/2 data-today:after:rounded-full data-today:after:bg-primary",
        "data-selected:bg-primary/15 data-selected:font-semibold data-selected:text-foreground data-selected:hover:bg-primary/15",
        // a range's ends: the primary filled, its ink (today's dot in that ink too); the days between keep the band's wash
        "data-range-end:bg-primary data-range-end:font-semibold data-range-end:text-primary-foreground data-range-end:hover:bg-primary data-today:data-range-end:after:bg-primary-foreground",
        "data-range-middle:text-foreground data-range-middle:hover:bg-primary/15",
        "disabled:pointer-events-none disabled:text-muted-foreground disabled:line-through",
        className
      )}
      {...props}
    />
  )
}

export { Calendar, CalendarDayButton }
