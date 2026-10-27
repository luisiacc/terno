/**
 * Binds the drag controller to the DOM: one delegated pointerdown on the
 * listbox (it stays mounted while rows virtualize away) and pointer capture on
 * it once the drag starts; the ghost moves imperatively in rAF; targets are
 * the sidebar's [data-drop-target] items, measured at drag start. A drop is
 * an exclusive move (the threads end up in that category only). During a
 * drag no row renders: the dimming is a keyed CSS rule (lib/flash.ts) and only
 * the two NavItems whose state changes re-render.
 */
import { formatNumber, t } from "@terno/i18n";
import { motionMs } from "~/lib/appearance";
import { isExclusivelyIn, moveToCategory } from "~/lib/categorize";
import { DragController, newIds, payloadFor, type PointerLike, type TargetRect } from "~/lib/drag";
import { dimRows, flashDrop } from "~/lib/flash";
import { getApp } from "~/state/app";
import { useDrag } from "~/state/drag";
import { useList } from "~/state/list";

const GHOST_OFFSET = { x: 12, y: 8 };
/** The sidebar scrolls while the pointer is this close to its top or bottom edge. */
const EDGE = 24;
const PROBE = !!import.meta.env.VITE_RENDER_PROBE;

let ghost: HTMLElement | null = null;
export function registerGhost(el: HTMLElement | null): void {
  ghost = el;
}

const html = () => document.documentElement;
const row = (id: number) => {
  const { items, index } = useList.getState();
  return items[index.get(id) ?? -1];
};
const scroller = () => document.querySelector<HTMLElement>("[data-drop-scroll]");
/** every container targets scroll in (the sidebar's nav; the List layout's tab strip when it scrolls) */
const scrollers = () => document.querySelectorAll<HTMLElement>("[data-drop-scroll]");

/** the elements measured at drag start, by TargetRect.at (the drop flies to the one it landed on) */
let measured: HTMLElement[] = [];

/**
 * The targets, each clipped to its own scrolling container (plan 24: a tab
 * above the sidebar's nav isn't clipped by the nav), skipping what's
 * scrolled out of view or inside something hidden (an inert page cover).
 */
export function measureTargets(): TargetRect[] {
  const out: TargetRect[] = [];
  measured = [];
  for (const el of document.querySelectorAll<HTMLElement>("[data-drop-target]")) {
    if (el.closest("[inert]")) continue;
    const r = el.getBoundingClientRect();
    const clip = el.closest<HTMLElement>("[data-drop-scroll]")?.getBoundingClientRect();
    const top = Math.max(r.top, clip?.top ?? -Infinity);
    const bottom = Math.min(r.bottom, clip?.bottom ?? Infinity);
    const left = Math.max(r.left, clip?.left ?? -Infinity);
    const right = Math.min(r.right, clip?.right ?? Infinity);
    if (bottom - top < 4 || right - left < 4) continue; // scrolled out of its container
    out.push({ id: Number(el.dataset.dropTarget), at: measured.length, left, right, top, bottom });
    measured.push(el);
  }
  return out;
}

/**
 * The click that ends a drag (released over the rows: a cancel, a drop back
 * on the list) must not open a row (List opens on click; plan 24, R8): it
 * is swallowed once, and the guard goes at the next frame either way.
 */
function swallowNextClick() {
  const swallow = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    window.removeEventListener("click", swallow, true);
  };
  window.addEventListener("click", swallow, true);
  requestAnimationFrame(() => setTimeout(() => window.removeEventListener("click", swallow, true), 0));
}

function placeGhost(p: PointerLike) {
  if (ghost) ghost.style.transform = `translate3d(${p.x + GHOST_OFFSET.x}px, ${p.y + GHOST_OFFSET.y}px, 0)`;
}

function showGhost(ids: readonly number[], at: PointerLike) {
  if (!ghost) return;
  const first = row(ids[0]!);
  ghost.querySelector("[data-ghost-subject]")!.textContent = first?.subject || t("common.noSubject");
  ghost.querySelector("[data-ghost-count]")!.textContent = formatNumber(ids.length);
  ghost.querySelectorAll<HTMLElement>("[data-ghost-stack]").forEach((s) => s.classList.toggle("hidden", ids.length < 2));
  const body = ghost.querySelector<HTMLElement>("[data-ghost-body]")!;
  body.removeAttribute("data-leaving");
  body.setAttribute("data-shown", "");
  for (const a of ghost.getAnimations({ subtree: true })) a.cancel();
  ghost.style.opacity = "";
  placeGhost(at);
  ghost.hidden = false;
}

function hideGhost() {
  if (!ghost) return;
  ghost.hidden = true;
  ghost.querySelector("[data-ghost-body]")?.removeAttribute("data-leaving");
}

/** Cancel: a quick fade where it is, no fly-back. */
function fadeGhost() {
  if (!ghost) return;
  const ms = motionMs();
  if (ms === 0) return hideGhost();
  const body = ghost.querySelector<HTMLElement>("[data-ghost-body]")!;
  body.removeAttribute("data-shown");
  body.setAttribute("data-leaving", "");
  const g = ghost;
  setTimeout(() => g.querySelector("[data-ghost-body]")?.hasAttribute("data-leaving") && hideGhost(), Math.round(ms * 0.66) + 20);
}

/** Drop: the ghost flies into the dot of the target it landed on (the sidebar's item or the tab) and fades. */
function flyGhost(categoryId: number, at?: number) {
  if (!ghost) return;
  const ms = motionMs();
  const target = (at !== undefined ? measured[at] : undefined) ?? document.querySelector(`[data-drop-target="${categoryId}"]`);
  const dot = target?.querySelector("[data-slot=category-dot]")?.getBoundingClientRect();
  if (ms === 0 || !dot) return hideGhost();
  const duration = Math.min(Math.round(ms * 1.33), 100);
  const from = ghost.style.transform;
  const to = `translate3d(${dot.left + dot.width / 2 - 6}px, ${dot.top + dot.height / 2 - 6}px, 0) scale(0.25)`;
  const fly = ghost.animate([{ transform: from, opacity: 1 }, { transform: to, opacity: 0 }], { duration, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", fill: "forwards" });
  fly.onfinish = () => {
    hideGhost();
    fly.cancel();
  };
}

function end() {
  html().removeAttribute("data-dragging");
  dimRows(null);
  useDrag.setState({ phase: "idle", ids: [], overTarget: null, overState: null });
}

let latest: PointerLike | null = null;
let frame = 0;

/** One frame per burst of pointermoves: ghost position, sidebar auto-scroll. */
function tick() {
  frame = 0;
  if (!latest || !ghost || ghost.hidden) return;
  placeGhost(latest);
  const nav = scroller();
  if (!nav) return;
  const r = nav.getBoundingClientRect();
  if (latest.x < r.left || latest.x > r.right) return;
  const dy = latest.y < r.top + EDGE ? -8 : latest.y > r.bottom - EDGE ? 8 : 0;
  if (dy && nav.scrollTop + dy >= 0 && nav.scrollTop + dy <= nav.scrollHeight - nav.clientHeight) {
    nav.scrollTop += dy;
    frame = requestAnimationFrame(tick);
  }
}

export function installDragController(list: HTMLElement): () => void {
  const ctl = new DragController({
    payload: (id) => {
      const checked = getApp().checked;
      return checked.has(id) ? payloadFor(id, checked, useList.getState().items.map((t) => t.id)) : [id];
    },
    targets: measureTargets,
    // a drop moves exclusively: it changes nothing only when every thread is in that category alone
    isAlready: (categoryId, ids) => isExclusivelyIn(categoryId, ids),
    start: (ids, at) => {
      html().setAttribute("data-dragging", "");
      dimRows(ids);
      showGhost(ids, at);
      useDrag.setState({ phase: "dragging", ids, overTarget: null, overState: null });
    },
    move: (at) => {
      latest = at;
      if (!frame) frame = requestAnimationFrame(tick);
    },
    target: (overTarget, overState) => useDrag.setState({ overTarget, overState }),
    drop: (categoryId, ids, at) => {
      flyGhost(categoryId, at);
      end();
      const added = newIds(ids, categoryId, (id) => row(id)?.categoryIds);
      void moveToCategory(categoryId, ids, { source: "dnd" });
      flashDrop(added.length ? added : ids, categoryId);
    },
    cancel: () => {
      fadeGhost();
      end();
    },
  });

  const point = (e: PointerEvent): PointerLike => ({ x: e.clientX, y: e.clientY, button: e.button, pointerId: e.pointerId, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey });

  let folders: ResizeObserver | null = null;
  const cleanup = () => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", onCancel);
    for (const s of scrollers()) s.removeEventListener("scroll", onScroll);
    folders?.disconnect();
    folders = null;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    latest = null;
  };

  function onMove(e: PointerEvent) {
    const t0 = performance.now();
    const wasDragging = ctl.dragging;
    const started = ctl.move(point(e));
    if (started) {
      try {
        list.setPointerCapture(e.pointerId);
      } catch {
        /* the pointer is already gone */
      }
      for (const s of scrollers()) s.addEventListener("scroll", onScroll, { passive: true });
      // More's folders growing or shrinking (plan 40: a held folder let go as the pointer left) slide the categories without a scroll
      const group = document.getElementById("sidebar-more-folders");
      if (group) (folders = new ResizeObserver(onScroll)).observe(group);
      if (PROBE) {
        performance.measure("drag:start", { start: t0, end: performance.now() });
        // the frame that shows the ghost: its rAF runs before style, layout and paint; a message
        // posted from there is handled after that frame's rendering (≈ painted)
        requestAnimationFrame(() => {
          const visible = !!ghost && !ghost.hidden;
          performance.measure(visible ? "drag:start-frame" : "drag:start-frame-missed", { start: t0, end: performance.now() });
          const ch = new MessageChannel();
          ch.port1.onmessage = () => performance.measure(visible ? "drag:start-paint" : "drag:start-paint-missed", { start: t0, end: performance.now() });
          ch.port2.postMessage(null);
        });
      }
    } else if (wasDragging && PROBE) {
      performance.measure("drag:move", { start: t0, end: performance.now() });
    }
    if (ctl.dragging) e.preventDefault();
  }
  function onUp(e: PointerEvent) {
    if (ctl.dragging) swallowNextClick();
    ctl.up(point(e));
    cleanup();
  }
  function onCancel() {
    if (ctl.dragging) swallowNextClick();
    ctl.cancel();
    cleanup();
  }
  function onKey(e: KeyboardEvent) {
    if (!ctl.dragging || e.key !== "Escape") return;
    // captured: Esc cancels the drag and nothing else (the reader stays open)
    e.preventDefault();
    e.stopImmediatePropagation();
    onCancel();
  }
  function onScroll() {
    ctl.refreshTargets();
  }
  const onDown = (e: PointerEvent) => {
    const el = (e.target as Element | null)?.closest<HTMLElement>("[data-thread-id]");
    if (!el || !list.contains(el) || ctl.pressed) return;
    // "all N of the view": only the loaded rows could travel, as with "Mover a…" (disabled there too)
    if (getApp().scope) return;
    if (!ctl.down(Number(el.dataset.threadId), point(e))) return;
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onCancel);
  };
  list.addEventListener("pointerdown", onDown);
  return () => {
    list.removeEventListener("pointerdown", onDown);
    ctl.cancel();
    cleanup();
  };
}
