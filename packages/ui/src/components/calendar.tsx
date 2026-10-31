import * as React from "react"
import { cn } from "cn"
import { DayPicker, getDefaultClassNames, type DayButton } from "react-day-picker"
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import { enUS, es } from "react-day-picker/locale"

/** the app's languages, for `locale` (names, the week's first day); another falls back to English */
export const CALENDAR_LOCALES = { en: enUS, es } as const

/**
 * shadcn's Calendar (react-day-picker), in Terno's tokens: the month on the
 * left and quiet arrows on the right (Calendar.app), days as soft rounded
 * cells, today in the accent's ink, the chosen day filled. Focus paints only
 * while moving with the keyboard (plan 54); motion: none.
 */
function Calendar({ className, classNames, showOutsideDays = true, components, ...props }: React.ComponentProps<typeof DayPicker>) {
  const d = getDefaultClassNames()
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn("group/calendar w-fit select-none [--cell:--spacing(8)]", className)}
      classNames={{
        root: cn("w-fit", d.root),
        months: cn("relative flex flex-col", d.months),
        month: cn("flex w-full flex-col gap-2", d.month),
        nav: cn("absolute top-0 right-0 flex items-center gap-0.5", d.nav),
        button_previous: cn(
          "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring aria-disabled:pointer-events-none aria-disabled:opacity-40",
          d.button_previous
        ),
        button_next: cn(
          "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring aria-disabled:pointer-events-none aria-disabled:opacity-40",
          d.button_next
        ),
        month_caption: cn("flex h-7 items-center pl-1.5", d.month_caption),
        caption_label: cn("text-sm font-semibold tracking-tight", d.caption_label),
        month_grid: cn("w-full border-collapse", d.month_grid),
        weekdays: cn("flex", d.weekdays),
        weekday: cn("w-(--cell) text-center text-2xs font-medium text-muted-foreground", d.weekday),
        week: cn("mt-0.5 flex w-full", d.week),
        day: cn("size-(--cell) p-0 text-center", d.day),
        today: cn("today", d.today),
        outside: cn("outside", d.outside),
        disabled: cn("disabled", d.disabled),
        hidden: cn("invisible", d.hidden),
        ...classNames,
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
      data-selected={modifiers.selected || undefined}
      data-today={modifiers.today || undefined}
      data-outside={modifiers.outside || undefined}
      className={cn(
        "inline-flex size-(--cell) items-center justify-center rounded-md text-sm tabular-nums outline-none",
        "hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring",
        "data-outside:text-muted-foreground",
        "data-today:font-semibold data-today:text-primary",
        "data-selected:bg-primary data-selected:font-semibold data-selected:text-primary-foreground data-selected:hover:bg-primary data-selected:hover:text-primary-foreground",
        "disabled:pointer-events-none disabled:text-muted-foreground disabled:opacity-40",
        className
      )}
      {...props}
    />
  )
}

export { Calendar, CalendarDayButton }
