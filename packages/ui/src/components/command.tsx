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
import { keyLabel, Shortcut } from "@terno/ui/components/shortcut"
import { Search as SearchIcon, Check as CheckIcon } from "@terno/ui/icons"

/*
 * BoardUI's command palette (plan 125): a search row over a full-width divider, a list of 32 px medium rows (Terno's, plan 158: more of a long list in view) 2 px apart
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
  finalFocus,
  ...props
}: Omit<React.ComponentProps<typeof Dialog>, "children"> & {
  /** where focus goes on closing (the popup's own option): by default, back where it was */
  finalFocus?: React.ComponentProps<typeof DialogContent>["finalFocus"]
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
          // in dark a scrim can't darken a near-black window much: the panel's own edge says where it ends (plan 158)
          "top-[18%] translate-y-0 gap-0 overflow-hidden rounded-palette! p-0 sm:max-w-[640px] dark:shadow-[0_0_0_var(--hairline-w)_var(--control-edge-hover),0_24px_64px_-24px_var(--shadow-color)]",
          className
        )}
        showCloseButton={showCloseButton}
        finalFocus={finalFocus}
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

/** One hint: its keys (`keyLabel` names) and what they do here. */
type CommandHint = { keys: readonly string[]; label: string }

/**
 * BoardUI's hint row: how to move, choose and leave, in muted text with the keys as keycaps. A page whose keys differ
 * says its own (`hints`), and may end the row with a few quiet controls of its own (`end`).
 */
function CommandHints({ className, hints, end, ...props }: React.ComponentProps<"div"> & { hints?: readonly CommandHint[]; end?: React.ReactNode }) {
  const shown = hints ?? [
    { keys: ["arrowup", "arrowdown"], label: t("ui.command.navigate") },
    { keys: ["enter"], label: t("ui.command.select") },
    { keys: ["escape"], label: t("ui.command.close") },
  ]
  return (
    <div
      data-slot="command-hints"
      className={cn("hairline-t flex shrink-0 items-center gap-4 px-5 py-2 text-sm text-muted-foreground", className)}
      {...props}
    >
      {shown.map((h) => (
        <span key={h.label} data-slot="command-hint" className="flex items-center gap-1.5">
          {h.keys.length > 1 ? (
            <KbdGroup>
              {h.keys.map((k) => <Kbd key={k}>{keyLabel(k)}</Kbd>)}
            </KbdGroup>
          ) : (
            <Kbd>{keyLabel(h.keys[0]!)}</Kbd>
          )}
          {h.label}
        </span>
      ))}
      {end && <span className="ms-auto flex items-center gap-1">{end}</span>}
    </div>
  )
}

function CommandInput({
  className,
  addon,
  end,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input> & {
  /** before the text, after the search icon (a page's name in the palette) */
  addon?: React.ReactNode
  /** after the text: a page's own way back and close */
  end?: React.ReactNode
}) {
  return (
    <div data-slot="command-input-wrapper" className="hairline-b px-2">
      <InputGroup className="h-11! rounded-none! border-0! bg-transparent! shadow-none! *:data-[slot=input-group-addon]:pl-3!">
        <CommandPrimitive.Input
          data-slot="command-input"
          className={cn(
            "w-full text-md font-medium outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:text-muted-foreground",
            className
          )}
          {...props}
        />
        <InputGroupAddon>
          <SearchIcon className="size-5 shrink-0 text-muted-foreground" />
          {addon}
        </InputGroupAddon>
        {end && <InputGroupAddon align="inline-end">{end}</InputGroupAddon>}
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

/**
 * The chosen row's fill is its own token, `--command-selected` (a palette's to set; the panel's --accent until then).
 * `data-variant="destructive"`: red, as a menu's Delete (MENU_ROW_DESTRUCTIVE), chosen on the red's wash.
 */
function CommandItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "group/command-item relative flex h-8 cursor-default items-center gap-2 rounded-(--command-radius) px-3 text-sm font-medium outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:text-muted-foreground data-selected:bg-[var(--command-selected,var(--accent))] data-selected:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:data-selected:bg-destructive/10 data-[variant=destructive]:data-selected:text-destructive dark:data-[variant=destructive]:data-selected:bg-destructive/20 data-[variant=destructive]:[&_svg:not([class*='text-'])]:text-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[1.15em] [&_svg:not([class*='text-'])]:text-muted-foreground",
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

/** A row's shortcut, drawn as every shortcut is (Shortcut: a keycap per press); on the chosen row, in full ink (contrast.ts) */
function CommandShortcut({
  keys,
  className,
  children,
  ...props
}: React.ComponentProps<"kbd"> & { keys?: string }) {
  if (keys) return <span data-slot="command-shortcut" className={cn("ms-auto inline-flex group-data-selected/command-item:[&_kbd]:text-foreground", className)}><Shortcut keys={keys} /></span>
  return (
    <Kbd
      data-slot="command-shortcut"
      className={cn("ms-auto group-data-selected/command-item:text-foreground", className)}
      {...props}
    >
      {children}
    </Kbd>
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
