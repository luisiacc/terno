"use client"

import { Separator as SeparatorPrimitive } from "@base-ui/react/separator"
import { cn } from "cn"

function Separator({
  className,
  orientation = "horizontal",
  ...props
}: SeparatorPrimitive.Props) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        // BoardUI's divider (plan 120), drawn as the app's hairlines
        "shrink-0 bg-hairline data-horizontal:h-(--hairline-w) data-horizontal:w-full data-vertical:w-(--hairline-w) data-vertical:self-stretch",
        className
      )}
      {...props}
    />
  )
}

/**
 * BoardUI's divider with a label (plan 204, the UI experiment's chat): its words centred between two hairlines. The
 * hairlines are drawing; the words are read, so the caller decides what they are (a heading, a caption).
 */
function SeparatorLabel({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="separator-label" className={cn("flex items-center gap-3 text-xs text-muted-foreground", className)} {...props}>
      <Separator aria-hidden className="w-auto flex-1" />
      <span className="shrink-0">{children}</span>
      <Separator aria-hidden className="w-auto flex-1" />
    </div>
  )
}

export { Separator, SeparatorLabel }
