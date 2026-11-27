"use client"

import * as React from "react"
import { Combobox } from "@base-ui/react/combobox"
import { cn } from "cn"

import { Input } from "@terno/ui/components/input"
import { ChevronDown } from "@terno/ui/icons"
import { FLOAT_INSET } from "../lib/float-inset"
import { MENU_PANEL, MENU_MOTION } from "./menu-styles"

/**
 * BoardUI's Combobox, as a picker (plan 248): a field that shows the value and finds as you type, its choices in the
 * menu panel under it. On Base UI's Combobox (the search form, combobox.tsx, is its Autocomplete): one value, chosen
 * by Enter or a click; the list opens on the chosen one, so the arrows go on from it. The caller filters and ranks
 * (`filteredItems`) and may virtualize (`virtualized`, rows placed by the caller with their `index`).
 *
 * Deviations (BOARDUI.md): a chevron at the end opens it like a select; the list may be wider than the field.
 */
function ComboboxPicker<Item>(props: Combobox.Root.Props<Item, false>) {
  return <Combobox.Root<Item, false> autoHighlight {...props} />
}

/**
 * The field: the text field's look, a chevron at its end that opens the list too. Focused, its text is selected, so
 * typing replaces the value's name rather than adding to it.
 */
function ComboboxPickerInput({
  className,
  fieldClassName,
  onFocus,
  onMouseUp,
  ref,
  ...props
}: Omit<Combobox.Input.Props, "className"> & {
  className?: string
  fieldClassName?: string
  ref?: React.Ref<HTMLInputElement>
}) {
  /** the click that focused it: its mouseup would put a caret in the selection */
  const focusing = React.useRef(false)
  return (
    <div data-slot="combobox-picker-field" className={cn("relative", className)}>
      <Combobox.Input
        ref={ref}
        render={<Input type="text" className={cn("pe-8", fieldClassName)} />}
        onFocus={(e) => {
          onFocus?.(e)
          e.currentTarget.select()
          focusing.current = true
        }}
        onMouseUp={(e) => {
          onMouseUp?.(e)
          if (focusing.current) e.preventDefault()
          focusing.current = false
        }}
        {...props}
      />
      <Combobox.Trigger
        data-slot="combobox-picker-trigger"
        tabIndex={-1}
        aria-hidden
        // focus stays in the field while the pointer opens the list
        onMouseDown={(e) => e.preventDefault()}
        className="absolute end-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground"
      >
        <ChevronDown className="size-3.5" />
      </Combobox.Trigger>
    </div>
  )
}

/**
 * The choices: the menu panel under the field, at its start, at least as wide. `ref` is its scroll box (what a
 * virtualizer measures); `children` go in the listbox.
 */
function ComboboxPickerPopup({
  className,
  listClassName,
  children,
  sideOffset = 6,
  "aria-label": label,
  ref,
  ...props
}: Combobox.Popup.Props & {
  listClassName?: string
  sideOffset?: number
  /** the listbox's name */
  "aria-label": string
  ref?: React.Ref<HTMLDivElement>
}) {
  return (
    <Combobox.Portal>
      <Combobox.Positioner side="bottom" align="start" sideOffset={sideOffset} collisionPadding={FLOAT_INSET} className="isolate z-50">
        <Combobox.Popup
          ref={ref}
          data-slot="combobox-picker-popup"
          className={cn("relative isolate z-50 min-w-(--anchor-width) max-h-[min(var(--available-height),20rem)] overscroll-contain", MENU_PANEL, MENU_MOTION, className)}
          {...props}
        >
          <Combobox.List aria-label={label} className={cn("relative", listClassName)}>
            {children}
          </Combobox.List>
        </Combobox.Popup>
      </Combobox.Positioner>
    </Combobox.Portal>
  )
}

/** A choice: a menu row, highlighted in the menu's neutral while the keyboard or the pointer is on it. */
function ComboboxPickerItem({ className, ...props }: Combobox.Item.Props) {
  return (
    <Combobox.Item
      data-slot="combobox-picker-item"
      className={cn(
        "flex h-8 w-full cursor-default items-center gap-2 rounded-md px-2 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-selected:font-medium",
        className
      )}
      {...props}
    />
  )
}

/** Nothing matches: one quiet line in the panel. */
function ComboboxPickerEmpty({ className, ...props }: Combobox.Empty.Props) {
  return <Combobox.Empty data-slot="combobox-picker-empty" className={cn("px-2 py-1.5 text-sm text-muted-foreground empty:hidden", className)} {...props} />
}

export { ComboboxPicker, ComboboxPickerEmpty, ComboboxPickerInput, ComboboxPickerItem, ComboboxPickerPopup }
