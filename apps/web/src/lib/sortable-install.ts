/**
 * Plan 169: binds lib/sortable's math to a group of the sidebar (its categories, its accounts). One delegated
 * pointerdown and keydown on the group; items are its `[data-sort-id]` children, dragged by their
 * `[data-sort-handle]` (the row itself: never a folder under an account, its "+" or its sign-in key).
 *
 * While dragging, transforms are written on the items directly: nothing renders. The drop hands the new order to
 * `commit`; the render that shows it calls `settle()` from its layout pass, which moves every item from where it was
 * seen to its new place (FLIP), so nothing jumps. A keyboard move (⌥↑ ⌥↓) settles the same way.
 */
import { motionMs } from "./appearance";
import { DRAG_THRESHOLD } from "./drag";
import { clampDy, moved, shiftsFor, slotOf, type Block } from "./sortable";

export interface SortableOptions {
  /** the new order of the group's ids */
  commit(ids: number[]): void;
  /** said by the sidebar's live region: the item moved, and where it is now */
  announce(id: number, position: number, total: number): void;
}

export interface Sortable {
  /** the group's ids changed: the drop's (or key's) new order is shown, or a list changed under a drag */
  settle(): void;
  dispose(): void;
}

/** the sidebar scrolls while the pointer holds this near its edge (the thread drag's edge and step) */
const EDGE = 24;
const STEP = 8;

type Phase =
  | { kind: "idle" }
  | { kind: "pressed"; el: HTMLElement; x: number; y: number; pointerId: number }
  | { kind: "dragging"; els: HTMLElement[]; blocks: Block[]; from: number; to: number; y0: number; top0: number; y: number };

const html = () => document.documentElement;
const idOf = (el: HTMLElement) => Number(el.dataset.sortId);

export function installSortable(group: HTMLElement, o: SortableOptions): Sortable {
  const scroller = group.closest<HTMLElement>("[data-drop-scroll]");
  // the group's own top: a scroll, or More's held rows letting go above it, moves every block alike (Codex plan review #5)
  const groupTop = () => group.getBoundingClientRect().top;
  const state: { phase: Phase; frame: number; flip: Map<HTMLElement, number> | null; focus: HTMLElement | null; done: number; resized: ResizeObserver | null } = { phase: { kind: "idle" }, frame: 0, flip: null, focus: null, done: 0, resized: null };
  const items = () => [...group.querySelectorAll<HTMLElement>(":scope > [data-sort-id]")];

  const listen = (on: boolean) => {
    const f = on ? window.addEventListener : window.removeEventListener;
    f("pointermove", onMove, true);
    f("pointerup", onUp, true);
    f("pointercancel", onCancel, true);
    f("keydown", onEscape, true);
    f("blur", onCancel);
    // a menu opened from the keyboard (⇧F10) mid-drag: the drag gives way (Codex plan review #6)
    f("contextmenu", onCancel, true);
  };

  /** the items' attributes and transforms go once the settle's transition is over (at once with motion off) */
  const finish = (els: readonly HTMLElement[]) => {
    window.clearTimeout(state.done);
    const clear = () => {
      for (const el of els) {
        el.removeAttribute("data-lifted");
        el.removeAttribute("data-settling");
        el.style.transform = "";
      }
    };
    const ms = motionMs();
    if (ms === 0) clear();
    else state.done = window.setTimeout(clear, ms + 20);
  };

  const end = () => {
    group.removeAttribute("data-sorting");
    html().removeAttribute("data-sorting");
    if (state.frame) cancelAnimationFrame(state.frame);
    state.frame = 0;
    listen(false);
    scroller?.removeEventListener("scroll", onShift);
    state.resized?.disconnect();
    state.resized = null;
  };

  /** the sidebar scrolled (a wheel, the edge) or More's rows above let go, with the pointer still: the row stays under it (Codex code review #2) */
  function onShift() {
    if (state.phase.kind === "dragging" && !state.frame) state.frame = requestAnimationFrame(tick);
  }

  /** the dragged item under the pointer, its neighbours out of its way */
  const place = () => {
    const p = state.phase;
    if (p.kind !== "dragging") return;
    // where the blocks were measured is where they'd be now with the group where it was
    const dy = clampDy(p.blocks, p.from, p.y - p.y0 - (groupTop() - p.top0));
    const to = slotOf(p.blocks, p.from, dy);
    p.els[p.from]!.style.transform = `translate3d(0, ${dy}px, 0)`;
    if (to === p.to) return;
    p.to = to;
    shiftsFor(p.blocks, p.from, to).forEach((shift, j) => {
      if (j !== p.from) p.els[j]!.style.transform = shift ? `translate3d(0, ${shift}px, 0)` : "";
    });
  };

  /** one frame per burst of moves; it runs on while the pointer holds near an edge and the sidebar can scroll */
  const tick = () => {
    state.frame = 0;
    const p = state.phase;
    if (p.kind !== "dragging") return;
    if (scroller) {
      const r = scroller.getBoundingClientRect();
      const step = p.y < r.top + EDGE ? -STEP : p.y > r.bottom - EDGE ? STEP : 0;
      const next = Math.min(Math.max(scroller.scrollTop + step, 0), scroller.scrollHeight - scroller.clientHeight);
      if (step && next !== scroller.scrollTop) {
        scroller.scrollTop = next;
        state.frame = requestAnimationFrame(tick);
      }
    }
    place();
  };

  const start = (p: Extract<Phase, { kind: "pressed" }>, y: number) => {
    const els = items();
    const from = els.indexOf(p.el);
    if (from < 0 || els.length < 2) return void (state.phase = { kind: "idle" });
    window.clearTimeout(state.done);
    // a row still settling from the last drag is a row again (Codex code review #1: it kept its lift)
    for (const el of els) {
      el.removeAttribute("data-settling");
      el.removeAttribute("data-lifted");
      el.style.transform = "";
    }
    const blocks = els.map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, height: r.height };
    });
    state.phase = { kind: "dragging", els, blocks, from, to: from, y0: p.y, top0: groupTop(), y };
    p.el.setAttribute("data-lifted", "");
    group.setAttribute("data-sorting", "");
    html().setAttribute("data-sorting", "");
    scroller?.addEventListener("scroll", onShift, { passive: true });
    const more = document.getElementById("sidebar-more-folders");
    if (more) (state.resized = new ResizeObserver(onShift)).observe(more);
    try {
      group.setPointerCapture(p.pointerId);
    } catch {
      /* the pointer is already gone */
    }
    place();
  };

  /** Before a new order is committed: where every item is seen now, for settle() to move it from. */
  const remember = (els: readonly HTMLElement[]) => {
    const flip = new Map(els.map((el) => [el, el.getBoundingClientRect().top]));
    state.flip = flip;
    const active = document.activeElement as HTMLElement | null;
    state.focus = active && group.contains(active) ? active : null;
    // the render that shows it settles; should none come (the list changed meanwhile), a frame later this does
    requestAnimationFrame(() => requestAnimationFrame(() => state.flip === flip && settle()));
  };

  function settle() {
    const p = state.phase;
    // a list that changes under a drag: the drag ends, nothing is saved
    if (p.kind === "dragging") return cancel();
    const flip = state.flip;
    if (!flip) return;
    state.flip = null;
    // React moves a row by taking it out and putting it back, which drops its focus
    const focus = state.focus;
    state.focus = null;
    if (focus?.isConnected && document.activeElement !== focus) focus.focus({ preventScroll: true });
    const els = [...flip.keys()].filter((el) => el.isConnected);
    for (const el of els) {
      el.removeAttribute("data-settling");
      el.style.transform = "";
    }
    const moving = els.flatMap((el) => {
      const dy = flip.get(el)! - el.getBoundingClientRect().top;
      if (Math.abs(dy) < 0.5) return [];
      el.style.transform = `translate3d(0, ${dy}px, 0)`;
      return [el];
    });
    if (moving.length && motionMs() > 0) {
      void group.offsetHeight; // the inverted positions are laid out before the transition starts
      for (const el of moving) {
        el.setAttribute("data-settling", "");
        el.style.transform = "";
      }
    }
    finish(els);
  }

  function cancel() {
    const p = state.phase;
    state.phase = { kind: "idle" };
    if (p.kind === "dragging") {
      for (const el of p.els) {
        el.setAttribute("data-settling", "");
        el.style.transform = "";
      }
      finish(p.els);
    }
    end();
  }

  function onMove(e: PointerEvent) {
    const p = state.phase;
    if (p.kind === "pressed") {
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_THRESHOLD) return;
      start(p, e.clientY);
    } else if (p.kind === "dragging") {
      p.y = e.clientY;
    }
    if (state.phase.kind !== "dragging") return;
    e.preventDefault();
    if (!state.frame) state.frame = requestAnimationFrame(tick);
  }

  function onUp() {
    const p = state.phase;
    // the last move, if its frame hasn't run yet
    place();
    state.phase = { kind: "idle" };
    if (p.kind !== "dragging") return end();
    swallowNextClick();
    const lifted = p.els[p.from]!;
    if (p.to === p.from) {
      end();
      // back into its own place
      lifted.setAttribute("data-settling", "");
      lifted.style.transform = "";
      return finish(p.els);
    }
    // where each row is seen, a neighbour mid-slide too, before end() takes the slide's transition away (Codex code review #3)
    remember(p.els);
    end();
    const ids = moved(p.els.map(idOf), p.from, p.to);
    o.commit(ids);
    o.announce(idOf(lifted), p.to + 1, ids.length);
  }

  function onCancel() {
    if (state.phase.kind === "dragging") swallowNextClick();
    cancel();
  }

  function onEscape(e: KeyboardEvent) {
    if (state.phase.kind !== "dragging" || e.key !== "Escape") return;
    // captured: Esc puts the rows back and does nothing else
    e.preventDefault();
    e.stopImmediatePropagation();
    cancel();
  }

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || state.phase.kind !== "idle") return;
    const el = (e.target as Element).closest("[data-sort-handle]")?.closest<HTMLElement>("[data-sort-id]");
    if (!el || el.parentElement !== group) return;
    state.phase = { kind: "pressed", el, x: e.clientX, y: e.clientY, pointerId: e.pointerId };
    listen(true);
  };

  /** ⌥↑ ⌥↓ on a focused row: one place up or down */
  const onKey = (e: KeyboardEvent) => {
    if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    const el = (e.target as Element).closest("[data-sort-handle]")?.closest<HTMLElement>("[data-sort-id]");
    if (!el || el.parentElement !== group || state.phase.kind !== "idle") return;
    e.preventDefault();
    e.stopPropagation();
    const els = items();
    const from = els.indexOf(el);
    const to = from + (e.key === "ArrowUp" ? -1 : 1);
    if (to < 0 || to >= els.length) return;
    remember(els);
    const ids = moved(els.map(idOf), from, to);
    o.commit(ids);
    o.announce(idOf(el), to + 1, ids.length);
  };

  group.addEventListener("pointerdown", onDown);
  group.addEventListener("keydown", onKey);
  return {
    settle,
    dispose: () => {
      group.removeEventListener("pointerdown", onDown);
      group.removeEventListener("keydown", onKey);
      cancel();
      window.clearTimeout(state.done);
    },
  };
}

/** The click that ends a drag must not open the category or toggle the account: swallowed once, gone a frame later. */
function swallowNextClick() {
  const swallow = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    window.removeEventListener("click", swallow, true);
  };
  window.addEventListener("click", swallow, true);
  requestAnimationFrame(() => setTimeout(() => window.removeEventListener("click", swallow, true), 0));
}
