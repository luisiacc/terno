"use client"

import { cn } from "cn"
import { useEffect } from "react"
import {
  DateInput,
  DateSegment,
  I18nProvider,
  TimeField as AriaTimeField,
  type TimeFieldProps as AriaTimeFieldProps,
  type TimeValue,
} from "react-aria-components"

import { Clock } from "@terno/ui/icons"

/**
 * BoardUI's Time Field (plan 122): a time of day typed segment by segment, in Input's filled field with a clock.
 * On React Aria's TimeField, the one part Base UI lacks: the hour, minute and AM/PM follow the locale's order and
 * hour cycle, typing fills a segment and moves on, Up and Down change it, and each segment is announced with its
 * value. The focused segment fills with the primary. `locale` sets the format (the app's, not the browser's).
 * `onCompleteChange` says whether every segment holds a value: React Aria keeps the last whole time as the value while
 * a segment is cleared, so a caller that acts on the value asks this too.
 */
function TimeField<T extends TimeValue>({
  className,
  locale,
  "data-testid": testId,
  onCompleteChange,
  ...props
}: Omit<AriaTimeFieldProps<T>, "className" | "children"> & { className?: string; locale?: string; "data-testid"?: string; onCompleteChange?: (complete: boolean) => void }) {
  const field = (
    <AriaTimeField {...props} data-slot="time-field" className={cn("group/time-field relative", className)}>
      {({ state }) => (
        <>
          <Complete complete={state.segments.every((s) => !s.isEditable || !s.isPlaceholder)} onChange={onCompleteChange} />
          <DateInput
            data-testid={testId}
            // Input's filled field: the fill at rest, the border on hover, focus (a text field keeps its ring) and error
            className={cn(
              "flex h-8 w-full min-w-0 cursor-text items-center rounded-lg border border-transparent bg-field pr-2.5 pl-8 text-sm whitespace-nowrap transition-colors",
              "data-[hovered]:border-input data-[focus-within]:border-ring data-[focus-within]:ring-3 data-[focus-within]:ring-ring",
              "data-[invalid]:border-destructive data-[invalid]:ring-3 data-[invalid]:ring-destructive/20 dark:data-[invalid]:border-destructive/50 dark:data-[invalid]:ring-destructive/40",
              "data-[disabled]:pointer-events-none data-[disabled]:bg-input/50 data-[disabled]:opacity-50"
            )}
          >
            {(segment) => (
              <DateSegment
                segment={segment}
                className={cn(
                  "rounded-sm px-0.5 text-foreground tabular-nums caret-transparent outline-none",
                  "data-[placeholder]:text-muted-foreground data-[type=literal]:px-0 data-[type=literal]:text-muted-foreground",
                  // focused, cleared or not, its text is the primary's own (a cleared segment's muted dashes would vanish on it)
                  "data-[focused]:bg-primary data-[focused]:text-primary-foreground data-[focused]:data-[placeholder]:text-primary-foreground"
                )}
              />
            )}
          </DateInput>
          <Clock aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-[1.15em] -translate-y-1/2 text-muted-foreground group-data-[invalid]/time-field:text-destructive" />
        </>
      )}
    </AriaTimeField>
  )
  return locale ? <I18nProvider locale={locale}>{field}</I18nProvider> : field
}

function Complete({ complete, onChange }: { complete: boolean; onChange?: (complete: boolean) => void }) {
  useEffect(() => onChange?.(complete), [complete, onChange])
  return null
}

// the value type, so callers need no date library of their own
export { Time } from "@internationalized/date"
export { TimeField }
