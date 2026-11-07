/**
 * BoardUI's menu recipe (plan 125, its menu-styles.ts), shared by the dropdown, the context menu and the select: they
 * keep their own Base UI semantics (actions, a value) and draw the same panel and rows.
 */

/** The panel (plan 118): solid, a 1 px edge, rows highlighted in the neutral muted, not the accent; rows 2 px apart */
export const MENU_PANEL =
  "flex max-h-(--available-height) origin-(--transform-origin) flex-col gap-0.5 overflow-x-hidden overflow-y-auto rounded-menu bg-popover p-1.5 text-popover-foreground shadow-menu outline-none [--accent:var(--menu-highlight)] [--accent-foreground:var(--foreground)]"

/** Opening and closing: a small spring in, a quick fade out */
export const MENU_MOTION =
  "duration-base ease-spring data-closed:duration-fast data-closed:ease-exit data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.97] data-closed:animate-out data-closed:overflow-hidden data-closed:fade-out-0"

/** A group of rows keeps the panel's rhythm */
export const MENU_GROUP = "flex flex-col gap-0.5"

/**
 * A row: medium weight, its icon 8 px from the label and muted until the row is highlighted. Unavailable, its text
 * goes muted (no opacity). 28 px, as dense as a native menu (plan 158: thirteen rows at 32 px ran to the window's foot), and md corners (concentric with the panel's, plan 119).
 */
export const MENU_ROW =
  "relative flex h-7 shrink-0 cursor-default items-center gap-2 rounded-md px-2 text-sm font-medium outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-inset:ps-[calc(1rem+1.15em)] data-disabled:pointer-events-none data-disabled:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[1.15em] [&_svg:not([class*='text-'])]:text-muted-foreground focus:[&_svg:not([class*='text-'])]:text-accent-foreground"

/**
 * A panel with a submenu keeps a chevron's column on every row, so the shortcuts form one column and the chevrons
 * another (the row's end padding, plus the chevron, plus the gap before it)
 */
export const MENU_CHEVRON_COLUMN = "[&:has(>[data-slot=context-menu-sub-trigger])>[data-slot=context-menu-item]]:pe-[calc(1rem+1.15em)]"

/**
 * A destructive row: red text; highlighted, the red's wash (plan 125 review: red on the neutral highlight fails AA in
 * six palettes, a deviation from BoardUI)
 */
export const MENU_ROW_DESTRUCTIVE =
  "data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:[&_svg:not([class*='text-'])]:text-destructive"

/** The same on a row whose submenu is open */
export const MENU_ROW_DESTRUCTIVE_OPEN =
  "data-[variant=destructive]:data-popup-open:bg-destructive/10 data-[variant=destructive]:data-popup-open:text-destructive dark:data-[variant=destructive]:data-popup-open:bg-destructive/20 data-[variant=destructive]:data-popup-open:[&_svg:not([class*='text-'])]:text-destructive"

/** A row with a check or radio mark at its end, the mark in the primary */
export const MENU_ROW_CHECKABLE = "pe-8"
export const MENU_INDICATOR = "pointer-events-none absolute end-2 flex items-center justify-center"
export const MENU_MARK = "text-primary"

/** A group's heading: muted body text on the rows' text line */
export const MENU_LABEL = "flex h-7 shrink-0 items-center px-2 text-sm font-medium text-muted-foreground data-inset:ps-[calc(1rem+1.15em)]"

/** A separator runs to the panel's edges (through its p-1.5) */
export const MENU_SEPARATOR = "-mx-1.5 my-1 h-(--hairline-w) shrink-0 bg-hairline"

/** A row's shortcut: plain muted text at its end */
export const MENU_SHORTCUT = "ms-auto ps-3 text-sm font-normal text-muted-foreground"

/** The submenu opens 4 px from its panel (the row sits 6 px in), its first row level with the one that opened it */
export const SUBMENU_SIDE_OFFSET = 10
export const SUBMENU_ALIGN_OFFSET = -6
