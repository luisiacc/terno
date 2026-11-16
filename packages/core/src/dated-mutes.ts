import { addressKey, automatedLevel } from "./people";
import { DATED_KINDS, type DatedKind } from "./dated";

/**
 * Plan 210 (iteration 4, the owner's "Mute this kind/sender"; the Codex review's revision 2): senders and kinds the reader
 * said not to show in What matters. A muted sender's mail isn't read for it at all (no AI cost); a muted kind's new items
 * aren't stored, while its settlements and moves still go through. What's already there is hidden, not closed, and
 * comes back on Unmute. A store-owned table (`dated_mutes`, both stores), bounded and never evicting.
 *
 * Iteration 5 (the owner's narrow offer; that review's revision 2): a `pair` is one kind from one sender ("deliveries
 * from Parcelo"), an identity of its own beside a whole sender and a whole kind, kept in a companion table
 * (`dated_mute_pairs`). It suppresses and hides that kind from that sender only: their mail is still read, their other
 * kinds, settlements and moves go through, and Needs you never loses their conversations.
 */

/** the most mutes kept: at this many, another is refused (never one dropped for it) */
export const DATED_MUTES_MAX = 200;
/** a sender's name as the list shows it, at most */
export const DATED_MUTE_NAME_MAX = 200;
/** the most sender–kind pairs kept, a bound of their own (each Remove may offer one), refused the same way */
export const DATED_MUTE_PAIRS_MAX = 200;

export type DatedMuteOn = "sender" | "kind" | "pair";

export interface DatedMute {
  on: DatedMuteOn;
  /** a sender's `addressKey`, a `DatedKind`, or a pair's `pairKey` */
  key: string;
  /** a sender's (or a pair's sender's) name as their mail gave it (may be empty: the list then shows the address); a kind's, empty */
  name: string;
  at: number;
}

/**
 * What Remove's snack offers to mute (once each): that kind from that sender, or the sender alone with positive evidence
 * they're a machine; never anything of someone the user has written to. A whole kind is only Settings' to hide.
 */
export type MuteOffer = { on: "pair"; key: string; kind: DatedKind; name: string } | { on: "sender"; key: string; name: string };

/** What the reader and the feed test against, read once from the list. */
export interface DatedMuted {
  senders: ReadonlySet<string>;
  kinds: ReadonlySet<DatedKind>;
  /** `pairKey`s: they hide and suppress items, never silence a sender */
  pairs: ReadonlySet<string>;
}

export const NOTHING_MUTED: DatedMuted = { senders: new Set(), kinds: new Set(), pairs: new Set() };

const KINDS: ReadonlySet<string> = new Set(DATED_KINDS);
export const isDatedKind = (key: string): key is DatedKind => KINDS.has(key);

const senderKeyOf = (key: string): string | null => {
  const k = addressKey(key);
  return k.includes("@") ? k : null;
};

/** One kind from one sender, as stored and sent: the kind first (no kind holds the bar, so the first one splits it). */
export const pairKey = (kind: DatedKind, senderKey: string): string => `${kind}|${senderKey}`;

/** A pair's parts, normalized; null unless both are ours. */
export function pairOf(key: string): { kind: DatedKind; sender: string } | null {
  const bar = key.indexOf("|");
  if (bar < 0) return null;
  const kind = key.slice(0, bar).trim();
  const sender = senderKeyOf(key.slice(bar + 1));
  return isDatedKind(kind) && sender !== null ? { kind, sender } : null;
}

/** A mute's key as stored: a sender's address normalized (`addressKey`), a kind only one of ours, a pair both; null for anything else. */
export function muteKey(on: DatedMuteOn, key: string): string | null {
  if (on === "kind") return isDatedKind(key) ? key : null;
  if (on === "pair") {
    const p = pairOf(key);
    return p && pairKey(p.kind, p.sender);
  }
  return senderKeyOf(key);
}

export function mutedOf(list: readonly Pick<DatedMute, "on" | "key">[]): DatedMuted {
  if (!list.length) return NOTHING_MUTED;
  const senders = new Set<string>();
  const kinds = new Set<DatedKind>();
  const pairs = new Set<string>();
  for (const m of list) {
    if (m.on === "sender") senders.add(m.key);
    else if (m.on === "pair") pairs.add(m.key);
    else if (isDatedKind(m.key)) kinds.add(m.key);
  }
  return { senders, kinds, pairs };
}

/** An item hidden while its sender, its kind or that kind from its sender is muted (it comes back on Unmute: nothing is closed). */
export const isMuted = (r: { senderKey: string; kind: DatedKind }, m: DatedMuted): boolean =>
  m.senders.has(r.senderKey) || m.kinds.has(r.kind) || (m.pairs.size > 0 && m.pairs.has(pairKey(r.kind, r.senderKey)));

/** Anything muted at all (the feed's filter is skipped when nothing is). */
export const anyMuted = (m: DatedMuted): boolean => m.senders.size > 0 || m.kinds.size > 0 || m.pairs.size > 0;

/**
 * The kinds Settings may hide whole (iteration 5: Remove's snack offers no whole kind): what mail tells the reader, never
 * a person's request of them (`ask`, `respond`): one wrong choice mustn't hide every request.
 */
export const WHOLE_MUTE_KINDS: readonly DatedKind[] = ["pay", "renew", "expire", "alert", "event", "delivery"];

/**
 * Positive evidence a sender is a machine, which offering them alone needs: list or bulk headers on their mail, or a
 * no-reply address (plan 17's level 2). A role address ("orders@") isn't enough: a person may answer it. Whether the user
 * has written to them is checked apart (`dated.written`), before any offer and again on taking it.
 */
export const automatedSender = (src: { automated: boolean; fromEmail: string }): boolean =>
  src.automated || automatedLevel({ from_email: src.fromEmail, list_id: null, is_bulk: 0, gmail_labels: null, is_spam: 0 }) === 2;
