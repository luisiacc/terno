import { applyFolderOp, folderReachable, keptInInbox, labelsLeft, labelsMoved, LEAVE_FOLDER, leaveFolderOps, MOVE_TO_FOLDER, type FolderFilterMove, type FolderMoved, type LeaveFolderPayload, type MoveToFolderPayload } from "@terno/store";
import { applyMessageAction, applyThreadAction, type ActionResult } from "./actions";
import { FOLDER_OPS_PENDING, listFolders } from "./folders";
import { recomputeThreads } from "./ingest";
import { enqueueOp } from "./repos";
import { placeholders, type Db } from "./sqlite";

const labelsOf = (raw: string | null): string[] => {
  try {
    const labels: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(labels) ? labels.filter((l): l is string => typeof l === "string") : [];
  } catch {
    return [];
  }
};

function byChunks<T>(ids: readonly number[], read: (chunk: number[]) => T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 500) out.push(...read(ids.slice(i, i + 500)));
  return out;
}

const isGmail = (db: Db, accountId: number) => db.get<{ kind: string }>("SELECT kind FROM accounts WHERE id = ?", accountId)?.kind === "gmail";

interface MoveRow {
  id: number;
  thread_id: number;
  is_sent: number;
  in_inbox: number;
  gmail_labels: string | null;
}

/** Which of these threads stay in the Inbox: in it, in a category shown there, in none hidden. */
function keptThreads(db: Db, threads: readonly { id: number; in_inbox: number }[]): Set<number> {
  const shown = new Map<number, boolean[]>();
  for (const r of byChunks(threads.map((t) => t.id), (chunk) => db.all<{ thread_id: number; show_in_inbox: number }>(`SELECT tc.thread_id, c.show_in_inbox FROM thread_categories tc JOIN categories c ON c.id = tc.category_id WHERE tc.thread_id IN (${placeholders(chunk.length)})`, ...chunk))) {
    const list = shown.get(r.thread_id);
    if (list) list.push(!!r.show_in_inbox);
    else shown.set(r.thread_id, [!!r.show_in_inbox]);
  }
  return new Set(threads.filter((t) => keptInInbox(!!t.in_inbox, shown.get(t.id) ?? [])).map((t) => t.id));
}

/** The provider ops that put these messages in the folder, and what each one changes (an undo's journal). */
function queueFolderMoves(db: Db, to: { accountId: number; folder: string; from: string | null; now: number }, messages: readonly MoveRow[], kept: ReadonlySet<number>): { moved: FolderMoved; opIds: string[] } {
  const { accountId, folder, from, now } = to;
  const gmail = isGmail(db, accountId);
  const places = new Map<number, Set<string>>();
  if (!gmail) {
    for (const l of byChunks(messages.map((m) => m.id), (chunk) => db.all<{ message_id: number; mailbox: string }>(`SELECT message_id, mailbox FROM message_locations WHERE message_id IN (${placeholders(chunk.length)})`, ...chunk))) {
      const set = places.get(l.message_id);
      if (set) set.add(l.mailbox);
      else places.set(l.message_id, new Set([l.mailbox]));
    }
  }
  const moved: FolderMoved = { accountId, folder, from, fromInbox: [], fromFolder: [], added: [], leftOnly: [] };
  const targets = { kept: [] as number[], rest: [] as number[] };
  // where each is once what's on its way lands: A → B then B → A is a move out of B
  const pending = db.get(FOLDER_OPS_PENDING)
    ? byChunks(messages.map((m) => m.id), (chunk) => db.all<{ message_id: number; kind: string; payload_json: string }>(`SELECT ot.message_id, o.kind, o.payload_json FROM op_targets ot JOIN ops o ON o.id = ot.op_id WHERE ot.grp = 'location' AND ot.message_id IN (${placeholders(chunk.length)}) AND o.kind IN ('moveToFolder', 'leaveFolder') AND o.state IN ('queued', 'running') ORDER BY o.seq`, ...chunk))
    : [];
  const pendingOf = new Map<number, typeof pending>();
  for (const p of pending) pendingOf.set(p.message_id, [...(pendingOf.get(p.message_id) ?? []), p]);
  // IMAP: your own mail stays in Sent, unless it's all there is or it's in the folder this leaves. Gmail's labels go on the whole conversation
  const received = new Set(messages.filter((m) => !m.is_sent).map((m) => m.thread_id));
  for (const m of messages) {
    const has = gmail ? new Set(labelsOf(m.gmail_labels)) : new Set(places.get(m.id));
    for (const p of pendingOf.get(m.id) ?? []) applyFolderOp(has, p.kind, JSON.parse(p.payload_json) as MoveToFolderPayload | LeaveFolderPayload);
    const inFolder = has.has(folder);
    const inFrom = from !== null && has.has(from);
    if (!gmail && m.is_sent && received.has(m.thread_id) && !inFrom) continue;
    if (inFolder && !inFrom) continue;
    (kept.has(m.thread_id) ? targets.kept : targets.rest).push(m.id);
    if (inFolder) moved.leftOnly.push(m.id);
    else if (inFrom) moved.fromFolder.push(m.id);
    else if (m.in_inbox && !kept.has(m.thread_id)) moved.fromInbox.push(m.id);
    else moved.added.push(m.id);
  }
  const opIds: string[] = [];
  const queue = (messageIds: number[], keepInbox: boolean) => {
    if (!messageIds.length) return;
    const payload: MoveToFolderPayload = { folder, from, keepInbox };
    const id = enqueueOp(db, { accountId, kind: MOVE_TO_FOLDER, target: { messageIds }, payload }, now);
    if (id) opIds.push(id);
  };
  queue(targets.kept, true);
  queue(targets.rest, false);
  return { moved, opIds };
}

/**
 * Plan 128: a filter's move, per message as a filter's every action is. Only `messageIds`, this account's, received, not
 * in Trash or Spam. A thread kept in the Inbox is copied there and stays. Null: the folder isn't there, nothing changed.
 * Runs inside the caller's transaction.
 */
export function moveMessagesToFolder(db: Db, c: FolderFilterMove & { now: number }): { threadIds: number[]; opIds: string[] } | null {
  const { accountId, folder, now } = c;
  if (!folderReachable(listFolders(db), accountId, folder)) return null;
  const messages = byChunks(c.messageIds, (chunk) => db.all<MoveRow>(`SELECT id, thread_id, is_sent, in_inbox, gmail_labels FROM messages WHERE id IN (${placeholders(chunk.length)}) AND account_id = ? AND is_draft = 0 AND is_sent = 0 AND is_trash = 0 AND is_spam = 0`, ...chunk, accountId));
  const threadIds = [...new Set(messages.map((m) => m.thread_id))];
  if (!threadIds.length) return { threadIds, opIds: [] };
  const kept = keptThreads(db, byChunks(threadIds, (chunk) => db.all<{ id: number; in_inbox: number }>(`SELECT id, in_inbox FROM threads WHERE id IN (${placeholders(chunk.length)})`, ...chunk)));
  const { opIds } = queueFolderMoves(db, { accountId, folder, from: null, now }, messages, kept);
  const archived = applyMessageAction(db, messages.filter((m) => !kept.has(m.thread_id)).map((m) => m.id), "archive");
  for (const target of archived.targets) {
    const id = enqueueOp(db, { accountId: target.accountId, kind: "archive", target: { messageIds: target.messageIds } }, now);
    if (id) opIds.push(id);
  }
  // membership reads the queued ops: the archive's recompute saw them; only what it didn't touch is left
  const done = new Set(archived.threadIds);
  recomputeThreads(db, threadIds.filter((t) => !done.has(t)));
  return { threadIds, opIds };
}

/** Plan 127: see MailStore.threads.moveToFolder. Runs inside the caller's transaction. */
export function moveThreadsToFolder(db: Db, c: { threadIds: readonly number[]; accountId: number; folder: string; from: string | null; now: number }): { threadIds: number[]; opIds: string[]; moved: FolderMoved; kept: number[]; archived: ActionResult } {
  const { accountId, folder, from, now } = c;
  const threads = byChunks([...new Set(c.threadIds)], (chunk) => db.all<{ id: number; in_inbox: number }>(`SELECT id, in_inbox FROM threads WHERE id IN (${placeholders(chunk.length)}) AND account_id = ? AND in_trash = 0 AND in_spam = 0`, ...chunk, accountId));
  const ids = threads.map((t) => t.id);
  const kept = keptThreads(db, threads);
  const messages = byChunks(ids, (chunk) => db.all<MoveRow>(`SELECT id, thread_id, is_sent, in_inbox, gmail_labels FROM messages WHERE thread_id IN (${placeholders(chunk.length)}) AND is_draft = 0 AND is_trash = 0 AND is_spam = 0`, ...chunk));
  const { moved, opIds } = queueFolderMoves(db, { accountId, folder, from, now }, messages, kept);
  // after the move's ops: IMAP's archive then finds no copy left in the Inbox, Gmail's takes its label away
  const archived = applyThreadAction(db, ids.filter((t) => !kept.has(t)), "archive");
  for (const target of archived.targets) {
    const id = enqueueOp(db, { accountId: target.accountId, kind: "archive", target: { messageIds: target.messageIds } }, now);
    if (id) opIds.push(id);
  }
  // membership reads the queued ops, and the archive recomputed before they were all in
  recomputeThreads(db, ids);
  return { threadIds: ids, opIds, moved, kept: [...kept], archived };
}

/** Plan 127: see MailStore.threads.leaveFolder. Runs inside the caller's transaction. */
export function leaveFolder(db: Db, c: { moved: FolderMoved; now: number }): { threadIds: number[]; opIds: string[] } {
  const opIds: string[] = [];
  const threads = new Set<number>();
  for (const { payload, messageIds } of leaveFolderOps(c.moved)) {
    for (const m of byChunks(messageIds, (chunk) => db.all<{ thread_id: number }>(`SELECT thread_id FROM messages WHERE id IN (${placeholders(chunk.length)})`, ...chunk))) threads.add(m.thread_id);
    const id = enqueueOp(db, { accountId: c.moved.accountId, kind: LEAVE_FOLDER, target: { messageIds }, payload }, c.now);
    if (id) opIds.push(id);
  }
  recomputeThreads(db, threads);
  return { threadIds: [...threads], opIds };
}

/**
 * A folder op settled. Gmail's labels change now, not at the drop: a failed one has nothing to take back, and a read
 * from before it can't undo it. Its threads' membership stops reading the op. The threads it touched.
 */
export function settleFolderOp(db: Db, op: { kind: string; account_id: number; target_json: string; payload_json: string }, succeeded: boolean): number[] {
  const ids = (JSON.parse(op.target_json) as { messageIds?: number[] }).messageIds ?? [];
  const rows = byChunks(ids, (chunk) => db.all<{ id: number; thread_id: number; gmail_labels: string | null }>(`SELECT id, thread_id, gmail_labels FROM messages WHERE id IN (${placeholders(chunk.length)})`, ...chunk));
  if (succeeded && isGmail(db, op.account_id)) {
    for (const m of rows) {
      const labels = labelsOf(m.gmail_labels);
      let next: string[] | null;
      if (op.kind === MOVE_TO_FOLDER) {
        const p = JSON.parse(op.payload_json) as MoveToFolderPayload;
        next = labelsMoved(labels, p.folder, p.from);
      } else {
        const p = JSON.parse(op.payload_json) as LeaveFolderPayload;
        next = labelsLeft(labels, p.folder, p.back, p.stays);
      }
      if (next) db.run("UPDATE messages SET gmail_labels = ? WHERE id = ?", JSON.stringify(next), m.id);
    }
  }
  const threads = [...new Set(rows.map((m) => m.thread_id))];
  recomputeThreads(db, threads);
  return threads;
}
