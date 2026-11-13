import { focusIntent } from "~/lib/focus-intent";
import { getApp } from "~/state/app";

/** how long a message may take to draw before its focus is given up */
const FOCUS_WAIT_MS = 10_000;

/**
 * Plan 161: what takes focus for a message in the reader (its header button; a one-message conversation's heading, or
 * the message itself where a design shows neither), or null while it isn't drawn. Shared by Ask's sources and links
 * to emails (plan 201).
 */
export function messageFocusTarget(messageId: number): HTMLElement | null {
  const article = document.querySelector<HTMLElement>(`[data-reader-scroller] article[data-message-id="${messageId}"]`);
  if (!article) return null;
  const el = article.querySelector<HTMLElement>("[data-testid=message-toggle]") ?? article.querySelector<HTMLElement>("h3") ?? article;
  if (el.tagName !== "BUTTON" && !el.hasAttribute("tabindex")) el.tabIndex = -1;
  return el;
}

/**
 * Focus for what a closing dialog leaves behind (a source's message, the pinned answer, a link's message): once the
 * dialog has gone and the target is drawn. It waits on the page changing (no polling), and yields to anything newer:
 * a key or a press, `wanted` turning false, or the wait running out.
 */
export function focusAfterDialog(target: () => HTMLElement | null, wanted: () => boolean): void {
  const seq = focusIntent.seq;
  const started = Date.now();
  const superseded = () => focusIntent.seq !== seq || !wanted() || Date.now() - started > FOCUS_WAIT_MS;
  /** done: focused, or nothing left to wait for */
  const attempt = (): boolean => {
    if (superseded()) return true;
    // the palette hands focus back once it has gone: wait for that, then take it
    if (getApp().dialog !== null || document.querySelector("[role=dialog]")) return false;
    const el = target();
    if (!el) return false;
    el.focus({ preventScroll: true });
    // a dialog's own restore may land a frame later: once more, unless the user moved
    requestAnimationFrame(() => {
      if (!superseded() && document.activeElement !== el) el.focus({ preventScroll: true });
    });
    return true;
  };
  if (attempt()) return;
  const watch = new MutationObserver(() => {
    if (attempt()) stop();
  });
  const timer = setTimeout(() => stop(), FOCUS_WAIT_MS);
  const stop = () => {
    watch.disconnect();
    clearTimeout(timer);
  };
  watch.observe(document.body, { childList: true, subtree: true });
}
