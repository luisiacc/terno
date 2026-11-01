/** The window's smallest size: the reader keeps its minimum beside a sidebar and a list. */
export const MIN_WINDOW = { width: 980, height: 600 } as const;
/** Past this a mail client only gets emptier: the reader has a measure, the list a width. */
const MAX_WINDOW = { width: 1920, height: 1200 } as const;
/** How much of the screen a new window takes: most of it, with the desktop still showing around it. */
const SHARE = 0.92;

/** A new window's size on a screen whose usable area is `workArea`: large, never past the screen, never below the minimum. */
export function initialWindowSize(workArea: { width: number; height: number }): { width: number; height: number } {
  const fit = (area: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(area * SHARE)));
  return { width: fit(workArea.width, MIN_WINDOW.width, MAX_WINDOW.width), height: fit(workArea.height, MIN_WINDOW.height, MAX_WINDOW.height) };
}
