import { addressKey } from "./people";
import { DATED_KINDS, type DatedKind } from "./dated";

/**
 * Plan 210 (iteration 4, the owner's "Mute this kind/sender"; the Codex review's revision 2): senders and kinds the reader
 * said not to show in What matters. A muted sender's mail isn't read for it at all (no AI cost); a muted kind's new items
 * aren't stored, while its settlements and moves still go through. What's already there is hidden, not closed, and
 * comes back on Unmute. A store-owned table (`dated_mutes`, both stores), bounded and never evicting.
 */

/** the most mutes kept: at this many, another is refused (never one dropped for it) */
export const DATED_MUTES_MAX = 200;
/** a sender's name as the list shows it, at most */
export const DATED_MUTE_NAME_MAX = 200;

export type DatedMuteOn = "sender" | "kind";

export interface DatedMute {
  on: DatedMuteOn;
  /** a sender's `addressKey`, or a `DatedKind` */
  key: string;
  /** a sender's name as their mail gave it (may be empty: the list then shows the address); a kind's, empty */
  name: string;
  at: number;
}

/** What Remove's snack offers to mute (once each): the kind of what was removed, or its sender, by name. */
export type MuteOffer = { on: "kind"; key: DatedKind } | { on: "sender"; key: string; name: string };

/** What the reader and the feed test against, read once from the list. */
export interface DatedMuted {
  senders: ReadonlySet<string>;
  kinds: ReadonlySet<DatedKind>;
}

export const NOTHING_MUTED: DatedMuted = { senders: new Set(), kinds: new Set() };

const KINDS: ReadonlySet<string> = new Set(DATED_KINDS);
export const isDatedKind = (key: string): key is DatedKind => KINDS.has(key);

/** A mute's key as stored: a sender's address normalized (`addressKey`), a kind only one of ours; null for anything else. */
export function muteKey(on: DatedMuteOn, key: string): string | null {
  if (on === "kind") return isDatedKind(key) ? key : null;
  const k = addressKey(key);
  return k.includes("@") ? k : null;
}

export function mutedOf(list: readonly Pick<DatedMute, "on" | "key">[]): DatedMuted {
  if (!list.length) return NOTHING_MUTED;
  const senders = new Set<string>();
  const kinds = new Set<DatedKind>();
  for (const m of list) {
    if (m.on === "sender") senders.add(m.key);
    else if (isDatedKind(m.key)) kinds.add(m.key);
  }
  return { senders, kinds };
}

/** An item hidden while its sender or its kind is muted (it comes back on Unmute: nothing is closed). */
export const isMuted = (r: { senderKey: string; kind: DatedKind }, m: DatedMuted): boolean => m.senders.has(r.senderKey) || m.kinds.has(r.kind);

/**
 * The kinds Remove's snack may offer to mute ("Don't show deliveries like this"): what mail tells the reader, never a
 * person's request of them (`ask`, `respond`), which only their sender may be muted for: one wrong click mustn't hide
 * every request.
 */
export const OFFERED_MUTE_KINDS: readonly DatedKind[] = ["pay", "renew", "expire", "alert", "event", "delivery"];
