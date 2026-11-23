import { addressKey, SHOWN_SENDERS_MAX, type DatedMute, type ShownSender } from "@terno/core";
import { RpcError } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import type { MailStore } from "@terno/store";

/**
 * Plan 240 ("Always show in What matters", from a sender's menu): the senders whose every unanswered conversation waits on
 * you in What matters, whatever their mail looks like. The store keeps them and recomputes their threads' facts in the same
 * command (plan 17: a shown sender's newest unanswered message waits); here, the words, the exact Undos and who's told.
 * Local: nothing here reaches a model or leaves the machine.
 */

export interface ShownSendersHost {
  readonly store: MailStore;
  now(): number;
  uuid(): string;
  /** a Show is about to end this sender's mute: mail from before now stays unread, as after an Unmute (Codex code review) */
  unmuting(key: string): Promise<void>;
  /** the threads whose facts the store recomputed: lists, counts and What matters read them (and the facts' job wakes for a sender with more) */
  threadsChanged(threadIds: readonly number[]): void;
  /** the list moved (every window's menus and Settings), and a mute it removed (What matters reads its items again) */
  listChanged(senders: readonly ShownSender[], mutes: boolean): void;
}

export class ShownSenders {
  constructor(private readonly host: ShownSendersHost) {}

  list(): Promise<ShownSender[]> {
    return this.host.store.today.shown.list();
  }

  /** Whether this sender (any spelling of the address) is shown. */
  async has(email: string): Promise<boolean> {
    const key = addressKey(email);
    return (await this.list()).some((s) => s.key === key);
  }

  /**
   * Shown from now on, the sender's own mute gone with it (`unmuted`, for the Undo). `id` and `at`: a Stop's Undo puts back
   * that same entry, in its place in the list. Shown already: `added` null, nothing changes.
   */
  async show(p: { email: string; name: string; id?: string; at?: number }): Promise<{ added: ShownSender | null; unmuted: DatedMute | null }> {
    if (!addressKey(p.email).includes("@")) throw new RpcError("BAD_REQUEST", L("errors.shown.invalid"));
    await this.host.unmuting(addressKey(p.email));
    const now = this.host.now();
    const r = await this.host.store.today.shown.add({ id: p.id ?? this.host.uuid(), email: p.email, name: p.name, at: p.at !== undefined && p.at <= now ? p.at : now });
    if (r === "full") throw new RpcError("BAD_REQUEST", L("errors.shown.full", { count: SHOWN_SENDERS_MAX }));
    if (r.added) await this.told(r.threadIds, r.unmuted !== null);
    return { added: r.added, unmuted: r.unmuted };
  }

  /**
   * Back to What matters' usual rules for this sender. `id`: only that entry (a Show's Undo never takes off a later Show);
   * `mute`: the sender mute that Show removed, put back as it was (the Undo's other half).
   */
  async stop(p: { email: string; id?: string; mute?: { name: string; at: number } }): Promise<{ removed: ShownSender | null }> {
    const key = addressKey(p.email);
    // the mute back in the same command, whatever the bound (Codex code review: never an Undo that half happens)
    const r = await this.host.store.today.shown.remove(key, p.id, p.mute && { name: p.mute.name, at: Math.min(p.mute.at, this.host.now()) });
    if (!r.removed) return { removed: null };
    await this.told(r.threadIds, p.mute !== undefined);
    return { removed: r.removed };
  }

  private async told(threadIds: readonly number[], mutes: boolean): Promise<void> {
    this.host.threadsChanged(threadIds);
    this.host.listChanged(await this.list(), mutes);
  }
}
