"use client"

import * as React from "react"
import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cn } from "cn"

/**
 * BoardUI's button group: items fused into one bordered control, split by hairlines, with only the outer corners
 * rounded. On a worded button's corners, so a pill where the design says so (plan 137). `aria-label` names the group.
 * Its rim and lit edge (Relief's depth, plan 208) are an overlay above the items, so a hovered item's fill never covers
 * them; the group itself casts only the lift.
 */
function ButtonGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      role="group"
      data-slot="button-group"
      className={cn(
        "relative inline-flex h-8 shrink-0 items-stretch divide-x divide-border overflow-hidden rounded-[max(var(--cta-floor),var(--ds-radius-lg))] border border-(--depth-edge) bg-card bg-(image:--depth-raised-sheen) shadow-(--depth-raised-lift) [text-shadow:var(--emboss)] after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:shadow-(--depth-raised)",
        className,
      )}
      {...props}
    />
  )
}

/**
 * One item: `iconOnly` needs an `aria-label`; `selected` keeps its hover fill and says so. The group clips, so focus is a ring
 * inside the item. Filled, it keeps the group's sheen over its fill, as a hovered outline button does.
 */
function ButtonGroupItem({ className, selected, iconOnly, type = "button", ...props }: ButtonPrimitive.Props & { selected?: boolean; iconOnly?: boolean }) {
  return (
    <ButtonPrimitive
      data-slot="button-group-item"
      type={type}
      aria-pressed={selected}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 text-[length:var(--ds-text-control)] font-medium whitespace-nowrap outline-none transition-colors select-none hover:bg-muted press:bg-[color-mix(in_oklab,var(--muted),var(--foreground)_6%)] aria-expanded:bg-muted aria-pressed:bg-muted hover:bg-(image:--depth-raised-sheen) press:bg-(image:--depth-raised-sheen) aria-expanded:bg-(image:--depth-raised-sheen) aria-pressed:bg-(image:--depth-raised-sheen) focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[1.15em] [&_svg:not([class*='text-'])]:text-muted-foreground hover:[&_svg:not([class*='text-'])]:text-foreground aria-expanded:[&_svg:not([class*='text-'])]:text-foreground",
        iconOnly ? "aspect-square" : "px-2.5",
        className,
      )}
      {...props}
    />
  )
}

export { ButtonGroup, ButtonGroupItem }
