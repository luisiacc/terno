import { getApp, setApp, type SettingsTab } from "~/state/app";

/**
 * Plan 246: where Settings was left (its section, how far down, the rows open there), so the gear and ⌘, come back to
 * it. This window's memory only, never stored: quitting, a reload or a new window start again at General.
 */
const place: { tab: SettingsTab; top: number; open: readonly string[] } = { tab: "general", top: 0, open: [] };

/** the pane's next mount comes back to the place (else a link: its section from the top). A mount nobody asked for (after the fatal modal) comes back too. */
const next = { returning: true };

/** a return under way, ended by whatever takes the scroll instead (Find) */
const current: { stop: (() => void) | null } = { stop: null };

/** up to a second for a section's rows to come (they're read from the backend), then the pane stays where they let it */
export const RETURN_WAIT_MS = 1000;

/**
 * Opens Settings. Without a section, where it was left; with one (a link: an error's AI settings, the palette's
 * Settings → Storage), that section from its top. Already open, a section is switched to and nothing else changes.
 */
export function openSettings(tab?: SettingsTab, account: number | null = null): void {
  if (getApp().dialog === "settings") {
    if (tab) setApp({ settingsTab: tab });
    return;
  }
  next.returning = tab === undefined;
  setApp({ dialog: "settings", settingsTab: tab ?? place.tab, settingsAccount: account });
}

/** The rows (their `data-setting-scope`) a section opens with: the ones open when Settings was left, on a return only. Read once, by a lazy initializer. */
export function reopenedRows(): ReadonlySet<string> {
  return new Set(next.returning ? place.open : []);
}

/** Find, or anything else that scrolls the pane to a setting, takes over from a return still waiting for its rows. */
export function endReturn(): void {
  current.stop?.();
}

export interface PaneState {
  tab: SettingsTab;
  /** a page inside the section (Writing style, a snippet's editor): its scroll isn't the section's place */
  page: boolean;
  /** the sheet is showing (it hides under the fatal modal) */
  open: boolean;
}

/**
 * Settings' pane mounted: comes back to the place if this open asked for it, and keeps the place as the pane scrolls
 * (one passive listener while Settings is open, writing two fields). `sectionChanged` after a section switch,
 * `dispose` as the pane unmounts (its DOM still there): the rows open then are kept, and nothing is left running.
 */
export function trackSettingsPane(scroller: HTMLElement, state: () => PaneState): { sectionChanged(): void; dispose(): void } {
  let back: ((write: boolean) => void) | null = null;
  const note = () => {
    const s = state();
    if (back || !s.open) return;
    // on a page the section keeps where its button was; a section first shown on one starts at its top
    if (!s.page) place.top = scroller.scrollTop;
    else if (place.tab !== s.tab) place.top = 0;
    place.tab = s.tab;
  };
  const start = state();
  if (next.returning && place.tab === start.tab && place.top > 0 && !start.page) {
    back = scrollBack(scroller, place.top, (write) => {
      back = null;
      if (write) note();
    });
  }
  if (!back) note();
  next.returning = false;
  scroller.addEventListener("scroll", note, { passive: true });
  return {
    sectionChanged() {
      back?.(false);
      note();
    },
    dispose() {
      back?.(false);
      scroller.removeEventListener("scroll", note);
      place.open = [...scroller.querySelectorAll("[data-setting-open][aria-expanded=true]")].flatMap((el) => el.closest("[data-setting-scope]")?.getAttribute("data-setting-scope") ?? []);
      next.returning = true;
    },
  };
}

const INPUT = ["wheel", "pointerdown", "touchstart", "keydown"] as const;

/**
 * Scrolls the pane to `top`. A section whose rows come from the backend is short for a moment: each time its content
 * grows the pane is put back, until it's there, the person scrolls, points or types in it, or `RETURN_WAIT_MS` passes;
 * then `ended` hears it with `write`. Stopped from outside (a section switch, Find, a close) `write` is false, so the
 * place stays the target. Null when the pane is there at once (nothing to wait for).
 */
function scrollBack(scroller: HTMLElement, top: number, ended: (write: boolean) => void): ((write: boolean) => void) | null {
  const reached = () => scroller.scrollTop >= top - 1;
  scroller.scrollTop = top;
  if (reached()) return null;
  let done = false;
  const stop = (write: boolean) => {
    if (done) return;
    done = true;
    observer.disconnect();
    clearTimeout(timer);
    for (const type of INPUT) scroller.removeEventListener(type, end);
    if (current.stop === yieldTo) current.stop = null;
    ended(write);
  };
  /** there, the person's own input, or the wait over: where the pane is now is the place */
  const end = () => stop(true);
  /** something else scrolls it (Find) */
  const yieldTo = () => stop(false);
  const observer = new ResizeObserver(() => {
    scroller.scrollTop = top;
    if (reached()) stop(true);
  });
  for (const child of scroller.children) observer.observe(child);
  const timer = setTimeout(end, RETURN_WAIT_MS);
  for (const type of INPUT) scroller.addEventListener(type, end, { passive: true });
  current.stop = yieldTo;
  return stop;
}

/** Tests: a new window's memory. */
export function resetSettingsPlace(): void {
  current.stop?.();
  Object.assign(place, { tab: "general", top: 0, open: [] });
  next.returning = true;
}
