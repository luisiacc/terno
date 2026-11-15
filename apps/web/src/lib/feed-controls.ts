/**
 * Plan 210 (iteration 1, Codex's critique point 10): Done and Later sit over an item's second line, and how wide they are is
 * the language's and the design's ("Hecho", "Más tarde"). The feed keeps their width as `--wm-controls`, so the line ends
 * before them; it's measured once for what the feed says it's drawn in (`data-controls-key`: the language and the design),
 * by the first item with controls that's drawn (the feed may open on items with none: Codex code review), and again when
 * either changes. One layout read each time, never one an item.
 */
export function measureControls(controls: HTMLElement | null, force = false): void {
  const feed = controls?.closest<HTMLElement>("[data-testid=wm-feed]");
  if (!controls || !feed) return;
  const key = feed.dataset.controlsKey ?? "";
  if (!force && feed.dataset.controlsFor === key) return;
  const width = controls.offsetWidth;
  if (!width) return;
  feed.style.setProperty("--wm-controls", `${width}px`);
  feed.dataset.controlsFor = key;
}
