import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"
import { cn } from "cn"

function TooltipProvider({
  delay = 0,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delay}
      {...props}
    />
  )
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 10,
  align = "center",
  alignOffset = 0,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<
    TooltipPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        {/* BoardUI's tooltip (plan 125): medium caption text, at most 240 px wide, 10 px off with a caret at the trigger */}
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            "z-50 inline-flex w-fit max-w-60 origin-(--transform-origin) duration-fast items-center gap-2 rounded-lg bg-popover px-2.5 py-1.5 text-xs font-medium text-popover-foreground shadow-menu has-data-[slot=kbd]:pr-1 data-[side=bottom]:slide-in-from-top-0.5 data-[side=top]:slide-in-from-bottom-0.5 data-[side=left]:slide-in-from-right-0.5 data-[side=right]:slide-in-from-left-0.5 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
            className
          )}
          {...props}
        >
          {children}
          {/* the caret: a square turned 45°, half under the edge, its two outer sides the panel's 1 px edge (as Popover's) */}
          <TooltipPrimitive.Arrow
            data-slot="tooltip-arrow"
            className={cn(
              "size-2.5 rotate-45 border-border bg-popover",
              "data-[side=right]:-left-[5px] data-[side=right]:border-b data-[side=right]:border-l",
              "data-[side=left]:-right-[5px] data-[side=left]:border-t data-[side=left]:border-r",
              "data-[side=bottom]:-top-[5px] data-[side=bottom]:border-t data-[side=bottom]:border-l",
              "data-[side=top]:-bottom-[5px] data-[side=top]:border-r data-[side=top]:border-b"
            )}
          />
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
