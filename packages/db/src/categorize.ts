import { RpcError } from "@terno/core/rpc";
import { L } from "@terno/i18n";
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
  type TrainExample,
} from "@terno/core";
import type { AddedBy, ClassifyResult, ExampleKey, ModelDelta, MovePhase, RootMessage, ThreadFeatureSet } from "@terno/store";
import type { Db } from "./sqlite";

export type { AddedBy, ClassifyResult, ExampleKey, ModelDelta, MovePhase, RootMessage, ThreadFeatureSet } from "@terno/store";


/** Origins that are an explicit user (or agent) decision and therefore train the model. */
const TRAINING_SOURCE: Partial<Record<AddedBy, ExampleSource>> = {
  user: "user",
  suggestion: "suggestion",
  agent: "agent",
  bulk: "bulk",
};



export interface OwnAddresses {
  emails: Set<string>;
  domains: Set<string>;
}

export function ownAddresses(db: Db): OwnAddresses {
  const emails = new Set(db.all<{ email: string }>("SELECT email FROM accounts").map((r) => r.email.toLowerCase()));
  return { emails, domains: new Set([...emails].map((e) => e.slice(e.lastIndexOf("@") + 1))) };
}


interface RootRow {
  thread_id: number;
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
  has_attachments: number;
  replied: number;
}

/**
 * The root inbound message of each thread: the earliest message the user did
 * not send, from an address that is not one of the user's own. One statement
 * for the whole batch (ingestion calls this once per slice).
 */
export function rootMessages(db: Db, threadIds: Iterable<number>, own: OwnAddresses = ownAddresses(db)): Map<number, RootMessage> {
  return rootsWithBodies(db, rootRefs(db, threadIds, own));
}

export interface RootRef {
  threadId: number;
  messageId: number;
  date: number;
  inInbox: boolean;
  spam: boolean;
  trash: boolean;
  draft: boolean;
}

/** Root ids and flags only: cheap enough to filter a whole import slice before reading any body. */
export function rootRefs(db: Db, threadIds: Iterable<number>, own: OwnAddresses = ownAddresses(db)): RootRef[] {
  const ids = [...new Set(threadIds)];
  if (ids.length === 0) return [];
  return db
    .all<{ thread_id: number; id: number; date: number; in_inbox: number; is_spam: number; is_trash: number; is_draft: number }>(
      `SELECT m.thread_id, m.id, m.date, m.in_inbox, m.is_spam, m.is_trash, m.is_draft
       FROM json_each(?1) t JOIN messages m ON m.id = (
         SELECT r.id FROM messages r INDEXED BY messages_thread
         WHERE r.thread_id = t.value AND r.is_sent = 0 AND r.from_email NOT IN (SELECT value FROM json_each(?2))
         ORDER BY r.date, r.id LIMIT 1)`,
      JSON.stringify(ids),
      JSON.stringify([...own.emails]),
    )
    .map((r) => ({ threadId: r.thread_id, messageId: r.id, date: r.date, inInbox: r.in_inbox === 1, spam: r.is_spam === 1, trash: r.is_trash === 1, draft: r.is_draft === 1 }));
}

/** The featurizer's input for the given roots, in one read. */
export function rootsWithBodies(db: Db, refs: readonly RootRef[]): Map<number, RootMessage> {
  const out = new Map<number, RootMessage>();
  if (refs.length === 0) return out;
  const rows = db.all<RootRow>(
    `SELECT m.thread_id, m.id, m.from_email, m.from_name, m.list_id, m.subject, b.body_text, m.body_state, m.date,
            m.in_inbox, m.is_spam, m.is_trash, m.is_draft, m.has_attachments,
            EXISTS (SELECT 1 FROM messages s WHERE s.thread_id = m.thread_id AND s.is_sent = 1) AS replied
     FROM json_each(?) j JOIN messages m ON m.id = j.value LEFT JOIN message_bodies b ON b.message_id = m.id`,
    JSON.stringify(refs.map((r) => r.messageId)),
  );
  const withFiles = rows.filter((r) => r.has_attachments === 1).map((r) => r.id);
  const files = new Map<number, string[]>();
  if (withFiles.length) {
    for (const a of db.all<{ message_id: number; filename: string }>("SELECT message_id, filename FROM attachments WHERE message_id IN (SELECT value FROM json_each(?))", JSON.stringify(withFiles))) {
      files.set(a.message_id, [...(files.get(a.message_id) ?? []), a.filename]);
    }
  }
  for (const r of rows) {
    out.set(r.thread_id, {
      threadId: r.thread_id,
      messageId: r.id,
      date: r.date,
      inInbox: r.in_inbox === 1,
      spam: r.is_spam === 1,
      trash: r.is_trash === 1,
      draft: r.is_draft === 1,
      bodyComplete: r.body_state === "full",
      source: { fromEmail: r.from_email, fromName: r.from_name, listId: r.list_id, subject: r.subject, bodyText: r.body_text, replied: r.replied === 1, attachmentNames: files.get(r.id) ?? [] },
    });
  }
  return out;
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
  sender: string;
  content: number;
  batch_id: number | null;
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
  if (previous) deltas.push({ op: "untrain", example: previous, key: [e.threadId, e.categoryId] });
  let content = 1;
  if (e.source === "bulk") {
    const used = db.get<{ c: number }>(
      `SELECT count(*) AS c FROM (
         SELECT 1 FROM cls_examples INDEXED BY cls_examples_bulk_content
         WHERE category_id = ? AND sender = ? AND source = 'bulk' AND content = 1 AND thread_id != ? LIMIT ?)`,
      e.categoryId,
      e.set.features.sender,
      e.threadId,
      BULK_CONTENT_CAP,
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
  deltas.push({ op: "train", example: { categoryId: e.categoryId, label: e.label, weight, at: e.at, content: content === 1, features: e.set.encoded }, key: [e.threadId, e.categoryId] });
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

/** Threads that just lost their last category and qualify as background (as a rebuild would count them). */
function backgroundDeltas(db: Db, threadIds: readonly number[], now: number, own?: OwnAddresses): ModelDelta[] {
  if (threadIds.length === 0) return [];
  const bare = db
    .all<{ t: number }>(
      `SELECT value AS t FROM json_each(?) j JOIN threads th ON th.id = j.value
       WHERE th.in_trash = 0 AND th.in_spam = 0 AND NOT EXISTS (SELECT 1 FROM thread_categories WHERE thread_id = j.value)`,
      JSON.stringify(threadIds),
    )
    .map((r) => r.t);
  const out: ModelDelta[] = [];
  for (const [threadId, set] of threadFeatures(db, bare, own)) {
    if (set.root.date <= now - BACKGROUND_MIN_AGE_MS) out.push({ op: "background", threadId, features: set.encoded });
  }
  return out;
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
          deltas.push({ op: "untrain", example: previous, key: [threadId, r.categoryId] });
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
    deltas.push(...backgroundDeltas(db, removed, r.now, r.own));
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
    const out = undoBatchPart(db, batchId, batchThreads(db, batchId), now);
    if (out.categoryId !== null) finishUndo(db, batchId, now);
    return out;
  });
}

/** Threads a batch still holds (large undos take them back in slices). */
export function batchThreads(db: Db, batchId: number): number[] {
  return db.all<{ thread_id: number }>("SELECT thread_id FROM thread_categories INDEXED BY thread_categories_batch WHERE batch_id = ?", batchId).map((r) => r.thread_id);
}

/** One slice of an undo: these threads' rows and examples from the batch. */
export function undoBatchPart(db: Db, batchId: number, threadIds: readonly number[], now: number): UndoResult {
  return db.tx(() => {
    const batch = db.get<{ category_id: number; undone_at: number | null }>("SELECT category_id, undone_at FROM cat_batches WHERE id = ?", batchId);
    if (!batch || batch.undone_at !== null) return { categoryId: null, removed: [], deltas: [] };
    const ids = JSON.stringify(threadIds);
    const removed = db
      .all<{ thread_id: number }>(
        "DELETE FROM thread_categories WHERE batch_id = ? AND category_id = ? AND thread_id IN (SELECT value FROM json_each(?)) RETURNING thread_id",
        batchId,
        batch.category_id,
        ids,
      )
      .map((r) => r.thread_id);
    const deltas: ModelDelta[] = db
      .all<ExampleRow>(
        "DELETE FROM cls_examples WHERE batch_id = ? AND category_id = ? AND label = 1 AND thread_id IN (SELECT value FROM json_each(?)) RETURNING *",
        batchId,
        batch.category_id,
        ids,
      )
      .map((r) => ({ op: "untrain", example: toExample(r), key: [r.thread_id, r.category_id] }));
    deltas.push(...backgroundDeltas(db, removed, now));
    return { categoryId: batch.category_id, removed, deltas };
  });
}

export function finishUndo(db: Db, batchId: number, now: number): void {
  db.run("UPDATE cat_batches SET undone_at = ? WHERE id = ? AND undone_at IS NULL", now, batchId);
}

// ───────────────────────────── move (drag, "Mover a…") ─────────────────────────────
//
// A move is exclusive: afterwards each thread is in `to` and nowhere else.
// beginMove records its threads (phase "moving"); applyMoveSlice then moves
// them in set-based slices, each one transaction that journals what it
// overwrites (cat_move_*: each removed row with its category) — a thread
// filed in 20 categories touches 20 rows, so 5,000 of them can't be one
// transaction within the event-loop budget. The training that follows (a
// positive example in `to`, a removal example per category left) runs in
// slices too ("training"). Progress is per thread (cat_move_threads.done),
// so a crash resumes forward. Undo mirrors it: undoMoveBegin, then
// memberships and decision outcomes in slices ("unmoving"), then examples
// ("restoring"); each thread comes back exactly.

/** How long a move can be undone (its journal is pruned after that). */
export const MOVE_UNDO_WINDOW_MS = 86_400_000;

const JOURNAL_TABLES = ["cat_move_threads", "cat_move_rows", "cat_move_examples", "cat_move_decisions"];

/** Journal rows of expired moves deleted per call: a large move journals 100,000s of rows, gone a part at a time. */
const PRUNE_THREADS = 200;

function pruneMoveJournals(db: Db, now: number): void {
  // a move older than the window can no longer be undone
  db.run(
    "UPDATE cat_batches SET scope_json = json_set(scope_json, '$.phase', 'expired') WHERE scope_json ->> '$.kind' = 'move' AND scope_json ->> '$.phase' = 'done' AND created_at < ?",
    now - MOVE_UNDO_WINDOW_MS,
  );
  const left = db.all<{ batch_id: number; thread_id: number }>(
    `SELECT batch_id, thread_id FROM cat_move_threads WHERE batch_id IN (SELECT id FROM cat_batches WHERE scope_json ->> '$.kind' = 'move' AND scope_json ->> '$.phase' = 'expired') LIMIT ?`,
    PRUNE_THREADS,
  );
  for (const r of left) for (const t of JOURNAL_TABLES) db.run(`DELETE FROM ${t} WHERE batch_id = ? AND thread_id = ?`, r.batch_id, r.thread_id);
}

function setPhase(db: Db, batchId: number, phase: MovePhase): void {
  db.run("UPDATE cat_batches SET scope_json = json_set(scope_json, '$.phase', ?) WHERE id = ?", phase, batchId);
}

export function movePhase(db: Db, batchId: number): MovePhase | null {
  const r = db.get<{ kind: string | null; phase: MovePhase | null }>("SELECT scope_json ->> '$.kind' AS kind, scope_json ->> '$.phase' AS phase FROM cat_batches WHERE id = ?", batchId);
  return r?.kind === "move" ? r.phase : null;
}

export function isMoveBatch(db: Db, batchId: number): boolean {
  return movePhase(db, batchId) !== null;
}

export type UnfinishedPhase = "moving" | "training" | "unmoving" | "restoring";

/** Moves (or their undos) that a crash left half-done. */
export function unfinishedMoves(db: Db): { batchId: number; phase: UnfinishedPhase }[] {
  return db.all<{ id: number; phase: UnfinishedPhase }>(
    "SELECT id, scope_json ->> '$.phase' AS phase FROM cat_batches WHERE scope_json ->> '$.kind' = 'move' AND scope_json ->> '$.phase' IN ('moving', 'training', 'unmoving', 'restoring') ORDER BY id",
  ).map((r) => ({ batchId: r.id, phase: r.phase }));
}

/** The phase is over for every thread: the next one starts from the top. */
function nextPhaseWhenDone(db: Db, batchId: number, next: MovePhase): boolean {
  if (db.get("SELECT 1 FROM cat_move_threads WHERE batch_id = ? AND done = 0 LIMIT 1", batchId)) return false;
  db.run("UPDATE cat_move_threads SET done = 0 WHERE batch_id = ?", batchId);
  setPhase(db, batchId, next);
  return true;
}

/** The move's threads whose current phase (training or restore) hasn't reached them yet. */
export function movePending(db: Db, batchId: number): number[] {
  return db.all<{ thread_id: number }>("SELECT thread_id FROM cat_move_threads WHERE batch_id = ? AND done = 0 ORDER BY thread_id", batchId).map((r) => r.thread_id);
}

/**
 * Filters `table` (thread_id, category_id) to the pairs a move touches, for
 * its threads in `ids` (a JSON array; null = all of them): the destination
 * and every category left. Driven by thread id, so it uses the table's key.
 */
function touched(table: string, batchId: number, to: number, ids: string | null, orJournaled = false): { where: string; params: (number | string)[] } {
  const only = ids === null ? "" : " AND thread_id IN (SELECT value FROM json_each(?))";
  // restoring: whatever the journal holds goes back in its place, so what is there now goes first (never a key conflict)
  const journaled = orJournaled ? ` OR EXISTS (SELECT 1 FROM cat_move_examples e WHERE e.batch_id = ? AND e.thread_id = ${table}.thread_id AND e.category_id = ${table}.category_id)` : "";
  return {
    // a move from before v8 (a single `from`) journaled that category for every thread, in the source or not
    where: `${table}.thread_id IN (SELECT thread_id FROM cat_move_threads WHERE batch_id = ?${only})
            AND (${table}.category_id = ? OR ${table}.category_id = (SELECT scope_json ->> '$.from' FROM cat_batches WHERE id = ?)
                 OR EXISTS (SELECT 1 FROM cat_move_rows r WHERE r.batch_id = ? AND r.thread_id = ${table}.thread_id AND r.category_id = ${table}.category_id)${journaled})`,
    params: [batchId, ...(ids === null ? [] : [ids]), to, batchId, batchId, ...(orJournaled ? [batchId] : [])],
  };
}

/**
 * Records a move: its threads (those that exist), nothing more, so 5,000 of
 * them cost a few ms. Nothing moves yet: applyMoveSlice does, in slices, and
 * finds out then what each thread leaves and joins. `leave` (plan 76) turns
 * it around: the threads only leave `to`, journaled the same way, so
 * categorize.undo puts every row, example and decision back exactly.
 */
export function beginMove(db: Db, m: { to: number; threadIds: readonly number[]; addedBy: AddedBy; now: number; source: string; leave?: boolean }): { batchId: number } {
  return db.tx(() => {
    pruneMoveJournals(db, m.now);
    const batchId = createBatch(db, m.to, m.source, { kind: "move", exclusive: !m.leave, ...(m.leave ? { leave: true } : {}), addedBy: m.addedBy, phase: "moving" satisfies MovePhase }, m.now);
    db.run(
      `INSERT INTO cat_move_threads (batch_id, thread_id, added, moved)
       SELECT ?, j.value, 0, 0 FROM (SELECT DISTINCT value FROM json_each(?)) j WHERE EXISTS (SELECT 1 FROM threads WHERE id = j.value)`,
      batchId,
      JSON.stringify(m.threadIds),
    );
    // nothing to move (every thread gone): nothing to train or undo either
    if (!db.get("SELECT 1 FROM cat_move_threads WHERE batch_id = ? LIMIT 1", batchId)) setPhase(db, batchId, "done");
    return { batchId };
  });
}

/** What an applied move did: the threads it added to `to`, and those it took out of another category. */
export function moveOutcome(db: Db, batchId: number): { added: number[]; moved: number[] } {
  const of = (column: "added" | "moved") =>
    db.all<{ thread_id: number }>(`SELECT thread_id FROM cat_move_threads WHERE batch_id = ? AND ${column} = 1 ORDER BY thread_id`, batchId).map((r) => r.thread_id);
  return { added: of("added"), moved: of("moved") };
}

/**
 * One slice of a move, in one set-based transaction: these threads leave
 * every other category and join `to`, and what that overwrites is journaled
 * (each removed row with its category, the decisions of every affected
 * category). Memberships are read now, so a filing since beginMove is
 * journaled too.
 */
export function applyMoveSlice(db: Db, batchId: number, threadIds: readonly number[], now: number): { deltas: ModelDelta[]; touched: number[] } {
  return db.tx(() => {
    const meta = db.get<{ to: number; addedBy: AddedBy; phase: MovePhase; leave: number | null }>(
      "SELECT category_id AS 'to', scope_json ->> '$.addedBy' AS addedBy, scope_json ->> '$.phase' AS phase, scope_json ->> '$.leave' AS leave FROM cat_batches WHERE id = ?",
      batchId,
    );
    if (!meta || meta.phase !== "moving") return { deltas: [], touched: [] };
    // the rows a slice takes out: every other category's, or (leaving) the one category's
    const left = meta.leave ? "=" : "!=";
    const ids = JSON.stringify(
      db
        .all<{ thread_id: number }>("SELECT thread_id FROM cat_move_threads WHERE batch_id = ? AND done = 0 AND thread_id IN (SELECT value FROM json_each(?))", batchId, JSON.stringify(threadIds))
        .map((r) => r.thread_id),
    );
    const slice = "SELECT value FROM json_each(?)";
    db.run(
      `UPDATE cat_move_threads SET
         added = ${meta.leave ? "0" : "NOT EXISTS (SELECT 1 FROM thread_categories tc WHERE tc.thread_id = cat_move_threads.thread_id AND tc.category_id = ?)"},
         moved = EXISTS (SELECT 1 FROM thread_categories tc WHERE tc.thread_id = cat_move_threads.thread_id AND tc.category_id ${left} ?)
       WHERE batch_id = ? AND thread_id IN (${slice})`,
      ...(meta.leave ? [] : [meta.to]),
      meta.to,
      batchId,
      ids,
    );
    // every row the slice removes, with its category, origin and batch (undo puts each back exactly)
    db.run(
      `INSERT OR IGNORE INTO cat_move_rows (batch_id, thread_id, category_id, added_by, added_at, prev_batch_id)
       SELECT ?, thread_id, category_id, added_by, added_at, batch_id FROM thread_categories WHERE thread_id IN (${slice}) AND category_id ${left} ?`,
      batchId,
      ids,
      meta.to,
    );
    const decisions = touched("cls_decisions", batchId, meta.to, ids);
    db.run(
      `INSERT OR IGNORE INTO cat_move_decisions (batch_id, thread_id, category_id, outcome)
       SELECT ?, thread_id, category_id, outcome FROM cls_decisions WHERE ${decisions.where}`,
      batchId,
      ...decisions.params,
    );
    db.run(`DELETE FROM thread_categories WHERE thread_id IN (${slice}) AND category_id ${left} ?`, ids, meta.to);
    const added = db
      .all<{ thread_id: number }>(
        `INSERT INTO thread_categories (thread_id, category_id, added_by, added_at, batch_id)
         SELECT thread_id, ?, ?, ?, ? FROM cat_move_threads WHERE batch_id = ? AND added = 1 AND thread_id IN (${slice})
         RETURNING thread_id`,
        meta.to,
        meta.addedBy,
        now,
        batchId,
        batchId,
        ids,
      )
      .map((r) => r.thread_id);
    // what addToCategory / removeFromCategory record about decisions
    db.run(
      `UPDATE cls_decisions SET outcome = 'accepted' WHERE category_id = ? AND kind = 'suggest' AND outcome IS NULL
         AND thread_id IN (SELECT value FROM json_each(?))`,
      meta.to,
      JSON.stringify(added),
    );
    db.run(
      `UPDATE cls_decisions SET outcome = 'reverted' WHERE kind = 'auto' AND outcome IS NULL AND at >= ?
         AND thread_id IN (SELECT thread_id FROM cat_move_rows WHERE batch_id = ? AND added_by = 'auto' AND thread_id IN (${slice}))
         AND EXISTS (SELECT 1 FROM cat_move_rows r WHERE r.batch_id = ? AND r.added_by = 'auto' AND r.thread_id = cls_decisions.thread_id AND r.category_id = cls_decisions.category_id)`,
      now - POLICY.revertWindowDays * 86_400_000,
      batchId,
      ids,
      batchId,
    );
    db.run(`UPDATE cat_move_threads SET done = 1 WHERE batch_id = ? AND thread_id IN (${slice})`, batchId, ids);
    if (nextPhaseWhenDone(db, batchId, "training")) {
      finishBatch(db, batchId, db.get<{ c: number }>("SELECT count(*) AS c FROM cat_move_threads WHERE batch_id = ? AND added = 1", batchId)!.c);
    }
    const sliceIds = JSON.parse(ids) as number[];
    const deltas: ModelDelta[] = added.map((threadId) => ({ op: "unbackground", threadId }));
    // leaving can take a thread's last category: it may go back to the background
    if (meta.leave) {
      const out = db.all<{ thread_id: number }>(`SELECT thread_id FROM cat_move_threads WHERE batch_id = ? AND moved = 1 AND thread_id IN (${slice})`, batchId, ids).map((r) => r.thread_id);
      deltas.push(...backgroundDeltas(db, out, now));
    }
    return { deltas, touched: sliceIds };
  });
}

/** One slice of a move's training: a positive in the destination for added threads, a removal example in each category a thread left. */
export function trainMoveSlice(db: Db, batchId: number, threadIds: readonly number[], now: number, own?: OwnAddresses): ModelDelta[] {
  return db.tx(() => {
    const meta = db.get<{ to: number; addedBy: AddedBy }>("SELECT category_id AS 'to', scope_json ->> '$.addedBy' AS addedBy FROM cat_batches WHERE id = ?", batchId);
    if (!meta) return [];
    const rows = db.all<{ thread_id: number; added: number }>(
      "SELECT thread_id, added FROM cat_move_threads WHERE batch_id = ? AND done = 0 AND thread_id IN (SELECT value FROM json_each(?))",
      batchId,
      JSON.stringify(threadIds),
    );
    const ids = JSON.stringify(rows.map((r) => r.thread_id));
    // the examples this slice overwrites go to the journal first (undo puts them back); journaling them here
    // instead of in beginMove keeps feature blobs out of the membership commit
    const journaled = touched("cls_examples", batchId, meta.to, ids);
    db.run(
      `INSERT OR IGNORE INTO cat_move_examples (batch_id, thread_id, category_id, label, weight, source, at, sender, content, example_batch_id, features)
       SELECT ?, thread_id, category_id, label, weight, source, at, sender, content, batch_id, features FROM cls_examples
       WHERE ${journaled.where}`,
      batchId,
      ...journaled.params,
    );
    const left = new Map<number, number[]>();
    for (const r of db.all<{ thread_id: number; category_id: number }>(
      "SELECT thread_id, category_id FROM cat_move_rows WHERE batch_id = ? AND thread_id IN (SELECT value FROM json_each(?)) ORDER BY thread_id, category_id",
      batchId,
      ids,
    )) {
      const list = left.get(r.thread_id) ?? [];
      list.push(r.category_id);
      left.set(r.thread_id, list);
    }
    const deltas: ModelDelta[] = [];
    const source = TRAINING_SOURCE[meta.addedBy];
    const sets = threadFeatures(db, rows.map((r) => r.thread_id), own);
    for (const r of rows) {
      const set = sets.get(r.thread_id);
      if (!set) continue;
      if (r.added && source) deltas.push(...putExample(db, { threadId: r.thread_id, categoryId: meta.to, label: 1, source, at: now, batchId, set }));
      for (const categoryId of left.get(r.thread_id) ?? []) deltas.push(...putExample(db, { threadId: r.thread_id, categoryId, label: -1, source: "removal", at: now, batchId: null, set }));
    }
    db.run("UPDATE cat_move_threads SET done = 1 WHERE batch_id = ? AND thread_id IN (SELECT value FROM json_each(?))", batchId, ids);
    if (!db.get("SELECT 1 FROM cat_move_threads WHERE batch_id = ? AND done = 0 LIMIT 1", batchId)) setPhase(db, batchId, "done");
    return deltas;
  });
}

export interface UndoMoveResult extends UndoResult {
  /** threads back in (at least one of) the categories they left */
  restored: number[];
}

/**
 * Starts taking a (fully applied and trained) move back: its memberships and
 * decisions then come back in slices (undoMoveSlice), its examples after
 * (restoreMoveSlice). Idempotent: false when there is nothing (left) to start.
 */
export function undoMoveBegin(db: Db, batchId: number, now: number): boolean {
  return db.tx(() => {
    const batch = db.get<{ undone_at: number | null; phase: MovePhase }>("SELECT undone_at, scope_json ->> '$.phase' AS phase FROM cat_batches WHERE id = ?", batchId);
    if (!batch || batch.undone_at !== null) return false;
    if (batch.phase === "expired") throw new RpcError("NOT_FOUND", L("errors.moveExpired"));
    if (batch.phase !== "done") throw new Error(`move ${batchId} is still being applied`);
    db.run("UPDATE cat_move_threads SET done = 0 WHERE batch_id = ?", batchId);
    setPhase(db, batchId, "unmoving");
    finishUndo(db, batchId, now);
    return true;
  });
}

/**
 * One slice of an undo, in one transaction: these threads leave the
 * destination if the move added them, get every row they lost back with its
 * original origin and batch (so undoing that earlier batch still works), and
 * their decision outcomes return to what they were.
 */
export function undoMoveSlice(db: Db, batchId: number, threadIds: readonly number[], now: number): UndoMoveResult {
  return db.tx(() => {
    const batch = db.get<{ category_id: number; phase: MovePhase }>("SELECT category_id, scope_json ->> '$.phase' AS phase FROM cat_batches WHERE id = ?", batchId);
    if (!batch || batch.phase !== "unmoving") return { categoryId: null, removed: [], restored: [], deltas: [] };
    const to = batch.category_id;
    const ids = JSON.stringify(
      db
        .all<{ thread_id: number }>("SELECT thread_id FROM cat_move_threads WHERE batch_id = ? AND done = 0 AND thread_id IN (SELECT value FROM json_each(?))", batchId, JSON.stringify(threadIds))
        .map((r) => r.thread_id),
    );
    const removed = db
      .all<{ thread_id: number }>(`DELETE FROM thread_categories WHERE batch_id = ? AND category_id = ? AND thread_id IN (SELECT value FROM json_each(?)) RETURNING thread_id`, batchId, to, ids)
      .map((r) => r.thread_id);
    // a category deleted since has nothing to come back to
    const restored = db
      .all<{ thread_id: number }>(
        `INSERT OR REPLACE INTO thread_categories (thread_id, category_id, added_by, added_at, batch_id)
         SELECT r.thread_id, r.category_id, r.added_by, r.added_at, r.prev_batch_id FROM cat_move_rows r
         WHERE r.batch_id = ? AND r.thread_id IN (SELECT value FROM json_each(?))
           AND EXISTS (SELECT 1 FROM threads WHERE id = r.thread_id) AND EXISTS (SELECT 1 FROM categories WHERE id = r.category_id)
         RETURNING thread_id`,
        batchId,
        ids,
      )
      .map((r) => r.thread_id);
    const decisions = touched("cls_decisions", batchId, to, ids);
    db.run(`UPDATE cls_decisions SET outcome = NULL WHERE ${decisions.where}`, ...decisions.params);
    db.run(
      `UPDATE cls_decisions SET outcome = d.outcome FROM cat_move_decisions d
       WHERE d.batch_id = ? AND d.thread_id IN (SELECT value FROM json_each(?)) AND cls_decisions.thread_id = d.thread_id AND cls_decisions.category_id = d.category_id`,
      batchId,
      ids,
    );
    db.run("UPDATE cat_move_threads SET done = 1 WHERE batch_id = ? AND thread_id IN (SELECT value FROM json_each(?))", batchId, ids);
    nextPhaseWhenDone(db, batchId, "restoring");
    const back = [...new Set(restored)].sort((a, b) => a - b);
    const deltas: ModelDelta[] = back.map((threadId) => ({ op: "unbackground", threadId }));
    deltas.push(...backgroundDeltas(db, removed, now));
    return { categoryId: to, removed, restored: back, deltas };
  });
}

/** One slice of an undo's example restore: every affected category's examples for these threads go back to the journal's. */
export function restoreMoveSlice(db: Db, batchId: number, threadIds: readonly number[]): ModelDelta[] {
  return db.tx(() => {
    const batch = db.get<{ to: number }>("SELECT category_id AS 'to' FROM cat_batches WHERE id = ?", batchId);
    if (!batch) return [];
    const ids = JSON.stringify(
      db
        .all<{ thread_id: number }>("SELECT thread_id FROM cat_move_threads WHERE batch_id = ? AND done = 0 AND thread_id IN (SELECT value FROM json_each(?))", batchId, JSON.stringify(threadIds))
        .map((r) => r.thread_id),
    );
    const replaced = touched("cls_examples", batchId, batch.to, ids, true);
    const deltas: ModelDelta[] = db
      .all<ExampleRow>(`DELETE FROM cls_examples WHERE ${replaced.where} RETURNING *`, ...replaced.params)
      .map((r) => ({ op: "untrain", example: toExample(r), key: [r.thread_id, r.category_id] }));
    for (const r of db.all<ExampleRow>(
      `INSERT INTO cls_examples (thread_id, category_id, label, weight, source, at, sender, content, batch_id, features)
       SELECT e.thread_id, e.category_id, e.label, e.weight, e.source, e.at, e.sender, e.content, e.example_batch_id, e.features FROM cat_move_examples e
       WHERE e.batch_id = ? AND e.thread_id IN (SELECT value FROM json_each(?)) AND EXISTS (SELECT 1 FROM threads WHERE id = e.thread_id)
         AND EXISTS (SELECT 1 FROM categories WHERE id = e.category_id)
       RETURNING *`,
      batchId,
      ids,
    )) {
      deltas.push({ op: "train", example: toExample(r), key: [r.thread_id, r.category_id] });
    }
    db.run("UPDATE cat_move_threads SET done = 1 WHERE batch_id = ? AND thread_id IN (SELECT value FROM json_each(?))", batchId, ids);
    // these threads are back for good: their journal goes with this slice (one delete for 100,000 rows would stall)
    for (const t of ["cat_move_rows", "cat_move_examples", "cat_move_decisions"]) db.run(`DELETE FROM ${t} WHERE batch_id = ? AND thread_id IN (SELECT value FROM json_each(?))`, batchId, ids);
    if (!db.get("SELECT 1 FROM cat_move_threads WHERE batch_id = ? AND done = 0 LIMIT 1", batchId)) {
      setPhase(db, batchId, "undone");
      for (const t of JOURNAL_TABLES) db.run(`DELETE FROM ${t} WHERE batch_id = ?`, batchId);
    }
    return deltas;
  });
}

// ───────────────────────────── rebuild ─────────────────────────────

/** Training examples, oldest first (the bulk content cap was decided at write time). */
export function loadExamples(db: Db): TrainExample[] {
  return db.all<ExampleRow>("SELECT * FROM cls_examples ORDER BY at, thread_id, category_id").map(toExample);
}

/** One page of the training set in key order (a rebuild reads it in bounded slices). */
export function loadExamplesPage(db: Db, after: ExampleKey | null, limit: number): { example: TrainExample; key: ExampleKey }[] {
  const rows = after
    ? db.all<ExampleRow>("SELECT * FROM cls_examples WHERE (thread_id, category_id) > (?, ?) ORDER BY thread_id, category_id LIMIT ?", after[0], after[1], limit)
    : db.all<ExampleRow>("SELECT * FROM cls_examples ORDER BY thread_id, category_id LIMIT ?", limit);
  return rows.map((r) => ({ example: toExample(r), key: [r.thread_id, r.category_id] }));
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
    "UPDATE cls_decisions INDEXED BY cls_decisions_maturing SET outcome = 'kept' WHERE kind = 'auto' AND outcome IS NULL AND at < ?",
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


/** What the policy needs from the database: one batch of reads per store command. */
function policyContext(db: Db): Map<number, CategoryPolicy & { name: string }> {
  const valve = new Map(
    db
      .all<{ category_id: number; kept: number; reverted: number }>(
        `SELECT category_id, coalesce(sum(outcome = 'kept'), 0) AS kept, coalesce(sum(outcome = 'reverted'), 0) AS reverted
         FROM cls_decisions INDEXED BY cls_decisions_outcomes WHERE kind = 'auto' AND outcome IS NOT NULL GROUP BY category_id`,
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

/** The user's removals in the sender-veto window, per "category:sender" (a small set). */
function recentRemovals(db: Db, now: number): Map<string, number> {
  return new Map(
    db
      .all<{ category_id: number; sender: string; n: number }>(
        "SELECT category_id, sender, count(*) AS n FROM cls_examples INDEXED BY cls_examples_removals WHERE label < 0 AND at >= ? AND source = 'removal' GROUP BY category_id, sender",
        now - POLICY.senderVetoDays * 86_400_000,
      )
      .map((r) => [`${r.category_id}:${r.sender}`, r.n]),
  );
}

function senderPositives(db: Db, categoryId: number, sender: string, now: number): number {
  return db.get<{ n: number }>(
    "SELECT count(*) AS n FROM cls_examples INDEXED BY cls_examples_sender WHERE category_id = ? AND sender = ? AND at >= ? AND label > 0",
    categoryId,
    sender,
    now - POLICY.senderVetoDays * 86_400_000,
  )!.n;
}

export function vetoesFor(
  db: Db,
  threadId: number,
  sender: string,
  categoryIds: readonly number[],
  now: number,
  /** per-store-command cache of sender histories ("category:sender") */
  senderCache: Map<string, { rem: number; pos: number }> = new Map(),
): Map<number, Vetoes> {
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
    const key = `${categoryId}:${sender}`;
    let s = senderCache.get(key);
    if (!s) {
      s = db.get<{ rem: number; pos: number }>(
        `SELECT coalesce(sum(label < 0), 0) AS rem, coalesce(sum(label > 0), 0) AS pos
         FROM cls_examples INDEXED BY cls_examples_sender WHERE category_id = ? AND sender = ? AND at >= ?`,
        categoryId,
        sender,
        since,
      )!;
      senderCache.set(key, s);
    }
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
/**
 * Threads no explicit decision closed to the engine: no training example, no
 * category the user (or a filter, agent, bulk add) set, no answered or
 * reverted decision. The engine's own auto adds don't close a thread: the
 * body arriving may still decide the other categories.
 */
const UNDECIDED = `SELECT value AS t FROM json_each(?) j
  WHERE NOT EXISTS (SELECT 1 FROM thread_categories WHERE thread_id = j.value AND added_by != 'auto')
    AND NOT EXISTS (SELECT 1 FROM cls_examples WHERE thread_id = j.value)
    AND NOT EXISTS (SELECT 1 FROM cls_decisions WHERE thread_id = j.value AND outcome IS NOT NULL)`;

/**
 * Classifies new inbound mail inside the ingestion transaction, so messages,
 * filter effects and the engine's decisions commit (or roll back) together.
 * Only threads nobody has decided on are evaluated: no category (filters run
 * first), no example, no decision beyond a pending suggestion. Auto adds never
 * train. Mail older than the auto window is backfill: counted here, suggested
 * later in one sliced pass (suggestBackfill), so an initial sync stays fast.
 * Must run inside the caller's transaction (the ingestion slice).
 */
export function classifyNewThreads(db: Db, req: ClassifyRequest): ClassifyResult {
  if (!db.inTransaction) throw new Error("classifyNewThreads runs inside the ingestion transaction");
  const out = emptyResult();
  const changed = [...req.inserted, ...req.bodyCompleted];
  if (changed.length === 0 || req.mode === "off") return out;
  const fresh = new Set(changed);
  const inserted = new Set(req.inserted);
  const threadIds = db
    .all<{ thread_id: number }>("SELECT DISTINCT thread_id FROM messages WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(changed))
    .map((r) => r.thread_id);
  const undecided = db.all<{ t: number }>(UNDECIDED, JSON.stringify(threadIds)).map((r) => r.t);
  if (undecided.length === 0) return out;
  const own = ownAddresses(db);
  const window = req.now - POLICY.autoWindowDays * 86_400_000;
  // flags first (one batched read), bodies and features only for what will be scored
  const candidates: RootRef[] = [];
  for (const ref of rootRefs(db, undecided, own)) {
    // a reply on an old conversation, or a flag update: not new mail
    if (!fresh.has(ref.messageId) || ref.spam || ref.trash || ref.draft) continue;
    if (ref.date < window) {
      // old mail arriving (initial sync, backfill): background and suggestions catch up once it settles
      if (inserted.has(ref.messageId)) out.backfill++;
      continue;
    }
    if (ref.inInbox) candidates.push(ref);
  }
  decideThreads(db, rootsWithBodies(db, candidates), { ...req, autoEligible: true }, own, out);
  return out;
}

/**
 * Suggestions for undecided inbox threads older than the auto window (they
 * arrived as backfill). Never auto-applies. One slice: call it in chunks.
 */
export function suggestBackfill(db: Db, req: { threadIds: readonly number[]; now: number; mode: AutoCategorize; model: CategorizerModel }): ClassifyResult {
  const out = emptyResult();
  if (req.mode === "off" || req.threadIds.length === 0) return out;
  db.tx(() => {
    const undecided = db.all<{ t: number }>(UNDECIDED, JSON.stringify(req.threadIds)).map((r) => r.t);
    const own = ownAddresses(db);
    const refs = rootRefs(db, undecided, own).filter((r) => r.inInbox && !r.spam && !r.trash && !r.draft);
    decideThreads(db, rootsWithBodies(db, refs), { ...req, autoEligible: false }, own, out);
  });
  return out;
}

function withdrawSuggestions(db: Db, threadId: number, keep: readonly number[]): void {
  db.run(
    "DELETE FROM cls_decisions WHERE thread_id = ? AND kind = 'suggest' AND outcome IS NULL AND category_id NOT IN (SELECT value FROM json_each(?))",
    threadId,
    JSON.stringify(keep),
  );
}

/** Inbox threads that arrived as backfill and nobody decided on yet (most recent first). */
export function backfillCandidates(db: Db, now: number, limit = 5000): number[] {
  return db
    .all<{ id: number }>(
      `SELECT t.id FROM threads t INDEXED BY threads_inbox
       WHERE t.in_inbox = 1 AND t.last_date < ?
         AND NOT EXISTS (SELECT 1 FROM thread_categories tc WHERE tc.thread_id = t.id)
         AND NOT EXISTS (SELECT 1 FROM cls_decisions d WHERE d.thread_id = t.id)
         AND NOT EXISTS (SELECT 1 FROM cls_examples e WHERE e.thread_id = t.id)
       ORDER BY t.last_date DESC, t.id DESC LIMIT ?`,
      now - POLICY.autoWindowDays * 86_400_000,
      limit,
    )
    .map((r) => r.id);
}

function emptyResult(): ClassifyResult {
  return { deltas: [], auto: new Map(), suggested: 0, touched: new Set(), uncertain: [], backfill: 0 };
}

function decideThreads(
  db: Db,
  roots: Map<number, RootMessage>,
  req: { now: number; mode: AutoCategorize; model: CategorizerModel; autoEligible: boolean },
  own: OwnAddresses,
  out: ClassifyResult,
): void {
  let policies: Map<number, CategoryPolicy & { name: string }> | null = null;
  let removals: Map<string, number> | null = null;
  for (const [threadId, root] of roots) {
    const features = extractFeatures(root.source, { ownDomains: own.domains });
    const set: ThreadFeatureSet = { root, features, encoded: encodeFeatures(features) };
    // categories the engine already filed this thread in stay as they are (their decision keeps its date)
    const filed = new Set(db.all<{ category_id: number }>("SELECT category_id FROM thread_categories WHERE thread_id = ?", threadId).map((r) => r.category_id));
    const scores = req.model.score(set.encoded).filter((s) => !filed.has(s.categoryId));
    const likely = candidateCategories(scores);
    if (likely.length === 0) {
      withdrawSuggestions(db, threadId, []);
      if (scores.some((s) => s.p >= 0.5)) out.uncertain.push(threadId);
      continue;
    }
    policies ??= policyContext(db);
    removals ??= recentRemovals(db, req.now);
    const vetoes = new Map<number, Vetoes>();
    for (const categoryId of likely) {
      // undecided threads have no examples or settled decisions: no hard veto is possible here
      const rem = removals.get(`${categoryId}:${set.features.sender}`) ?? 0;
      vetoes.set(categoryId, { hard: false, senderRemovals: rem, senderPositives: rem >= POLICY.senderVetoRemovals ? senderPositives(db, categoryId, set.features.sender, req.now) : 0 });
    }
    const decisions = decide({
      mode: req.mode,
      autoEligible: req.autoEligible && root.date >= req.now - POLICY.autoWindowDays * 86_400_000,
      scores,
      categories: policies,
      vetoes,
      lookAlike: req.model.lookAlike(set.encoded),
      senderSupport: req.model.senderSupport(set.encoded),
    });
    // the pending suggestions are replaced as a set: what the new evidence doesn't support goes
    withdrawSuggestions(db, threadId, decisions.filter((d) => d.decision !== "none").map((d) => d.categoryId));
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
      // already inside the store command's transaction: no savepoint per add
      const added = db.run(
        "INSERT OR IGNORE INTO thread_categories (thread_id, category_id, added_by, added_at) VALUES (?, ?, 'auto', ?)",
        threadId,
        d.categoryId,
        req.now,
      ).changes;
      if (added > 0) {
        out.deltas.push({ op: "unbackground", threadId });
        out.auto.set(d.categoryId, [...(out.auto.get(d.categoryId) ?? []), threadId]);
      }
    }
  }
}
