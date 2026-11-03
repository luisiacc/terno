import { Switch as SwitchPrimitive } from "@base-ui/react/switch"
import { cn } from "cn"

function Switch({
  className,
  size = "default",
  ...props
}: SwitchPrimitive.Root.Props & {
  size?: "sm" | "default"
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch relative inline-flex shrink-0 items-center rounded-full border border-transparent transition-all outline-none group-has-[:focus-visible]/field-label:border-transparent group-has-[:focus-visible]/field-label:ring-0 after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[size=default]:h-[18.4px] data-[size=default]:w-[32px] data-[size=sm]:h-[14px] data-[size=sm]:w-[24px] dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-checked:bg-primary data-unchecked:bg-input dark:data-unchecked:bg-input/80 data-disabled:cursor-not-allowed data-disabled:opacity-50",
        // The switch (plan 118): the track lit from the top with an inner highlight, a dot in the thumb
        "data-checked:bg-linear-to-b data-checked:from-highlight data-checked:to-transparent data-checked:shadow-[inset_0_1px_var(--highlight)]",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        // BoardUI's thumb (plan 125): white in both modes, lit from the top, over a two-layer contact shadow; its chip a
        // small embossed dot, the primary when on
        className="pointer-events-none relative block rounded-full bg-card bg-linear-to-b from-card from-45% to-muted shadow-[0_3px_3px_0_color-mix(in_oklab,var(--shadow-color)_30%,transparent),0_0.75px_0_0_color-mix(in_oklab,var(--shadow-color)_50%,transparent)] ring-0 transition-transform group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 group-data-[size=default]/switch:data-checked:translate-x-[calc(100%-2px)] group-data-[size=sm]/switch:data-checked:translate-x-[calc(100%-2px)] group-data-[size=default]/switch:data-unchecked:translate-x-0 group-data-[size=sm]/switch:data-unchecked:translate-x-0 dark:bg-foreground dark:from-foreground dark:to-[color-mix(in_oklab,var(--foreground)_88%,var(--background))] after:absolute after:inset-0 after:m-auto after:size-1.5 after:rounded-full after:bg-input after:shadow-[inset_0_0.5px_1px_var(--shadow-color)] dark:data-unchecked:after:bg-muted-foreground/50 data-checked:after:bg-primary group-data-[size=sm]/switch:after:size-1"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
