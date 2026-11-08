import { FLOAT_INSET } from "./float-inset"

/**
 * Plan 160: a scrolling list of rows never ends mid-row. Given the list's content height, its rows (from the content's
 * top, at the list's first scroll position), its bottom padding and the most it may take: the height that ends on the
 * last row that fits whole (its padding after it, short of where the next row starts: a row must not peek into it), or
 * null when everything fits.
 */
export function wholeRowsHeight(content: number, rows: readonly { top: number; bottom: number }[], padBottom: number, limit: number): number | null {
  if (content <= limit) return null
  let best = 0
  for (const r of rows) {
    let next = Infinity
    for (const o of rows) if (o.top >= r.bottom && o.top < next) next = o.top
    const h = Math.min(r.bottom + padBottom, next)
    if (h <= limit && h > best) best = h
  }
  return best > 0 ? best : Math.max(0, limit)
}

/** How far down from `to` an element sits, through its offset parents (transforms, an opening zoom, don't count) */
function offsetWithin(el: HTMLElement, to: HTMLElement): number {
  let y = 0
  for (let at: HTMLElement | null = el; at && at !== to; at = at.offsetParent as HTMLElement | null) y += at.offsetTop
  return y
}

/**
 * Fits a list in a fixed panel (the palette): no taller than its own maximum, nor than leaves --float-inset under the
 * panel, and ending on a whole row; `data-more` while rows wait below (the list must be its rows' offset parent).
 */
export function fitWholeRows(list: HTMLElement, rows: string): void {
  list.style.maxHeight = ""
  const panel = list.closest<HTMLElement>("[role=dialog]")
  const style = getComputedStyle(list)
  const cap = parseFloat(style.maxHeight) || Infinity
  const top = panel ? parseFloat(getComputedStyle(panel).top) + list.offsetTop : list.getBoundingClientRect().top
  const below = panel ? panel.offsetHeight - list.offsetTop - list.offsetHeight : 0
  const limit = Math.min(cap, innerHeight - FLOAT_INSET - below - top)
  const spans = [...list.querySelectorAll<HTMLElement>(rows)].map((r) => {
    const top = offsetWithin(r, list)
    return { top, bottom: top + r.offsetHeight }
  })
  const height = wholeRowsHeight(list.scrollHeight, spans, parseFloat(style.paddingBottom) || 0, limit)
  if (height !== null) list.style.maxHeight = `${height}px`
  markMore(list)
}

/** Rows below what shows: the list says so (a fade at its foot) */
export function markMore(list: HTMLElement): void {
  list.toggleAttribute("data-more", list.scrollTop + list.clientHeight < list.scrollHeight - 1)
}
