/**
 * Row and sidebar effects that must survive virtualization with zero React
 * renders: one injected <style> whose rules are keyed by data-thread-id (a
 * row that scrolls back into view picks its rule up again). Ids are integers,
 * never text from mail.
 */
import { motionMs } from "~/lib/appearance";

const rules = new Map<string, string>();
let sheet: HTMLStyleElement | null = null;

function render() {
  if (!sheet) {
    sheet = document.createElement("style");
    sheet.id = "terno-flash";
    document.head.appendChild(sheet);
  }
  sheet.textContent = [...rules.values()].join("\n");
}

export const rowSelector = (ids: readonly number[], suffix = "") => ids.map((id) => `[data-thread-id="${Math.trunc(id)}"]${suffix}`).join(",");

export function setRule(key: string, css: string | null): void {
  if (css === null) rules.delete(key);
  else rules.set(key, css);
  render();
}

/** The rows being dragged stay in place at half opacity. */
export function dimRows(ids: readonly number[] | null): void {
  setRule("dim", ids?.length ? `${rowSelector(ids)}{opacity:.5}` : null);
}

let seq = 0;
/** Plays a keyed effect for `ms` (+ a little), then drops its rule. Skipped when motion is off. */
function play(css: string, ms: number): void {
  if (motionMs() === 0) return;
  const key = `fx:${++seq}`;
  setRule(key, css);
  setTimeout(() => setRule(key, null), ms + 60);
}

/** After a drop: rows flash, their new dot pops in, the category's count bumps. */
export function flashDrop(ids: readonly number[], categoryId: number): void {
  const id = Math.trunc(categoryId);
  play(
    [
      `${rowSelector(ids)}{animation:drop-flash var(--motion-slow) var(--motion-ease)}`,
      `${rowSelector(ids, ` [data-cat-dot="${id}"]`)}{animation:dot-pop var(--motion-base) var(--motion-ease)}`,
      `[data-drop-target="${id}"] [data-slot=nav-count]{animation:count-bump var(--motion-slow) var(--motion-ease)}`,
    ].join("\n"),
    Math.min(motionMs() * 1.33, 100),
  );
}

/** Plan 127: a drop on a folder whose rows stay on screen: they flash; there's no dot to pop. */
export function flashRows(ids: readonly number[]): void {
  if (ids.length) play(`${rowSelector(ids)}{animation:drop-flash var(--motion-slow) var(--motion-ease)}`, Math.min(motionMs() * 1.33, 100));
}

let reflowTimer: ReturnType<typeof setTimeout> | null = null;

/** The listbox's rows slide to their places for this window (a removal's, plan 195: an arrival's too). */
export function armReflow(): void {
  const ms = motionNow();
  const list = document.querySelector<HTMLElement>("[role=listbox]");
  if (!list || ms === 0) return;
  list.dataset.reflow = "";
  if (reflowTimer) clearTimeout(reflowTimer);
  reflowTimer = setTimeout(() => delete list.dataset.reflow, Math.min(ms * 1.33, 100) + 60);
}

/**
 * Rows are leaving the list (archive, trash, a move out of the category view): the ones leaving fade
 * out as detached copies while the rest slide up. data-reflow enables the
 * slide on the listbox only for this window, so navigation never animates.
 */
export function reflowRemoval(ids: readonly number[]): void {
  const ms = motionNow();
  const list = document.querySelector<HTMLElement>("[role=listbox]");
  // nothing leaving (the filter kept the only target, the open thread): no rule to build, nothing to slide
  if (!list || ms === 0 || ids.length === 0) return;
  for (const row of list.querySelectorAll<HTMLElement>(rowSelector(ids))) {
    const ghost = row.cloneNode(true) as HTMLElement;
    ghost.removeAttribute("data-thread-id");
    ghost.removeAttribute("data-testid");
    ghost.setAttribute("aria-hidden", "true");
    ghost.style.pointerEvents = "none";
    row.parentElement?.appendChild(ghost);
    const fade = ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: Math.round(ms * 0.66), easing: "ease-out", fill: "forwards" });
    fade.onfinish = fade.oncancel = () => ghost.remove();
  }
  armReflow();
}

/**
 * The motion setting as it is now: 0 when it's off, reduced by the OS, or paused for the frames a language switch
 * re-mounts the app (`motion-paused`: CSS stops there, and script animations must too).
 */
export function motionNow(): number {
  if (typeof document !== "undefined" && document.documentElement.classList.contains("motion-paused")) return 0;
  return motionMs();
}

/** A motion token's value (WAAPI can't read a var()): the curves have one source, globals.css */
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * Plans 195–199: the one arrival. From 4 px below and transparent to settled, at --motion-slow on the motion ease (the
 * spring's small settle where a rare moment allows it). `translate` composes with a row's own transform. Nothing when
 * motion is off.
 */
export function arrive(el: Element | null, { spring = false }: { spring?: boolean } = {}): void {
  const ms = motionNow();
  if (!el || ms === 0) return;
  for (const a of el.getAnimations()) if (a.id === "arrive") a.cancel();
  el.animate([{ opacity: 0, translate: "0 4px" }, { opacity: 1, translate: "0 0" }], { id: "arrive", duration: Math.min(Math.round(ms * 1.33), 100), easing: token(spring ? "--motion-ease-spring" : "--motion-ease") || "ease-out" });
}

/** Plan 195: rows that just arrived at the list's top (the others slide down: armReflow, before the commit). */
export function arriveRows(ids: readonly number[]): void {
  const list = document.querySelector<HTMLElement>("[role=listbox]");
  if (!list) return;
  for (const row of list.querySelectorAll<HTMLElement>(rowSelector(ids))) arrive(row);
}

/**
 * Plan 196: a held message's mail leaves: the accent line across its top draws once, left to right (the crossbar of
 * Terno's mark), on the drawer's curve; it then stays while the mail is sending. Motion off: it's simply there.
 */
export function seal(line: Element | null): void {
  const ms = motionNow();
  if (!line || ms === 0) return;
  line.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { id: "seal", duration: Math.min(Math.round(ms * 1.33), 100), easing: token("--motion-ease-drawer") || "ease-out" });
}
