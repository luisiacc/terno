/**
 * The windows the site's pictures are taken in (plan 97), in CSS pixels: what the capture scripts set and what
 * render.test.ts holds each section picture inside. Plain data, so the test can read it without the scripts.
 */

/** A laptop-sized window, so the app reads large on the site; captured at 2×. */
export const VIEWPORT = { width: 1280, height: 800 };
/** The shortcuts sheet is as tall as the window lets it be: a taller one shows more of the keyboard. */
export const SHORTCUTS_WINDOW = { width: VIEWPORT.width, height: 900 };
/** The filed newsletter with the offer under it: short enough that the snackbar sits just under the reply bar. */
export const FILED_WINDOW = { width: VIEWPORT.width, height: 510 };
