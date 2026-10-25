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

let reflowTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Rows are leaving the list (archive, trash, a move out of the category view): the ones leaving fade
 * out as detached copies while the rest slide up. data-reflow enables the
 * slide on the listbox only for this window, so navigation never animates.
 */
export function reflowRemoval(ids: readonly number[]): void {
  const ms = motionMs();
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
  list.dataset.reflow = "";
  if (reflowTimer) clearTimeout(reflowTimer);
  reflowTimer = setTimeout(() => delete list.dataset.reflow, Math.min(ms * 1.33, 100) + 60);
}
