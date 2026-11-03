"use client"

import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

const toggleVariants = cva(
  "group/toggle inline-flex items-center justify-center gap-1 rounded-lg text-sm font-medium whitespace-nowrap transition-all outline-none hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-transparent aria-pressed:bg-muted data-[state=on]:bg-muted",
        // BoardUI's segmented control (plan 120), an item on ToggleGroup's track: the chosen one a raised thumb, card on
        // the field wash (light), muted on the background with an inner highlight (dark, where the track is darker)
        segmented: "bg-transparent text-muted-foreground hover:bg-transparent hover:text-foreground aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-xs dark:aria-pressed:bg-muted dark:aria-pressed:shadow-[inset_0_1px_var(--highlight),0_1px_2px_var(--shadow-color)]",
      },
      size: {
        default:
          "h-8 min-w-8 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        sm: "h-7 min-w-7 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 min-w-9 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
      },
    },
    // Terno's height inside the track (h-7 in an h-8 control), corners concentric with the track's
    compoundVariants: [{ variant: "segmented", class: "h-7 min-w-0 rounded-md px-2.5 text-sm [&_svg:not([class*='size-'])]:size-[1.15em]" }],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Toggle({
  className,
  variant = "default",
  size = "default",
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Toggle, toggleVariants }
