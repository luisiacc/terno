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
    sheet.id = "unica-flash";
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
