import type { Locator } from "@playwright/test";

/**
 * Plan 161, pass 3: what in a menu or popover doesn't show whole: every element with text of its own whose content is wider
 * than its box, and the panel itself if it leaves the window. Empty when nothing is cut.
 */
export async function unclipped(panel: Locator): Promise<string[]> {
  return panel.evaluate((root) => {
    const cut: string[] = [];
    const box = root.getBoundingClientRect();
    if (box.left < 0 || box.right > window.innerWidth + 0.5 || box.top < 0 || box.bottom > window.innerHeight + 0.5) cut.push(`panel ${Math.round(box.left)}..${Math.round(box.right)} of ${window.innerWidth}`);
    for (const el of [root, ...root.querySelectorAll<HTMLElement>("*")]) {
      if (![...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim())) continue;
      // text for screen readers only (sr-only: a 1 px clipped box) is meant to be out of sight (plan 162)
      if (el.closest(".sr-only")) continue;
      if (el.scrollWidth > el.clientWidth + 0.5 && getComputedStyle(el).display !== "inline") cut.push(`${el.textContent!.trim()} (${el.scrollWidth} > ${el.clientWidth})`);
      const r = el.getBoundingClientRect();
      if (r.right > box.right + 0.5 || r.left < box.left - 0.5) cut.push(`${el.textContent!.trim()} outside the panel`);
    }
    return cut;
  });
}
