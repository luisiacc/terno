import { anyMuted, automatedSender, calendarService, DATED_MUTE_PAIRS_MAX, DATED_MUTES_MAX, isMuted, muteKey, mutedOf, pairKey, pairOf, type DatedKind, type DatedMute, type DatedMuteOn, type DatedMuted, type MuteOffer } from "@terno/core";
import { RpcError } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import type { MailStore } from "@terno/store";

/**
 * Plan 210 (iteration 4, the owner's "Mute this kind/sender"; the Codex review's revision 2): what the reader said not to
 * show in What matters, kept by the store (`dated.mutes`). Here: what Remove’s snack offers (once per kind from a sender, and per sender),
 * muting and unmuting, and telling the reader and the feed. Nothing here is logged or sent anywhere.
 */

/** what’s been offered once (`pair:…`, `sender:…`; iteration 4’s `kind:…` left as they were), in the store’s own small values: a memory of offers (dropping the oldest loses nothing) */
const OFFERED_KEY = "whatMatters:muteOffered";
const OFFERED_MAX = 500;

/**
 * Codex's code review of iteration 4: Unmute is for mail from then on, so it keeps when each sender was unmuted (the newest
 * 500, as `[key, at]`): their mail from before it, queued or consumed unread while they were muted, is never read later.
 */
const UNMUTED_KEY = "whatMatters:unmutedAt";
const UNMUTED_MAX = 500;

/** What the reader leaves unread: the muted senders, and when each one unmuted was. */
export interface DatedSilence {
  muted: DatedMuted;
  unmutedAt: ReadonlyMap<string, number>;
}

export async function silenceOf(store: MailStore): Promise<DatedSilence> {
  const [list, unmuted] = await Promise.all([store.dated.mutes.list(), store.settings.get<[string, number][]>(UNMUTED_KEY, [])]);
  return { muted: mutedOf(list), unmutedAt: new Map(unmuted) };
}

/** A message the reader never reads: its sender's muted, or it's from before they were unmuted. */
export const silenced = (s: { senderKey: string; date: number }, x: DatedSilence): boolean => x.muted.senders.has(s.senderKey) || s.date < (x.unmutedAt.get(s.senderKey) ?? -Infinity);

export interface DatedMutesHost {
  readonly store: MailStore;
  now(): number;
  /** a mute or an Unmute: What matters reads its items again, and the reader stops a reading of a sender just muted */
  changed(muted: DatedMuted): void;
  /** plan 240: a sender mute ended a Show: those threads' facts were recomputed, and the list moved */
  shownStopped?(threadIds: readonly number[]): void;
}

export class DatedMutes {
  constructor(private readonly host: DatedMutesHost) {}

  async list(): Promise<DatedMute[]> {
    return this.host.store.dated.mutes.list();
  }

  async muted(): Promise<DatedMuted> {
    return mutedOf(await this.host.store.dated.mutes.list());
  }

  /**
   * After Remove (the user's own, on this item). Iteration 5 (the owner's narrow offer): that kind from that sender, the
   * first time it's removed; else the sender alone, the first time theirs is, only with positive evidence they're a
   * machine (`automatedSender`). Nothing at all for someone the user has written to (checked here and again on taking
   * it), and never a whole kind (Settings' to hide). Each is offered once, ever; nothing already muted is offered. Null:
   * nothing to offer. The claims ledger's second batch: a calendar service's invitation is named by the service, never by
   * the person it was sent in the name of (`calendarService`).
   */
  async offer(id: number): Promise<MuteOffer | null> {
    const { store } = this.host;
    const row = await store.dated.get(id);
    if (!row || row.state !== "dismissed" || row.closedReason !== "user" || muteKey("sender", row.senderKey) === null) return null;
    const [muted, written, src, from] = await Promise.all([this.muted(), store.dated.written([row.senderKey]), store.dated.source(row.messageId), store.today.fromOf([row.messageId])]);
    // plan 240: never to hide a sender the user said to always show
    if (written.has(row.senderKey) || muted.senders.has(row.senderKey) || (await store.today.shown.list()).some((s) => s.key === row.senderKey)) return null;
    const pair = pairKey(row.kind, row.senderKey);
    const alone = !!src && src.senderKey === row.senderKey && automatedSender(src);
    const sent = from.get(row.messageId);
    const service = calendarService({ fromEmail: row.senderKey });
    const name = service ?? (sent?.name.trim() || sent?.email.trim() || row.senderKey);
    const named = service ? { name, service } : { name };
    return store.settings.update<string[], MuteOffer | null>(OFFERED_KEY, [], (offered) => {
      const said = new Set(offered);
      const pick: MuteOffer | null =
        !muted.kinds.has(row.kind) && !muted.pairs.has(pair) && !said.has(`pair:${pair}`) ? { on: "pair", key: pair, kind: row.kind, ...named }
        : alone && !said.has(`sender:${row.senderKey}`) ? { on: "sender", key: row.senderKey, ...named }
        : null;
      if (!pick) return { value: offered, result: null };
      return { value: [...offered, `${pick.on}:${pick.key}`].slice(-OFFERED_MAX), result: pick };
    });
  }

  /**
   * At the bound, refused in plain words (nothing is dropped for it). Null: it was muted already. A new sender or pair
   * (not an Unmute's Undo, which puts back what was: `at`) is refused for someone the user has written to since it was
   * offered: their mail is never hidden by an offer they've outgrown.
   */
  async mute(m: { on: DatedMuteOn; key: string; name?: string; at?: number }): Promise<DatedMute | null> {
    const key = muteKey(m.on, m.key);
    if (key === null) throw new RpcError("BAD_REQUEST", L("errors.dated.muteInvalid"));
    const { store } = this.host;
    const sender = m.on === "sender" ? key : m.on === "pair" ? pairOf(key)!.sender : null;
    if (sender !== null && m.at === undefined && (await store.dated.written([sender])).has(sender)) {
      throw new RpcError("BAD_REQUEST", L("errors.dated.muteWritten", { sender: m.name?.trim() || sender }));
    }
    // plan 240: one sender is never both hidden and always shown: muting them ends the Show (an Unmute's Undo; Remove's
    // snack never offers to mute a shown sender)
    if (m.on === "sender") {
      const r = await store.today.shown.remove(key);
      if (r.removed) this.host.shownStopped?.(r.threadIds);
    }
    const now = this.host.now();
    // an Undo of an Unmute puts it back where it was in the list
    const mute: DatedMute = { on: m.on, key, name: m.on === "kind" ? "" : (m.name ?? ""), at: m.at !== undefined && m.at <= now ? m.at : now };
    const added = await store.dated.mutes.add(mute);
    if (added === "full") throw new RpcError("BAD_REQUEST", m.on === "pair" ? L("errors.dated.mutePairsFull", { count: DATED_MUTE_PAIRS_MAX }) : L("errors.dated.mutesFull", { count: DATED_MUTES_MAX }));
    if (added === "already") return null;
    this.host.changed(await this.muted());
    return mute;
  }

  /** What's muted shows again, as it is; mail from then on is read again (what came meanwhile stays unread). */
  async unmute(on: DatedMuteOn, key: string): Promise<DatedMute | null> {
    const { store } = this.host;
    // the boundary first, so the reader never sees the sender unmuted without it
    const sender = on === "sender" ? muteKey(on, key) : null;
    if (sender !== null && (await this.muted()).senders.has(sender)) {
      const at = this.host.now();
      await store.settings.update<[string, number][], void>(UNMUTED_KEY, [], (was) => ({ value: [...was.filter(([k]) => k !== sender), [sender, at] as [string, number]].slice(-UNMUTED_MAX), result: undefined }));
    }
    const removed = await store.dated.mutes.remove(on, key);
    if (!removed) return null;
    this.host.changed(await this.muted());
    return removed;
  }
}

/** Plan 210 (iteration 4): open items of a muted sender or kind (iteration 5: or that kind from that sender) are hidden wherever they’d show, never closed. */
export const withoutMuted = <T extends { senderKey: string; kind: DatedKind }>(rows: readonly T[], muted: DatedMuted): T[] => (anyMuted(muted) ? rows.filter((r) => !isMuted(r, muted)) : [...rows]);
