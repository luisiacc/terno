import { cn } from "cn"

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      // BoardUI's key (plans 118, 125): a flat pill a step darker than what it sits on, its caption semibold. On the field
      // wash rather than BoardUI's grey: muted text on the border's fill fails AA in five palettes (contrast.ts)
      className={cn(
        "pointer-events-none inline-flex h-4.5 w-fit min-w-4.5 items-center justify-center gap-1 rounded-full bg-field px-1 font-sans text-xs font-semibold tracking-normal whitespace-nowrap text-muted-foreground tabular select-none [&_svg:not([class*='size-'])]:size-3",
        className
      )}
      {...props}
    />
  )
}

function KbdGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <kbd
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-1", className)}
      {...props}
    />
  )
}

export { Kbd, KbdGroup }
