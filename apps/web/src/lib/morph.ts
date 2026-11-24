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
export function morph(update: () => void): void {
  const doc = document as WithTransitions;
  if (motionMs() === 0 || typeof doc.startViewTransition !== "function") return update();
  if (running) {
    running.skipTransition();
    return update();
  }
  let named = nameShown();
  let transition: Transition;
  try {
    transition = doc.startViewTransition(() => {
      clear(named);
      flushSync(update);
      named = nameShown();
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
      if (running === transition) running = null;
    });
}

function shown(el: HTMLElement): boolean {
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
