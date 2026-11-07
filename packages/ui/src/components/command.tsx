import * as React from "react"
import { Command as CommandPrimitive } from "cmdk"
import { cn } from "cn"
import { t } from "@terno/i18n"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@terno/ui/components/dialog"
import {
  InputGroup,
  InputGroupAddon,
} from "@terno/ui/components/input-group"
import { Kbd, KbdGroup } from "@terno/ui/components/kbd"
import { keyLabel } from "@terno/ui/components/shortcut"
import { Search as SearchIcon, Check as CheckIcon } from "@terno/ui/icons"

/*
 * BoardUI's command palette (plan 125): a search row over a full-width divider, a list of 36 px medium rows 2 px apart
 * at an 8 px inset (their --command-radius corners concentric with the panel's rounded-palette), muted section headings, and a hint
 * row. Everything sits on one line 20 px in: the search glyph, the rows' icons, the headings and the hints. Terno keeps
 * its width and placement (640 px at 18%): long subjects need the room.
 */
function Command({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "flex size-full flex-col overflow-hidden rounded-palette! bg-popover text-popover-foreground [--accent:var(--menu-highlight)] [--accent-foreground:var(--foreground)]",
        className
      )}
      {...props}
    />
  )
}

function CommandDialog({
  title = t("ui.command.title"),
  description = t("ui.command.description"),
  children,
  className,
  showCloseButton = false,
  hints = true,
  ...props
}: Omit<React.ComponentProps<typeof Dialog>, "children"> & {
  title?: string
  description?: string
  className?: string
  showCloseButton?: boolean
  /** the row of keyboard hints under the list */
  hints?: boolean
  children: React.ReactNode
}) {
  return (
    <Dialog {...props}>
      <DialogContent
        className={cn(
          "top-[18%] translate-y-0 gap-0 overflow-hidden rounded-palette! p-0 sm:max-w-[640px]",
          className
        )}
        showCloseButton={showCloseButton}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        {hints && <CommandHints />}
      </DialogContent>
    </Dialog>
  )
}

/** BoardUI's hint row: how to move, choose and leave, in muted text with the keys as keycaps */
function CommandHints({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="command-hints"
      className={cn("hairline-t flex shrink-0 items-center gap-4 px-5 py-2 text-sm text-muted-foreground", className)}
      {...props}
    >
      <span className="flex items-center gap-1.5">
        <KbdGroup>
          <Kbd>{keyLabel("arrowup")}</Kbd>
          <Kbd>{keyLabel("arrowdown")}</Kbd>
        </KbdGroup>
        {t("ui.command.navigate")}
      </span>
      <span className="flex items-center gap-1.5">
        <Kbd>{keyLabel("enter")}</Kbd>
        {t("ui.command.select")}
      </span>
      <span className="flex items-center gap-1.5">
        <Kbd>{keyLabel("escape")}</Kbd>
        {t("ui.command.close")}
      </span>
    </div>
  )
}

function CommandInput({
  className,
  addon,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input> & {
  /** before the text, after the search icon (a page's name in the palette) */
  addon?: React.ReactNode
}) {
  return (
    <div data-slot="command-input-wrapper" className="hairline-b px-2">
      <InputGroup className="h-11! rounded-none! border-0! bg-transparent! shadow-none! *:data-[slot=input-group-addon]:pl-3!">
        <CommandPrimitive.Input
          data-slot="command-input"
          className={cn(
            "w-full text-sm font-medium outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:text-muted-foreground",
            className
          )}
          {...props}
        />
        <InputGroupAddon>
          <SearchIcon className="size-5 shrink-0 text-muted-foreground" />
          {addon}
        </InputGroupAddon>
      </InputGroup>
    </div>
  )
}

function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        "no-scrollbar max-h-96 scroll-pt-9 scroll-pb-2 overflow-x-hidden overflow-y-auto p-2 outline-none",
        className
      )}
      {...props}
    />
  )
}

function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn("flex min-h-32 items-center justify-center px-4 text-center text-sm font-medium text-muted-foreground", className)}
      {...props}
    />
  )
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        // the heading stays while its rows scroll: without it "Spam" under Go to reads like the action
        "text-foreground not-first:pt-2 **:[[cmdk-group-items]]:flex **:[[cmdk-group-items]]:flex-col **:[[cmdk-group-items]]:gap-0.5 **:[[cmdk-group-heading]]:sticky **:[[cmdk-group-heading]]:-top-2 **:[[cmdk-group-heading]]:z-10 **:[[cmdk-group-heading]]:bg-popover **:[[cmdk-group-heading]]:px-3 **:[[cmdk-group-heading]]:pt-2 **:[[cmdk-group-heading]]:pb-1 **:[[cmdk-group-heading]]:text-xs **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("-mx-2 my-1 h-(--hairline-w) bg-hairline", className)}
      {...props}
    />
  )
}

/** The chosen row's fill is its own token, `--command-selected` (a palette's to set; the panel's --accent until then) */
function CommandItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "group/command-item relative flex h-9 cursor-default items-center gap-2 rounded-(--command-radius) px-3 text-sm font-medium outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:text-muted-foreground data-selected:bg-[var(--command-selected,var(--accent))] data-selected:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[1.15em] [&_svg:not([class*='text-'])]:text-muted-foreground",
        className
      )}
      {...props}
    >
      {children}
      <CheckIcon className="ml-auto opacity-0 group-has-data-[slot=command-shortcut]/command-item:hidden group-has-data-[slot=command-hint]/command-item:hidden group-data-[checked=true]/command-item:opacity-100" />
    </CommandPrimitive.Item>
  )
}

/** Muted text at a row's end: the section or a path, what the command acts on */
function CommandDescription({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-hint"
      className={cn("ms-auto truncate ps-3 font-normal text-muted-foreground", className)}
      {...props}
    />
  )
}

/** A row's shortcut, one keycap for the chord; on the chosen row, in full ink (contrast.ts) */
function CommandShortcut({
  className,
  ...props
}: React.ComponentProps<"kbd">) {
  return (
    <Kbd
      data-slot="command-shortcut"
      className={cn("ms-auto group-data-selected/command-item:text-foreground", className)}
      {...props}
    />
  )
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandDescription,
  CommandHints,
  CommandShortcut,
  CommandSeparator,
}
