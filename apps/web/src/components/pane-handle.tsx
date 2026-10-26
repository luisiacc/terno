import { t } from "@terno/i18n";
import { cn } from "@terno/ui/lib/utils";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDesign } from "~/lib/design";
import { clampWidth, commitWidth, keyWidth, LIMITS, maxWidth, previewWidth, usePanes, type Pane } from "~/lib/panes";

/** the element whose width each handle sets (and names in aria-controls) */
const PANE_ID: Record<Pane, string> = { sidebar: "app-sidebar", list: "app-list" };
const widthOf = (id: string): number => document.getElementById(id)?.getBoundingClientRect().width ?? 0;
/** the pane's width now and the widest it may be in this window */
const measure = (pane: Pane, readerMin: number) => ({ now: Math.round(widthOf(PANE_ID[pane])), max: maxWidth(pane, innerWidth, widthOf(PANE_ID.sidebar), readerMin) });

interface Drag {
  pointer: number;
  x: number;
  start: number;
  /** what was stored before (Esc puts it back) */
  stored: number | null;
  /** the sidebar's width, fixed while the list's edge moves */
  sidebar: number;
  next: number;
  moved: boolean;
  frame: number;
  stop: () => void;
}

/**
 * A pane's right edge (plan 21): a hairline that shows on hover, a separator
 * for the keyboard (← → by 16 px, Shift by 64, Home, End, Enter resets).
 * Dragging writes the width to a CSS variable once a frame and commits it on
 * release, so nothing renders while it moves (the list included); a
 * double-click goes back to the design's width. Only this handle renders
 * when a pane's width changes (its aria values).
 */
export function PaneHandle({ pane }: { pane: Pane }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [m, setM] = useState(() => ({ now: 0, max: LIMITS[pane].max }));
  const readerMin = useDesign().layout.readerMin;

  useLayoutEffect(() => {
    const read = () => {
      const next = measure(pane, readerMin);
      setM((p) => (p.now === next.now && p.max === next.max ? p : next));
    };
    read();
    const ro = new ResizeObserver(read);
    const list = document.getElementById(PANE_ID.list);
    // the panes, and the window (the grid): the max follows it while the panes keep their widths
    for (const el of [document.getElementById(PANE_ID.sidebar), list, list?.parentElement]) if (el) ro.observe(el);
    return () => ro.disconnect();
  }, [pane, readerMin]);

  const end = (commit: boolean) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    cancelAnimationFrame(d.frame);
    d.stop();
    if (ref.current) {
      delete ref.current.dataset.dragging;
      if (ref.current.hasPointerCapture(d.pointer)) ref.current.releasePointerCapture(d.pointer);
    }
    delete document.documentElement.dataset.resizing;
    // a click (or a double-click's two) that didn't move stores nothing
    if (commit && d.moved) commitWidth(pane, d.next);
    else previewWidth(pane, d.stored);
  };

  // unmounted mid-drag (a crash boundary resetting): nothing left behind on <html> or the window
  useEffect(() => () => end(false), []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // one pointer drives a drag: a second finger (not primary) neither starts nor ends one
    if (e.button !== 0 || !e.isPrimary || drag.current) return;
    e.preventDefault();
    const el = e.currentTarget;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer is already gone: the drag ends with its up, or Esc */
    }
    // Esc puts the width back and does nothing else (captured on the window, before any shortcut sees it);
    // leaving the window mid-drag puts it back too
    const onKey = (k: KeyboardEvent) => {
      if (k.key !== "Escape") return;
      k.preventDefault();
      k.stopImmediatePropagation();
      end(false);
    };
    const onBlur = () => end(false);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    const start = Math.round(widthOf(PANE_ID[pane]));
    drag.current = {
      pointer: e.pointerId,
      x: e.clientX,
      start,
      stored: usePanes.getState()[pane],
      sidebar: widthOf(PANE_ID.sidebar),
      next: start,
      moved: false,
      frame: 0,
      stop: () => {
        window.removeEventListener("keydown", onKey, true);
        window.removeEventListener("blur", onBlur);
      },
    };
    el.dataset.dragging = "";
    document.documentElement.dataset.resizing = "";
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    const next = clampWidth(pane, d.start + e.clientX - d.x, innerWidth, d.sidebar, readerMin);
    if (next === d.next) return;
    d.next = next;
    d.moved = true;
    // one write a frame, however fast the pointer reports
    d.frame ||= requestAnimationFrame(() => {
      d.frame = 0;
      previewWidth(pane, d.next);
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey || drag.current) return;
    const now = measure(pane, readerMin);
    const next = keyWidth(e.key, e.shiftKey, now.now, now.max, pane);
    if (next === null) return;
    // the window's shortcuts skip a handled key (keyboard.ts: defaultPrevented)
    e.preventDefault();
    commitWidth(pane, next === "reset" ? null : clampWidth(pane, next, innerWidth, widthOf(PANE_ID.sidebar), readerMin));
  };

  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation="vertical"
      aria-label={pane === "sidebar" ? t("panes.resizeSidebar") : t("panes.resizeList")}
      aria-controls={PANE_ID[pane]}
      aria-valuenow={m.now}
      aria-valuemin={LIMITS[pane].min}
      aria-valuemax={m.max}
      tabIndex={0}
      data-testid={`pane-handle-${pane}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => e.pointerId === drag.current?.pointer && end(true)}
      onPointerCancel={(e) => e.pointerId === drag.current?.pointer && end(true)}
      onLostPointerCapture={(e) => e.pointerId === drag.current?.pointer && end(true)}
      onDoubleClick={() => commitWidth(pane, null)}
      onKeyDown={onKeyDown}
      className={cn("group/handle no-drag absolute inset-y-0 z-20 w-2 cursor-col-resize touch-none outline-none", pane === "sidebar" ? "-left-1" : "-right-1")}
    >
      <span className="pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-ring opacity-0 transition-opacity duration-fast group-hover/handle:opacity-50 group-focus-visible/handle:opacity-100 group-data-dragging/handle:opacity-100" />
    </div>
  );
}
