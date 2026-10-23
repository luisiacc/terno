import { randomUUID } from "node:crypto";
import type {
  Account,
  AccountKind,
  AccountSyncState,
  Category,
  CategoryColor,
  Filter,
  FilterRule,
  OpState,
  ThreadSummary,
  UserActionKind,
} from "@unica/core";
import { getSummaries } from "./queries";
import { placeholders, type Db } from "./sqlite";

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

export function createAccount(
  db: Db,
  a: { kind: AccountKind; email: string; displayName: string; color: string; providerConfig?: unknown; secretRef?: string | null },
  now = Date.now(),
): Account {
  const position = db.get<{ p: number }>("SELECT coalesce(max(position), -1) + 1 AS p FROM accounts")!.p;
  const id = db.run(
    `INSERT INTO accounts (kind, email, display_name, color, provider_config, secret_ref, position, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    a.kind,
    a.email.toLowerCase(),
    a.displayName,
    a.color,
    JSON.stringify(a.providerConfig ?? {}),
    a.secretRef ?? null,
    position,
    now,
  ).lastInsertRowid;
  return getAccount(db, id)!;
}

export function updateAccount(db: Db, id: number, patch: { displayName?: string; color?: string }): Account | null {
  if (patch.displayName !== undefined) db.run("UPDATE accounts SET display_name = ? WHERE id = ?", patch.displayName, id);
  if (patch.color !== undefined) db.run("UPDATE accounts SET color = ? WHERE id = ?", patch.color, id);
  return getAccount(db, id);
}

export function setAccountSyncState(db: Db, id: number, patch: Partial<AccountSyncState>): void {
  const current = getAccount(db, id);
  if (!current) return;
  db.run("UPDATE accounts SET sync_state = ? WHERE id = ?", JSON.stringify({ ...current.syncState, ...patch }), id);
}

export function setAccountProviderConfig(db: Db, id: number, config: unknown): void {
  db.run("UPDATE accounts SET provider_config = ? WHERE id = ?", JSON.stringify(config), id);
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
  return db.all<Category>("SELECT id, name, color, position FROM categories ORDER BY position, id");
}

export function createCategory(db: Db, name: string, color: CategoryColor): Category {
  const position = db.get<{ p: number }>("SELECT coalesce(max(position), -1) + 1 AS p FROM categories")!.p;
  const id = db.run("INSERT INTO categories (name, color, position) VALUES (?, ?, ?)", name, color, position).lastInsertRowid;
  return { id, name, color, position };
}

export function updateCategory(
  db: Db,
  id: number,
  patch: { name?: string; color?: CategoryColor; position?: number },
): Category | null {
  if (patch.name !== undefined) db.run("UPDATE categories SET name = ? WHERE id = ?", patch.name, id);
  if (patch.color !== undefined) db.run("UPDATE categories SET color = ? WHERE id = ?", patch.color, id);
  if (patch.position !== undefined) db.run("UPDATE categories SET position = ? WHERE id = ?", patch.position, id);
  return db.get<Category>("SELECT id, name, color, position FROM categories WHERE id = ?", id) ?? null;
}

export function deleteCategory(db: Db, id: number): void {
  db.run("DELETE FROM categories WHERE id = ?", id);
}

export function addThreadsToCategory(
  db: Db,
  categoryId: number,
  threadIds: readonly number[],
  addedBy: "user" | "filter" | "agent" | "suggestion",
  now = Date.now(),
): number {
  let added = 0;
  db.tx(() => {
    for (const threadId of threadIds) {
      added += db.run(
        `INSERT OR IGNORE INTO thread_categories (thread_id, category_id, added_by, added_at)
         SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM threads WHERE id = ?)`,
        threadId,
        categoryId,
        addedBy,
        now,
        threadId,
      ).changes;
    }
  });
  return added;
}

export function removeThreadsFromCategory(db: Db, categoryId: number, threadIds: readonly number[]): number {
  if (threadIds.length === 0) return 0;
  return db.run(
    `DELETE FROM thread_categories WHERE category_id = ? AND thread_id IN (${placeholders(threadIds.length)})`,
    categoryId,
    ...threadIds,
  ).changes;
}

export interface CategorySuggestionResult {
  key: string;
  reason: "sender" | "list" | "domain";
  value: string;
  threads: ThreadSummary[];
  total: number;
}

const CONSUMER_DOMAINS = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "me.com", "live.com", "proton.me", "protonmail.com"]);

/**
 * After a thread lands in a category, find similar threads not yet in it:
 * same sender → same mailing list → same (non-consumer) domain.
 */
export function suggestSimilarForCategory(
  db: Db,
  categoryId: number,
  threadId: number,
  limit = 50,
): CategorySuggestionResult | null {
  const source = db.get<{ from_email: string; from_domain: string; list_id: string | null }>(
    `SELECT from_email, from_domain, list_id FROM messages WHERE thread_id = ?
     ORDER BY is_sent ASC, date DESC LIMIT 1`,
    threadId,
  );
  if (!source) return null;
  const dismissed = new Set(db.all<{ key: string }>("SELECT key FROM dismissed_suggestions").map((r) => r.key));
  const candidates: { reason: "sender" | "list" | "domain"; value: string | null; column: string; index: string }[] = [
    { reason: "sender", value: source.from_email, column: "from_email", index: "messages_from" },
    { reason: "list", value: source.list_id, column: "list_id", index: "messages_list" },
    {
      reason: "domain",
      value: CONSUMER_DOMAINS.has(source.from_domain) ? null : source.from_domain,
      column: "from_domain",
      index: "messages_domain",
    },
  ];
  for (const cand of candidates) {
    if (!cand.value) continue;
    const key = `cat:${categoryId}:${cand.reason}:${cand.value}`;
    if (dismissed.has(key)) continue;
    const ids = db
      .all<{ id: number }>(
        `SELECT t.id FROM threads t
         WHERE t.id IN (SELECT m.thread_id FROM messages m INDEXED BY ${cand.index} WHERE m.${cand.column} = ?)
           AND t.id != ? AND t.in_trash = 0 AND t.in_spam = 0
           AND NOT EXISTS (SELECT 1 FROM thread_categories tc WHERE tc.thread_id = t.id AND tc.category_id = ?)
         ORDER BY t.last_date DESC, t.id DESC`,
        cand.value,
        threadId,
        categoryId,
      )
      .map((r) => r.id);
    if (ids.length === 0) continue;
    return { key, reason: cand.reason, value: cand.value, threads: getSummaries(db, ids.slice(0, limit)), total: ids.length };
  }
  return null;
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

export interface OpRow {
  id: string;
  seq: number;
  account_id: number;
  kind: string;
  target_json: string;
  payload_json: string;
  state: OpState;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
}

const OPPOSITE: Record<string, string> = { markRead: "markUnread", markUnread: "markRead", star: "unstar", unstar: "star" };
/** Ops in the same group write the same piece of provider state; the newest intent wins. */
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
    if (group && op.target.messageIds?.length) {
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
    const id = randomUUID();
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

/** Claims ready ops (in seq order per account) and marks them running. */
export function claimReadyOps(db: Db, now = Date.now(), limit = 20, accountId?: number): OpRow[] {
  return db.tx(() => {
    const rows = db.all<OpRow>(
      `SELECT * FROM ops WHERE state = 'queued' AND next_attempt_at <= ?${accountId ? " AND account_id = ?" : ""}
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
  return state;
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
    const requeued = db.run("UPDATE ops SET state = 'queued', updated_at = ? WHERE state = 'running'", now).changes;
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

export function getSecret(db: Db, name: string): Uint8Array | null {
  const r = db.get<{ blob: Uint8Array }>("SELECT blob FROM secrets WHERE name = ?", name);
  return r?.blob ?? null;
}

export function deleteSecret(db: Db, name: string): void {
  db.run("DELETE FROM secrets WHERE name = ?", name);
}

// ───────────────────────────── drafts ─────────────────────────────

export interface DraftRow {
  id: number;
  account_id: number;
  to_json: string;
  cc_json: string;
  subject: string;
  body_text: string;
  in_reply_to_message_id: number | null;
  updated_at: number;
}

export function saveDraft(
  db: Db,
  d: { id?: number; accountId: number; to: unknown[]; cc: unknown[]; subject: string; bodyText: string; inReplyToMessageId?: number },
  now = Date.now(),
): DraftRow {
  if (d.id !== undefined) {
    db.run(
      "UPDATE drafts SET account_id = ?, to_json = ?, cc_json = ?, subject = ?, body_text = ?, in_reply_to_message_id = ?, updated_at = ? WHERE id = ?",
      d.accountId,
      JSON.stringify(d.to),
      JSON.stringify(d.cc),
      d.subject,
      d.bodyText,
      d.inReplyToMessageId ?? null,
      now,
      d.id,
    );
    return db.get<DraftRow>("SELECT * FROM drafts WHERE id = ?", d.id)!;
  }
  const id = db.run(
    "INSERT INTO drafts (account_id, to_json, cc_json, subject, body_text, in_reply_to_message_id, updated_at) VALUES (?,?,?,?,?,?,?)",
    d.accountId,
    JSON.stringify(d.to),
    JSON.stringify(d.cc),
    d.subject,
    d.bodyText,
    d.inReplyToMessageId ?? null,
    now,
  ).lastInsertRowid;
  return db.get<DraftRow>("SELECT * FROM drafts WHERE id = ?", id)!;
}

export function listDrafts(db: Db): DraftRow[] {
  return db.all<DraftRow>("SELECT * FROM drafts ORDER BY updated_at DESC");
}

export function deleteDraft(db: Db, id: number): void {
  db.run("DELETE FROM drafts WHERE id = ?", id);
}
