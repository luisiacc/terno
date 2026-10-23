import {
  BULK_CONTENT_CAP,
  candidateCategories,
  decide,
  encodeFeatures,
  explain,
  extractFeatures,
  featuresFromBlob,
  featuresToBlob,
  POLICY,
  SOURCE_WEIGHT,
  type AutoCategorize,
  type CategorizerModel,
  type CategoryPolicy,
  type ExampleSource,
  type Vetoes,
  type FeatureSource,
  type ThreadFeatures,
  type TrainExample,
} from "@unica/core";
import type { Db } from "./sqlite";

export type AddedBy = "user" | "filter" | "agent" | "suggestion" | "auto" | "bulk";

/** Origins that are an explicit user (or agent) decision and therefore train the model. */
const TRAINING_SOURCE: Partial<Record<AddedBy, ExampleSource>> = {
  user: "user",
  suggestion: "suggestion",
  agent: "agent",
  bulk: "bulk",
};

/**
 * In-memory model changes a store command produced. The caller applies them
 * only after the outermost transaction commits, so a rollback never leaves
 * RAM ahead of the database.
 */
export type ModelDelta =
  | { op: "train" | "untrain"; example: TrainExample }
  /** the thread is categorized now: it stops being a background (weak negative) thread */
  | { op: "unbackground"; threadId: number }
  | { op: "background"; threadId: number; features: Uint32Array };

export interface OwnAddresses {
  emails: Set<string>;
  domains: Set<string>;
}

export function ownAddresses(db: Db): OwnAddresses {
  const emails = new Set(db.all<{ email: string }>("SELECT email FROM accounts").map((r) => r.email.toLowerCase()));
  return { emails, domains: new Set([...emails].map((e) => e.slice(e.lastIndexOf("@") + 1))) };
}

export interface RootMessage {
  threadId: number;
  messageId: number;
  date: number;
  inInbox: boolean;
  spam: boolean;
  trash: boolean;
  draft: boolean;
  bodyComplete: boolean;
  source: FeatureSource;
}

interface RootRow {
  id: number;
  from_email: string;
  from_name: string;
  list_id: string | null;
  subject: string;
  body_text: string | null;
  body_state: string;
  date: number;
  in_inbox: number;
  is_spam: number;
  is_trash: number;
  is_draft: number;
  replied: number;
}

/**
 * The root inbound message of each thread: the earliest message the user did
 * not send, from an address that is not one of the user's own.
 */
export function rootMessages(db: Db, threadIds: Iterable<number>, own: OwnAddresses = ownAddresses(db)): Map<number, RootMessage> {
  const out = new Map<number, RootMessage>();
  const ownJson = JSON.stringify([...own.emails]);
  for (const threadId of threadIds) {
    if (out.has(threadId)) continue;
    const r = db.get<RootRow>(
      `SELECT id, from_email, from_name, list_id, subject, body_text, body_state, date, in_inbox, is_spam, is_trash, is_draft,
              EXISTS (SELECT 1 FROM messages s WHERE s.thread_id = m.thread_id AND s.is_sent = 1) AS replied
       FROM messages m INDEXED BY messages_thread
       WHERE m.thread_id = ? AND m.is_sent = 0 AND m.from_email NOT IN (SELECT value FROM json_each(?))
       ORDER BY m.date, m.id LIMIT 1`,
      threadId,
      ownJson,
    );
    if (!r) continue;
    const attachmentNames = db.all<{ filename: string }>("SELECT filename FROM attachments WHERE message_id = ?", r.id).map((a) => a.filename);
    out.set(threadId, {
      threadId,
      messageId: r.id,
      date: r.date,
      inInbox: r.in_inbox === 1,
      spam: r.is_spam === 1,
      trash: r.is_trash === 1,
      draft: r.is_draft === 1,
      bodyComplete: r.body_state === "full",
      source: { fromEmail: r.from_email, fromName: r.from_name, listId: r.list_id, subject: r.subject, bodyText: r.body_text, replied: r.replied === 1, attachmentNames },
    });
  }
  return out;
}

export interface ThreadFeatureSet {
  root: RootMessage;
  features: ThreadFeatures;
  encoded: Uint32Array;
}

export function threadFeatures(db: Db, threadIds: Iterable<number>, own: OwnAddresses = ownAddresses(db)): Map<number, ThreadFeatureSet> {
  const out = new Map<number, ThreadFeatureSet>();
  for (const [id, root] of rootMessages(db, threadIds, own)) {
    const features = extractFeatures(root.source, { ownDomains: own.domains });
    out.set(id, { root, features, encoded: encodeFeatures(features) });
  }
  return out;
}

interface ExampleRow {
  thread_id: number;
  category_id: number;
  label: number;
  weight: number;
  source: ExampleSource;
  at: number;
  content: number;
  features: Uint8Array;
}

function toExample(r: ExampleRow): TrainExample {
  return { categoryId: r.category_id, label: r.label > 0 ? 1 : -1, weight: r.weight, at: r.at, content: r.content === 1, features: featuresFromBlob(r.features) };
}

function existingExample(db: Db, threadId: number, categoryId: number): TrainExample | null {
  const r = db.get<ExampleRow>("SELECT * FROM cls_examples WHERE thread_id = ? AND category_id = ?", threadId, categoryId);
  return r ? toExample(r) : null;
}

/** Writes (replacing) the example for (thread, category); returns the deltas for RAM. */
function putExample(
  db: Db,
  e: { threadId: number; categoryId: number; label: 1 | -1; source: ExampleSource; at: number; batchId: number | null; set: ThreadFeatureSet },
): ModelDelta[] {
  const deltas: ModelDelta[] = [];
  const previous = existingExample(db, e.threadId, e.categoryId);
  if (previous) deltas.push({ op: "untrain", example: previous });
  let content = 1;
  if (e.source === "bulk") {
    const used = db.get<{ c: number }>(
      "SELECT count(*) AS c FROM cls_examples WHERE category_id = ? AND sender = ? AND source = 'bulk' AND content = 1 AND thread_id != ?",
      e.categoryId,
      e.set.features.sender,
      e.threadId,
    )!.c;
    content = used < BULK_CONTENT_CAP ? 1 : 0;
  }
  const weight = SOURCE_WEIGHT[e.source];
  db.run(
    `INSERT OR REPLACE INTO cls_examples (thread_id, category_id, label, weight, source, at, sender, content, batch_id, features)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    e.threadId,
    e.categoryId,
    e.label,
    weight,
    e.source,
    e.at,
    e.set.features.sender,
    content,
    e.batchId,
    featuresToBlob(e.set.encoded),
  );
  deltas.push({ op: "train", example: { categoryId: e.categoryId, label: e.label, weight, at: e.at, content: content === 1, features: e.set.encoded } });
  return deltas;
}

export interface AddResult {
  /** threads that were not in the category before */
  added: number[];
  deltas: ModelDelta[];
}

/**
 * Adds threads to a category. Explicit origins (user, suggestion, agent, bulk)
 * also record a positive example in the same transaction; filter and auto
 * adds never train, so the model can't feed on its own output.
 */
export function addToCategory(
  db: Db,
  a: { categoryId: number; threadIds: readonly number[]; addedBy: AddedBy; now: number; batchId?: number | null; own?: OwnAddresses },
): AddResult {
  const added: number[] = [];
  const deltas: ModelDelta[] = [];
  db.tx(() => {
    for (const threadId of new Set(a.threadIds)) {
      const changes = db.run(
        `INSERT OR IGNORE INTO thread_categories (thread_id, category_id, added_by, added_at, batch_id)
         SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM threads WHERE id = ?)`,
        threadId,
        a.categoryId,
        a.addedBy,
        a.now,
        a.batchId ?? null,
        threadId,
      ).changes;
      if (changes > 0) {
        added.push(threadId);
        deltas.push({ op: "unbackground", threadId });
      }
    }
    const source = TRAINING_SOURCE[a.addedBy];
    if (!source || added.length === 0) return;
    const sets = threadFeatures(db, added, a.own);
    for (const threadId of added) {
      const set = sets.get(threadId);
      if (!set) continue; // nothing inbound to learn from (a conversation the user started)
      deltas.push(...putExample(db, { threadId, categoryId: a.categoryId, label: 1, source, at: a.now, batchId: a.batchId ?? null, set }));
    }
    db.run(
      `UPDATE cls_decisions SET outcome = 'accepted' WHERE category_id = ? AND kind = 'suggest' AND outcome IS NULL
         AND thread_id IN (SELECT value FROM json_each(?))`,
      a.categoryId,
      JSON.stringify(added),
    );
  });
  return { added, deltas };
}

export interface RemoveResult {
  removed: number[];
  deltas: ModelDelta[];
}

/**
 * Removes threads from a category. A user removal is the strongest signal
 * there is: it is kept as a negative example (and reverts an auto decision).
 * "undo" takes back the user's own add a moment ago: its example is dropped,
 * nothing negative is learned.
 */
export function removeFromCategory(
  db: Db,
  r: { categoryId: number; threadIds: readonly number[]; reason: "user" | "undo"; now: number; own?: OwnAddresses },
): RemoveResult {
  const removed: number[] = [];
  const deltas: ModelDelta[] = [];
  db.tx(() => {
    const negatives: number[] = [];
    for (const threadId of new Set(r.threadIds)) {
      const row = db.get<{ added_by: AddedBy }>(
        "DELETE FROM thread_categories WHERE thread_id = ? AND category_id = ? RETURNING added_by",
        threadId,
        r.categoryId,
      );
      if (!row) continue;
      removed.push(threadId);
      const undo = r.reason === "undo" && row.added_by !== "auto" && row.added_by !== "filter";
      if (undo) {
        const previous = existingExample(db, threadId, r.categoryId);
        if (previous && previous.label > 0) {
          db.run("DELETE FROM cls_examples WHERE thread_id = ? AND category_id = ?", threadId, r.categoryId);
          deltas.push({ op: "untrain", example: previous });
        }
        continue;
      }
      if (row.added_by === "auto") {
        db.run(
          `UPDATE cls_decisions SET outcome = 'reverted' WHERE thread_id = ? AND category_id = ? AND kind = 'auto'
             AND outcome IS NULL AND at >= ?`,
          threadId,
          r.categoryId,
          r.now - POLICY.revertWindowDays * 86_400_000,
        );
      }
      negatives.push(threadId);
    }
    const sets = threadFeatures(db, negatives, r.own);
    for (const threadId of negatives) {
      const set = sets.get(threadId);
      if (set) deltas.push(...putExample(db, { threadId, categoryId: r.categoryId, label: -1, source: "removal", at: r.now, batchId: null, set }));
    }
  });
  return { removed, deltas };
}

/** "No, it isn't": a rejected suggestion is a negative example of weight 1. */
export function rejectSuggestion(db: Db, threadId: number, categoryId: number, now: number): ModelDelta[] {
  return db.tx(() => {
    db.run("UPDATE cls_decisions SET outcome = 'rejected' WHERE thread_id = ? AND category_id = ? AND kind = 'suggest'", threadId, categoryId);
    const set = threadFeatures(db, [threadId]).get(threadId);
    if (!set) return [];
    return putExample(db, { threadId, categoryId, label: -1, source: "reject", at: now, batchId: null, set });
  });
}

export function createBatch(db: Db, categoryId: number, source: string, scope: unknown, now: number): number {
  return db.run("INSERT INTO cat_batches (category_id, source, scope_json, created_at) VALUES (?, ?, ?, ?)", categoryId, source, JSON.stringify(scope), now).lastInsertRowid;
}

export function finishBatch(db: Db, batchId: number, added: number): void {
  db.run("UPDATE cat_batches SET added = added + ? WHERE id = ?", added, batchId);
}

export interface UndoResult {
  categoryId: number | null;
  removed: number[];
  deltas: ModelDelta[];
}

/** Takes back one batch exactly: its rows and the examples it recorded, nothing else. */
export function undoBatch(db: Db, batchId: number, now: number): UndoResult {
  return db.tx(() => {
    const batch = db.get<{ category_id: number; undone_at: number | null }>("SELECT category_id, undone_at FROM cat_batches WHERE id = ?", batchId);
    if (!batch || batch.undone_at !== null) return { categoryId: batch?.category_id ?? null, removed: [], deltas: [] };
    const removed = db
      .all<{ thread_id: number }>("DELETE FROM thread_categories WHERE batch_id = ? AND category_id = ? RETURNING thread_id", batchId, batch.category_id)
      .map((r) => r.thread_id);
    const deltas: ModelDelta[] = db
      .all<ExampleRow>("DELETE FROM cls_examples WHERE batch_id = ? AND category_id = ? AND label = 1 RETURNING *", batchId, batch.category_id)
      .map((r) => ({ op: "untrain", example: toExample(r) }));
    db.run("UPDATE cat_batches SET undone_at = ? WHERE id = ?", now, batchId);
    return { categoryId: batch.category_id, removed, deltas };
  });
}

// ───────────────────────────── rebuild ─────────────────────────────

/** Training examples, oldest first (the bulk content cap was decided at write time). */
export function loadExamples(db: Db): TrainExample[] {
  return db.all<ExampleRow>("SELECT * FROM cls_examples ORDER BY at, thread_id, category_id").map(toExample);
}

/**
 * Uncategorized inbound threads old enough that the user had the chance to
 * file them: the model's weak negatives. Most recent first, capped.
 */
export function backgroundCandidates(db: Db, now: number, limit = 20_000): number[] {
  return db
    .all<{ id: number }>(
      `SELECT t.id FROM threads t INDEXED BY threads_all
       WHERE t.in_trash = 0 AND t.in_spam = 0
         AND NOT EXISTS (SELECT 1 FROM thread_categories tc WHERE tc.thread_id = t.id)
         AND EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.is_sent = 0 AND m.date <= ?)
       ORDER BY t.last_date DESC, t.id DESC LIMIT ?`,
      now - BACKGROUND_MIN_AGE_MS,
      limit,
    )
    .map((r) => r.id);
}

/** Mail younger than this hasn't been seen long enough to count as "not in any category". */
export const BACKGROUND_MIN_AGE_MS = 3 * 86_400_000;

/**
 * Category rows from before v4 (or written without features) get their
 * examples: existing installs start with a warm model.
 */
export function backfillExamples(db: Db, limit = 2000): number {
  const rows = db.all<{ thread_id: number; category_id: number; added_by: AddedBy; added_at: number }>(
    `SELECT tc.thread_id, tc.category_id, tc.added_by, tc.added_at FROM thread_categories tc
     WHERE tc.added_by IN ('user', 'suggestion', 'agent', 'bulk')
       AND NOT EXISTS (SELECT 1 FROM cls_examples e WHERE e.thread_id = tc.thread_id AND e.category_id = tc.category_id)
     LIMIT ?`,
    limit,
  );
  if (rows.length === 0) return 0;
  const own = ownAddresses(db);
  const sets = threadFeatures(db, rows.map((r) => r.thread_id), own);
  db.tx(() => {
    for (const r of rows) {
      const set = sets.get(r.thread_id);
      const source = TRAINING_SOURCE[r.added_by]!;
      if (!set) {
        // keep a featureless marker so the row isn't scanned again
        db.run(
          "INSERT OR IGNORE INTO cls_examples (thread_id, category_id, label, weight, source, at, features) VALUES (?, ?, 1, 0, ?, ?, x'')",
          r.thread_id,
          r.category_id,
          source,
          r.added_at,
        );
        continue;
      }
      putExample(db, { threadId: r.thread_id, categoryId: r.category_id, label: 1, source, at: r.added_at, batchId: null, set });
    }
  });
  return rows.length;
}

/** Changes whenever the training set does (snapshot staleness after a crash). */
export function examplesFingerprint(db: Db): string {
  const r = db.get<{ c: number; m: number | null; s: number | null }>("SELECT count(*) AS c, max(at) AS m, total(label * weight + thread_id) AS s FROM cls_examples")!;
  return `${r.c}:${r.m ?? 0}:${r.s ?? 0}`;
}

export function loadSnapshot(db: Db): { featuresV: number; builtAt: number; fingerprint: string; blob: Uint8Array } | null {
  const r = db.get<{ features_v: number; built_at: number; fingerprint: string; blob: Uint8Array }>("SELECT * FROM cls_snapshot WHERE id = 1");
  return r ? { featuresV: r.features_v, builtAt: r.built_at, fingerprint: r.fingerprint, blob: r.blob } : null;
}

export function saveSnapshot(db: Db, s: { featuresV: number; builtAt: number; fingerprint: string; blob: Uint8Array }): void {
  db.run("INSERT OR REPLACE INTO cls_snapshot (id, features_v, built_at, fingerprint, blob) VALUES (1, ?, ?, ?, ?)", s.featuresV, s.builtAt, s.fingerprint, s.blob);
}

/** Auto decisions older than the revert window without a revert matured as kept. */
export function matureDecisions(db: Db, now: number): number {
  return db.run(
    "UPDATE cls_decisions SET outcome = 'kept' WHERE kind = 'auto' AND outcome IS NULL AND at < ?",
    now - POLICY.revertWindowDays * 86_400_000,
  ).changes;
}

// ───────────────────────────── classification at ingest ─────────────────────────────

export interface ClassifyRequest {
  /** messages inserted by this store command */
  inserted: readonly number[];
  /** existing messages whose body just became complete (reclassified once) */
  bodyCompleted: readonly number[];
  now: number;
  mode: AutoCategorize;
  /** read-only: the store command calls its pure scoring functions, nothing else */
  model: CategorizerModel;
}

export interface ClassifyResult {
  deltas: ModelDelta[];
  /** threads auto-added, per category */
  auto: Map<number, number[]>;
  suggested: number;
  /** threads with a decision (for change notifications) */
  touched: Set<number>;
  /** uncertain band threads (0.5 ≤ p < auto threshold, no decision): candidates for the optional AI assist */
  uncertain: number[];
}

/** What the policy needs from the database: one batch of reads per store command. */
function policyContext(db: Db): Map<number, CategoryPolicy & { name: string }> {
  const valve = new Map(
    db
      .all<{ category_id: number; kept: number; reverted: number }>(
        `SELECT category_id, coalesce(sum(outcome = 'kept'), 0) AS kept, coalesce(sum(outcome = 'reverted'), 0) AS reverted
         FROM cls_decisions WHERE kind = 'auto' GROUP BY category_id`,
      )
      .map((r) => [r.category_id, r]),
  );
  return new Map(
    db.all<{ id: number; name: string; auto_apply: number }>("SELECT id, name, auto_apply FROM categories").map((c) => [
      c.id,
      { name: c.name, autoApply: c.auto_apply === 1, kept: valve.get(c.id)?.kept ?? 0, reverted: valve.get(c.id)?.reverted ?? 0 },
    ]),
  );
}

export function vetoesFor(db: Db, threadId: number, sender: string, categoryIds: readonly number[], now: number): Map<number, Vetoes> {
  const since = now - POLICY.senderVetoDays * 86_400_000;
  const out = new Map<number, Vetoes>();
  for (const categoryId of categoryIds) {
    const hard =
      db.get(
        `SELECT 1 FROM cls_examples WHERE thread_id = ? AND category_id = ? AND label < 0
         UNION ALL SELECT 1 FROM cls_decisions WHERE thread_id = ? AND category_id = ? AND outcome IN ('reverted', 'rejected') LIMIT 1`,
        threadId,
        categoryId,
        threadId,
        categoryId,
      ) !== undefined;
    const s = db.get<{ rem: number; pos: number }>(
      `SELECT coalesce(sum(label < 0), 0) AS rem, coalesce(sum(label > 0), 0) AS pos
       FROM cls_examples INDEXED BY cls_examples_sender WHERE category_id = ? AND sender = ? AND at >= ?`,
      categoryId,
      sender,
      since,
    )!;
    out.set(categoryId, { hard, senderRemovals: s.rem, senderPositives: s.pos });
  }
  return out;
}

/**
 * Classifies new inbound mail inside the ingestion transaction, so messages,
 * filter effects and the engine's decisions commit (or roll back) together.
 * Only threads nobody has decided on are evaluated: no category (filters run
 * first), no example, no decision beyond a pending suggestion. Auto adds never
 * train. Background (weak negative) updates come back as deltas for after commit.
 */
export function classifyNewThreads(db: Db, req: ClassifyRequest): ClassifyResult {
  const out: ClassifyResult = { deltas: [], auto: new Map(), suggested: 0, touched: new Set(), uncertain: [] };
  const changed = [...req.inserted, ...req.bodyCompleted];
  if (changed.length === 0 || req.mode === "off") return out;
  const fresh = new Set(changed);
  const threadIds = db
    .all<{ thread_id: number }>("SELECT DISTINCT thread_id FROM messages WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(changed))
    .map((r) => r.thread_id);
  const undecided = threadIds.filter(
    (t) =>
      db.get(
        `SELECT 1 FROM thread_categories WHERE thread_id = ?1
         UNION ALL SELECT 1 FROM cls_examples WHERE thread_id = ?1
         UNION ALL SELECT 1 FROM cls_decisions WHERE thread_id = ?1 AND (kind = 'auto' OR outcome IS NOT NULL) LIMIT 1`,
        t,
      ) === undefined,
  );
  if (undecided.length === 0) return out;
  const own = ownAddresses(db);
  const sets = threadFeatures(db, undecided, own);
  let policies: Map<number, CategoryPolicy & { name: string }> | null = null;
  for (const [threadId, set] of sets) {
    const { root } = set;
    // a reply on an old conversation, or a flag update: not new mail
    if (!fresh.has(root.messageId) || root.spam || root.trash || root.draft) continue;
    const old = root.date <= req.now - BACKGROUND_MIN_AGE_MS;
    if (old && req.inserted.includes(root.messageId)) out.deltas.push({ op: "background", threadId, features: set.encoded });
    if (!root.inInbox) continue;
    const scores = req.model.score(set.encoded);
    const candidates = candidateCategories(scores);
    if (candidates.length === 0) {
      if (scores.some((s) => s.p >= 0.5)) out.uncertain.push(threadId);
      continue;
    }
    policies ??= policyContext(db);
    const decisions = decide({
      mode: req.mode,
      autoEligible: root.date >= req.now - POLICY.autoWindowDays * 86_400_000,
      scores,
      categories: policies,
      vetoes: vetoesFor(db, threadId, set.features.sender, candidates, req.now),
      lookAlike: req.model.lookAlike(set.encoded),
      senderSupport: req.model.senderSupport(set.encoded),
    });
    for (const d of decisions) {
      if (d.decision === "none") continue;
      const reasons = explain(req.model, set.features, d.categoryId, policies.get(d.categoryId)?.name ?? "", root.source.fromName || set.features.sender);
      db.run(
        "INSERT OR REPLACE INTO cls_decisions (thread_id, category_id, kind, p, explain_json, at) VALUES (?, ?, ?, ?, ?, ?)",
        threadId,
        d.categoryId,
        d.decision,
        d.p,
        JSON.stringify(reasons),
        req.now,
      );
      out.touched.add(threadId);
      if (d.decision === "suggest") {
        out.suggested++;
        continue;
      }
      const added = addToCategory(db, { categoryId: d.categoryId, threadIds: [threadId], addedBy: "auto", now: req.now, own });
      out.deltas.push(...added.deltas);
      if (added.added.length) out.auto.set(d.categoryId, [...(out.auto.get(d.categoryId) ?? []), threadId]);
    }
  }
  return out;
}
