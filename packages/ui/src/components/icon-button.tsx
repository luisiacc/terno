import { cn } from "cn"

import { Button } from "@terno/ui/components/button"
import { Shortcut } from "@terno/ui/components/shortcut"
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip"

type IconButtonProps = Omit<React.ComponentProps<typeof Button>, "variant" | "size" | "aria-label"> & {
  /** its name, for screen readers and the tooltip (there is no visible one) */
  label: string
  /** a binding ("mod+p", "g i") shown after the name in the tooltip */
  shortcut?: string
  /** `ghost`: Terno's quiet toolbar icon, muted until hovered; `secondary`: BoardUI's bordered icon button */
  variant?: "ghost" | "secondary"
  size?: "icon-xs" | "icon-sm" | "icon" | "icon-lg"
  tooltipSide?: React.ComponentProps<typeof TooltipContent>["side"]
}

/**
 * BoardUI's icon button (plan 125): an icon-only button whose name is required and shown, with its key, in a tooltip.
 * The one wrapper behind the reader's, the draft's and the selection toolbar's icons.
 */
function IconButton({ label, shortcut, variant = "ghost", size = "icon-sm", tooltipSide, className, ...props }: IconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={variant === "secondary" ? "outline" : "ghost"}
            size={size}
            aria-label={label}
            className={cn(variant === "ghost" && "text-muted-foreground hover:text-foreground", className)}
            {...props}
          />
        }
      />
      <TooltipContent side={tooltipSide}>
        {label}
        {shortcut && <Shortcut keys={shortcut} />}
      </TooltipContent>
    </Tooltip>
  )
}

export { IconButton, type IconButtonProps }
