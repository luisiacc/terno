import { DATED_MUTES_MAX, isMuted, muteKey, mutedOf, OFFERED_MUTE_KINDS, type DatedKind, type DatedMute, type DatedMuteOn, type DatedMuted, type MuteOffer } from "@terno/core";
import { RpcError } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import type { MailStore } from "@terno/store";

/**
 * Plan 210 (iteration 4, the owner's "Mute this kind/sender"; the Codex review's revision 2): what the reader said not to
 * show in What matters, kept by the store (`dated.mutes`). Here: what Remove's snack offers (once per sender and per kind),
 * muting and unmuting, and telling the reader and the feed. Nothing here is logged or sent anywhere.
 */

/** what's been offered once, in the store's own small values: a memory of offers (dropping the oldest loses nothing) */
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
   * After Remove (the user's own, on this item): its kind, the first time an item of that kind is removed, unless it's a
   * person's request (`OFFERED_MUTE_KINDS`); else its sender, the first time theirs is. Each is offered once, ever; nothing
   * already muted is offered. Null: nothing to offer.
   */
  async offer(id: number): Promise<MuteOffer | null> {
    const { store } = this.host;
    const row = await store.dated.get(id);
    if (!row || row.state !== "dismissed" || row.closedReason !== "user") return null;
    const muted = await this.muted();
    const kind = `kind:${row.kind}`;
    const sender = `sender:${row.senderKey}`;
    const name = async () => {
      const from = (await store.today.fromOf([row.messageId])).get(row.messageId);
      return from?.name.trim() || from?.email.trim() || row.senderKey;
    };
    return store.settings.update<string[], MuteOffer | null>(OFFERED_KEY, [], (offered) => {
      const said = new Set(offered);
      const pick: MuteOffer | null =
        OFFERED_MUTE_KINDS.includes(row.kind) && !muted.kinds.has(row.kind) && !said.has(kind) ? { on: "kind", key: row.kind } : !muted.senders.has(row.senderKey) && !said.has(sender) && muteKey("sender", row.senderKey) ? { on: "sender", key: row.senderKey, name: "" } : null;
      if (!pick) return { value: offered, result: null };
      return { value: [...offered, pick.on === "kind" ? kind : sender].slice(-OFFERED_MAX), result: pick };
    }).then(async (pick) => (pick?.on === "sender" ? { ...pick, name: await name() } : pick));
  }

  /** At the bound, refused in plain words (nothing is dropped for it). Null: it was muted already. */
  async mute(m: { on: DatedMuteOn; key: string; name?: string; at?: number }): Promise<DatedMute | null> {
    const key = muteKey(m.on, m.key);
    if (key === null) throw new RpcError("BAD_REQUEST", L("errors.dated.muteInvalid"));
    const now = this.host.now();
    // an Undo of an Unmute puts it back where it was in the list
    const mute: DatedMute = { on: m.on, key, name: m.on === "sender" ? (m.name ?? "") : "", at: m.at !== undefined && m.at <= now ? m.at : now };
    const added = await this.host.store.dated.mutes.add(mute);
    if (added === "full") throw new RpcError("BAD_REQUEST", L("errors.dated.mutesFull", { count: DATED_MUTES_MAX }));
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

/** Plan 210 (iteration 4): open items of a muted sender or kind are hidden wherever they'd show, never closed. */
export const withoutMuted = <T extends { senderKey: string; kind: DatedKind }>(rows: readonly T[], muted: DatedMuted): T[] => (muted.senders.size || muted.kinds.size ? rows.filter((r) => !isMuted(r, muted)) : [...rows]);
