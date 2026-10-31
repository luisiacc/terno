import { categoryAction, categoryOfJson, CATEGORY_ACTIONS, isCategoryAction, type MessageCategory, type ThreadAction } from "@terno/core";
import { reaffirmFlagIntent, restoreLocationOps, sameLocation, type MessageState } from "@terno/store";
import { sqlFlags } from "./flag-intents";
import { recomputeThreads } from "./ingest";
import { placeholders, type Db } from "./sqlite";

export interface ActionTarget {
  accountId: number;
  /** message ids captured at action time; provider ops act on exactly these */
  messageIds: number[];
}

export interface ActionResult {
  threadIds: number[];
  targets: ActionTarget[];
  /** each changed message as it was before */
  before: MessageState[];
}

interface Msg {
  id: number;
  account_id: number;
  thread_id: number;
  date: number;
  is_sent: number;
  is_trash: number;
  is_spam: number;
  in_inbox: number;
  is_read: number;
  is_starred: number;
  is_draft: number;
  /** plan 86: null: not Gmail (read from the labels when a stored row predates the column) */
  category: number | null;
}

const MSG_COLUMNS = "id, account_id, thread_id, date, is_sent, is_draft, is_trash, is_spam, in_inbox, is_read, is_starred, coalesce(category, CASE WHEN gmail_labels IS NULL THEN NULL ELSE -1 END) AS category, CASE WHEN category IS NULL THEN gmail_labels END AS gmail_labels";

/** Rows read with MSG_COLUMNS: a category the backfill hasn't written yet comes from the labels. */
function withCategory(rows: (Msg & { gmail_labels?: string | null })[]): Msg[] {
  for (const r of rows) {
    if (r.category === -1) r.category = categoryOfJson(r.gmail_labels);
    delete r.gmail_labels;
  }
  return rows;
}

/** Which messages an action changes, and the column updates applied to them. */
function plan(action: ThreadAction, msgs: Msg[], explicit = false): { ids: number[]; set: string; scope?: number[] } {
  const latestPerThread = new Map<number, Msg>();
  for (const m of msgs) {
    const cur = latestPerThread.get(m.thread_id);
    if (!cur || m.date > cur.date || (m.date === cur.date && m.id > cur.id)) latestPerThread.set(m.thread_id, m);
  }
  // Thread actions star / mark-unread the latest message; explicit message actions (filters) act on every message given.
  const latest = explicit ? msgs : [...latestPerThread.values()];
  const ids = (list: Msg[]) => list.map((m) => m.id);
  if (isCategoryAction(action)) {
    // plan 86: Gmail messages someone else wrote (yours never decide a tab); only Gmail has categories
    const target = CATEGORY_ACTIONS[action];
    const chosen = msgs.filter((m) => m.category !== null && !m.is_sent && !m.is_draft);
    return { ids: ids(chosen.filter((m) => m.category !== target)), set: `category = ${target}`, scope: ids(chosen) };
  }
  switch (action) {
    case "archive":
      return { ids: ids(msgs.filter((m) => m.in_inbox)), set: "in_inbox = 0" };
    case "trash":
      return { ids: ids(msgs.filter((m) => !m.is_trash)), set: "is_trash = 1, in_inbox = 0" };
    case "spam":
      return { ids: ids(msgs.filter((m) => !m.is_spam || m.in_inbox)), set: "is_spam = 1, in_inbox = 0" };
    case "notSpam":
      return { ids: ids(msgs.filter((m) => m.is_spam)), set: "is_spam = 0, in_inbox = 1" };
    case "moveToInbox": {
      // Restore received mail to the inbox; a thread of only sent mail restores everything.
      const received = msgs.filter((m) => !m.is_sent);
      const scope = new Set(received.map((m) => m.thread_id));
      const chosen = msgs.filter((m) => !m.is_sent || !scope.has(m.thread_id));
      return {
        ids: ids(chosen.filter((m) => !m.in_inbox || m.is_trash || m.is_spam)),
        set: "in_inbox = 1, is_trash = 0, is_spam = 0",
        scope: ids(chosen),
      };
    }
    case "markRead":
      return { ids: ids(msgs.filter((m) => !m.is_read)), set: "is_read = 1" };
    case "markUnread":
      return { ids: ids(latest.filter((m) => m.is_read)), set: "is_read = 0", scope: ids(latest) };
    case "star":
      return { ids: ids(latest.filter((m) => !m.is_starred)), set: "is_starred = 1", scope: ids(latest) };
    case "unstar":
      return { ids: ids(msgs.filter((m) => m.is_starred)), set: "is_starred = 0" };
  }
}

/**
 * Applies a thread action locally (optimistic, in one transaction) and returns
 * the exact messages it changed, grouped by account, for the provider ops.
 * Messages already in the target state are not touched (and not re-sent).
 */
export function applyThreadAction(db: Db, threadIds: readonly number[], action: ThreadAction): ActionResult {
  return db.tx(() => {
    const msgs: Msg[] = [];
    for (let i = 0; i < threadIds.length; i += 500) {
      const chunk = threadIds.slice(i, i + 500);
      msgs.push(
        ...withCategory(db.all<Msg>(`SELECT ${MSG_COLUMNS} FROM messages WHERE thread_id IN (${placeholders(chunk.length)})`, ...chunk)),
      );
    }
    return applyToMessages(db, msgs, action, false);
  });
}

/**
 * Plan 86: Move to Inbox also takes these threads out of Gmail's Promotions and Social, where their account keeps
 * them apart (else they'd land in the tab again): their tabbed messages of someone else's go to Primary.
 */
export function untabThreads(db: Db, threadIds: readonly number[]): ActionResult {
  return db.tx(() => {
    const ids: number[] = [];
    for (let i = 0; i < threadIds.length; i += 500) {
      const chunk = threadIds.slice(i, i + 500);
      for (const r of db.all<{ id: number }>(
        `SELECT m.id FROM messages m JOIN accounts a ON a.id = m.account_id
         WHERE m.thread_id IN (${placeholders(chunk.length)}) AND a.kind = 'gmail' AND coalesce(json_extract(a.provider_config, '$.separateTabs'), 1) != 0
           AND (m.category IN (2, 3) OR (m.category IS NULL AND m.gmail_labels IS NOT NULL))`,
        ...chunk,
      )) ids.push(r.id);
    }
    const msgs: Msg[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      msgs.push(...withCategory(db.all<Msg>(`SELECT ${MSG_COLUMNS} FROM messages WHERE id IN (${placeholders(chunk.length)})`, ...chunk)));
    }
    return applyToMessages(db, msgs.filter((m) => m.category === 2 || m.category === 3), "toPrimary", true);
  });
}

/** Same as applyThreadAction, but for explicit messages (filters act per message). */
export function applyMessageAction(db: Db, messageIds: readonly number[], action: ThreadAction): ActionResult {
  return db.tx(() => {
    const msgs: Msg[] = [];
    for (let i = 0; i < messageIds.length; i += 500) {
      const chunk = messageIds.slice(i, i + 500);
      msgs.push(
        ...withCategory(db.all<Msg>(`SELECT ${MSG_COLUMNS} FROM messages WHERE id IN (${placeholders(chunk.length)})`, ...chunk)),
      );
    }
    return applyToMessages(db, msgs, action, true);
  });
}

function applyToMessages(db: Db, msgs: Msg[], action: ThreadAction, explicit: boolean): ActionResult {
  const { ids, set, scope } = plan(action, msgs, explicit);
  const changed = new Set(ids);
  reaffirmFlagIntent(sqlFlags(db), (scope ?? msgs.map((m) => m.id)).filter((id) => !changed.has(id)), action);
  const byId = new Map(msgs.map((m) => [m.id, m]));
  const touched = new Set<number>();
  const byAccount = new Map<number, number[]>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    db.run(`UPDATE messages SET ${set} WHERE id IN (${placeholders(chunk.length)})`, ...chunk);
  }
  for (const id of ids) {
    const m = byId.get(id)!;
    touched.add(m.thread_id);
    const list = byAccount.get(m.account_id) ?? [];
    list.push(id);
    byAccount.set(m.account_id, list);
  }
  recomputeThreads(db, touched);
  return {
    threadIds: [...touched],
    targets: [...byAccount].map(([accountId, messageIds]) => ({ accountId, messageIds })),
    // plan 86: only a category move's undo puts a category back (an archive's never touches one Gmail changed since)
    before: ids.map((id) => stateOf(byId.get(id)!, isCategoryAction(action))),
  };
}

const stateOf = (m: Pick<Msg, "id" | "is_read" | "is_starred" | "in_inbox" | "is_trash" | "is_spam" | "category">, category = true): MessageState => ({
  id: m.id,
  isRead: !!m.is_read,
  isStarred: !!m.is_starred,
  inInbox: !!m.in_inbox,
  isTrash: !!m.is_trash,
  isSpam: !!m.is_spam,
  ...(category ? { category: m.category } : {}),
});

export interface RestoreResult {
  threadIds: number[];
  /** ops to queue, in this order (a message's location steps stay in sequence) */
  ops: { accountId: number; kind: ThreadAction; messageIds: number[] }[];
}

/** Puts messages back exactly as they were (an undo) and says which provider ops take them there. */
export function restoreMessages(db: Db, states: readonly MessageState[]): RestoreResult {
  return db.tx(() => {
    const wanted = new Map(states.map((s) => [s.id, s]));
    const msgs: (Msg & { id: number })[] = [];
    const ids = [...wanted.keys()];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      msgs.push(
        ...withCategory(db.all<Msg>(`SELECT ${MSG_COLUMNS} FROM messages WHERE id IN (${placeholders(chunk.length)})`, ...chunk)),
      );
    }
    // step 0: read/star and the first location step; step 1: the second location step
    const steps = [new Map<string, { accountId: number; kind: ThreadAction; messageIds: number[] }>(), new Map<string, { accountId: number; kind: ThreadAction; messageIds: number[] }>()];
    const add = (step: number, accountId: number, kind: ThreadAction, id: number) => {
      const key = `${accountId}:${kind}`;
      const op = steps[step]!.get(key) ?? { accountId, kind, messageIds: [] };
      op.messageIds.push(id);
      steps[step]!.set(key, op);
    };
    const touched = new Set<number>();
    for (const m of msgs) {
      const was = wanted.get(m.id)!;
      const now = stateOf(m);
      // plan 86: a snapshot from before it, or of a message without a category, leaves the category as it is
      const category = was.category == null || m.category === null ? m.category : was.category;
      if (now.isRead === was.isRead && now.isStarred === was.isStarred && sameLocation(now, was) && category === m.category) continue;
      db.run(
        "UPDATE messages SET is_read = ?, is_starred = ?, in_inbox = ?, is_trash = ?, is_spam = ?, category = ? WHERE id = ?",
        +was.isRead,
        +was.isStarred,
        +was.inInbox,
        +was.isTrash,
        +was.isSpam,
        category,
        m.id,
      );
      touched.add(m.thread_id);
      if (now.isRead !== was.isRead) add(0, m.account_id, was.isRead ? "markRead" : "markUnread", m.id);
      if (now.isStarred !== was.isStarred) add(0, m.account_id, was.isStarred ? "star" : "unstar", m.id);
      if (category !== m.category) add(0, m.account_id, categoryAction(category as MessageCategory), m.id);
      restoreLocationOps(now, was).forEach((kind, step) => add(step, m.account_id, kind, m.id));
    }
    recomputeThreads(db, touched);
    return { threadIds: [...touched], ops: steps.flatMap((s) => [...s.values()]) };
  });
}
