import { cn } from "cn"

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      // The key (plan 118): a flat pill
      className={cn(
        "pointer-events-none inline-flex h-4.5 w-fit min-w-4.5 items-center justify-center gap-1 rounded-full bg-muted px-1.5 font-sans text-2xs font-semibold text-muted-foreground tabular select-none [&_svg:not([class*='size-'])]:size-3",
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
