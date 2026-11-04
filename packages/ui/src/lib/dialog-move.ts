import * as React from "react"

/** Offset from the middle of the window, where a dialog opens. */
export interface Spot {
  x: number
  y: number
}

interface Box {
  width: number
  height: number
}

/** Sideways and above the window's bottom, this much stays in view: enough to grab it again. */
const KEEP_X = 120
const KEEP_BOTTOM = 48
/** Less than this is a click that shook. */
const SLOP = 3
/** A control brought back into view clears the window's edge by this much. */
const FOCUS_MARGIN = 8
/** Inside a handle, these keep their press. */
const CONTROL = "button, a, input, textarea, select, label, [role=button], [role=tab], [contenteditable], [tabindex]"
const HANDLE = "[data-slot=dialog-header], [data-dialog-handle]"

/** For the session, as a Mac window keeps its place; outlives a closed dialog and the language switch's remount. */
const spots = new Map<string, Spot>()

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

/**
 * Partly off-screen is fine: the point is to see past it, and a window barely wider than the dialog couldn't otherwise
 * move it at all. Its top edge stays in the window, so the title it is dragged by can't be lost above it.
 */
export function clampSpot(spot: Spot, size: Box, viewport: Box): Spot {
  return {
    x: clamp(spot.x, KEEP_X - (viewport.width + size.width) / 2, (viewport.width + size.width) / 2 - KEEP_X),
    y: clamp(spot.y, (size.height - viewport.height) / 2, (viewport.height + size.height) / 2 - KEEP_BOTTOM),
  }
}

/** Over the popup's centring, in `translate`: the entrance and exit animate `transform`, so they leave it alone. */
const translateOf = (spot: Spot) => `calc(-50% + ${spot.x}px) calc(-50% + ${spot.y}px)`
const sizeOf = (el: HTMLElement): Box => ({ width: el.offsetWidth, height: el.offsetHeight })
const windowBox = (): Box => ({ width: window.innerWidth, height: window.innerHeight })

/** The dialog's margin, a header or a marked region, short of the controls in them. React bubbles a portalled child's press here too: `contains` turns those away. */
function isHandle(popup: HTMLElement, target: EventTarget, clientX: number, clientY: number): boolean {
  if (!(target instanceof Element) || !popup.contains(target)) return false
  if (target === popup) {
    // a sheet that scrolls itself: its scrollbar is the popup too
    const box = popup.getBoundingClientRect()
    return clientX - box.left < popup.clientLeft + popup.clientWidth && clientY - box.top < popup.clientTop + popup.clientHeight
  }
  if (!target.closest(HANDLE)) return false
  const control = target.closest(CONTROL)
  return !control || control === popup
}

/**
 * Plan 129: a dialog the user can drag aside to see what's behind it. Mounted with the popup, so each opening reads the
 * remembered spot. A drag writes the element directly: no render per move, and no layout.
 */
export function useDialogMove(id: string | undefined) {
  const [spot, setSpot] = React.useState(() => (id ? spots.get(id) ?? null : null))
  const [moving, setMoving] = React.useState(false)
  const [element, setElement] = React.useState<HTMLElement | null>(null)

  const commit = React.useCallback((next: Spot | null) => {
    if (id && next) spots.set(id, next)
    else if (id) spots.delete(id)
    setSpot(next)
  }, [id])

  // before the first paint too: the window may have shrunk while it was closed
  React.useLayoutEffect(() => {
    if (!element || !spot || moving) return
    const fit = () => {
      const next = clampSpot(spot, sizeOf(element), windowBox())
      if (next.x !== spot.x || next.y !== spot.y) commit(next)
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(element)
    window.addEventListener("resize", fit)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", fit)
    }
  }, [element, spot, moving, commit])

  if (!id) return { moved: false, props: {} }

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    const popup = e.currentTarget
    if (e.button !== 0 || e.ctrlKey || e.pointerType === "touch" || !isHandle(popup, e.target, e.clientX, e.clientY)) return
    const from = spot ?? { x: 0, y: 0 }
    const [startX, startY] = [e.clientX, e.clientY]
    let last: Spot | null = null
    // captured from the press, so a release past the popup isn't a press outside it and a mail frame can't take the pointer
    popup.setPointerCapture(e.pointerId)
    const onMove = (move: PointerEvent) => {
      const [dx, dy] = [move.clientX - startX, move.clientY - startY]
      if (!last && Math.hypot(dx, dy) < SLOP) return
      if (!last) setMoving(true)
      last = clampSpot({ x: from.x + dx, y: from.y + dy }, sizeOf(popup), windowBox())
      popup.style.translate = translateOf(last)
      spots.set(id, last)
    }
    popup.addEventListener("pointermove", onMove)
    // the one way a drag ends: release, cancel and a lost capture all land here
    popup.addEventListener("lostpointercapture", () => {
      popup.removeEventListener("pointermove", onMove)
      if (!last) return
      setSpot(last)
      setMoving(false)
    }, { once: true })
  }

  return {
    moved: spot !== null || moving,
    props: {
      ref: setElement,
      "data-movable": "",
      "data-moving": moving ? "" : undefined,
      style: spot ? { translate: translateOf(spot) } : undefined,
      onPointerDown,
      // a focused field keeps its focus and caret through a drag, and no selection starts
      onMouseDown: (e: React.MouseEvent<HTMLElement>) => {
        if (isHandle(e.currentTarget, e.target, e.clientX, e.clientY)) e.preventDefault()
      },
      onDoubleClick: (e: React.MouseEvent<HTMLElement>) => {
        if (isHandle(e.currentTarget, e.target, e.clientX, e.clientY)) commit(null)
      },
      // the Tab key can reach a control pushed past the window's edge: show it, moving no further than that takes
      onFocus: (e: React.FocusEvent<HTMLElement>) => {
        const [popup, target] = [e.currentTarget, e.target]
        if (!spot || target === popup || !popup.contains(target) || !target.matches(":focus-visible")) return
        const box = target.getBoundingClientRect()
        const view = windowBox()
        const dx = box.left < 0 ? FOCUS_MARGIN - box.left : box.right > view.width ? view.width - FOCUS_MARGIN - box.right : 0
        const dy = box.top < 0 ? FOCUS_MARGIN - box.top : box.bottom > view.height ? view.height - FOCUS_MARGIN - box.bottom : 0
        if (dx || dy) commit(clampSpot({ x: spot.x + dx, y: spot.y + dy }, sizeOf(popup), view))
      },
    },
  }
}
