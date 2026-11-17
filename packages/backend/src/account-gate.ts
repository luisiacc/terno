import type { Account } from "@terno/core";

/** Plan 211: an account's two switches, as the workers read them. */
export interface AccountSwitches {
  /** "Use AI with this account": off, none of its mail reaches an AI provider */
  ai: boolean;
  /** "Show in What matters": off, nothing of it is in the feed */
  feed: boolean;
}

/** One account's switches moved (an account added or removed isn't a change: its work starts or ends on its own path). */
export interface GateChange {
  accountId: number;
  before: AccountSwitches;
  after: AccountSwitches;
}

const ON: AccountSwitches = { ai: true, feed: true };
const switchesOf = (a: Pick<Account, "ai" | "feed">): AccountSwitches => ({ ai: a.ai !== false, feed: a.feed !== false });

/**
 * Plan 211: the one place every worker asks whether an account's mail may go to an AI provider, and whether it's in What
 * matters. A map in memory, refreshed from the stored accounts (at startup, and before every `accounts` event, so no
 * window hears of a switch before the workers do): a lookup, never a query, on any hot path. An account it hasn't heard
 * of yet is on, its default.
 */
export class AccountGate {
  private switches = new Map<number, AccountSwitches>();
  private aiOffIds: number[] = [];
  private feedOffIds: number[] = [];
  private readonly listeners: ((changes: readonly GateChange[]) => void)[] = [];

  /** May its mail reach an AI provider, for any feature? */
  ai(accountId: number): boolean {
    return this.switches.get(accountId)?.ai !== false;
  }

  /** Is it in What matters at all: its local rows (Needs you, reminders) follow this alone. */
  feed(accountId: number): boolean {
    return this.switches.get(accountId)?.feed !== false;
  }

  /** May the feed's AI read it (the dated reader, follow-ups, the digest), and its AI-made rows show: both switches. */
  reads(accountId: number): boolean {
    return this.ai(accountId) && this.feed(accountId);
  }

  /** The accounts no AI may read, for a store's account filter (empty, the usual case: no filter at all). */
  get aiOff(): readonly number[] {
    return this.aiOffIds;
  }

  /** The accounts the feed's AI may not read, nor its AI-made rows show: AI off or the feed off. */
  get readsOff(): readonly number[] {
    return this.feedOffIds.length ? [...new Set([...this.aiOffIds, ...this.feedOffIds])] : this.aiOffIds;
  }

  /** The accounts out of What matters altogether. */
  get feedOff(): readonly number[] {
    return this.feedOffIds;
  }

  /** Told, synchronously, of every switch that moves; before anything else hears of it. */
  onChange(listener: (changes: readonly GateChange[]) => void): void {
    this.listeners.push(listener);
  }

  /** Every account as stored: the map becomes them (those gone leave it). */
  set(accounts: readonly Pick<Account, "id" | "ai" | "feed">[]): void {
    const next = new Map(accounts.map((a) => [a.id, switchesOf(a)]));
    this.apply(next);
  }

  /** One account as just written (`accounts.update`'s), ahead of the next full read. */
  put(account: Pick<Account, "id" | "ai" | "feed">): void {
    const next = new Map(this.switches);
    next.set(account.id, switchesOf(account));
    this.apply(next);
  }

  private apply(next: Map<number, AccountSwitches>): void {
    const changes: GateChange[] = [];
    for (const [accountId, after] of next) {
      // one not heard of yet was on, as the lookups said
      const before = this.switches.get(accountId) ?? ON;
      if (before.ai !== after.ai || before.feed !== after.feed) changes.push({ accountId, before, after });
    }
    this.switches = next;
    this.aiOffIds = [...next].flatMap(([id, s]) => (s.ai ? [] : [id]));
    this.feedOffIds = [...next].flatMap(([id, s]) => (s.feed ? [] : [id]));
    if (changes.length) for (const listener of this.listeners) listener(changes);
  }
}
