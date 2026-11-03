import { useId } from "react"
import { cn } from "cn"

/**
 * BoardUI's progress bar (plan 125): a 4 px track on the field wash with the fill in the primary, rounded at both ends,
 * moved by a transform (the compositor's) within --motion; an optional label row above it, its value at the end.
 * Plain markup with `role="progressbar"` rather than Base UI's Progress: the first-sync pill that uses it is in the
 * entry chunk. `value` is 0 to 100; null is an amount not yet known (a third drawn, the bar just says it is working).
 * Children draw over the track (the sync's sheen).
 */
function Progress({
  value,
  label,
  valueLabel,
  className,
  children,
  "aria-label": ariaLabel,
  "aria-valuetext": valueText,
  ...props
}: Omit<React.ComponentProps<"div">, "role"> & {
  value: number | null
  /** names the bar, shown above it */
  label?: React.ReactNode
  /** the value as shown at the end of the label row (the bar says it whole with `aria-valuetext`) */
  valueLabel?: React.ReactNode
}) {
  const labelId = useId()
  // a sliver stays at the start, so a bar that has barely begun still shows its rounded end
  const drawn = value === null ? 30 : Math.min(100, Math.max(4, value))
  return (
    <div data-slot="progress" className={cn("flex w-full flex-col gap-1", className)} {...props}>
      {(label !== undefined || valueLabel !== undefined) && (
        <div className="flex items-baseline justify-between gap-2">
          <span id={labelId} className="min-w-0 truncate">
            {label}
          </span>
          <span aria-hidden className="shrink-0 text-muted-foreground tabular-nums">
            {valueLabel}
          </span>
        </div>
      )}
      <div
        role="progressbar"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabel === undefined && label !== undefined ? labelId : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value === null ? undefined : Math.round(value)}
        aria-valuetext={valueText}
        data-slot="progress-track"
        className="relative h-1 w-full overflow-hidden rounded-full bg-field"
      >
        <span data-slot="progress-fill" className="absolute inset-0 rounded-full bg-primary transition-transform duration-base ease-motion" style={{ transform: `translateX(${drawn - 100}%)` }} />
        {children}
      </div>
    </div>
  )
}

export { Progress }
