import { flushSync } from "react-dom";
import { motionMs } from "~/lib/appearance";

interface Transition {
  finished: Promise<void>;
  skipTransition: () => void;
}
type WithTransitions = Document & { startViewTransition?: (update: () => void) => Transition };

/** the transition running, if any: a second change meanwhile ends it and goes at once */
let running: Transition | null = null;

/**
 * Plan 251: a change of layout morphs. Elements marked `data-morph="<name>"` (and optionally `data-morph-class`) glide
 * from where they were to where they land, the rest cross-fades, in one view transition of `--motion`. Only what's wholly
 * in view in its scroller (`data-morph-clip`, less its scroll padding at the foot, where a sticky bar sits) is named:
 * a named element escapes its pane's clip, so one scrolled out of it would fly in from outside. Names exist only while
 * the transition runs.
 *
 * The update runs on the transition's frame, after the old state is captured, not now: a caller that reads the state
 * right after (an action's Undo) must not use this. Motion off, no API, or a transition already running: it runs now.
 * An update that runs late is the caller's to check (what it was for may have gone meanwhile).
 */
export function morph(update: () => void, pairs: readonly MorphPair[] = []): void {
  const doc = document as WithTransitions;
  // (plan 281) paused too, as flash.ts's motion is: a language switch re-mounting the app moves nothing
  if (motionMs() === 0 || document.documentElement.classList.contains("motion-paused") || typeof doc.startViewTransition !== "function") return update();
  if (running) {
    running.skipTransition();
    return update();
  }
  let named = nameShown();
  const before = namePairs(pairs, named);
  let transition: Transition;
  try {
    transition = doc.startViewTransition(() => {
      clear(named);
      flushSync(update);
      named = nameShown();
      // a pair not wholly in view before (a message taller than the pane), or drawn otherwise after: the change is still
      // (both pictures of it would be in the cross-fade, its words doubled: Codex code review #3)
      if (before.size < pairs.length || !matchPairs(pairs, before, named)) document.documentElement.dataset.morphStill = "";
    });
  } catch (error) {
    clear(named);
    throw error;
  }
  running = transition;
  void transition.finished
    .catch(() => {})
    .finally(() => {
      clear(named);
      delete document.documentElement.dataset.morphStill;
      if (running === transition) running = null;
    });
}

/** Plan 281: resolves once the running morph (if any) has finished, so a change that follows doesn't cut it short. */
export function morphSettled(): Promise<void> {
  return running ? running.finished.catch(() => {}) : Promise.resolve();
}

/**
 * Plan 271: one element that is the same thing on both sides of this one change (a sent message and its copy), found
 * afresh before and after it. It glides, never resizes: named before only if wholly in view of its scroller, and after
 * only if it's there, wholly in view and the same size; it shows its new picture at once (`morph-swap`). Not wholly in
 * view before, or unmatched after (a design that draws it otherwise: Lumen's sender card), the change is still
 * (`data-morph-still`): a cross-fade would show two pictures of the one message, its words doubled.
 */
export interface MorphPair {
  name: string;
  find: () => HTMLElement | null;
}

function inView(el: HTMLElement): DOMRect | null {
  const r = el.getBoundingClientRect();
  const scroller = el.closest<HTMLElement>("[data-reader-scroller]")?.getBoundingClientRect();
  if (r.height === 0 || (scroller && (r.top < scroller.top - 0.5 || r.bottom > scroller.bottom + 0.5))) return null;
  return r;
}

function namePairs(pairs: readonly MorphPair[], named: HTMLElement[]): Map<string, DOMRect> {
  const sizes = new Map<string, DOMRect>();
  for (const p of pairs) {
    const el = p.find();
    const r = el && inView(el);
    if (!el || !r) continue;
    el.style.setProperty("view-transition-name", p.name);
    named.push(el);
    sizes.set(p.name, r);
  }
  return sizes;
}

/** Names each pair's element after the change; false if one named before has no match. */
function matchPairs(pairs: readonly MorphPair[], before: ReadonlyMap<string, DOMRect>, named: HTMLElement[]): boolean {
  let all = true;
  for (const p of pairs) {
    const was = before.get(p.name);
    if (!was) continue;
    const el = p.find();
    const r = el && inView(el);
    if (!el || !r || Math.abs(r.width - was.width) > 1 || Math.abs(r.height - was.height) > 1) {
      all = false;
      continue;
    }
    el.style.setProperty("view-transition-name", p.name);
    el.style.setProperty("view-transition-class", "morph-swap");
    named.push(el);
  }
  return all;
}

function shown(el: HTMLElement): boolean {
  // plan 281: what isn't drawn (List's covered list) has no picture to glide from or to
  if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) return false;
  const clip = el.closest<HTMLElement>("[data-morph-clip]");
  // a sticky bar (`data-morph-pinned`) is always in its pane's view
  if (!clip || el.hasAttribute("data-morph-pinned")) return true;
  const c = clip.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const floor = c.bottom - (parseFloat(getComputedStyle(clip).scrollPaddingBottom) || 0);
  return r.height > 0 && r.top >= c.top - 0.5 && r.bottom <= floor + 0.5;
}

function nameShown(): HTMLElement[] {
  const named: HTMLElement[] = [];
  for (const el of document.querySelectorAll<HTMLElement>("[data-morph]")) {
    if (!shown(el)) continue;
    el.style.setProperty("view-transition-name", el.dataset.morph!);
    if (el.dataset.morphClass) el.style.setProperty("view-transition-class", el.dataset.morphClass);
    named.push(el);
  }
  return named;
}

function clear(named: readonly HTMLElement[]): void {
  for (const el of named) {
    el.style.removeProperty("view-transition-name");
    el.style.removeProperty("view-transition-class");
  }
}
