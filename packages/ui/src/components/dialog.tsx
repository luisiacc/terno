import * as React from "react"
import { ModalHostPopup } from "@terno/ui/components/modal-host"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { cn } from "cn"
import { t } from "@terno/i18n"

import { Button } from "@terno/ui/components/button"
import { CloseButton } from "@terno/ui/components/close-button"
import { useDialogMove } from "@terno/ui/lib/dialog-move"

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        // moved aside (plan 129), the app shows its real colors: the backdrop stays, and still catches a click
        "fixed inset-0 isolate z-50 bg-overlay transition-[background-color] duration-base data-moved:bg-transparent data-closed:duration-fast data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

/**
 * BoardUI's modal (plan 125): one surface at a 24 px inset, the title, a muted description 4 px under it, the body,
 * and the actions as a plain row at the end (no band). The close is the round CloseButton at the top end, centred on
 * the title's first line; DialogHeader leaves it room. A sheet with an inset of its own (p-0) places it with
 * `closeClassName`.
 */
function DialogContent(props: DialogSurfaceProps) {
  return (
    <DialogPortal>
      <DialogSurface {...props} />
    </DialogPortal>
  )
}

type DialogSurfaceProps = DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean
  closeClassName?: string
  /** Plan 129: the user can drag it aside, and it stays there for the session under this id. Its margin and DialogHeader are the handles; mark others `data-dialog-handle`. */
  movable?: string
}

/** Inside the portal, so it mounts with each opening (a dialog's host may stay mounted between them). */
function DialogSurface({
  className,
  children,
  showCloseButton = true,
  closeClassName,
  movable,
  ...props
}: DialogSurfaceProps) {
  const move = useDialogMove(movable)
  return (
    <>
      <DialogOverlay data-moved={move.moved ? "" : undefined} />
      <DialogPrimitive.Popup
        render={(elementProps, state) => <ModalHostPopup open={state.open} elementProps={elementProps} />}
        data-slot="dialog-content"
        data-close={showCloseButton || undefined}
        className={cn(
          "group/dialog fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-2xl bg-popover p-6 text-sm text-popover-foreground shadow-modal duration-slow ease-drawer data-closed:duration-fast data-closed:ease-exit outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.98] data-closed:animate-out data-closed:fade-out-0",
          className
        )}
        {...props}
        {...move.props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={
              <CloseButton
                size="sm"
                // the 24 px inset, then down to the middle of the title's first line
                className={cn("absolute end-6 top-[calc(var(--spacing)*6+(var(--text-lg--line-height)-var(--spacing)*6)/2)]", closeClassName)}
              />
            }
          />
        )}
      </DialogPrimitive.Popup>
    </>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      // the close's width and the gap before it, when there is one
      className={cn("flex flex-col gap-1 group-data-close/dialog:pe-8", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        // a plain row of actions at the end, stacked on phones with the main one on top (no band: plan 125)
        "mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          {t("common.close")}
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "font-heading text-lg font-medium",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
