/**
 * The last measured height of each message's frame, folded (as a frame opens: its quoted history folded), so a message
 * opens to it, not to a guess that jumps when measured. Keyed by message id; a held send's card by `heldBodyId`.
 */
const heights = new Map<number, number>();
/** a body shown first under another key (a held send's card, then its copy): that key's, until its own is measured */
const standIns = new Map<number, number>();
const MAX = 500;

function bounded(map: Map<number, number>, key: number, value: number) {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX) map.delete(map.keys().next().value!);
}

export function rememberHeight(key: number, h: number): void {
  bounded(heights, key, h);
  standIns.delete(key);
}

/** Its own height, else its stand-in's as measured now (read as the frame opens, never copied earlier: it may change) */
export function frameHeight(key: number): number | undefined {
  const from = standIns.get(key);
  return heights.get(key) ?? (from === undefined ? undefined : heights.get(from));
}

/** `to` opens at `from`'s height until it measures its own: the same body, shown first under another key */
export function standIn(to: number, from: number): void {
  if (!heights.has(to)) bounded(standIns, to, from);
}
