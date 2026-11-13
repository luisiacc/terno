"use client"

import * as React from "react"
import { Autocomplete } from "@base-ui/react/autocomplete"
import { cn } from "cn"
import { t } from "@terno/i18n"

import { CloseButton } from "@terno/ui/components/close-button"
import { Input } from "@terno/ui/components/input"
import { Search } from "@terno/ui/icons"
import { FLOAT_INSET } from "../lib/float-inset"
import { MENU_GROUP, MENU_MOTION, MENU_PANEL } from "./menu-styles"

/**
 * BoardUI's Combobox (plan 203): a field that finds as you type, its results in the menu panel under it. On Base UI's
 * Autocomplete, whose value is the typed text: the caller ranks the results itself and passes them as `items`
 * (`mode="none"`: nothing is filtered here). The first result is highlighted as results come, so Enter opens it; a
 * choice keeps the query (Base UI would put the chosen item's text in the field). Focus stays in the field; the
 * results are a listbox it controls.
 *
 * Deviations (BOARDUI.md): the list may be wider than the field, its rows may run to several lines, and a search has
 * no toggle (with nothing typed there is nothing to show).
 */
function Combobox<Item>({
  value,
  onValueChange,
  ...props
}: Omit<Autocomplete.Root.Props<Item>, "mode" | "autoHighlight" | "value" | "onValueChange" | "items"> & {
  /** the results, already ranked: shown as given */
  items: readonly Item[]
  value: string
  onValueChange: (value: string) => void
}) {
  return (
    <Autocomplete.Root
      mode="none"
      autoHighlight
      value={value}
      onValueChange={(next, details) => {
        // a choice is the item's own (its click); the field keeps what was typed
        if (details.reason === "item-press") return
        onValueChange(next)
      }}
      {...props}
    />
  )
}

/**
 * The field: the search field's look (the glyph at the start, the round clear at the end once there's text). Esc with
 * the list closed empties it and goes no further; with nothing in it, Esc is the caller's (a dialog closes).
 */
function ComboboxInput({
  className,
  fieldClassName,
  clearLabel,
  onKeyDown,
  ref,
  ...props
}: Omit<Autocomplete.Input.Props, "className"> & {
  className?: string
  fieldClassName?: string
  clearLabel?: string
  ref?: React.Ref<HTMLInputElement>
}) {
  return (
    <div data-slot="combobox-field" className={cn("relative", className)}>
      <Search aria-hidden className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Autocomplete.Input
        ref={ref}
        render={<Input type="text" className={cn("ps-8 pe-8", fieldClassName)} />}
        onKeyDown={(e) => {
          onKeyDown?.(e)
          const input = e.currentTarget
          if (e.defaultPrevented || e.key !== "Escape" || e.nativeEvent.isComposing || input.getAttribute("aria-expanded") === "true" || !input.value) return
          // the list is closed: Base UI's own handler empties the field; the Esc goes no further (Settings stays open)
          e.stopPropagation()
        }}
        {...props}
      />
      <Autocomplete.Clear
        render={<CloseButton size="2xs" label={clearLabel ?? t("ui.search.clear")} />}
        tabIndex={-1}
        // focus stays in the field while the pointer clears it
        onMouseDown={(e) => e.preventDefault()}
        className="absolute end-2 top-1/2 -translate-y-1/2 data-[ending-style]:hidden"
      />
    </div>
  )
}

/** The results: the menu panel under the field, at its start, as wide as `className` makes it (at least the field). */
function ComboboxPopup({
  className,
  listClassName,
  children,
  sideOffset = 6,
  "aria-label": label,
  ...props
}: Autocomplete.Popup.Props & {
  listClassName?: string
  sideOffset?: number
  /** the listbox's name */
  "aria-label": string
}) {
  return (
    <Autocomplete.Portal>
      <Autocomplete.Positioner side="bottom" align="start" sideOffset={sideOffset} collisionPadding={FLOAT_INSET} className="isolate z-50">
        <Autocomplete.Popup
          data-slot="combobox-popup"
          className={cn("relative isolate z-50 min-w-(--anchor-width) max-h-[min(var(--available-height),26rem)] overscroll-contain", MENU_PANEL, MENU_MOTION, className)}
          {...props}
        >
          <Autocomplete.List aria-label={label} className={cn(MENU_GROUP, "empty:hidden", listClassName)}>
            {children}
          </Autocomplete.List>
        </Autocomplete.Popup>
      </Autocomplete.Positioner>
    </Autocomplete.Portal>
  )
}

/**
 * A result: a menu row, highlighted in the menu's neutral while the keyboard or the pointer is on it. Its content is
 * the caller's (any number of lines); `aria-labelledby` and `aria-describedby` point at its name and its details.
 */
function ComboboxItem({ className, ...props }: Autocomplete.Item.Props) {
  return (
    <Autocomplete.Item
      data-slot="combobox-item"
      className={cn(
        "relative flex w-full shrink-0 cursor-default items-start gap-2 rounded-md px-2 py-1.5 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className
      )}
      {...props}
    />
  )
}

/** Nothing matches: one quiet line in the panel. */
function ComboboxEmpty({ className, ...props }: Autocomplete.Empty.Props) {
  return <Autocomplete.Empty data-slot="combobox-empty" className={cn("px-2 py-1.5 text-sm text-muted-foreground empty:hidden", className)} {...props} />
}

export { Combobox, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxPopup }
