/**
 * Plan 38: what deserves the user's attention outside the window: the Dock's
 * number. Pure: the backend decides when, main and the page show.
 */

/** The Dock badge: nothing at 0, the number up to 9,999, then "9999+" (five digits cover the icon). */
export function badgeText(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "";
  return count > 9999 ? "9999+" : String(Math.floor(count));
}
