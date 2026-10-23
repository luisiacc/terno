/**
 * Binds the drag controller to the DOM: one delegated pointerdown on the
 * listbox (it stays mounted while rows virtualize away) and pointer capture on
 * it once the drag starts; the ghost moves imperatively in rAF; targets are
 * the sidebar's [data-drop-target] items, measured at drag start. During a
 * drag no row renders: the dimming is a keyed CSS rule (lib/flash.ts) and only
 * the two NavItems whose state changes re-render.
 */
import { motionMs } from "~/lib/appearance";
import { addToCategory } from "~/lib/categorize";
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

function measureTargets(): TargetRect[] {
  const clip = scroller()?.getBoundingClientRect();
  const out: TargetRect[] = [];
  for (const el of document.querySelectorAll<HTMLElement>("[data-drop-target]")) {
    const r = el.getBoundingClientRect();
    const top = Math.max(r.top, clip?.top ?? -Infinity);
    const bottom = Math.min(r.bottom, clip?.bottom ?? Infinity);
    if (bottom - top < 4) continue; // scrolled out of the sidebar
    out.push({ id: Number(el.dataset.dropTarget), left: r.left, right: r.right, top, bottom });
  }
  return out;
}

function placeGhost(p: PointerLike) {
  if (ghost) ghost.style.transform = `translate3d(${p.x + GHOST_OFFSET.x}px, ${p.y + GHOST_OFFSET.y}px, 0)`;
}

function showGhost(ids: readonly number[], at: PointerLike) {
  if (!ghost) return;
  const first = row(ids[0]!);
  ghost.querySelector("[data-ghost-subject]")!.textContent = first?.subject || "(sin asunto)";
  ghost.querySelector("[data-ghost-count]")!.textContent = String(ids.length);
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

/** Drop: the ghost flies into the category's dot and fades. */
function flyGhost(categoryId: number) {
  if (!ghost) return;
  const ms = motionMs();
  const dot = document.querySelector(`[data-drop-target="${categoryId}"] [data-slot=category-dot]`)?.getBoundingClientRect();
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
let alt = false;

/** One frame per burst of pointermoves: ghost position, ⌥ hint, sidebar auto-scroll. */
function tick() {
  frame = 0;
  if (!latest || !ghost || ghost.hidden) return;
  placeGhost(latest);
  const moving = alt && getApp().categoryId !== null;
  const hint = ghost.querySelector<HTMLElement>("[data-ghost-move]");
  if (hint && hint.hidden === moving) hint.hidden = !moving;
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
    isAlready: (categoryId, ids) => {
      const s = getApp();
      if (s.categoryId === categoryId && s.reviewCategoryId === null) return true;
      return newIds(ids, categoryId, (id) => row(id)?.categoryIds).length === 0;
    },
    start: (ids, at) => {
      html().setAttribute("data-dragging", "");
      dimRows(ids);
      showGhost(ids, at);
      useDrag.setState({ phase: "dragging", ids, overTarget: null, overState: null });
    },
    move: (at) => {
      latest = at;
      alt = !!at.altKey;
      if (!frame) frame = requestAnimationFrame(tick);
    },
    target: (overTarget, overState) => useDrag.setState({ overTarget, overState }),
    drop: (categoryId, ids, { move }) => {
      const s = getApp();
      const from = move && s.categoryId !== null && s.reviewCategoryId === null && s.categoryId !== categoryId ? s.categoryId : null;
      flyGhost(categoryId);
      end();
      const added = newIds(ids, categoryId, (id) => row(id)?.categoryIds);
      void addToCategory(categoryId, ids, { source: "dnd", movedFrom: from ?? undefined });
      flashDrop(added.length ? added : ids, categoryId);
    },
    cancel: () => {
      fadeGhost();
      end();
    },
  });

  const point = (e: PointerEvent): PointerLike => ({ x: e.clientX, y: e.clientY, button: e.button, pointerId: e.pointerId, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey });

  const cleanup = () => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("keyup", onKey, true);
    window.removeEventListener("blur", onCancel);
    scroller()?.removeEventListener("scroll", onScroll);
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
      scroller()?.addEventListener("scroll", onScroll, { passive: true });
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
    ctl.up(point(e));
    cleanup();
  }
  function onCancel() {
    ctl.cancel();
    cleanup();
  }
  function onKey(e: KeyboardEvent) {
    if (!ctl.dragging) return;
    if (e.key === "Escape" && e.type === "keydown") {
      // captured: Esc cancels the drag and nothing else (the reader stays open)
      e.preventDefault();
      e.stopImmediatePropagation();
      onCancel();
    } else if (e.key === "Alt") {
      alt = e.type === "keydown";
      if (latest) latest = { ...latest, altKey: alt };
      if (!frame) frame = requestAnimationFrame(tick);
    }
  }
  function onScroll() {
    ctl.refreshTargets();
  }
  const onDown = (e: PointerEvent) => {
    const el = (e.target as Element | null)?.closest<HTMLElement>("[data-thread-id]");
    if (!el || !list.contains(el) || ctl.pressed) return;
    if (!ctl.down(Number(el.dataset.threadId), point(e))) return;
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("blur", onCancel);
  };
  list.addEventListener("pointerdown", onDown);
  return () => {
    list.removeEventListener("pointerdown", onDown);
    ctl.cancel();
    cleanup();
  };
}
