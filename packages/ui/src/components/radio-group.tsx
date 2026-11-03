"use client"

import { Radio as RadioPrimitive } from "@base-ui/react/radio"
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group"
import { cn } from "cn"

/**
 * BoardUI's radio (plan 125) on Base UI's RadioGroup: one choice of a few, arrow keys move and choose (Base UI's), Tab
 * leaves the group. `Radio` is the 16 px dot with its label; `RadioCard` is a bordered card that is the radio itself,
 * taking the accent edge when chosen (the first-run and appearance choices), with `RadioDot` inside it to say so.
 */
function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
  return <RadioGroupPrimitive data-slot="radio-group" className={cn("flex flex-col gap-2", className)} {...props} />
}

/**
 * The dot, drawn from its radio's state (`group/radio`): white over a contact shadow at rest, its border firming on
 * hover; chosen, the accent lit from the top (the checkbox's) with a white centre. Presentation only.
 */
function RadioDot({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="radio-dot"
      aria-hidden
      className={cn(
        "relative flex size-4 shrink-0 items-center justify-center rounded-full border border-input bg-card shadow-xs transition-colors group-data-unchecked/radio:group-hover/radio:border-foreground/30",
        "group-data-checked/radio:border-primary group-data-checked/radio:bg-primary group-data-checked/radio:bg-linear-to-b group-data-checked/radio:from-highlight group-data-checked/radio:to-transparent group-data-checked/radio:shadow-[inset_0_1px_var(--highlight)]",
        // the centre, scaled in when chosen
        "after:size-1.5 after:scale-0 after:rounded-full after:bg-primary-foreground after:transition-transform group-data-checked/radio:after:scale-100",
        className
      )}
      {...props}
    />
  )
}

/** A radio and its label (children); the label clicks it. Without children, name it with `aria-label`. */
function Radio({ className, children, ...props }: RadioPrimitive.Root.Props) {
  const radio = (
    <RadioPrimitive.Root
      data-slot="radio"
      className={cn(
        "group/radio relative inline-flex shrink-0 rounded-full outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:ring-3 focus-visible:ring-ring data-disabled:cursor-not-allowed data-disabled:opacity-50",
        children === undefined && className
      )}
      {...props}
    >
      <RadioDot />
    </RadioPrimitive.Root>
  )
  if (children === undefined) return radio
  return (
    <label data-slot="radio-label" className={cn("inline-flex cursor-pointer items-center gap-2 text-sm font-medium has-data-disabled:cursor-not-allowed has-data-disabled:text-muted-foreground", className)}>
      {radio}
      {children}
    </label>
  )
}

/** A card that is a radio: its content names it. Put a `RadioDot` in it where the choice should show. */
function RadioCard({ className, ...props }: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-card"
      className={cn(
        "group/radio relative flex cursor-pointer rounded-xl border border-border bg-card text-left text-foreground shadow-xs transition-[border-color,box-shadow] outline-none select-none data-unchecked:hover:border-input focus-visible:ring-2 focus-visible:ring-ring data-checked:border-primary data-checked:shadow-[0_0_0_1px_var(--primary)] data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { RadioGroup, Radio, RadioCard, RadioDot }
