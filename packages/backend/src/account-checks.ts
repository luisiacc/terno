import type { MailStore } from "@terno/store";
import { readOfferAnswers } from "./settings";

/**
 * Plan 211: the check of mail already here is the backend's, one account at a time, with no offer. Each worker keeps the
 * accounts it has checked under its own key, with when: an account is checked once it has synced and its switches let the
 * worker read it, and again, from the moment it stopped being readable, when it's readable again (revisions 7 and 8:
 * "already read" isn't stored, so what came before was read, or checked, while it was on).
 */
export const DATED_CHECKED_KEY = "dated:checked";
export const FOLLOWUPS_CHECKED_KEY = "followups:checked";
/** revision 10: once the offers' answers are carried over */
const CHECKS_VERSION_KEY = "checks:version";
const CHECKS_VERSION = 1;

/**
 * An account's record: when its check was queued, and the first moment since then it stopped being readable (its switches,
 * or follow-ups' own), a gap owed until a check covers it. Kept here, not read from the account's `aiOffAt`/`feedOffAt`:
 * those keep each switch's latest moment only, and two switches going off and on in turn would lose a gap's start.
 */
interface Entry {
  at: number;
  gap?: number;
}
type Checked = Record<string, Entry>;

export interface AccountChecksHost {
  readonly store: Pick<MailStore, "settings" | "accounts">;
  /** the worker's key in the settings store */
  readonly key: string;
  now(): number;
  /** the feature is on and AI can run (plans 147, 150): nothing is checked otherwise */
  active(): Promise<boolean>;
  /** the account's switches let the worker read it (a lookup: asked on every pass's end) */
  allowed(accountId: number): boolean;
  /** what else of the account the worker asks (follow-ups' own switch); absent, nothing */
  wanted?(accountId: number): Promise<boolean>;
  /**
   * Queue the account's mail in the worker's window, from `since` when it's a gap's (null: the whole window). False when it
   * couldn't, asked again at that moment (the feature or the account's switches went off meanwhile): then nothing's recorded.
   */
  check(accountId: number, since: number | null): Promise<boolean>;
  log(level: "info" | "warn" | "error", message: string, extra?: unknown): void;
}

export class AccountChecks {
  private checked: Map<number, Entry> | null = null;
  private chain: Promise<void> = Promise.resolve();
  /** from the worker's start, once the upgrade (revision 10) wrote what's checked: never if it failed */
  private open = false;

  constructor(private readonly host: AccountChecksHost) {}

  /** The worker started after `upgradeChecks`: checks may be made from now on, and are, for every account. */
  start(): Promise<void> {
    this.open = true;
    return this.reconcile();
  }

  /**
   * Revision 9: a sync pass ended with the account synced (a first sync that ended offline too). An account checked, with
   * no gap owed, is a lookup in memory, and so is one the worker may not read.
   */
  synced(accountId: number): Promise<void> {
    const entry = this.checked?.get(accountId);
    if (!this.open || (entry && entry.gap === undefined) || !this.host.allowed(accountId)) return Promise.resolve();
    return this.reconcile([accountId]);
  }

  /** Every account (`only`: those): the worker's start, the feature on, AI available, a switch back on. Serialized. */
  reconcile(only?: readonly number[]): Promise<void> {
    return this.serially(() => this.pass(only));
  }

  /**
   * The account stopped being readable (a switch off): a checked one owes what comes from now, until a check covers it.
   * The first such moment is kept: turned on and off again before any check, the gap still starts there.
   */
  withdrawn(accountId: number): Promise<void> {
    const at = this.host.now();
    return this.serially(async () => {
      const checked = await this.load();
      const entry = checked.get(accountId);
      if (!entry || entry.gap !== undefined) return;
      checked.set(accountId, { ...entry, gap: at });
      await this.save(checked);
    });
  }

  /** An account removed: its id may come back as another's (SQLite reuses the highest). */
  forget(accountId: number): Promise<void> {
    return this.serially(async () => {
      const checked = await this.load();
      if (checked.delete(accountId)) await this.save(checked);
    });
  }

  private serially(work: () => Promise<void>): Promise<void> {
    if (!this.open) return Promise.resolve();
    this.chain = this.chain.then(work).catch((error: unknown) => this.host.log("warn", "the check of mail already here failed", error instanceof Error ? error.name : "error"));
    return this.chain;
  }

  private async load(): Promise<Map<number, Entry>> {
    this.checked ??= new Map(Object.entries(await this.host.store.settings.get<Checked>(this.host.key, {})).map(([id, entry]) => [Number(id), entry]));
    return this.checked;
  }

  private save(checked: Map<number, Entry>): Promise<void> {
    return this.host.store.settings.set(this.host.key, Object.fromEntries(checked));
  }

  private async pass(only: readonly number[] | undefined): Promise<void> {
    const checked = await this.load();
    const due: { accountId: number; since: number | null }[] = [];
    for (const account of await this.host.store.accounts.list()) {
      if (only && !only.includes(account.id)) continue;
      // its first sync done (as stored: a pass that ended offline says so too)
      if (!this.host.allowed(account.id) || account.syncState.lastSyncAt === null) continue;
      const entry = checked.get(account.id);
      if (!entry) due.push({ accountId: account.id, since: null });
      else if (entry.gap !== undefined) due.push({ accountId: account.id, since: entry.gap });
    }
    if (!due.length || !(await this.host.active())) return;
    for (const { accountId, since } of due) {
      if (this.host.wanted && !(await this.host.wanted(accountId))) continue;
      const now = this.host.now();
      // the queue first, then the record: a crash between queues again, and a queue ignores what's marked already (the
      // dated reader's candidates keep what's marked, so the same messages are picked, never the next ones)
      if (!(await this.host.check(accountId, since))) continue;
      checked.set(accountId, { at: now });
      await this.save(checked);
    }
  }
}

/**
 * Revision 10: an install that answered the offer (yes or no) counts every account it had then as checked, so nothing
 * declined is read now; one that never answered checks each. Once, at startup, before any worker starts; a failure keeps
 * the checks closed until the next start (the workers' `start({ checks: false })`).
 */
export async function upgradeChecks(store: Pick<MailStore, "settings" | "accounts">, now: number): Promise<void> {
  if ((await store.settings.get<number>(CHECKS_VERSION_KEY, 0)) >= CHECKS_VERSION) return;
  const answered = await readOfferAnswers(store);
  if (answered.dated || answered.followups) {
    const all = everyAccount(await store.accounts.list(), now);
    if (answered.dated) await store.settings.set(DATED_CHECKED_KEY, all);
    if (answered.followups) await store.settings.set(FOLLOWUPS_CHECKED_KEY, all);
  }
  await store.settings.set(CHECKS_VERSION_KEY, CHECKS_VERSION);
}

/** A made-up mailbox (the demo's) counts as checked: thousands of a model's reads of nothing, at every start, otherwise. */
export async function countAsChecked(store: Pick<MailStore, "settings" | "accounts">, now: number): Promise<void> {
  const all = everyAccount(await store.accounts.list(), now);
  await store.settings.set(DATED_CHECKED_KEY, all);
  await store.settings.set(FOLLOWUPS_CHECKED_KEY, all);
}

const everyAccount = (accounts: readonly { id: number }[], now: number): Checked => Object.fromEntries(accounts.map((a) => [a.id, { at: now }]));
