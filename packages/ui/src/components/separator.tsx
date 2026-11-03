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

export { Separator }
