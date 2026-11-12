/**
 * Plan 191: an agent waiting for new mail on one account (a verification code, a reply). A Gmail-like account is
 * watched meanwhile (QuickChecks: checked every 5 s, as a focused window's); a push account already hears at once.
 * At the end of each pass the core hands over what it inserted as live mail. The wait ends with the first such
 * messages of that account that match the agent's `from` and `subject`, and are outside Spam and Trash (plan 185,
 * the owner's rule); or with nothing when its time is up.
 *
 * - Matching is per message, on what the arrival row holds (sender, subject): never a search, which matches
 *   conversations and lets `in:spam` in. The answer is those messages themselves, not their conversations'
 *   summaries (a message in Spam elsewhere in the conversation may have written its subject).
 * - A message whose body hasn't come while a filter reads bodies may still be moved to Spam: it is held until its
 *   body arrives (`bodyArrived`) or the wait ends.
 * - One wait per agent and account: a new one ends the one before (a call the agent cancelled leaves none behind).
 * - Nothing runs without a wait: `listening` is false and `arrived` returns at once. Queues and reads are bounded;
 *   the only timers are a wait's deadline and the watch's cadence (QuickChecks').
 */
import type { AgentArrival, ArrivalRow, ThreadSummary } from "@terno/core";

/** the most waits at once, across every agent */
export const AGENT_WAITS_MAX = 4;
/** the most arrivals a wait keeps to look at, or holds for their body, and a pass collects for them (the newest win) */
export const AGENT_ARRIVALS_MAX = 500;
const HELD_MAX = 50;
/** arrival rows read per store call */
const READ_CHUNK = 200;
/** messages a wait answers with */
const ANSWER_MAX = 10;

type Timer = ReturnType<typeof setTimeout>;

export interface AgentMailWaitHooks {
  /** QuickChecks.watch / unwatch */
  watch(key: string, accountId: number, forMs: number): void;
  unwatch(key: string): void;
  arrivals(messageIds: readonly number[]): Promise<ArrivalRow[]>;
  summaries(threadIds: readonly number[]): Promise<ThreadSummary[]>;
  /** an enabled filter reads bodies (it may still move mail whose body hasn't come) */
  bodyFilters(): Promise<boolean>;
  yieldTurn(): Promise<void>;
  now(): number;
  log?(message: string, error: unknown): void;
  setTimeout?(fn: () => void, ms: number): Timer;
  clearTimeout?(t: Timer): void;
}

export class AgentWaitBusyError extends Error {
  constructor() {
    super("Terno is already waiting for mail for other agents. Try again in a moment.");
  }
}

export interface AgentWaitMatch {
  /** a part of the sender's address or name (`github.com`, `GitHub`), any case */
  from?: string;
  /** a part of the subject, any case */
  subject?: string;
}

export interface AgentWaitResult {
  items: AgentArrival[];
  waitedMs: number;
}

interface Waiter {
  key: string;
  clientId: string;
  accountId: number;
  from: string;
  subject: string;
  timer: Timer | null;
  /** arrivals not looked at yet */
  pending: Set<number>;
  /** matching arrivals waiting for their body (a filter that reads bodies may still move them) */
  held: Set<number>;
  done: (items: AgentArrival[]) => void;
}

const norm = (s: string | undefined) => s?.trim().toLowerCase() ?? "";

/** keeps the newest (highest) ids when over the bound */
function bounded(set: Set<number>, max: number): void {
  if (set.size <= max) return;
  const keep = [...set].sort((a, b) => b - a).slice(0, max);
  set.clear();
  for (const id of keep) set.add(id);
}

export class AgentMailWaits {
  private readonly waiters = new Map<string, Waiter>();
  private seq = 0;
  private stopped = false;
  /** the look in progress per wait (one at a time; drained before the store closes) */
  private readonly looks = new Map<string, Promise<void>>();
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (t: Timer) => void;

  constructor(private readonly hooks: AgentMailWaitHooks) {
    this.setTimer = hooks.setTimeout ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      (t as { unref?: () => void }).unref?.();
      return t;
    });
    this.clearTimer = hooks.clearTimeout ?? ((t) => clearTimeout(t));
  }

  /**
   * Waits up to `waitMs` for new mail on the account matching `from` and `subject` (none: any). `quick`: watch the
   * account (checks every 5 s) meanwhile; a push or poll-only account only listens. Throws AgentWaitBusyError past
   * AGENT_WAITS_MAX. Synchronous up to the registration, so a caller that checked its connection just before can't
   * leave a wait behind a disconnect.
   */
  wait(p: { clientId: string; accountId: number; match?: AgentWaitMatch; waitMs: number; quick: boolean }): Promise<AgentWaitResult> {
    if (this.stopped) return Promise.resolve({ items: [], waitedMs: 0 });
    // the agent's earlier wait on this account is over: it asks again (or cancelled that call)
    for (const w of this.waiters.values()) if (w.clientId === p.clientId && w.accountId === p.accountId) w.done([]);
    if (this.waiters.size >= AGENT_WAITS_MAX) return Promise.reject(new AgentWaitBusyError());
    const key = `agent-wait:${++this.seq}`;
    const started = this.hooks.now();
    return new Promise<AgentWaitResult>((resolve) => {
      const w: Waiter = {
        key,
        clientId: p.clientId,
        accountId: p.accountId,
        from: norm(p.match?.from),
        subject: norm(p.match?.subject),
        timer: null,
        pending: new Set(),
        held: new Set(),
        done: (items) => {
          if (!this.waiters.delete(key)) return;
          if (w.timer) this.clearTimer(w.timer);
          w.timer = null;
          w.pending.clear();
          w.held.clear();
          if (p.quick) this.hooks.unwatch(key);
          resolve({ items, waitedMs: Math.max(0, this.hooks.now() - started) });
        },
      };
      this.waiters.set(key, w);
      w.timer = this.setTimer(() => w.done([]), p.waitMs);
      if (p.quick) this.hooks.watch(key, p.accountId, p.waitMs);
    });
  }

  /** A wait listens to this account: only then does a pass collect its arrivals. */
  listening(accountId: number): boolean {
    for (const w of this.waiters.values()) if (w.accountId === accountId) return true;
    return false;
  }

  /** A pass of the account ended: these are the messages it inserted as live mail (its flags and filters settled). */
  arrived(accountId: number, messageIds: readonly number[]): void {
    if (!this.waiters.size || !messageIds.length) return;
    for (const w of this.waiters.values()) {
      if (w.accountId !== accountId) continue;
      for (const id of messageIds) w.pending.add(id);
      bounded(w.pending, AGENT_ARRIVALS_MAX);
      this.look(w);
    }
  }

  /** A message's body arrived: a wait holding it looks again (its filters have now read it). */
  bodyArrived(messageId: number): void {
    if (!this.waiters.size) return;
    for (const w of this.waiters.values()) {
      if (!w.held.delete(messageId)) continue;
      w.pending.add(messageId);
      this.look(w);
    }
  }

  /** the agent's connection went: its waits end (nobody hears them) */
  disconnected(clientId: string): void {
    // a Map may lose the entry being visited
    for (const w of this.waiters.values()) if (w.clientId === clientId) w.done([]);
  }

  /** Ends every wait; resolves once no look reads the store any more. */
  stop(): Promise<void> {
    this.stopped = true;
    for (const w of this.waiters.values()) w.done([]);
    return Promise.allSettled(this.looks.values()).then(() => {});
  }

  /** waits in progress (tests) */
  get size(): number {
    return this.waiters.size;
  }

  /** one look per wait at a time; arrivals meanwhile join its queue and the same look (or the next) takes them */
  private look(w: Waiter): void {
    if (this.looks.has(w.key)) return;
    const run = this.drain(w)
      .catch((error: unknown) => this.hooks.log?.("agent wait: looking at new mail failed", error))
      .finally(() => {
        this.looks.delete(w.key);
        // queued after the loop's last check but before this: looked at now, not left for the next arrival (Codex code review #3)
        if (this.waiters.has(w.key) && w.pending.size) this.look(w);
      });
    this.looks.set(w.key, run);
  }

  private async drain(w: Waiter): Promise<void> {
    const alive = () => this.waiters.has(w.key);
    while (w.pending.size && alive()) {
      const ids = [...w.pending].slice(0, READ_CHUNK);
      for (const id of ids) w.pending.delete(id);
      const rows = await this.hooks.arrivals(ids);
      if (!alive()) return;
      const matched = rows.filter((r) => this.matches(w, r));
      // held before asking about filters: a body that comes meanwhile moves it back to pending (Codex code review #2)
      const waiting = matched.filter((r) => r.bodyPending);
      for (const r of waiting) w.held.add(r.id);
      const filters = waiting.length > 0 && (await this.hooks.bodyFilters());
      if (!alive()) return;
      let ready = matched.filter((r) => !r.bodyPending);
      if (!filters) {
        // nothing reads bodies: each still held goes now (one its body brought back is read again from pending)
        ready = [...ready, ...waiting.filter((r) => w.held.delete(r.id))];
      }
      bounded(w.held, HELD_MAX);
      if (!ready.length) {
        await this.hooks.yieldTurn();
        continue;
      }
      ready.sort((a, b) => b.date - a.date || b.id - a.id);
      // a conversation in Spam or Trash stays out (plan 185)
      const threads = await this.hooks.summaries([...new Set(ready.map((r) => r.threadId))]);
      if (!alive()) return;
      const outside = new Set(threads.filter((t) => !t.inSpam && !t.inTrash).map((t) => t.id));
      const items = ready.filter((r) => outside.has(r.threadId)).slice(0, ANSWER_MAX);
      if (items.length) {
        return w.done(items.map((r) => ({ threadId: r.threadId, messageId: r.id, fromName: r.fromName, fromEmail: r.fromEmail, subject: r.subject, snippet: r.snippet, date: r.date })));
      }
    }
  }

  private matches(w: Waiter, r: ArrivalRow): boolean {
    if (r.accountId !== w.accountId || r.isSpam || r.isTrash || r.isSent || r.isDraft) return false;
    if (w.from && !r.fromEmail.toLowerCase().includes(w.from) && !r.fromName.toLowerCase().includes(w.from)) return false;
    if (w.subject && !r.subject.toLowerCase().includes(w.subject)) return false;
    return true;
  }
}
