/**
 * The mounted list's way to bring a row into view by its index (the Inbox's list, or What matters' feed, plan 210), set
 * by whichever is on screen. Here, not in either component, so the keyboard and focus helpers reach it without them.
 */
export const listScroller: { scrollToIndex?: (i: number) => void } = {};
