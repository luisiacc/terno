"use client"

import { Radio as RadioPrimitive } from "@base-ui/react/radio"
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group"
import { cn } from "cn"

/**
 * BoardUI color picker's preset row (plan 125): round swatches as one radio group (arrows move and choose, Tab leaves),
 * each named for its colour. A hairline keeps light colours off the surface; the chosen one is ringed inside its edge
 * (a ring of the card's white, then a dark hairline), so it reads on any colour and the row never shifts.
 */
function ColorSwatches({ className, ...props }: RadioGroupPrimitive.Props) {
  return <RadioGroupPrimitive data-slot="color-swatches" className={cn("flex flex-wrap items-center gap-1.5", className)} {...props} />
}

/** `label` names it ("Violet"); `color` fills it (any CSS colour); children draw on it (a letter, a "none" stroke). */
function ColorSwatch({
  className,
  label,
  color,
  style,
  children,
  ...props
}: Omit<RadioPrimitive.Root.Props, "style"> & { label: string; color?: string; style?: React.CSSProperties }) {
  return (
    <RadioPrimitive.Root
      data-slot="color-swatch"
      aria-label={label}
      className={cn(
        "group/swatch relative inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--foreground)_10%,transparent)] transition-transform outline-none hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className
      )}
      style={color ? { backgroundColor: color, ...style } : style}
      {...props}
    >
      {children}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-full opacity-0 shadow-[inset_0_0_0_2px_var(--card),inset_0_0_0_3px_color-mix(in_oklab,var(--foreground)_25%,transparent)] transition-opacity group-data-checked/swatch:opacity-100"
      />
    </RadioPrimitive.Root>
  )
}

export { ColorSwatches, ColorSwatch }
