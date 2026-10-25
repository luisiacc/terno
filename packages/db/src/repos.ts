import {
  accountPrefs,
  withAccountPrefs,
  type Account,
  type AccountKind,
  type AccountPatch,
  type AccountPrefs,
  type AccountSyncState,
  type Category,
  type CategoryColor,
  type Filter,
  type FilterRule,
  type OpState,
  type UserActionKind,
} from "@terno/core";
import { addToCategory, removeFromCategory, type AddedBy } from "./categorize";
import { AWAITING_AUTH, type DraftInput, type DraftRow, type OpRow } from "@terno/store";
import type { Db, Param } from "./sqlite";

export type { DraftRow, OpRow } from "@terno/store";

// ───────────────────────────── accounts ─────────────────────────────

interface AccountRow {
  id: number;
  kind: AccountKind;
  email: string;
  display_name: string;
  color: string;
  sync_state: string;
  provider_config: string;
  secret_ref: string | null;
}

const DEFAULT_SYNC: AccountSyncState = { status: "idle", syncedSince: null, bodiesPending: 0, lastError: null, lastSyncAt: null };

function toAccount(r: AccountRow): Account {
  return {
    id: r.id,
    kind: r.kind,
    email: r.email,
    displayName: r.display_name,
    color: r.color,
    ...accountPrefs(JSON.parse(r.provider_config) as AccountPrefs, r.display_name),
    syncState: { ...DEFAULT_SYNC, ...JSON.parse(r.sync_state) },
  };
}

export function listAccounts(db: Db): Account[] {
  return db.all<AccountRow>("SELECT * FROM accounts ORDER BY position, id").map(toAccount);
}

export function getAccount(db: Db, id: number): Account | null {
  const r = db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", id);
  return r ? toAccount(r) : null;
}

export function getAccountConfig<T>(db: Db, id: number): { config: T; secretRef: string | null } | null {
  const r = db.get<AccountRow>("SELECT provider_config, secret_ref FROM accounts WHERE id = ?", id);
  return r ? { config: JSON.parse(r.provider_config) as T, secretRef: r.secret_ref } : null;
}

/**
 * Account ids are never reused (SQLite would hand out the max rowid again after
 * a delete): secrets, ops and the owner refer to accounts by id, and a pending
 * verification must never land on an unrelated replacement account.
 */
function nextAccountId(db: Db): number {
  const stored = db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'account_id_hwm'");
  const next = Math.max(stored ? Number(JSON.parse(stored.value_json)) : 0, db.get<{ m: number | null }>("SELECT max(id) AS m FROM accounts")!.m ?? 0) + 1;
  db.run("INSERT OR REPLACE INTO settings (key, value_json) VALUES ('account_id_hwm', ?)", JSON.stringify(next));
  return next;
}

export function createAccount(
  db: Db,
  a: { kind: AccountKind; email: string; displayName: string; color: string; providerConfig?: unknown; secretRef?: string | null },
  now = Date.now(),
): Account {
  return db.tx(() => {
    const id = nextAccountId(db);
    const position = db.get<{ p: number }>("SELECT coalesce(max(position), -1) + 1 AS p FROM accounts")!.p;
    db.run(
      `INSERT INTO accounts (id, kind, email, display_name, color, provider_config, secret_ref, position, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      id,
      a.kind,
      a.email.toLowerCase(),
      a.displayName,
      a.color,
      JSON.stringify(a.providerConfig ?? {}),
      a.secretRef ?? null,
      position,
      now,
    );
    return getAccount(db, id)!;
  });
}

/** What identifies one specific account over time (ids alone are not enough across a remove + add). */
export function accountStamp(db: Db, id: number): { id: number; email: string; createdAt: number } | null {
  const r = db.get<{ email: string; created_at: number }>("SELECT email, created_at FROM accounts WHERE id = ?", id);
  return r ? { id, email: r.email, createdAt: r.created_at } : null;
}

export function updateAccount(db: Db, id: number, patch: AccountPatch): Account | null {
  return db.tx(() => {
    const row = db.get<{ provider_config: string }>("SELECT provider_config FROM accounts WHERE id = ?", id);
    if (!row) return null;
    if (patch.displayName !== undefined) db.run("UPDATE accounts SET display_name = ? WHERE id = ?", patch.displayName, id);
    if (patch.color !== undefined) db.run("UPDATE accounts SET color = ? WHERE id = ?", patch.color, id);
    if (patch.senderName !== undefined || patch.signature !== undefined || patch.syncWindowDays !== undefined) {
      db.run("UPDATE accounts SET provider_config = ? WHERE id = ?", JSON.stringify(withAccountPrefs(JSON.parse(row.provider_config) as AccountPrefs, patch)), id);
    }
    return getAccount(db, id);
  });
}

export function setAccountSyncState(db: Db, id: number, patch: Partial<AccountSyncState>): void {
  const current = getAccount(db, id);
  if (!current) return;
  db.run("UPDATE accounts SET sync_state = ? WHERE id = ?", JSON.stringify({ ...current.syncState, ...patch }), id);
}

export function setAccountProviderConfig(db: Db, id: number, config: unknown): void {
  db.run("UPDATE accounts SET provider_config = ? WHERE id = ?", JSON.stringify(config), id);
}

/** The sync cursor, merged into the stored config inside one transaction (a preference saved meanwhile stays). */
export function setAccountCursor(db: Db, id: number, cursor: unknown): void {
  db.tx(() => {
    const row = db.get<{ provider_config: string }>("SELECT provider_config FROM accounts WHERE id = ?", id);
    if (row) db.run("UPDATE accounts SET provider_config = ? WHERE id = ?", JSON.stringify({ ...(JSON.parse(row.provider_config) as object), cursor }), id);
  });
}

export function removeAccount(db: Db, id: number): void {
  // cascades to threads, messages, ops, drafts; FTS rows go via the delete trigger
  db.tx(() => {
    db.run("DELETE FROM messages WHERE account_id = ?", id);
    db.run("DELETE FROM accounts WHERE id = ?", id);
  });
}

// ───────────────────────────── categories ─────────────────────────────

export function listCategories(db: Db): Category[] {
  return db
    .all<Category & { auto_apply: number }>("SELECT id, name, color, position, auto_apply FROM categories ORDER BY position, id")
    .map(({ auto_apply, ...c }) => ({ ...c, autoApply: auto_apply === 1 }));
}

export function createCategory(db: Db, name: string, color: CategoryColor): Category {
  const position = db.get<{ p: number }>("SELECT coalesce(max(position), -1) + 1 AS p FROM categories")!.p;
  const id = db.run("INSERT INTO categories (name, color, position) VALUES (?, ?, ?)", name, color, position).lastInsertRowid;
  return { id, name, color, position, autoApply: true };
}

export function updateCategory(
  db: Db,
  id: number,
  patch: { name?: string; color?: CategoryColor; position?: number; autoApply?: boolean },
): Category | null {
  if (patch.name !== undefined) db.run("UPDATE categories SET name = ? WHERE id = ?", patch.name, id);
  if (patch.color !== undefined) db.run("UPDATE categories SET color = ? WHERE id = ?", patch.color, id);
  if (patch.position !== undefined) db.run("UPDATE categories SET position = ? WHERE id = ?", patch.position, id);
  if (patch.autoApply !== undefined) db.run("UPDATE categories SET auto_apply = ? WHERE id = ?", patch.autoApply ? 1 : 0, id);
  return listCategories(db).find((c) => c.id === id) ?? null;
}

/** Positions in the given order; categories it leaves out keep their order after those. */
export function reorderCategories(db: Db, ids: readonly number[]): Category[] {
  return db.tx(() => {
    const current = listCategories(db).map((c) => c.id);
    const order = [...new Set(ids.filter((id) => current.includes(id))), ...current.filter((id) => !ids.includes(id))];
    order.forEach((id, position) => db.run("UPDATE categories SET position = ? WHERE id = ?", position, id));
    return listCategories(db);
  });
}

export function deleteCategory(db: Db, id: number): void {
  db.run("DELETE FROM categories WHERE id = ?", id);
}

/** Adds threads (explicit origins also record training examples); returns how many were new. */
export function addThreadsToCategory(db: Db, categoryId: number, threadIds: readonly number[], addedBy: AddedBy, now = Date.now()): number {
  return addToCategory(db, { categoryId, threadIds, addedBy, now }).added.length;
}

/** A user removal: recorded as a negative example. */
export function removeThreadsFromCategory(db: Db, categoryId: number, threadIds: readonly number[], now = Date.now()): number {
  return removeFromCategory(db, { categoryId, threadIds, reason: "user", now }).removed.length;
}

export function dismissSuggestion(db: Db, key: string, now = Date.now()): void {
  db.run("INSERT OR REPLACE INTO dismissed_suggestions (key, at) VALUES (?, ?)", key, now);
}

export function dismissedKeys(db: Db): Set<string> {
  return new Set(db.all<{ key: string }>("SELECT key FROM dismissed_suggestions").map((r) => r.key));
}

// ───────────────────────────── filters ─────────────────────────────

interface FilterRow {
  id: number;
  name: string;
  enabled: number;
  source: Filter["source"];
  rule_json: string;
  hits: number;
  created_at: number;
  learned_key: string | null;
}

function toFilter(r: FilterRow): Filter {
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled === 1,
    source: r.source,
    rule: JSON.parse(r.rule_json) as FilterRule,
    hits: r.hits,
    createdAt: r.created_at,
  };
}

export function listFilters(db: Db): Filter[] {
  return db.all<FilterRow>("SELECT * FROM filters ORDER BY position, id").map(toFilter);
}

export function getFilter(db: Db, id: number): Filter | null {
  const r = db.get<FilterRow>("SELECT * FROM filters WHERE id = ?", id);
  return r ? toFilter(r) : null;
}

export function saveFilter(
  db: Db,
  f: { id?: number; name: string; enabled: boolean; source: Filter["source"]; rule: FilterRule; learnedKey?: string },
  now = Date.now(),
): Filter {
  if (f.id !== undefined) {
    const previous = db.get<{ rule_json: string }>("SELECT rule_json FROM filters WHERE id = ?", f.id);
    // A changed rule is a different filter: forget what the old definition was applied to.
    if (previous && previous.rule_json !== JSON.stringify(f.rule)) db.run("DELETE FROM filter_applications WHERE filter_id = ?", f.id);
    db.run(
      "UPDATE filters SET name = ?, enabled = ?, source = ?, rule_json = ? WHERE id = ?",
      f.name,
      f.enabled ? 1 : 0,
      f.source,
      JSON.stringify(f.rule),
      f.id,
    );
    return getFilter(db, f.id)!;
  }
  const position = db.get<{ p: number }>("SELECT coalesce(max(position), -1) + 1 AS p FROM filters")!.p;
  const id = db.run(
    "INSERT INTO filters (name, enabled, source, rule_json, learned_key, position, created_at) VALUES (?,?,?,?,?,?,?)",
    f.name,
    f.enabled ? 1 : 0,
    f.source,
    JSON.stringify(f.rule),
    f.learnedKey ?? null,
    position,
    now,
  ).lastInsertRowid;
  return getFilter(db, id)!;
}

export function deleteFilter(db: Db, id: number): void {
  db.run("DELETE FROM filters WHERE id = ?", id);
}

export function learnedFilterKeys(db: Db): Set<string> {
  return new Set(
    db.all<{ learned_key: string }>("SELECT learned_key FROM filters WHERE learned_key IS NOT NULL").map((r) => r.learned_key),
  );
}

/** Records applications; returns only the message ids this filter had not been applied to yet. */
export function claimFilterApplications(db: Db, filterId: number, messageIds: readonly number[], now = Date.now()): number[] {
  const fresh: number[] = [];
  for (const id of messageIds) {
    const r = db.run("INSERT OR IGNORE INTO filter_applications (filter_id, message_id, applied_at) VALUES (?,?,?)", filterId, id, now);
    if (r.changes > 0) fresh.push(id);
  }
  if (fresh.length > 0) {
    db.run("UPDATE filters SET hits = hits + ?, last_applied_at = ? WHERE id = ?", fresh.length, now, filterId);
  }
  return fresh;
}

// ───────────────────────────── ops ─────────────────────────────


const OPPOSITE: Record<string, string> = { markRead: "markUnread", markUnread: "markRead", star: "unstar", unstar: "star" };
/**
 * Ops in the same group touch the same provider state. "read" and "star" set an
 * absolute value, so the newest intent supersedes older ones. "location" ops have
 * provider-specific side effects that don't fully overwrite each other (Gmail
 * archive doesn't clear SPAM), so they are never superseded: instead they run
 * strictly in order per message (see claimReadyOps).
 */
const SUPERSEDABLE = new Set(["read", "star"]);
const GROUP: Record<string, string> = {
  markRead: "read",
  markUnread: "read",
  star: "star",
  unstar: "star",
  archive: "location",
  trash: "location",
  spam: "location",
  notSpam: "location",
  moveToInbox: "location",
};
export const MAX_OP_ATTEMPTS = 8;

/**
 * Persists a provider operation. Older *queued* ops of the same group lose the
 * overlapping messages (superseded), so a retry in backoff can never overwrite a
 * newer intent. An exactly-opposite op that was never attempted cancels out with
 * the new one: the provider was never touched and still holds the original state.
 */
export function enqueueOp(
  db: Db,
  op: { accountId: number; kind: string; target: { messageIds?: number[] } & Record<string, unknown>; payload?: unknown },
  now = Date.now(),
): string | null {
  const targetJson = JSON.stringify(op.target);
  const group = GROUP[op.kind];
  return db.tx(() => {
    const opposite = OPPOSITE[op.kind];
    if (opposite) {
      const cancelled = db.run(
        "DELETE FROM ops WHERE account_id = ? AND kind = ? AND state = 'queued' AND attempts = 0 AND target_json = ?",
        op.accountId,
        opposite,
        targetJson,
      );
      if (cancelled.changes > 0) return null;
    }
    if (group && SUPERSEDABLE.has(group) && op.target.messageIds?.length) {
      const mine = new Set(op.target.messageIds);
      const overlapping = db.all<{ id: string; target_json: string }>(
        `SELECT DISTINCT o.id, o.target_json FROM op_targets t JOIN ops o ON o.id = t.op_id
         WHERE t.grp = ? AND t.message_id IN (SELECT value FROM json_each(?)) AND o.account_id = ? AND o.state = 'queued'`,
        group,
        JSON.stringify(op.target.messageIds),
        op.accountId,
      );
      for (const older of overlapping) {
        const target = JSON.parse(older.target_json) as { messageIds?: number[] };
        const remaining = (target.messageIds ?? []).filter((m) => !mine.has(m));
        if (remaining.length === 0) {
          db.run("DELETE FROM ops WHERE id = ?", older.id);
        } else {
          db.run("UPDATE ops SET target_json = ? WHERE id = ?", JSON.stringify({ ...target, messageIds: remaining }), older.id);
          db.run(`DELETE FROM op_targets WHERE op_id = ? AND message_id IN (SELECT value FROM json_each(?))`, older.id, JSON.stringify([...mine]));
        }
      }
    }
    const id = db.uuid();
    db.run(
      `INSERT INTO ops (id, seq, account_id, kind, target_json, payload_json, state, created_at, updated_at, next_attempt_at)
       VALUES (?, (SELECT coalesce(max(seq), 0) + 1 FROM ops), ?, ?, ?, ?, 'queued', ?, ?, 0)`,
      id,
      op.accountId,
      op.kind,
      targetJson,
      JSON.stringify(op.payload ?? {}),
      now,
      now,
    );
    for (const messageId of new Set(op.target.messageIds ?? [])) {
      db.run("INSERT OR IGNORE INTO op_targets (op_id, message_id, grp) VALUES (?, ?, ?)", id, messageId, group ?? op.kind);
    }
    return id;
  });
}

/**
 * Claims ready ops (in seq order) and marks them running. A location op waits
 * while an older unsettled location op targets any of the same messages, so
 * archive/trash/spam effects always reach the provider in the order the user
 * made them, even across retries.
 */
export function claimReadyOps(db: Db, now = Date.now(), limit = 20, accountId?: number): OpRow[] {
  return db.tx(() => {
    const rows = db.all<OpRow>(
      `SELECT * FROM ops WHERE state = 'queued' AND next_attempt_at <= ?${accountId ? " AND account_id = ?" : ""}
         AND NOT EXISTS (
           SELECT 1 FROM op_targets mine
           JOIN op_targets other ON other.message_id = mine.message_id AND other.grp = mine.grp
           JOIN ops o2 ON o2.id = other.op_id
           WHERE mine.op_id = ops.id AND mine.grp = 'location'
             AND o2.seq < ops.seq AND o2.state IN ('queued', 'running'))
       ORDER BY seq LIMIT ?`,
      now,
      ...(accountId ? [accountId] : []),
      limit,
    );
    for (const r of rows) {
      db.run("UPDATE ops SET state = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?", now, r.id);
      r.state = "running";
      r.attempts += 1;
    }
    return rows;
  });
}

export function completeOp(db: Db, id: string, now = Date.now()): void {
  db.run("UPDATE ops SET state = 'succeeded', last_error = NULL, updated_at = ? WHERE id = ?", now, id);
  db.run("DELETE FROM op_targets WHERE op_id = ?", id); // settled: no longer protects anything
}

/**
 * An op going back to the queue (retry, crash recovery) gives up the messages a
 * NEWER read/star op already covers; otherwise its retry would undo newer intent.
 * Returns false if nothing is left and the op was removed.
 */
function yieldToNewerOps(db: Db, id: string): boolean {
  const op = db.get<{ seq: number; account_id: number; kind: string; target_json: string }>("SELECT seq, account_id, kind, target_json FROM ops WHERE id = ?", id);
  const group = op ? GROUP[op.kind] : undefined;
  if (!op || !group || !SUPERSEDABLE.has(group)) return true;
  const covered = new Set(
    db
      .all<{ message_id: number }>(
        `SELECT DISTINCT t2.message_id FROM op_targets t1
         JOIN op_targets t2 ON t2.message_id = t1.message_id AND t2.grp = t1.grp
         JOIN ops o2 ON o2.id = t2.op_id
         WHERE t1.op_id = ? AND o2.seq > ? AND o2.account_id = ? AND o2.state != 'failed'`,
        id,
        op.seq,
        op.account_id,
      )
      .map((r) => r.message_id),
  );
  if (covered.size === 0) return true;
  const target = JSON.parse(op.target_json) as { messageIds?: number[] };
  const remaining = (target.messageIds ?? []).filter((m) => !covered.has(m));
  if (remaining.length === 0) {
    db.run("DELETE FROM ops WHERE id = ?", id);
    return false;
  }
  db.run("UPDATE ops SET target_json = ? WHERE id = ?", JSON.stringify({ ...target, messageIds: remaining }), id);
  db.run(`DELETE FROM op_targets WHERE op_id = ? AND message_id IN (SELECT value FROM json_each(?))`, id, JSON.stringify([...covered]));
  return true;
}

/**
 * Removes deleted messages from every unsettled op. Message rowids can be reused
 * by SQLite, so a stale target must never resolve to an unrelated new message.
 */
export function pruneOpTargets(db: Db, messageIds: readonly number[]): void {
  if (messageIds.length === 0) return;
  const json = JSON.stringify(messageIds);
  for (const op of db.all<{ id: string; kind: string; target_json: string }>(
    `SELECT DISTINCT o.id, o.kind, o.target_json FROM op_targets t JOIN ops o ON o.id = t.op_id
     WHERE t.message_id IN (SELECT value FROM json_each(?)) AND o.state IN ('queued', 'running', 'unknown')`,
    json,
  )) {
    const gone = new Set(messageIds);
    const target = JSON.parse(op.target_json) as { messageIds?: number[] };
    const remaining = (target.messageIds ?? []).filter((m) => !gone.has(m));
    if (remaining.length === 0 && op.kind !== "send") db.run("DELETE FROM ops WHERE id = ?", op.id);
    else db.run("UPDATE ops SET target_json = ? WHERE id = ?", JSON.stringify({ ...target, messageIds: remaining }), op.id);
  }
  db.run("DELETE FROM op_targets WHERE message_id IN (SELECT value FROM json_each(?))", json);
}

/** Retryable failure: exponential backoff (1s, 2s, 4s … capped at 5 min), then `failed`. */
export function failOp(db: Db, id: string, error: string, retryable: boolean, now = Date.now()): OpState {
  const op = db.get<{ attempts: number }>("SELECT attempts FROM ops WHERE id = ?", id);
  if (!op) return "failed";
  const state: OpState = retryable && op.attempts < MAX_OP_ATTEMPTS ? "queued" : "failed";
  const delay = Math.min(1000 * 2 ** (op.attempts - 1), 300_000);
  db.run(
    "UPDATE ops SET state = ?, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?",
    state,
    error,
    now + delay,
    now,
    id,
  );
  if (state === "failed") db.run("DELETE FROM op_targets WHERE op_id = ?", id);
  else if (!yieldToNewerOps(db, id)) return "succeeded"; // fully superseded: nothing left to do
  return state;
}

/** Waits for the user to sign in again: queued, the claim's attempt given back, never ready until resumeAuthOps. */
export function awaitAuthOp(db: Db, id: string, error: string, now: number): void {
  db.run("UPDATE ops SET state = 'queued', attempts = max(attempts - 1, 0), next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ? AND state = 'running'", AWAITING_AUTH, error, now, id);
}

/** A claimed op that never reached its provider goes back exactly as it was (quit or update before it started). */
export function releaseOp(db: Db, id: string, now: number): void {
  db.run("UPDATE ops SET state = 'queued', attempts = max(attempts - 1, 0), updated_at = ? WHERE id = ? AND state = 'running'", now, id);
}

export function resumeAuthOps(db: Db, accountId: number, now: number): string[] {
  return db
    .all<{ id: string }>("UPDATE ops SET next_attempt_at = 0, updated_at = ? WHERE account_id = ? AND state = 'queued' AND next_attempt_at = ? RETURNING id", now, accountId, AWAITING_AUTH)
    .map((r) => r.id);
}

/** Ambiguous outcome (e.g. connection lost after SMTP DATA). Never retried automatically. */
export function markOpUnknown(db: Db, id: string, error: string, now = Date.now()): void {
  db.run("UPDATE ops SET state = 'unknown', last_error = ?, updated_at = ? WHERE id = ?", error, now, id);
}

/**
 * Startup recovery after a crash: a send that was running may have been
 * transmitted, so it becomes `unknown`; other ops are idempotent set-to-state
 * operations and are safely re-queued.
 */
export function recoverOps(db: Db, now = Date.now()): { requeued: number; unknown: number } {
  return db.tx(() => {
    const unknown = db.run(
      "UPDATE ops SET state = 'unknown', last_error = 'Interrupted while sending', updated_at = ? WHERE state = 'running' AND kind = 'send'",
      now,
    ).changes;
    const running = db.all<{ id: string }>("SELECT id FROM ops WHERE state = 'running'");
    const requeued = db.run("UPDATE ops SET state = 'queued', updated_at = ? WHERE state = 'running'", now).changes;
    for (const r of running) yieldToNewerOps(db, r.id);
    return { requeued, unknown };
  });
}

export function getOp(db: Db, id: string): OpRow | null {
  return db.get<OpRow>("SELECT * FROM ops WHERE id = ?", id) ?? null;
}

export function listRecentOps(db: Db, limit = 100): OpRow[] {
  return db.all<OpRow>(
    "SELECT * FROM ops WHERE state != 'succeeded' OR updated_at > ? ORDER BY seq DESC LIMIT ?",
    Date.now() - 3_600_000,
    limit,
  );
}

/**
 * Message ids that still have unsettled ops. Incoming sync must not overwrite
 * their flags with (older) provider state until the op settles.
 */
export function messagesWithPendingOps(db: Db, accountId: number): Set<number> {
  return new Set(
    db
      .all<{ message_id: number }>(
        `SELECT DISTINCT t.message_id FROM op_targets t JOIN ops o ON o.id = t.op_id
         WHERE o.account_id = ? AND o.state IN ('queued', 'running')`,
        accountId,
      )
      .map((r) => r.message_id),
  );
}

// ───────────────────────────── user actions (learning) ─────────────────────────────

/** Logs explicit user actions on threads (never automated filter actions). */
export function recordUserActions(db: Db, threadIds: readonly number[], action: UserActionKind, now = Date.now()): void {
  for (const threadId of threadIds) {
    const m = db.get<{ from_email: string; from_domain: string; list_id: string | null }>(
      `SELECT from_email, from_domain, list_id FROM messages WHERE thread_id = ?
       ORDER BY is_sent ASC, date DESC LIMIT 1`,
      threadId,
    );
    if (!m) continue;
    db.run(
      "INSERT INTO user_actions (thread_id, action, from_email, from_domain, list_id, at) VALUES (?,?,?,?,?,?)",
      threadId,
      action,
      m.from_email,
      m.from_domain,
      m.list_id,
      now,
    );
  }
}

export function loadUserActions(db: Db, since: number) {
  // protective signals are read regardless of age (see core/learning)
  return db.all<{ action: UserActionKind; fromEmail: string; fromDomain: string; listId: string | null; at: number }>(
    `SELECT action, from_email AS fromEmail, from_domain AS fromDomain, list_id AS listId, at FROM user_actions
     WHERE at >= ? OR action IN ('star', 'reply', 'markImportant')`,
    since,
  );
}

// ───────────────────────────── settings & secrets ─────────────────────────────

export function getSetting<T>(db: Db, key: string, fallback: T): T {
  const r = db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", key);
  return r ? (JSON.parse(r.value_json) as T) : fallback;
}

export function setSetting(db: Db, key: string, value: unknown): void {
  db.run("INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)", key, JSON.stringify(value));
}

export function putSecret(db: Db, name: string, blob: Uint8Array): void {
  db.run("INSERT OR REPLACE INTO secrets (name, blob) VALUES (?, ?)", name, blob);
}

export function secretNames(db: Db): string[] {
  return db.all<{ name: string }>("SELECT name FROM secrets ORDER BY name").map((r) => r.name);
}

export function getSecret(db: Db, name: string): Uint8Array | null {
  const r = db.get<{ blob: Uint8Array }>("SELECT blob FROM secrets WHERE name = ?", name);
  return r?.blob ?? null;
}

export function deleteSecret(db: Db, name: string): void {
  db.run("DELETE FROM secrets WHERE name = ?", name);
}

// ───────────────────────────── drafts ─────────────────────────────


/**
 * Saves a draft (see DraftInput): an insert starts at revision 1 in format 2;
 * an update bumps the revision, unless the stored one isn't the one the edit
 * was made on (another writer), in which case the edit becomes a new draft.
 * null: the draft no longer exists (sent or discarded).
 */
export function saveDraft(db: Db, d: DraftInput, now = Date.now()): DraftRow | null {
  const row = d.id !== undefined ? db.get<DraftRow>("SELECT * FROM drafts WHERE id = ?", d.id) : undefined;
  if (d.id !== undefined && !row) return null;
  const replyThread = (msgId: number | null | undefined) => (msgId ? (db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE id = ?", msgId)?.thread_id ?? null) : null);
  const inReplyTo = d.inReplyToMessageId !== undefined ? d.inReplyToMessageId : (row?.in_reply_to_message_id ?? null);
  const values = {
    account_id: d.accountId,
    thread_id: d.threadId !== undefined ? d.threadId : row ? row.thread_id : replyThread(inReplyTo),
    mode: d.mode ?? row?.mode ?? (inReplyTo ? "reply" : "new"),
    to_json: JSON.stringify(d.to),
    cc_json: JSON.stringify(d.cc),
    bcc_json: d.bcc !== undefined ? JSON.stringify(d.bcc) : (row?.bcc_json ?? "[]"),
    subject: d.subject,
    subject_edited: d.subjectEdited !== undefined ? Number(d.subjectEdited) : (row?.subject_edited ?? 0),
    body_text: d.bodyText,
    quoted_text: d.quotedText ?? row?.quoted_text ?? "",
    include_quote: d.includeQuote !== undefined ? Number(d.includeQuote) : (row?.include_quote ?? 0),
    in_reply_to_message_id: inReplyTo,
    forward_of_message_id: d.forwardOfMessageId !== undefined ? d.forwardOfMessageId : (row?.forward_of_message_id ?? null),
    ui_state: d.uiState ?? row?.ui_state ?? "open",
  };
  const cols = Object.keys(values);
  if (row && (d.baseRevision === undefined || d.baseRevision === row.revision)) {
    db.run(`UPDATE drafts SET ${cols.map((c) => `${c} = ?`).join(", ")}, revision = revision + 1, updated_at = ? WHERE id = ?`, ...(Object.values(values) as Param[]), now, row.id);
    return db.get<DraftRow>("SELECT * FROM drafts WHERE id = ?", row.id)!;
  }
  // new (or edited from a revision another writer replaced): its own draft, format 2
  const id = db.run(
    `INSERT INTO drafts (${cols.join(", ")}, format, revision, updated_at) VALUES (${cols.map(() => "?").join(", ")}, 2, 1, ?)`,
    ...(Object.values(values) as Param[]),
    now,
  ).lastInsertRowid;
  return db.get<DraftRow>("SELECT * FROM drafts WHERE id = ?", id)!;
}

/**
 * Every draft, newest first. A reply or forward whose conversation or
 * original message is gone comes back as a new message (threading ids
 * cleared): it keeps its recipients and text and can be sent.
 */
export function listDrafts(db: Db): DraftRow[] {
  const exists = (id: number | null) => id !== null && db.get("SELECT 1 FROM messages WHERE id = ?", id) !== undefined;
  return db.all<DraftRow>("SELECT * FROM drafts ORDER BY updated_at DESC").map((d) => normalizeOrphan(d, exists));
}

/** A draft whose conversation or original message is gone, as a new message (IdbMailStore applies the same rule). */
export function normalizeOrphan(d: DraftRow, exists: (messageId: number | null) => boolean): DraftRow {
  if (d.mode === "new") return d;
  const lost = d.thread_id === null || (d.in_reply_to_message_id !== null && !exists(d.in_reply_to_message_id)) || (d.forward_of_message_id !== null && !exists(d.forward_of_message_id));
  return lost ? { ...d, mode: "new", thread_id: null, in_reply_to_message_id: null, forward_of_message_id: null } : d;
}

/** Message-IDs are stored as ingestion normalizes them: no <>, lower case. */
export const normalizeRfcId = (id: string): string => id.trim().replace(/^<|>$/g, "").trim().toLowerCase();

export function messageRef(db: Db, messageId: number): string | null {
  return db.get<{ r: string | null }>("SELECT rfc_message_id AS r FROM messages WHERE id = ?", messageId)?.r ?? null;
}

export function findMessageByRef(db: Db, accountId: number, rfcMessageId: string): { id: number; threadId: number } | null {
  const r = db.get<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages WHERE account_id = ? AND rfc_message_id = ? ORDER BY id DESC LIMIT 1", accountId, normalizeRfcId(rfcMessageId));
  return r ? { id: r.id, threadId: r.thread_id } : null;
}

export function deleteDraft(db: Db, id: number): void {
  db.run("DELETE FROM drafts WHERE id = ?", id);
}
