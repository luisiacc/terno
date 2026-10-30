import { RpcError } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import {
  BULK_CONTENT_CAP,
  candidateCategories,
  CONSUMER_DOMAINS,
  COUNT_CAP,
  decide,
  encodeFeatures,
  explain,
  parseReasons,
  extractFeatures,
  featuresFromBlob,
  featuresToBlob,
  fnv1a,
  normalizeText,
  POLICY,
  SOURCE_WEIGHT,
  valvePaused,
  type AutoCategorize,
  type CategorizerModel,
  type Reason,
  type CategorizeScope,
  type CategoryModelStats,
  type CategoryPolicy,
  type ExampleSource,
  type Prediction,
  type QuickActions,
  type TrainExample,
  type Vetoes,
} from "@terno/core";
import type { AddedBy, ClassifyResult, ExampleKey, ModelDelta, MovePhase, PendingSuggestion, RootMessage, ThreadFeatureSet } from "@terno/store";
import { pendingSuggestionCounts, T, type Ctx, type R } from "./mail";

/**
 * Plan 02's store commands (packages/db/src/categorize*.ts), ported onto
 * the in-memory tables with the same rules: explicit origins train, filter
 * and auto adds never do, a removal is a strong negative, merges honor the
 * newest decision, moves journal what they overwrite.
 */

const TRAINING_SOURCE: Partial<Record<AddedBy, ExampleSource>> = { user: "user", suggestion: "suggestion", agent: "agent", bulk: "bulk" };
const DAY = 86_400_000;
export const MOVE_UNDO_WINDOW_MS = 86_400_000;
export const BACKGROUND_MIN_AGE_MS = 3 * DAY;

export interface OwnAddresses {
  emails: Set<string>;
  domains: Set<string>;
}

export function ownAddresses(c: Ctx): OwnAddresses {
  const emails = new Set([...T(c, "accounts").all()].map((r) => String(r.email).toLowerCase()));
  return { emails, domains: new Set([...emails].map((e) => e.slice(e.lastIndexOf("@") + 1))) };
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

/** The earliest inbound message of each thread, from an address that isn't the user's. */
export function rootRefs(c: Ctx, threadIds: Iterable<number>, own: OwnAddresses = ownAddresses(c)): RootRef[] {
  const messages = T(c, "messages");
  const out: RootRef[] = [];
  for (const threadId of new Set(threadIds)) {
    let root: R | null = null;
    for (const m of messages.by("fk_thread_id", threadId)) {
      if (m.is_sent || own.emails.has(m.from_email)) continue;
      if (!root || m.date < root.date || (m.date === root.date && m.id < root.id)) root = m;
    }
    if (root) out.push({ threadId, messageId: root.id, date: root.date, inInbox: root.in_inbox === 1, spam: root.is_spam === 1, trash: root.is_trash === 1, draft: root.is_draft === 1 });
  }
  return out;
}

/** The roots' bodies must have been read ahead (the store does it before the command's synchronous part). */
export function rootsWithBodies(c: Ctx, refs: readonly RootRef[]): Map<number, RootMessage> {
  const messages = T(c, "messages");
  const attachments = T(c, "attachments");
  const out = new Map<number, RootMessage>();
  for (const ref of refs) {
    const m = messages.get(ref.messageId)!;
    const replied = messages.by("fk_thread_id", m.thread_id).some((s) => s.is_sent === 1);
    out.set(ref.threadId, {
      threadId: ref.threadId,
      messageId: m.id,
      date: m.date,
      inInbox: m.in_inbox === 1,
      spam: m.is_spam === 1,
      trash: m.is_trash === 1,
      draft: m.is_draft === 1,
      bodyComplete: m.body_state === "full",
      source: {
        fromEmail: m.from_email,
        fromName: m.from_name,
        listId: m.list_id,
        subject: m.subject,
        bodyText: c.body(m.id)?.body_text ?? null,
        replied,
        attachmentNames: m.has_attachments ? attachments.by("fk_message_id", m.id).sort((x, y) => x.id - y.id).map((a) => a.filename as string) : [],
      },
    });
  }
  return out;
}

export function threadFeatures(c: Ctx, threadIds: Iterable<number>, own: OwnAddresses = ownAddresses(c)): Map<number, ThreadFeatureSet> {
  const out = new Map<number, ThreadFeatureSet>();
  for (const [id, root] of rootsWithBodies(c, rootRefs(c, threadIds, own))) {
    const features = extractFeatures(root.source, { ownDomains: own.domains });
    out.set(id, { root, features, encoded: encodeFeatures(features) });
  }
  return out;
}

export const toExample = (r: R): TrainExample => ({ categoryId: r.category_id, label: r.label > 0 ? 1 : -1, weight: r.weight, at: r.at, content: r.content === 1, features: featuresFromBlob(r.features) });

function putExample(c: Ctx, e: { threadId: number; categoryId: number; label: 1 | -1; source: ExampleSource; at: number; batchId: number | null; set: ThreadFeatureSet }): ModelDelta[] {
  const examples = T(c, "cls_examples");
  const deltas: ModelDelta[] = [];
  const previous = examples.get(e.threadId, e.categoryId);
  if (previous) deltas.push({ op: "untrain", example: toExample(previous), key: [e.threadId, e.categoryId] });
  let content = 1;
  if (e.source === "bulk") {
    const used = examples.by("sender", e.categoryId, e.set.features.sender).filter((x) => x.source === "bulk" && x.content === 1 && x.thread_id !== e.threadId).length;
    content = used < BULK_CONTENT_CAP ? 1 : 0;
  }
  const weight = SOURCE_WEIGHT[e.source];
  examples.put({ thread_id: e.threadId, category_id: e.categoryId, label: e.label, weight, source: e.source, at: e.at, sender: e.set.features.sender, content, batch_id: e.batchId, features: featuresToBlob(e.set.encoded) });
  deltas.push({ op: "train", example: { categoryId: e.categoryId, label: e.label, weight, at: e.at, content: content === 1, features: e.set.encoded }, key: [e.threadId, e.categoryId] });
  return deltas;
}

function settleSuggestions(c: Ctx, categoryId: number, threadIds: Iterable<number>, outcome: "accepted"): void {
  const decisions = T(c, "cls_decisions");
  for (const t of threadIds) {
    const d = decisions.get(t, categoryId);
    if (d && d.kind === "suggest" && d.outcome === null) decisions.update(d, { outcome });
  }
}

export function addToCategory(c: Ctx, a: { categoryId: number; threadIds: readonly number[]; addedBy: AddedBy; now: number; batchId?: number | null }): { added: number[]; deltas: ModelDelta[] } {
  const added: number[] = [];
  const deltas: ModelDelta[] = [];
  c.db.tx(() => {
    const threads = T(c, "threads");
    for (const threadId of new Set(a.threadIds)) {
      if (!threads.has(threadId)) continue;
      if (T(c, "thread_categories").insert({ thread_id: threadId, category_id: a.categoryId, added_by: a.addedBy, added_at: a.now, batch_id: a.batchId ?? null })) {
        added.push(threadId);
        deltas.push({ op: "unbackground", threadId });
      }
    }
    const source = TRAINING_SOURCE[a.addedBy];
    if (!source || added.length === 0) return;
    const sets = threadFeatures(c, added);
    for (const threadId of added) {
      const set = sets.get(threadId);
      if (set) deltas.push(...putExample(c, { threadId, categoryId: a.categoryId, label: 1, source, at: a.now, batchId: a.batchId ?? null, set }));
    }
    settleSuggestions(c, a.categoryId, added, "accepted");
  });
  return { added, deltas };
}

function backgroundDeltas(c: Ctx, threadIds: readonly number[], now: number): ModelDelta[] {
  if (threadIds.length === 0) return [];
  const threads = T(c, "threads");
  const memberships = T(c, "thread_categories");
  const bare = threadIds.filter((id) => {
    const t = threads.get(id);
    return t && !t.in_trash && !t.in_spam && memberships.count("fk_thread_id", id) === 0;
  });
  const out: ModelDelta[] = [];
  for (const [threadId, set] of threadFeatures(c, bare)) if (set.root.date <= now - BACKGROUND_MIN_AGE_MS) out.push({ op: "background", threadId, features: set.encoded });
  return out;
}

export function removeFromCategory(c: Ctx, r: { categoryId: number; threadIds: readonly number[]; reason: "user" | "undo"; now: number }): { removed: number[]; deltas: ModelDelta[] } {
  const removed: number[] = [];
  const deltas: ModelDelta[] = [];
  c.db.tx(() => {
    const memberships = T(c, "thread_categories");
    const examples = T(c, "cls_examples");
    const decisions = T(c, "cls_decisions");
    const negatives: number[] = [];
    for (const threadId of new Set(r.threadIds)) {
      const row = memberships.delete(threadId, r.categoryId);
      if (!row) continue;
      removed.push(threadId);
      if (r.reason === "undo" && row.added_by !== "auto" && row.added_by !== "filter") {
        const previous = examples.get(threadId, r.categoryId);
        if (previous && previous.label > 0) {
          examples.deleteRow(previous);
          deltas.push({ op: "untrain", example: toExample(previous), key: [threadId, r.categoryId] });
        }
        continue;
      }
      if (row.added_by === "auto") {
        const d = decisions.get(threadId, r.categoryId);
        if (d && d.kind === "auto" && d.outcome === null && d.at >= r.now - POLICY.revertWindowDays * DAY) decisions.update(d, { outcome: "reverted" });
      }
      negatives.push(threadId);
    }
    const sets = threadFeatures(c, negatives);
    for (const threadId of negatives) {
      const set = sets.get(threadId);
      if (set) deltas.push(...putExample(c, { threadId, categoryId: r.categoryId, label: -1, source: "removal", at: r.now, batchId: null, set }));
    }
    deltas.push(...backgroundDeltas(c, removed, r.now));
  });
  return { removed, deltas };
}

export function rejectSuggestion(c: Ctx, threadId: number, categoryId: number, now: number): ModelDelta[] {
  return c.db.tx(() => {
    const decisions = T(c, "cls_decisions");
    const d = decisions.get(threadId, categoryId);
    if (d && d.kind === "suggest") decisions.update(d, { outcome: "rejected" });
    const set = threadFeatures(c, [threadId]).get(threadId);
    if (!set) return [];
    return putExample(c, { threadId, categoryId, label: -1, source: "reject", at: now, batchId: null, set });
  });
}

export function createBatch(c: Ctx, categoryId: number, source: string, scope: unknown, now: number): number {
  const row: R = { id: undefined, category_id: categoryId, source, scope_json: JSON.stringify(scope), added: 0, created_at: now, undone_at: null };
  T(c, "cat_batches").insert(row);
  return row.id;
}

export function finishBatch(c: Ctx, batchId: number, added: number): void {
  const batches = T(c, "cat_batches");
  const b = batches.get(batchId);
  if (b) batches.update(b, { added: b.added + added });
}

export function batchThreads(c: Ctx, batchId: number): number[] {
  return T(c, "thread_categories")
    .by("batch", batchId)
    .map((r) => r.thread_id as number)
    .sort((x, y) => x - y);
}

export function undoBatchPart(c: Ctx, batchId: number, threadIds: readonly number[], now: number): { categoryId: number | null; removed: number[]; deltas: ModelDelta[] } {
  return c.db.tx(() => {
    const batch = T(c, "cat_batches").get(batchId);
    if (!batch || batch.undone_at !== null) return { categoryId: null, removed: [], deltas: [] };
    const memberships = T(c, "thread_categories");
    const examples = T(c, "cls_examples");
    const removed: number[] = [];
    const deltas: ModelDelta[] = [];
    for (const t of new Set(threadIds)) {
      const row = memberships.get(t, batch.category_id);
      if (row && row.batch_id === batchId) {
        memberships.deleteRow(row);
        removed.push(t);
      }
    }
    for (const t of new Set(threadIds)) {
      const e = examples.get(t, batch.category_id);
      if (e && e.batch_id === batchId && e.label === 1) {
        examples.deleteRow(e);
        deltas.push({ op: "untrain", example: toExample(e), key: [e.thread_id, e.category_id] });
      }
    }
    deltas.push(...backgroundDeltas(c, removed, now));
    return { categoryId: batch.category_id, removed, deltas };
  });
}

export function finishUndo(c: Ctx, batchId: number, now: number): void {
  const batches = T(c, "cat_batches");
  const b = batches.get(batchId);
  if (b && b.undone_at === null) batches.update(b, { undone_at: now });
}

// ───────────────────────────── moves ─────────────────────────────

const scopeOf = (b: R) => JSON.parse(b.scope_json) as { kind?: string; phase?: MovePhase; from?: number; addedBy?: AddedBy; leave?: boolean };
const JOURNAL = ["cat_move_threads", "cat_move_rows", "cat_move_examples", "cat_move_decisions"];

function setPhase(c: Ctx, batchId: number, phase: MovePhase): void {
  const batches = T(c, "cat_batches");
  const b = batches.get(batchId);
  if (b) batches.update(b, { scope_json: JSON.stringify({ ...scopeOf(b), phase }) });
}

function clearJournal(c: Ctx, batchId: number): void {
  for (const name of JOURNAL) for (const r of T(c, name).by("fk_batch_id", batchId)) T(c, name).deleteRow(r);
}

/** Journal threads of expired moves cleared per call: a large move's journal goes a part at a time. */
const PRUNE_THREADS = 200;

function pruneMoveJournals(c: Ctx, now: number): void {
  let budget = PRUNE_THREADS;
  for (const b of T(c, "cat_batches").all()) {
    const s = scopeOf(b);
    if (s.kind !== "move") continue;
    if (s.phase === "done" && b.created_at < now - MOVE_UNDO_WINDOW_MS) setPhase(c, b.id, "expired");
    else if (s.phase !== "expired") continue;
    for (const r of T(c, "cat_move_threads").by("fk_batch_id", b.id)) {
      if (budget-- <= 0) return;
      for (const name of JOURNAL) for (const x of T(c, name).by("fk_batch_id", b.id)) if (x.thread_id === r.thread_id) T(c, name).deleteRow(x);
    }
  }
}

export function movePhase(c: Ctx, batchId: number): MovePhase | null {
  const b = T(c, "cat_batches").get(batchId);
  if (!b) return null;
  const s = scopeOf(b);
  return s.kind === "move" ? (s.phase ?? null) : null;
}

type UnfinishedPhase = "moving" | "training" | "unmoving" | "restoring";
const UNFINISHED = new Set<MovePhase | undefined>(["moving", "training", "unmoving", "restoring"]);

export function unfinishedMoves(c: Ctx): { batchId: number; phase: UnfinishedPhase }[] {
  return [...T(c, "cat_batches").all()]
    .filter((b) => {
      const s = scopeOf(b);
      return s.kind === "move" && UNFINISHED.has(s.phase);
    })
    .sort((x, y) => x.id - y.id)
    .map((b) => ({ batchId: b.id, phase: scopeOf(b).phase as UnfinishedPhase }));
}

/** The phase is over for every thread: the next one starts from the top. */
function nextPhaseWhenDone(c: Ctx, batchId: number, next: MovePhase): void {
  const journal = T(c, "cat_move_threads");
  const rows = journal.by("fk_batch_id", batchId);
  if (rows.some((r) => r.done === 0)) return;
  for (const r of rows) journal.update(r, { done: 0 });
  setPhase(c, batchId, next);
}

export function movePending(c: Ctx, batchId: number): number[] {
  return T(c, "cat_move_threads")
    .by("fk_batch_id", batchId)
    .filter((r) => r.done === 0)
    .map((r) => r.thread_id as number)
    .sort((x, y) => x - y);
}

/** Each move thread's journaled source rows (the categories it left), by thread. */
function leftBy(c: Ctx, batchId: number): Map<number, R[]> {
  const out = new Map<number, R[]>();
  for (const r of T(c, "cat_move_rows").by("fk_batch_id", batchId)) {
    const list = out.get(r.thread_id) ?? [];
    list.push(r);
    out.set(r.thread_id, list);
  }
  for (const list of out.values()) list.sort((x, y) => x.category_id - y.category_id);
  return out;
}

/**
 * The categories a move touches for one thread: the destination and every
 * one it left. A move from before IndexedDB version 2 (a single `from`)
 * journaled that category for every thread, in the source or not.
 */
const touchedCategories = (to: number, left: readonly R[] | undefined, legacyFrom?: number) => [
  ...new Set([to, ...(legacyFrom === undefined ? [] : [legacyFrom]), ...(left ?? []).map((r) => r.category_id as number)]),
];

/**
 * Records an exclusive move (its threads, nothing more); applyMoveSlice moves them in slices.
 * `leave` (plan 77): the threads only leave `to`, journaled alike, so categorize.undo is exact.
 */
export function beginMove(c: Ctx, m: { to: number; threadIds: readonly number[]; addedBy: AddedBy; now: number; source: string; leave?: boolean }): { batchId: number } {
  return c.db.tx(() => {
    pruneMoveJournals(c, m.now);
    const batchId = createBatch(c, m.to, m.source, { kind: "move", exclusive: !m.leave, ...(m.leave ? { leave: true } : {}), addedBy: m.addedBy, phase: "moving" satisfies MovePhase }, m.now);
    const threads = T(c, "threads");
    const journal = T(c, "cat_move_threads");
    for (const t of [...new Set(m.threadIds)].sort((x, y) => x - y)) if (threads.has(t)) journal.insert({ batch_id: batchId, thread_id: t, added: 0, moved: 0, done: 0 });
    if (journal.by("fk_batch_id", batchId).length === 0) setPhase(c, batchId, "done");
    return { batchId };
  });
}

/** What an applied move did: the threads it added to `to`, and those it took out of another category. */
export function moveOutcome(c: Ctx, batchId: number): { added: number[]; moved: number[] } {
  const rows = T(c, "cat_move_threads").by("fk_batch_id", batchId).sort((x, y) => x.thread_id - y.thread_id);
  return { added: rows.filter((r) => r.added === 1).map((r) => r.thread_id as number), moved: rows.filter((r) => r.moved === 1).map((r) => r.thread_id as number) };
}

/** One slice of a move, one unit: these threads leave every other category (each row journaled) and join `to`. */
export function applyMoveSlice(c: Ctx, batchId: number, threadIds: readonly number[], now: number): { deltas: ModelDelta[]; touched: number[] } {
  return c.db.tx(() => {
    const batch = T(c, "cat_batches").get(batchId);
    if (!batch) return { deltas: [], touched: [] };
    const s = scopeOf(batch);
    if (s.phase !== "moving") return { deltas: [], touched: [] };
    const to = batch.category_id as number;
    const memberships = T(c, "thread_categories");
    const decisions = T(c, "cls_decisions");
    const journal = T(c, "cat_move_threads");
    const wanted = new Set(threadIds);
    const mine = journal.by("fk_batch_id", batchId).filter((r) => r.done === 0 && wanted.has(r.thread_id)).sort((x, y) => x.thread_id - y.thread_id);
    const added: number[] = [];
    for (const r of mine) {
      const rows = memberships.by("fk_thread_id", r.thread_id);
      // the rows a slice takes out: every other category's, or (leaving) the one category's
      const others = rows.filter((x) => (s.leave ? x.category_id === to : x.category_id !== to)).sort((x, y) => x.category_id - y.category_id);
      const isAdded = !s.leave && !rows.some((x) => x.category_id === to);
      for (const src of others) T(c, "cat_move_rows").insert({ batch_id: batchId, thread_id: r.thread_id, category_id: src.category_id, added_by: src.added_by, added_at: src.added_at, prev_batch_id: src.batch_id });
      for (const cat of touchedCategories(to, others, s.from)) {
        const d = decisions.get(r.thread_id, cat);
        if (d) T(c, "cat_move_decisions").insert({ batch_id: batchId, thread_id: r.thread_id, category_id: cat, outcome: d.outcome });
      }
      for (const src of others) memberships.deleteRow(src);
      if (isAdded) {
        memberships.insert({ thread_id: r.thread_id, category_id: to, added_by: s.addedBy, added_at: now, batch_id: batchId });
        added.push(r.thread_id);
      }
      for (const src of others) {
        if (src.added_by !== "auto") continue;
        const d = decisions.get(r.thread_id, src.category_id);
        if (d && d.kind === "auto" && d.outcome === null && d.at >= now - POLICY.revertWindowDays * DAY) decisions.update(d, { outcome: "reverted" });
      }
      journal.update(r, { added: isAdded ? 1 : 0, moved: others.length ? 1 : 0, done: 1 });
    }
    settleSuggestions(c, to, added, "accepted");
    if (!journal.by("fk_batch_id", batchId).some((r) => r.done === 0)) finishBatch(c, batchId, journal.by("fk_batch_id", batchId).filter((r) => r.added === 1).length);
    nextPhaseWhenDone(c, batchId, "training");
    return { deltas: added.map((threadId): ModelDelta => ({ op: "unbackground", threadId })), touched: mine.map((r) => r.thread_id as number) };
  });
}

export function trainMoveSlice(c: Ctx, batchId: number, threadIds: readonly number[], now: number): ModelDelta[] {
  return c.db.tx(() => {
    const batch = T(c, "cat_batches").get(batchId);
    if (!batch) return [];
    const s = scopeOf(batch);
    const to = batch.category_id as number;
    const journal = T(c, "cat_move_threads");
    const wanted = new Set(threadIds);
    const rows = journal.by("fk_batch_id", batchId).filter((r) => r.done === 0 && wanted.has(r.thread_id)).sort((x, y) => x.thread_id - y.thread_id);
    const left = leftBy(c, batchId);
    const examples = T(c, "cls_examples");
    for (const r of rows) {
      for (const cat of touchedCategories(to, left.get(r.thread_id), s.from)) {
        const e = examples.get(r.thread_id, cat);
        if (e) T(c, "cat_move_examples").insert({ batch_id: batchId, thread_id: e.thread_id, category_id: e.category_id, label: e.label, weight: e.weight, source: e.source, at: e.at, sender: e.sender, content: e.content, example_batch_id: e.batch_id, features: e.features });
      }
    }
    const deltas: ModelDelta[] = [];
    const source = TRAINING_SOURCE[s.addedBy!];
    const sets = threadFeatures(c, rows.map((r) => r.thread_id as number));
    for (const r of rows) {
      const set = sets.get(r.thread_id);
      if (!set) continue;
      if (r.added && source) deltas.push(...putExample(c, { threadId: r.thread_id, categoryId: to, label: 1, source, at: now, batchId, set }));
      for (const src of left.get(r.thread_id) ?? []) deltas.push(...putExample(c, { threadId: r.thread_id, categoryId: src.category_id, label: -1, source: "removal", at: now, batchId: null, set }));
    }
    // leaving can take a thread's last category: back to the background, here (a resumed move replays training, not the apply)
    if (s.leave) deltas.push(...backgroundDeltas(c, rows.filter((r) => r.moved).map((r) => r.thread_id as number), now));
    for (const r of rows) journal.update(journal.get(batchId, r.thread_id)!, { done: 1 });
    if (!journal.by("fk_batch_id", batchId).some((r) => r.done === 0)) setPhase(c, batchId, "done");
    return deltas;
  });
}

/** Starts taking a fully applied move back (false: nothing left to undo); undoMoveSlice restores in slices. */
export function undoMoveBegin(c: Ctx, batchId: number, now: number): boolean {
  return c.db.tx(() => {
    const batch = T(c, "cat_batches").get(batchId);
    if (!batch || batch.undone_at !== null) return false;
    const s = scopeOf(batch);
    if (s.phase === "expired") throw new RpcError("NOT_FOUND", L("errors.moveExpired"));
    if (s.phase !== "done") throw new Error(`move ${batchId} is still being applied`);
    const journal = T(c, "cat_move_threads");
    for (const r of journal.by("fk_batch_id", batchId)) journal.update(r, { done: 0 });
    setPhase(c, batchId, "unmoving");
    finishUndo(c, batchId, now);
    return true;
  });
}

/** One slice of an undo: these threads leave the destination (if the move added them) and get every row they lost back, exactly. */
export function undoMoveSlice(c: Ctx, batchId: number, threadIds: readonly number[], now: number): { categoryId: number | null; removed: number[]; restored: number[]; deltas: ModelDelta[] } {
  return c.db.tx(() => {
    const batch = T(c, "cat_batches").get(batchId);
    if (!batch) return { categoryId: null, removed: [], restored: [], deltas: [] };
    const s = scopeOf(batch);
    if (s.phase !== "unmoving") return { categoryId: null, removed: [], restored: [], deltas: [] };
    const to = batch.category_id as number;
    const threads = T(c, "threads");
    const categories = T(c, "categories");
    const memberships = T(c, "thread_categories");
    const decisions = T(c, "cls_decisions");
    const journal = T(c, "cat_move_threads");
    const wanted = new Set(threadIds);
    const mine = journal.by("fk_batch_id", batchId).filter((r) => r.done === 0 && wanted.has(r.thread_id)).sort((x, y) => x.thread_id - y.thread_id);
    const left = leftBy(c, batchId);
    const removed: number[] = [];
    const restored = new Set<number>();
    for (const r of mine) {
      const t = r.thread_id as number;
      const row = memberships.get(t, to);
      if (row && row.batch_id === batchId) {
        memberships.deleteRow(row);
        removed.push(t);
      }
      if (threads.has(t)) {
        for (const src of left.get(t) ?? []) {
          // a category deleted since has nothing to come back to
          if (!categories.has(src.category_id)) continue;
          memberships.put({ thread_id: t, category_id: src.category_id, added_by: src.added_by, added_at: src.added_at, batch_id: src.prev_batch_id });
          restored.add(t);
        }
      }
      const cats = touchedCategories(to, left.get(t), s.from);
      for (const cat of cats) {
        const d = decisions.get(t, cat);
        if (d) decisions.update(d, { outcome: null });
      }
      journal.update(r, { done: 1 });
    }
    const slice = new Set(mine.map((r) => r.thread_id as number));
    for (const d of T(c, "cat_move_decisions").by("fk_batch_id", batchId)) {
      if (!slice.has(d.thread_id)) continue;
      const cur = decisions.get(d.thread_id, d.category_id);
      if (cur) decisions.update(cur, { outcome: d.outcome });
    }
    nextPhaseWhenDone(c, batchId, "restoring");
    const back = [...restored].sort((x, y) => x - y);
    const deltas: ModelDelta[] = back.map((threadId) => ({ op: "unbackground", threadId }));
    deltas.push(...backgroundDeltas(c, removed, now));
    return { categoryId: to, removed, restored: back, deltas };
  });
}

export function restoreMoveSlice(c: Ctx, batchId: number, threadIds: readonly number[]): ModelDelta[] {
  return c.db.tx(() => {
    const batch = T(c, "cat_batches").get(batchId);
    if (!batch) return [];
    const to = batch.category_id as number;
    const journal = T(c, "cat_move_threads");
    const wanted = new Set(threadIds);
    const ids = journal.by("fk_batch_id", batchId).filter((r) => r.done === 0 && wanted.has(r.thread_id)).map((r) => r.thread_id as number).sort((x, y) => x - y);
    const left = leftBy(c, batchId);
    const legacyFrom = scopeOf(batch).from;
    // whatever the journal holds goes back in its place, so what is there now goes first
    const journaled = new Map<number, number[]>();
    for (const e of T(c, "cat_move_examples").by("fk_batch_id", batchId)) journaled.set(e.thread_id, [...(journaled.get(e.thread_id) ?? []), e.category_id]);
    const examples = T(c, "cls_examples");
    const deltas: ModelDelta[] = [];
    for (const t of ids) for (const cat of new Set([...touchedCategories(to, left.get(t), legacyFrom), ...(journaled.get(t) ?? [])])) {
      const e = examples.delete(t, cat);
      if (e) deltas.push({ op: "untrain", example: toExample(e), key: [e.thread_id, e.category_id] });
    }
    const threads = T(c, "threads");
    const categories = T(c, "categories");
    const idSet = new Set(ids);
    for (const e of T(c, "cat_move_examples").by("fk_batch_id", batchId).sort((x, y) => x.thread_id - y.thread_id || x.category_id - y.category_id)) {
      if (!idSet.has(e.thread_id) || !threads.has(e.thread_id) || !categories.has(e.category_id)) continue;
      const row: R = { thread_id: e.thread_id, category_id: e.category_id, label: e.label, weight: e.weight, source: e.source, at: e.at, sender: e.sender, content: e.content, batch_id: e.example_batch_id, features: e.features };
      examples.insert(row);
      deltas.push({ op: "train", example: toExample(row), key: [row.thread_id, row.category_id] });
    }
    for (const t of ids) journal.update(journal.get(batchId, t)!, { done: 1 });
    if (!journal.by("fk_batch_id", batchId).some((r) => r.done === 0)) {
      setPhase(c, batchId, "undone");
      clearJournal(c, batchId);
    }
    return deltas;
  });
}

// ───────────────────────────── training set ─────────────────────────────

export function loadExamples(c: Ctx): TrainExample[] {
  return [...T(c, "cls_examples").all()].sort((x, y) => x.at - y.at || x.thread_id - y.thread_id || x.category_id - y.category_id).map(toExample);
}

export function loadExamplesPage(c: Ctx, after: ExampleKey | null, limit: number): { example: TrainExample; key: ExampleKey }[] {
  return [...T(c, "cls_examples").all()]
    .filter((r) => !after || r.thread_id > after[0] || (r.thread_id === after[0] && r.category_id > after[1]))
    .sort((x, y) => x.thread_id - y.thread_id || x.category_id - y.category_id)
    .slice(0, limit)
    .map((r) => ({ example: toExample(r), key: [r.thread_id, r.category_id] as ExampleKey }));
}

export function backgroundCandidates(c: Ctx, now: number, limit = 20_000): number[] {
  const threads = T(c, "threads");
  const messages = T(c, "messages");
  const memberships = T(c, "thread_categories");
  const out: number[] = [];
  for (const id of c.order.current(threads)) {
    if (out.length >= limit) break;
    const t = threads.get(id)!;
    if (t.in_trash || t.in_spam || memberships.count("fk_thread_id", id) > 0) continue;
    if (messages.by("fk_thread_id", id).some((m) => m.is_sent === 0 && m.date <= now - BACKGROUND_MIN_AGE_MS)) out.push(id);
  }
  return out;
}

/** Rows that need an example (written without one): the threads whose roots the store reads ahead. */
export function backfillRows(c: Ctx, limit: number): R[] {
  const examples = T(c, "cls_examples");
  const out: R[] = [];
  for (const tc of T(c, "thread_categories").all()) {
    if (out.length >= limit) break;
    if (["user", "suggestion", "agent", "bulk"].includes(tc.added_by) && !examples.has(tc.thread_id, tc.category_id)) out.push(tc);
  }
  return out;
}

export function backfillExamples(c: Ctx, rows: readonly R[]): number {
  if (rows.length === 0) return 0;
  const sets = threadFeatures(c, rows.map((r) => r.thread_id as number));
  c.db.tx(() => {
    for (const r of rows) {
      const set = sets.get(r.thread_id);
      const source = TRAINING_SOURCE[r.added_by as AddedBy]!;
      if (!set) {
        T(c, "cls_examples").insert({ thread_id: r.thread_id, category_id: r.category_id, label: 1, weight: 0, source, at: r.added_at, sender: "", content: 1, batch_id: null, features: new Uint8Array(0) });
        continue;
      }
      putExample(c, { threadId: r.thread_id, categoryId: r.category_id, label: 1, source, at: r.added_at, batchId: null, set });
    }
  });
  return rows.length;
}

export function examplesFingerprint(c: Ctx): string {
  let n = 0;
  let max = 0;
  let sum = 0;
  for (const e of T(c, "cls_examples").all()) {
    n++;
    max = Math.max(max, e.at);
    sum += e.label * e.weight + e.thread_id;
  }
  return `${n}:${max}:${sum}`;
}

export function loadSnapshot(c: Ctx): { featuresV: number; builtAt: number; fingerprint: string; blob: Uint8Array } | null {
  const r = T(c, "cls_snapshot").get(1);
  return r ? { featuresV: r.features_v, builtAt: r.built_at, fingerprint: r.fingerprint, blob: r.blob } : null;
}

export function saveSnapshot(c: Ctx, s: { featuresV: number; builtAt: number; fingerprint: string; blob: Uint8Array }): void {
  T(c, "cls_snapshot").put({ id: 1, features_v: s.featuresV, built_at: s.builtAt, fingerprint: s.fingerprint, blob: s.blob });
}

export function matureDecisions(c: Ctx, now: number): number {
  const decisions = T(c, "cls_decisions");
  let n = 0;
  for (const d of decisions.all()) {
    if (d.kind === "auto" && d.outcome === null && d.at < now - POLICY.revertWindowDays * DAY) {
      decisions.update(d, { outcome: "kept" });
      n++;
    }
  }
  return n;
}

// ───────────────────────────── classification ─────────────────────────────

export interface ClassifyRequest {
  inserted: readonly number[];
  bodyCompleted: readonly number[];
  now: number;
  mode: AutoCategorize;
  model: CategorizerModel;
}

function valveStats(c: Ctx): Map<number, { kept: number; reverted: number }> {
  const out = new Map<number, { kept: number; reverted: number }>();
  const decisions = T(c, "cls_decisions");
  for (const d of [...decisions.by("outcome", "auto", "kept"), ...decisions.by("outcome", "auto", "reverted")]) {
    const v = out.get(d.category_id) ?? { kept: 0, reverted: 0 };
    if (d.outcome === "kept") v.kept++;
    if (d.outcome === "reverted") v.reverted++;
    out.set(d.category_id, v);
  }
  return out;
}

function policyContext(c: Ctx): Map<number, CategoryPolicy & { name: string }> {
  const valve = valveStats(c);
  return new Map([...T(c, "categories").all()].map((r) => [r.id as number, { name: r.name, autoApply: r.auto_apply === 1, kept: valve.get(r.id)?.kept ?? 0, reverted: valve.get(r.id)?.reverted ?? 0 }]));
}

function recentRemovals(c: Ctx, now: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of T(c, "cls_examples").by("source", "removal")) {
    if (e.label < 0 && e.at >= now - POLICY.senderVetoDays * DAY) {
      const k = `${e.category_id}:${e.sender}`;
      out.set(k, (out.get(k) ?? 0) + 1);
    }
  }
  return out;
}

function senderHistory(c: Ctx, categoryId: number, sender: string, since: number): { rem: number; pos: number } {
  let rem = 0;
  let pos = 0;
  for (const e of T(c, "cls_examples").by("sender", categoryId, sender)) {
    if (e.at < since) continue;
    if (e.label < 0) rem++;
    if (e.label > 0) pos++;
  }
  return { rem, pos };
}

export function vetoesFor(c: Ctx, threadId: number, sender: string, categoryIds: readonly number[], now: number, senderCache = new Map<string, { rem: number; pos: number }>()): Map<number, Vetoes> {
  const since = now - POLICY.senderVetoDays * DAY;
  const examples = T(c, "cls_examples");
  const decisions = T(c, "cls_decisions");
  const out = new Map<number, Vetoes>();
  for (const categoryId of categoryIds) {
    const e = examples.get(threadId, categoryId);
    const d = decisions.get(threadId, categoryId);
    const hard = (!!e && e.label < 0) || (!!d && (d.outcome === "reverted" || d.outcome === "rejected"));
    const key = `${categoryId}:${sender}`;
    let s = senderCache.get(key);
    if (!s) senderCache.set(key, (s = senderHistory(c, categoryId, sender, since)));
    out.set(categoryId, { hard, senderRemovals: s.rem, senderPositives: s.pos });
  }
  return out;
}

/** No explicit decision closed it: no category but the engine's own, no example, no settled decision. */
function undecided(c: Ctx, threadIds: Iterable<number>): number[] {
  const memberships = T(c, "thread_categories");
  const examples = T(c, "cls_examples");
  const decisions = T(c, "cls_decisions");
  return [...threadIds].filter(
    (t) => !memberships.by("fk_thread_id", t).some((r) => r.added_by !== "auto") && examples.count("fk_thread_id", t) === 0 && !decisions.by("fk_thread_id", t).some((d) => d.outcome !== null),
  );
}

const emptyResult = (): ClassifyResult => ({ deltas: [], auto: new Map(), suggested: 0, touched: new Set(), uncertain: [], backfill: 0 });

export function classifyNewThreads(c: Ctx, req: ClassifyRequest): ClassifyResult {
  if (!c.db.inTransaction) throw new Error("classifyNewThreads runs inside the ingestion transaction");
  const out = emptyResult();
  const changed = [...req.inserted, ...req.bodyCompleted];
  if (changed.length === 0 || req.mode === "off") return out;
  const fresh = new Set(changed);
  const inserted = new Set(req.inserted);
  const messages = T(c, "messages");
  const threadIds = new Set<number>();
  for (const id of changed) {
    const m = messages.get(id);
    if (m) threadIds.add(m.thread_id);
  }
  const open = undecided(c, threadIds);
  if (open.length === 0) return out;
  const own = ownAddresses(c);
  const window = req.now - POLICY.autoWindowDays * DAY;
  const candidates: RootRef[] = [];
  for (const ref of rootRefs(c, open, own)) {
    if (!fresh.has(ref.messageId) || ref.spam || ref.trash || ref.draft) continue;
    if (ref.date < window) {
      if (inserted.has(ref.messageId)) out.backfill++;
      continue;
    }
    if (ref.inInbox) candidates.push(ref);
  }
  decideThreads(c, rootsWithBodies(c, candidates), { ...req, autoEligible: true }, own, out);
  return out;
}

export function suggestBackfill(c: Ctx, req: { threadIds: readonly number[]; now: number; mode: AutoCategorize; model: CategorizerModel }): ClassifyResult {
  const out = emptyResult();
  if (req.mode === "off" || req.threadIds.length === 0) return out;
  c.db.tx(() => {
    const own = ownAddresses(c);
    const refs = rootRefs(c, undecided(c, req.threadIds), own).filter((r) => r.inInbox && !r.spam && !r.trash && !r.draft);
    decideThreads(c, rootsWithBodies(c, refs), { ...req, autoEligible: false }, own, out);
  });
  return out;
}

function withdrawSuggestions(c: Ctx, threadId: number, keep: readonly number[]): void {
  const decisions = T(c, "cls_decisions");
  for (const d of decisions.by("fk_thread_id", threadId)) if (d.kind === "suggest" && d.outcome === null && !keep.includes(d.category_id)) decisions.deleteRow(d);
}

export function backfillCandidates(c: Ctx, now: number, limit = 5000): number[] {
  const threads = T(c, "threads");
  const memberships = T(c, "thread_categories");
  const decisions = T(c, "cls_decisions");
  const examples = T(c, "cls_examples");
  const out: number[] = [];
  for (const id of c.order.current(threads)) {
    if (out.length >= limit) break;
    const t = threads.get(id)!;
    if (t.in_inbox !== 1 || t.last_date >= now - POLICY.autoWindowDays * DAY) continue;
    if (memberships.count("fk_thread_id", id) || decisions.count("fk_thread_id", id) || examples.count("fk_thread_id", id)) continue;
    out.push(id);
  }
  return out;
}

function decideThreads(c: Ctx, roots: Map<number, RootMessage>, req: { now: number; mode: AutoCategorize; model: CategorizerModel; autoEligible: boolean }, own: OwnAddresses, out: ClassifyResult): void {
  let policies: Map<number, CategoryPolicy & { name: string }> | null = null;
  let removals: Map<string, number> | null = null;
  const memberships = T(c, "thread_categories");
  const decisionsT = T(c, "cls_decisions");
  for (const [threadId, root] of roots) {
    const features = extractFeatures(root.source, { ownDomains: own.domains });
    const set: ThreadFeatureSet = { root, features, encoded: encodeFeatures(features) };
    const filed = new Set(memberships.by("fk_thread_id", threadId).map((r) => r.category_id as number));
    const scores = req.model.score(set.encoded).filter((s) => !filed.has(s.categoryId));
    const likely = candidateCategories(scores);
    if (likely.length === 0) {
      withdrawSuggestions(c, threadId, []);
      if (scores.some((s) => s.p >= 0.5)) out.uncertain.push(threadId);
      continue;
    }
    policies ??= policyContext(c);
    removals ??= recentRemovals(c, req.now);
    const vetoes = new Map<number, Vetoes>();
    for (const categoryId of likely) {
      const rem = removals.get(`${categoryId}:${set.features.sender}`) ?? 0;
      vetoes.set(categoryId, { hard: false, senderRemovals: rem, senderPositives: rem >= POLICY.senderVetoRemovals ? senderHistory(c, categoryId, set.features.sender, req.now - POLICY.senderVetoDays * DAY).pos : 0 });
    }
    const decisions = decide({
      mode: req.mode,
      autoEligible: req.autoEligible && root.date >= req.now - POLICY.autoWindowDays * DAY,
      scores,
      categories: policies,
      vetoes,
      lookAlike: req.model.lookAlike(set.encoded),
      senderSupport: req.model.senderSupport(set.encoded),
    });
    withdrawSuggestions(c, threadId, decisions.filter((d) => d.decision !== "none").map((d) => d.categoryId));
    for (const d of decisions) {
      if (d.decision === "none") continue;
      const reasons = explain(req.model, set.features, d.categoryId, policies.get(d.categoryId)?.name ?? "", root.source.fromName || set.features.sender);
      decisionsT.put({ thread_id: threadId, category_id: d.categoryId, kind: d.decision, p: d.p, explain_json: JSON.stringify(reasons), at: req.now, outcome: null });
      out.touched.add(threadId);
      if (d.decision === "suggest") {
        out.suggested++;
        continue;
      }
      if (memberships.insert({ thread_id: threadId, category_id: d.categoryId, added_by: "auto", added_at: req.now, batch_id: null })) {
        out.deltas.push({ op: "unbackground", threadId });
        out.auto.set(d.categoryId, [...(out.auto.get(d.categoryId) ?? []), threadId]);
      }
    }
  }
}

// ───────────────────────────── bulk scopes, quick actions, predictions ─────────────────────────────

/** Sender/domain/list scopes (received mail only, outside trash and spam, not filed, not removed); null for query scopes. */
export function scopeThreads(c: Ctx, categoryId: number, scope: CategorizeScope): number[] | null {
  const own = ownAddresses(c);
  const messages = T(c, "messages");
  let rows: R[];
  switch (scope.kind) {
    case "sender":
      rows = messages.by("from", normalizeText(scope.email.trim()));
      break;
    case "domain":
      rows = messages.by("domain", normalizeText(scope.domain.trim().replace(/^@/, "")));
      break;
    case "list":
      rows = messages.by("list", normalizeText(scope.listId.trim()));
      break;
    case "query":
      return null;
  }
  const ids = new Set<number>();
  for (const m of rows) if (m.is_sent === 0 && !own.emails.has(m.from_email)) ids.add(m.thread_id);
  const threads = T(c, "threads");
  return sortByRecency(
    c,
    [...ids].filter((t) => scopeOpen(c, categoryId, threads.get(t))),
  );
}

/** what every bulk scope leaves out */
export function scopeOpen(c: Ctx, categoryId: number, t: R | undefined): boolean {
  if (!t || t.in_trash || t.in_spam || T(c, "thread_categories").has(t.id, categoryId)) return false;
  const e = T(c, "cls_examples").get(t.id, categoryId);
  return !(e && e.label < 0);
}

export function sortByRecency(c: Ctx, ids: number[]): number[] {
  const threads = T(c, "threads");
  return ids.sort((x, y) => threads.get(y)!.last_date - threads.get(x)!.last_date || y - x);
}

export function countOf(n: number): { count: number; capped: boolean } {
  return { count: Math.min(n, COUNT_CAP), capped: n > COUNT_CAP };
}

const MAX_TERMS = 6;

export function quickActions(c: Ctx, categoryId: number, threadIds: readonly number[], model: CategorizerModel | null): QuickActions {
  const own = ownAddresses(c);
  const sets = [...threadFeatures(c, threadIds.slice(0, 200), own).values()];
  const empty: QuickActions = { sender: null, domain: null, list: null, terms: [], filterDraft: null };
  if (sets.length === 0) return empty;
  const shared = <V,>(pick: (s: (typeof sets)[number]) => V | null): V | null => {
    const first = pick(sets[0]!);
    return first !== null && sets.every((s) => pick(s) === first) ? first : null;
  };
  const senderEmail = shared((s) => s.features.sender);
  const sender = senderEmail ? { email: senderEmail, name: sets[0]!.root.source.fromName || senderEmail } : null;
  const domain = shared((s) => s.features.domain);
  const list = shared((s) => s.features.list);
  let words = new Map<string, string>(sets[0]!.features.tokens.filter((t) => !t.slice(2).startsWith("#")).map((t) => [t.slice(2), t]));
  for (const s of sets.slice(1)) {
    const mine = new Set(s.features.tokens.map((t) => t.slice(2)));
    words = new Map([...words].filter(([w]) => mine.has(w)));
  }
  const brand = new Set(normalizeText(`${senderEmail ?? ""} ${sets[0]!.root.source.fromName}`).split(/[^a-z0-9]+/).filter((w) => w.length > 1));
  const total = Math.max(1, model?.trainingThreads ?? 0);
  const ranked = [...words.entries()]
    .filter(([w]) => !brand.has(w))
    .map(([w, key]) => {
      const hashes = [fnv1a(`s:${w}`), fnv1a(`b:${w}`), fnv1a(key)];
      const support = model ? Math.max(...hashes.map((h) => model.support(h))) : 2;
      const llr = model ? Math.max(...hashes.map((h) => model.featureStats(h, categoryId).llr)) : 0;
      return { term: w, support, llr, subject: key.startsWith("s:") };
    })
    .filter((x) => !model || (x.support >= 2 && x.support <= total * 0.2))
    .sort((x, y) => y.llr - x.llr || Number(y.subject) - Number(x.subject) || x.term.localeCompare(y.term))
    .slice(0, MAX_TERMS);
  const strongest: { field: "from" | "listId" | "fromDomain"; value: string; label: string } | null = sender
    ? { field: "from", value: sender.email, label: sender.name }
    : list
      ? { field: "listId", value: list, label: list }
      : domain
        ? { field: "fromDomain", value: domain, label: `@${domain}` }
        : null;
  return {
    sender,
    domain: domain && !CONSUMER_DOMAINS.has(domain) && !own.domains.has(domain) ? domain : null,
    list,
    terms: ranked.map((r, i) => ({ term: r.term, preselected: i < 2 })),
    filterDraft: strongest ? { name: strongest.label.slice(0, 120), rule: { match: "all", conditions: [{ field: strongest.field, op: "equals", value: strongest.value }], actions: [{ type: "addCategory", categoryId }] } } : null,
  };
}

export function predictThread(c: Ctx, threadId: number, model: CategorizerModel, mode: AutoCategorize, now: number): Prediction[] {
  const set = threadFeatures(c, [threadId]).get(threadId);
  if (!set) return [];
  const scores = model.score(set.encoded);
  const valve = valveStats(c);
  const categories = new Map([...T(c, "categories").all()].map((r) => [r.id as number, { name: r.name as string, autoApply: r.auto_apply === 1, ...(valve.get(r.id) ?? { kept: 0, reverted: 0 }) }]));
  const decisions = decide({
    mode,
    autoEligible: true,
    scores,
    categories,
    vetoes: vetoesFor(c, threadId, set.features.sender, scores.map((s) => s.categoryId), now),
    lookAlike: model.lookAlike(set.encoded),
    senderSupport: model.senderSupport(set.encoded),
  });
  return decisions
    .map((d) => ({ categoryId: d.categoryId, p: d.p, decision: d.decision, reasons: explain(model, set.features, d.categoryId, categories.get(d.categoryId)?.name ?? "", set.root.source.fromName || set.features.sender) }))
    .sort((x, y) => y.p - x.p);
}

export function pendingSuggestions(c: Ctx, o: { categoryId?: number; threadId?: number; limit: number }): PendingSuggestion[] {
  const threads = T(c, "threads");
  const memberships = T(c, "thread_categories");
  const decisions = T(c, "cls_decisions");
  const pool = o.threadId !== undefined ? decisions.by("fk_thread_id", o.threadId) : o.categoryId !== undefined ? decisions.by("fk_category_id", o.categoryId) : [...decisions.all()];
  return pool
    .filter((d) => {
      if (d.kind !== "suggest" || d.outcome !== null) return false;
      if (o.categoryId !== undefined && d.category_id !== o.categoryId) return false;
      if (o.threadId !== undefined && d.thread_id !== o.threadId) return false;
      const t = threads.get(d.thread_id);
      return !!t && !t.in_trash && !t.in_spam && !memberships.has(d.thread_id, d.category_id);
    })
    .sort((x, y) => {
      const tx = threads.get(x.thread_id)!;
      const ty = threads.get(y.thread_id)!;
      return ty.last_date - tx.last_date || ty.id - tx.id || y.p - x.p;
    })
    .slice(0, o.limit)
    .map((d) => ({ threadId: d.thread_id, categoryId: d.category_id, p: d.p, reasons: parseReasons(d.explain_json), at: d.at }));
}

export function autoReasons(c: Ctx, threadId: number): { categoryId: number; reasons: Reason[] }[] {
  const memberships = T(c, "thread_categories");
  return T(c, "cls_decisions")
    .by("fk_thread_id", threadId)
    .filter((d) => d.kind === "auto" && memberships.get(threadId, d.category_id)?.added_by === "auto")
    .sort((x, y) => x.category_id - y.category_id)
    .map((d) => ({ categoryId: d.category_id, reasons: parseReasons(d.explain_json) }));
}

export function categoryStats(c: Ctx): CategoryModelStats[] {
  const valve = valveStats(c);
  const pending = pendingSuggestionCounts(c);
  const examples = new Map<number, number>();
  for (const e of T(c, "cls_examples").all()) if (e.label > 0 && e.weight > 0) examples.set(e.category_id, (examples.get(e.category_id) ?? 0) + 1);
  return [...T(c, "categories").all()]
    .sort((x, y) => x.position - y.position || x.id - y.id)
    .map((cat) => {
      const v = valve.get(cat.id) ?? { kept: 0, reverted: 0 };
      return {
        categoryId: cat.id,
        examples: examples.get(cat.id) ?? 0,
        autoApply: cat.auto_apply === 1,
        kept: v.kept,
        reverted: v.reverted,
        autoPrecision: v.kept + v.reverted > 0 ? v.kept / (v.kept + v.reverted) : null,
        paused: valvePaused(v.kept, v.reverted),
        pendingSuggestions: pending[cat.id] ?? 0,
      };
    });
}

/** New-mail-like (inbox, not spam/trash/draft) and nobody decided on it yet. */
export function aiCandidate(c: Ctx, threadId: number): boolean {
  const root = rootRefs(c, [threadId])[0];
  if (!root || !root.inInbox || root.spam || root.trash || root.draft) return false;
  return !T(c, "thread_categories").count("fk_thread_id", threadId) && !T(c, "cls_decisions").count("fk_thread_id", threadId) && !T(c, "cls_examples").count("fk_thread_id", threadId);
}
