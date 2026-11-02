import { forwardAddresses, type Address, type CategoryForward, type ForwardRuleKind, type ForwardRuleRef, type FilterRule } from "@terno/core";
import type { AddedBy } from "./types";

/**
 * Plan 116's forwards, the part both stores share: what a rule's stored
 * state is, which category memberships make new mail go, and the row shape.
 * The SQL (`packages/db/src/forwards.ts`) and IndexedDB
 * (`packages/idb/src/forwards.ts`) adapters keep the same tables:
 *
 * - `forward_eligible`: new mail (live sync, under 3 days old, not mine),
 *   written by the ingest that inserted it; gone after FORWARD_ELIGIBLE_MS
 * - `forwards`: one row per (message, rule), the 10 s wait, the cap's hold,
 *   the sends it queued
 * - `forward_recipients`: one row per (message, address): a message goes to
 *   an address once, whatever rules name it
 */

/** A rule's state, stored with it (`categories.forward_json`, `filters.forward_json`). */
export interface ForwardRuleState {
  /** a category's addresses (a filter's are in its forward action) */
  addresses?: Address[];
  enabled: boolean;
  /** bumped when the addresses change or it is turned on: forwards waiting under an older one never go */
  rev: number;
  /** when it was last turned on: mail that arrived before isn't its */
  since: number;
  /** "Keep forwarding" until then: the cap doesn't hold its forwards */
  approvedUntil: number;
  /** a filter's addresses as compared (lowercased, in order) */
  key?: string;
}

export function readRuleState(json: unknown): ForwardRuleState | null {
  if (typeof json !== "string" || !json) return null;
  try {
    const v = JSON.parse(json) as Partial<ForwardRuleState>;
    if (typeof v.rev !== "number" || typeof v.since !== "number") return null;
    return { addresses: Array.isArray(v.addresses) ? v.addresses : undefined, enabled: v.enabled === true, rev: v.rev, since: v.since, approvedUntil: typeof v.approvedUntil === "number" ? v.approvedUntil : 0, key: typeof v.key === "string" ? v.key : undefined };
  } catch {
    return null;
  }
}

const keyOf = (list: readonly Address[]) => list.map((a) => a.email.toLowerCase()).join("\n");

/**
 * A category's trigger after the user saved it: null when it has no
 * addresses; a new revision (and `since`) when the addresses changed or it
 * was turned on, so what waited under the old one is cancelled.
 */
export function nextCategoryState(prev: ForwardRuleState | null, forward: CategoryForward | null, now: number): ForwardRuleState | null {
  const addresses = forwardAddresses(forward?.addresses ?? []);
  if (!addresses.length) return null;
  const enabled = forward?.enabled !== false;
  const changed = !prev || keyOf(prev.addresses ?? []) !== keyOf(addresses);
  const turnedOn = enabled && !prev?.enabled;
  if (!changed && !turnedOn) return { ...prev!, addresses, enabled };
  return { addresses, enabled, rev: (prev?.rev ?? 0) + 1, since: changed || turnedOn ? now : prev!.since, approvedUntil: 0 };
}

/** The forward action of a rule (a filter has at most one). */
export function forwardAction(rule: FilterRule): { type: "forward"; to: Address[] } | null {
  return (rule.actions.find((a) => a.type === "forward") as { type: "forward"; to: Address[] } | undefined) ?? null;
}

/**
 * A filter's state after it was saved: null without a forward action; a new
 * revision when its addresses changed, it gained the action, or the filter
 * was turned on. Saving it again from the builder resumes a paused one.
 */
export function nextFilterState(prev: ForwardRuleState | null, rule: FilterRule, filterEnabled: boolean, wasEnabled: boolean, now: number): ForwardRuleState | null {
  const action = forwardAction(rule);
  if (!action) return null;
  const key = keyOf(forwardAddresses(action.to));
  if (prev && prev.key === key && prev.enabled && (wasEnabled || !filterEnabled)) return prev;
  return { enabled: true, rev: (prev?.rev ?? 0) + 1, since: now, approvedUntil: 0, key };
}

/** Whether a rule's waiting forwards may go: it exists, is on, and is the revision they were made under. */
export function ruleCurrent(state: ForwardRuleState | null, rev: number, filterEnabled = true): boolean {
  return Boolean(state && state.enabled && filterEnabled && state.rev === rev);
}

/**
 * Whether a thread's membership in a category makes a new message there go:
 * - the thread was there before the message arrived (a reply in a filed conversation)
 * - Terno filed it: a filter, the engine (auto), a suggestion the user accepted
 * - an agent filed it, when agents may send
 * - the user filed this one conversation by hand (`filed`); a bulk filing or an undo never
 */
export function membershipForwards(m: { addedBy: AddedBy; addedAt: number }, arrivedAt: number, o: { filed: boolean; agentFiles: boolean }): boolean {
  if (m.addedAt < arrivedAt) return true;
  if (m.addedBy === "filter" || m.addedBy === "auto" || m.addedBy === "suggestion") return true;
  if (m.addedBy === "agent") return o.agentFiles;
  return o.filed;
}

export type ForwardRowState = "waiting" | "held" | "sending" | "queued" | "cancelled" | "failed";

export interface ForwardRow {
  id: number;
  messageId: number;
  threadId: number;
  accountId: number;
  ruleKind: ForwardRuleKind;
  ruleId: number;
  rev: number;
  /** the rule's addresses when it was made; once claimed, the ones this forward owns */
  to: Address[];
  state: ForwardRowState;
  dueAt: number;
  /** waiting for the original's files until then (null: not waiting for them) */
  filesUntil: number | null;
  filesMissing: boolean;
  /** one per send (forwardChunks), null until it is queued */
  opIds: (string | null)[];
  /** an i18n key: why Terno cancelled it or it failed */
  reason: string | null;
  createdAt: number;
  claimedAt: number | null;
  at: number;
}

/** A rule past its cap and what it holds. */
export interface ForwardHold {
  rule: ForwardRuleRef;
  count: number;
  held: number;
}

/** What claiming a due forward found. */
export type ForwardClaim =
  | { kind: "go"; row: ForwardRow; chunks: Address[][]; filesMissing: boolean }
  | { kind: "held"; row: ForwardRow }
  | { kind: "cancelled"; row: ForwardRow }
  /** not due, or not waiting (cancelled, claimed by another turn) */
  | { kind: "none" };

export interface ForwardsStore {
  /** any rule that forwards (an enabled category trigger, an enabled filter with a forward action): ingest marks new mail only then */
  active(): Promise<boolean>;
  /** a category's trigger (null: none); cancels its waiting and held forwards when it changes; null when the category is gone */
  setCategory(categoryId: number, forward: CategoryForward | null, now: number): Promise<{ changed: boolean } | null>;
  /**
   * New forwards for eligible messages (by message or by thread) whose rules
   * match them now, due in FORWARD_DELAY_MS. `filed`: threads the user filed
   * one at a time; `agentFiles`: an agent's filing counts (agents may send).
   */
  plan(p: { messageIds?: readonly number[]; threadIds?: readonly number[]; filed?: readonly number[]; agentFiles: boolean; now: number }): Promise<ForwardRow[]>;
  /** eligible messages after `after` (by id), for the sweep at start */
  eligiblePage(now: number, after: number, limit: number): Promise<number[]>;
  /** waiting, held, sending and queued, and what settled lately (newest first, at most `limit`) */
  list(now: number, limit: number): Promise<ForwardRow[]>;
  /** rules holding forwards (the questions) */
  holds(now: number): Promise<ForwardHold[]>;
  /** the soonest due waiting forward (null: none) */
  nextDue(): Promise<number | null>;
  /** the user's Cancel: those still waiting or held */
  cancel(ids: readonly number[], now: number): Promise<ForwardRow[]>;
  /**
   * A due forward, fenced in one transaction: its rule is current, the mail
   * is still in the category and not in Spam or Trash, the cap allows it
   * (else it is held), and the addresses no other forward of this message
   * owns are claimed for it. `filesMissing`: it goes without some files.
   */
  claim(id: number, now: number, o: { filesMissing: boolean; own: readonly string[] }): Promise<ForwardClaim>;
  /** a waiting forward waits for its files until `until` */
  waitForFiles(id: number, until: number, now: number): Promise<boolean>;
  /** a claimed forward that couldn't be queued: failed (its unqueued claims released) */
  fail(id: number, reason: string, now: number): Promise<void>;
  /** the user's Retry of a failed forward whose sends all failed before anything went: it waits again */
  retry(id: number, now: number, failedOps: readonly string[]): Promise<ForwardRow | null>;
  /** "Keep forwarding": no hold for FORWARD_APPROVAL_MS; its held forwards wait their 10 s */
  approve(rule: ForwardRuleRef, now: number): Promise<number>;
  /** "Stop": the rule is turned off (a filter keeps its other actions) and what it holds or waits is cancelled */
  stop(rule: ForwardRuleRef, now: number): Promise<number>;
  /** drops what is no longer needed: old eligibility, settled history, held past FORWARD_HELD_MS (cancelled) */
  prune(now: number): Promise<{ cancelled: number }>;
  /** a forward by id */
  get(id: number): Promise<ForwardRow | null>;
}

export type { CategoryForward };
