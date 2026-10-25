"use client"

import { Toolbar as ToolbarPrimitive } from "@base-ui/react/toolbar"
import { cn } from "cn"

/** A row of controls with one tab stop: arrows move between them (WAI-ARIA toolbar). */
function Toolbar({ className, ...props }: ToolbarPrimitive.Root.Props) {
  return <ToolbarPrimitive.Root data-slot="toolbar" className={cn("flex items-center", className)} {...props} />
}

function ToolbarGroup({ className, ...props }: ToolbarPrimitive.Group.Props) {
  return <ToolbarPrimitive.Group data-slot="toolbar-group" className={cn("flex items-center", className)} {...props} />
}

function ToolbarSeparator({ className, ...props }: ToolbarPrimitive.Separator.Props) {
  return <ToolbarPrimitive.Separator data-slot="toolbar-separator" className={cn("mx-1 h-4 w-(--hairline-w) shrink-0 bg-hairline", className)} {...props} />
}

function ToolbarButton({ className, ...props }: ToolbarPrimitive.Button.Props) {
  return <ToolbarPrimitive.Button data-slot="toolbar-button" className={className} {...props} />
}

export { Toolbar, ToolbarButton, ToolbarGroup, ToolbarSeparator }
