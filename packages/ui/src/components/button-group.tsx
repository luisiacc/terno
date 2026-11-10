"use client"

import * as React from "react"
import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cn } from "cn"

/**
 * BoardUI's button group: items fused into one bordered control, split by hairlines, with only the outer corners
 * rounded. On a worded button's corners, so a pill where the design says so (plan 137). `aria-label` names the group.
 */
function ButtonGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      role="group"
      data-slot="button-group"
      className={cn(
        "inline-flex h-8 shrink-0 items-stretch divide-x divide-border overflow-hidden rounded-[max(var(--cta-floor),var(--ds-radius-lg))] border border-border bg-card shadow-xs",
        className,
      )}
      {...props}
    />
  )
}

/** One item: `iconOnly` needs an `aria-label`; `selected` keeps its hover fill and says so. The group clips, so focus is a ring inside the item. */
function ButtonGroupItem({ className, selected, iconOnly, type = "button", ...props }: ButtonPrimitive.Props & { selected?: boolean; iconOnly?: boolean }) {
  return (
    <ButtonPrimitive
      data-slot="button-group-item"
      type={type}
      aria-pressed={selected}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 text-[length:var(--ds-text-control)] font-medium whitespace-nowrap outline-none transition-colors select-none hover:bg-muted press:bg-[color-mix(in_oklab,var(--muted),var(--foreground)_6%)] aria-expanded:bg-muted aria-pressed:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[1.15em] [&_svg:not([class*='text-'])]:text-muted-foreground hover:[&_svg:not([class*='text-'])]:text-foreground aria-expanded:[&_svg:not([class*='text-'])]:text-foreground",
        iconOnly ? "aspect-square" : "px-2.5",
        className,
      )}
      {...props}
    />
  )
}

export { ButtonGroup, ButtonGroupItem }
