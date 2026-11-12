/**
 * Plan 188: the app's one polite voice for what changed where focus isn't (the list under a sidebar row, the conversation
 * j moved to, a summary that's ready). One region, always in the page: a region that arrives with its words is read
 * unreliably, and the same words twice must be said twice, so it's emptied and written on the next frame.
 */
const region: { el: HTMLElement | null; frame: number } = { el: null, frame: 0 };

export function announce(text: string): void {
  const el = region.el;
  if (!el || !text) return;
  el.textContent = "";
  if (typeof requestAnimationFrame === "undefined") return void (el.textContent = text);
  cancelAnimationFrame(region.frame);
  region.frame = requestAnimationFrame(() => {
    el.textContent = text;
  });
}

/** Mounted once, in the app's shell. */
export function Announcer() {
  return (
    <div
      ref={(el) => {
        region.el = el;
      }}
      role="status"
      aria-live="polite"
      aria-atomic
      className="sr-only"
      data-testid="announcer"
    />
  );
}
