/**
 * The drag-to-category controller: a small pointer state machine with no DOM
 * or React inside, so it is unit-tested directly. lib/drag-install.ts binds it
 * to the list (one delegated listener, pointer capture), the ghost, the
 * sidebar's cached target rects and the drop action.
 *
 * Payload is ids only. Nothing here causes a row to re-render.
 */

/** Movement (px) that turns a press into a drag; less is a click. */
export const DRAG_THRESHOLD = 4;

export interface PointerLike {
  x: number;
  y: number;
  button?: number;
  pointerId?: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

/** What a drop lands on: a category (its id) or an account's folder (plan 127: its `folderRef`). */
export type DropId = number | string;

export interface TargetRect {
  id: DropId;
  /** which measured element it is (a category can be a target twice: its sidebar item and its tab, plan 24) */
  at?: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** `refused` (plan 127): a target these rows can't go to (another account's folder): no highlight, a drop only says why. */
export type DropState = "over" | "already" | "refused";

export interface DragEnv {
  /** ids to drag when the press started on `id` (checked rows travel together, in list order) */
  payload(id: number): number[];
  /** drop targets, measured once at drag start (and again after the sidebar scrolls) */
  targets(): TargetRect[];
  /** dropping here would change nothing: every thread is already in it, and in it alone (a drop moves) */
  isAlready(target: DropId, ids: readonly number[]): boolean;
  /** plan 127: these rows can't go here (absent: anything can) */
  refuses?(target: DropId, ids: readonly number[]): boolean;
  start(ids: number[], at: PointerLike): void;
  /** every pointermove while dragging (the binding coalesces to one frame) */
  move(at: PointerLike): void;
  target(target: DropId | null, state: DropState | null, at?: number): void;
  /** a category: an exclusive move, afterwards the threads are in it only; a folder: plan 127's move (`at`: the element it was dropped on) */
  drop(target: DropId, ids: number[], at?: number): void;
  cancel(): void;
  /** plan 127: dropped on a target that refuses them, after `cancel` */
  refused?(target: DropId, ids: readonly number[]): void;
}

export function exceedsThreshold(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= DRAG_THRESHOLD;
}

export function hitTest(rects: readonly TargetRect[], x: number, y: number): DropId | null {
  return hitRect(rects, x, y)?.id ?? null;
}

/** The target under the point itself (which of a category's elements). */
export function hitRect(rects: readonly TargetRect[], x: number, y: number): TargetRect | null {
  for (const r of rects) if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) return r;
  return null;
}

/** The checked rows in list order when the pressed row is one of them; otherwise just that row. */
export function payloadFor(id: number, checked: ReadonlySet<number>, order: readonly number[]): number[] {
  if (!checked.has(id)) return [id];
  return order.filter((x) => checked.has(x));
}

/** A drop moves exclusively: it changes nothing only when every thread is in the category and no other. */
export function exclusivelyIn(ids: readonly number[], categoryId: number, categoriesOf: (id: number) => readonly number[] | undefined): boolean {
  return ids.every((id) => {
    const cats = categoriesOf(id);
    return cats !== undefined && cats.length === 1 && cats[0] === categoryId;
  });
}

/** The threads a drop actually adds (undo removes exactly these). */
export function newIds(ids: readonly number[], categoryId: number, categoriesOf: (id: number) => readonly number[] | undefined): number[] {
  return ids.filter((id) => !categoriesOf(id)?.includes(categoryId));
}

type Phase = { kind: "idle" } | { kind: "pressed"; id: number; x: number; y: number; pointerId?: number } | { kind: "dragging"; ids: number[]; over: DropId | null; at: number | undefined; state: DropState | null; rects: TargetRect[]; last: PointerLike };

export class DragController {
  private phase: Phase = { kind: "idle" };

  constructor(private env: DragEnv) {}

  get dragging(): boolean {
    return this.phase.kind === "dragging";
  }

  get pressed(): boolean {
    return this.phase.kind !== "idle";
  }

  /** pointerdown on a row: primary button, no ⌘/⇧/⌃ (those keep their click meaning) */
  down(id: number, e: PointerLike): boolean {
    if ((e.button ?? 0) !== 0 || e.metaKey || e.shiftKey || e.ctrlKey) return false;
    this.phase = { kind: "pressed", id, x: e.x, y: e.y, pointerId: e.pointerId };
    return true;
  }

  /** Returns true when this move started the drag. */
  move(e: PointerLike): boolean {
    const p = this.phase;
    if (p.kind === "pressed") {
      if (!exceedsThreshold(e.x - p.x, e.y - p.y)) return false;
      const ids = this.env.payload(p.id);
      this.phase = { kind: "dragging", ids, over: null, at: undefined, state: null, rects: this.env.targets(), last: e };
      this.env.start(ids, e);
      this.track(e);
      return true;
    }
    if (p.kind === "dragging") this.track(e);
    return false;
  }

  /** The sidebar scrolled: re-measure the targets and re-test the pointer. */
  refreshTargets(): void {
    if (this.phase.kind !== "dragging") return;
    this.phase.rects = this.env.targets();
    this.track(this.phase.last);
  }

  private track(e: PointerLike): void {
    const p = this.phase;
    if (p.kind !== "dragging") return;
    p.last = e;
    this.env.move(e);
    const hit = hitRect(p.rects, e.x, e.y);
    const over = hit?.id ?? null;
    const state = over === null ? null : this.stateOf(over, p.ids);
    if (over !== p.over || state !== p.state || hit?.at !== p.at) {
      p.over = over;
      p.at = hit?.at;
      p.state = state;
      this.env.target(over, state, hit?.at);
    }
  }

  private stateOf(target: DropId, ids: readonly number[]): DropState {
    return this.env.refuses?.(target, ids) ? "refused" : this.env.isAlready(target, ids) ? "already" : "over";
  }

  up(e: PointerLike): void {
    const p = this.phase;
    this.phase = { kind: "idle" };
    if (p.kind !== "dragging") return;
    // measured again for the drop itself: a target may have moved since the drag started (a tab widened by a new count, into More)
    const hit = hitRect(this.env.targets(), e.x, e.y);
    const state = hit && this.stateOf(hit.id, p.ids);
    if (hit && state === "over") return this.env.drop(hit.id, p.ids, hit.at);
    this.env.cancel();
    if (hit && state === "refused") this.env.refused?.(hit.id, p.ids);
  }

  /** Esc, pointercancel, window blur: nothing happens, the ghost fades. */
  cancel(): void {
    const was = this.phase.kind;
    this.phase = { kind: "idle" };
    if (was === "dragging") this.env.cancel();
  }
}
