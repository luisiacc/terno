import { applyFolderOp, filedArchive, folderReachable, keptInInbox, labelsLeft, labelsMoved, LEAVE_FOLDER, leaveFolderOps, MOVE_TO_FOLDER, oneFolderPerMessage, planOneFolderMove, requestFlagSnapshots, type FolderFilterMove, type FolderMoved, type LeaveFolderPayload, type MoveToFolderPayload } from "@terno/store";
import { applyMessageAction, applyThreadAction, type ActionResult } from "./actions";
import { listFolders, oneFolderFolders, pendingFolderOps } from "./folders";
import { recomputeThreads } from "./ingest";
import { sqlFlags } from "./flag-intents";
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

const kindOf = (db: Db, accountId: number) => db.get<{ kind: string }>("SELECT kind FROM accounts WHERE id = ?", accountId)?.kind;
const isGmail = (db: Db, accountId: number) => kindOf(db, accountId) === "gmail";
/** plan 259: Outlook keeps a message in one folder: a filing is a move, and no thread stays in the Inbox by a copy */
const isOneFolder = (db: Db, accountId: number) => oneFolderPerMessage(kindOf(db, accountId));

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
  if (isOneFolder(db, accountId)) {
    // plan 259 stage 2b: one move a message, from where it is once what's on its way lands, each one's way back journalled
    const at = oneFolderFolders(db, messages.map((m) => m.id));
    const rows = messages.map((m) => ({ id: m.id, thread_id: m.thread_id, is_sent: !!m.is_sent, in_inbox: !!m.in_inbox, folder: at.get(m.id) ?? null }));
    const plan = planOneFolderMove({ accountId, folder, from }, rows);
    const payload: MoveToFolderPayload = { folder, from, keepInbox: false, ...(plan.moved.fromInbox.length && { fromInbox: plan.moved.fromInbox }) };
    const id = plan.messageIds.length ? enqueueOp(db, { accountId, kind: MOVE_TO_FOLDER, target: { messageIds: plan.messageIds }, payload }, now) : null;
    return { moved: plan.moved, opIds: id ? [id] : [] };
  }
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
  const pendingOf = pendingFolderOps(db, messages.map((m) => m.id));
  // IMAP: your own mail stays in Sent, unless it's all there is or it's in the folder this leaves. Gmail's labels go on the whole conversation
  const received = new Set(messages.filter((m) => !m.is_sent).map((m) => m.thread_id));
  for (const m of messages) {
    const has = gmail ? new Set(labelsOf(m.gmail_labels)) : new Set(places.get(m.id));
    for (const p of pendingOf.get(m.id) ?? []) applyFolderOp(has, p.kind, p.payload);
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
  // plan 259: an Outlook filing moves the message out of the Inbox on the server, whatever its categories say
  const kept = isOneFolder(db, accountId) ? new Set<number>() : keptThreads(db, byChunks(threadIds, (chunk) => db.all<{ id: number; in_inbox: number }>(`SELECT id, in_inbox FROM threads WHERE id IN (${placeholders(chunk.length)})`, ...chunk)));
  const { opIds, moved } = queueFolderMoves(db, { accountId, folder, from: null, now }, messages, kept);
  const archived = archiveFiled(db, accountId, moved, () => applyMessageAction(db, messages.filter((m) => !kept.has(m.thread_id)).map((m) => m.id), "archive"));
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
  // plan 259 (owner decision): an Outlook filing is a plain move, so no thread stays in the Inbox by its category
  const kept = isOneFolder(db, accountId) ? new Set<number>() : keptThreads(db, threads);
  const messages = byChunks(ids, (chunk) => db.all<MoveRow>(`SELECT id, thread_id, is_sent, in_inbox, gmail_labels FROM messages WHERE thread_id IN (${placeholders(chunk.length)}) AND is_draft = 0 AND is_trash = 0 AND is_spam = 0`, ...chunk));
  const { moved, opIds } = queueFolderMoves(db, { accountId, folder, from, now }, messages, kept);
  // after the move's ops: IMAP's archive then finds no copy left in the Inbox, Gmail's takes its label away
  const archived = archiveFiled(db, accountId, moved, () => applyThreadAction(db, ids.filter((t) => !kept.has(t)), "archive"));
  for (const target of archived.targets) {
    const id = enqueueOp(db, { accountId: target.accountId, kind: "archive", target: { messageIds: target.messageIds } }, now);
    if (id) opIds.push(id);
  }
  // membership reads the queued ops, and the archive recomputed before they were all in
  recomputeThreads(db, ids);
  return { threadIds: ids, opIds, moved, kept: [...kept], archived };
}

/**
 * A filing's archive part. IMAP and Gmail queue it as its own op after the move. Outlook's move takes the message out of
 * the Inbox itself, so only those it moves leave the Inbox here and no op follows (Codex code review #3: a filing that
 * failed must never archive); `settleFolderOp` puts them back if the move never lands.
 */
function archiveFiled(db: Db, accountId: number, moved: FolderMoved, otherwise: () => ActionResult): ActionResult {
  if (!isOneFolder(db, accountId)) return otherwise();
  return filedArchive(applyMessageAction(db, moved.fromInbox, "archive"));
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
  // plan 259: an Outlook filing (an undo's too) settled. What the server confirmed in the folder, however the op ended
  // (a partial success's answers are stored), is out of the Inbox, Trash and Junk, as a folder of the person's own is
  // none of them: a stale read on its way can't leave it there (round 2 #6; exact undo revision #5, code review #6).
  // Never landed, what it took out of the Inbox here comes back, unless the server has it in a folder or a newer
  // location op is on its way for it (round 2 #7), and where each one really is is read again (an undo out of Trash has
  // nothing else asking).
  const p = op.kind === MOVE_TO_FOLDER ? JSON.parse(op.payload_json) as MoveToFolderPayload : undefined;
  if (p && isOneFolder(db, op.account_id)) {
    const untouched = "NOT EXISTS (SELECT 1 FROM op_targets t INDEXED BY op_targets_msg JOIN ops o ON o.id = t.op_id WHERE t.message_id = messages.id AND t.grp = 'location' AND o.state IN ('queued', 'running'))";
    for (const chunk of byChunks(ids, (c) => [c])) db.run(`UPDATE messages SET in_inbox = 0, is_trash = 0, is_spam = 0 WHERE id IN (${placeholders(chunk.length)}) AND account_id = ? AND (in_inbox = 1 OR is_trash = 1 OR is_spam = 1)
      AND EXISTS (SELECT 1 FROM message_folders f WHERE f.message_id = messages.id AND f.folder = ?) AND ${untouched}`, ...chunk, op.account_id, p.folder);
    if (!succeeded) {
      for (const chunk of byChunks(p.fromInbox ?? [], (c) => [c])) db.run(`UPDATE messages SET in_inbox = 1 WHERE id IN (${placeholders(chunk.length)}) AND account_id = ? AND in_inbox = 0 AND is_trash = 0 AND is_spam = 0
        AND NOT EXISTS (SELECT 1 FROM message_folders f WHERE f.message_id = messages.id) AND ${untouched}`, ...chunk, op.account_id);
      requestFlagSnapshots(sqlFlags(db), op.account_id, ids, ["inInbox", "isTrash", "isSpam"]);
    }
  }
  const threads = [...new Set(rows.map((m) => m.thread_id))];
  recomputeThreads(db, threads);
  return threads;
}
