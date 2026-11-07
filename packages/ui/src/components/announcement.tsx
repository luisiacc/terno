import * as React from "react"
import { cn } from "cn"

import { CloseButton } from "@terno/ui/components/close-button"

type AnnouncementProps = Omit<React.ComponentProps<"div">, "title"> & {
  /** a glyph from @terno/ui/icons, drawn in the accent on the title's line */
  icon?: React.ReactElement
  title?: React.ReactNode
  /** extra props for the title's paragraph (a test id) */
  titleProps?: React.ComponentProps<"p"> & { "data-testid"?: string }
  description?: React.ReactNode
  /** small buttons under the text, or at the row's end when `inline` */
  actions?: React.ReactNode
  /** one line: the text truncates and the actions sit before the close */
  inline?: boolean
  /** shows a CloseButton at the end; `closeLabel` names what it does ("Dismiss", "Hide for a week") */
  onClose?: () => void
  closeLabel?: string
  closeProps?: Omit<React.ComponentProps<typeof CloseButton>, "label" | "onClick"> & { "data-testid"?: string }
}

/**
 * BoardUI's announcement (plan 125): a dismissible note above the list, on the tint with Terno's banner insets. Its
 * icon in the accent, a medium title over muted text, small actions, a round close at the end. The one class list
 * behind the learned-filter offer, the problem row, the forward question and the web's Mac banner.
 */
function Announcement({
  icon,
  title,
  titleProps,
  description,
  actions,
  inline = false,
  onClose,
  closeLabel,
  closeProps,
  className,
  role,
  ...props
}: AnnouncementProps) {
  const titleId = React.useId()
  return (
    <div
      data-slot="announcement"
      role={role}
      // a group or status is named by its title; a plain div can't carry a name
      aria-labelledby={role && title ? titleId : undefined}
      className={cn(
        "mt-1 mr-4 mb-1 ml-2 flex gap-2.5 rounded-[calc(var(--radius-lg)+2px)] bg-tint p-2.5 text-xs",
        inline ? "items-center py-1.5" : "items-start",
        className
      )}
      {...props}
    >
      {icon && (
        <span aria-hidden className={cn("flex shrink-0 text-primary [&_svg]:size-3.5", !inline && "h-4 items-center")}>
          {icon}
        </span>
      )}
      <div className={cn("min-w-0 flex-1", inline && "flex items-center gap-2")}>
        {title && (
          <p id={titleId} {...titleProps} className={cn("font-medium text-foreground", inline && "min-w-0 flex-1 truncate", titleProps?.className)}>
            {title}
          </p>
        )}
        {description && <p className={cn("text-muted-foreground", title && !inline && "mt-0.5", inline && "min-w-0 flex-1 truncate")}>{description}</p>}
        {actions && <div className={cn("flex flex-wrap gap-1.5", !inline && "mt-1.5", inline && "shrink-0")}>{actions}</div>}
      </div>
      {onClose && (
        // centred on the first line of text (16 px), the 20 px button reaching 2 px past it
        <CloseButton size="xs" label={closeLabel} onClick={onClose} {...closeProps} className={cn(!inline && "-my-0.5", closeProps?.className)} />
      )}
    </div>
  )
}

export { Announcement, type AnnouncementProps }
