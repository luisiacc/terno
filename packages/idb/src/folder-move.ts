import { applyFolderOp, keptInInbox, labelsLeft, labelsMoved, LEAVE_FOLDER, leaveFolderOps, MOVE_TO_FOLDER, type FolderMoved, type LeaveFolderPayload, type MoveToFolderPayload } from "@terno/store";
import { pendingFolderOps } from "./folders";
import { applyThreadAction, enqueueOp, recomputeThreads, T, type ActionResult, type Ctx, type R } from "./mail";

const labelsOf = (m: R): string[] => {
  try {
    const labels: unknown = m.gmail_labels ? JSON.parse(m.gmail_labels as string) : [];
    return Array.isArray(labels) ? labels.filter((l): l is string => typeof l === "string") : [];
  } catch {
    return [];
  }
};

const isGmail = (c: Ctx, accountId: number) => T(c, "accounts").get(accountId)?.kind === "gmail";

/** Plan 127: see MailStore.threads.moveToFolder (the SQL adapter's folder-move.ts). Inside the caller's unit. */
export function moveThreadsToFolder(c: Ctx, o: { threadIds: readonly number[]; accountId: number; folder: string; from: string | null; now: number }): { threadIds: number[]; opIds: string[]; moved: FolderMoved; kept: number[]; archived: ActionResult } {
  const { accountId, folder, from, now } = o;
  const threadRows = T(c, "threads");
  const threads = [...new Set(o.threadIds)].flatMap((id) => {
    const t = threadRows.get(id);
    return t && t.account_id === accountId && !t.in_trash && !t.in_spam ? [t] : [];
  });
  const ids = threads.map((t) => t.id as number);
  const categories = T(c, "categories");
  const memberships = T(c, "thread_categories");
  const kept = new Set(threads.filter((t) => keptInInbox(t.in_inbox === 1, memberships.by("fk_thread_id", t.id).map((m) => categories.get(m.category_id)?.show_in_inbox !== 0))).map((t) => t.id as number));
  const gmail = isGmail(c, accountId);
  const messages = T(c, "messages");
  const locations = T(c, "message_locations");
  const rows = ids.flatMap((id) => messages.by("fk_thread_id", id)).filter((m) => !m.is_draft && !m.is_trash && !m.is_spam).sort((x, y) => x.id - y.id);
  // IMAP: your own mail stays in Sent, unless it's all there is or it's in the folder this leaves. Gmail's labels go on the whole conversation
  const received = new Set(rows.filter((m) => !m.is_sent).map((m) => m.thread_id as number));
  const moved: FolderMoved = { accountId, folder, from, fromInbox: [], fromFolder: [], added: [], leftOnly: [] };
  const targets = { kept: [] as number[], rest: [] as number[] };
  for (const m of rows) {
    const has = new Set<string>(gmail ? labelsOf(m) : locations.by("fk_message_id", m.id).map((l) => l.mailbox as string));
    // where it is once what's on its way lands: A → B then B → A is a move out of B
    if (T(c, "ops").count("folder_moves", accountId)) for (const op of pendingFolderOps(c, m.id)) applyFolderOp(has, op.kind as string, JSON.parse(op.payload_json as string) as MoveToFolderPayload | LeaveFolderPayload);
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
    const id = enqueueOp(c, { accountId, kind: MOVE_TO_FOLDER, target: { messageIds }, payload }, now);
    if (id) opIds.push(id);
  };
  queue(targets.kept, true);
  queue(targets.rest, false);
  // after the move's ops: IMAP's archive then finds no copy left in the Inbox, Gmail's takes its label away
  const archived = applyThreadAction(c, ids.filter((t) => !kept.has(t)), "archive");
  for (const target of archived.targets) {
    const id = enqueueOp(c, { accountId: target.accountId, kind: "archive", target: { messageIds: target.messageIds } }, now);
    if (id) opIds.push(id);
  }
  // membership reads the queued ops, and the archive recomputed before they were all in
  recomputeThreads(c, ids);
  return { threadIds: ids, opIds, moved, kept: [...kept], archived };
}

/** Plan 127: see MailStore.threads.leaveFolder. Inside the caller's unit. */
export function leaveFolder(c: Ctx, o: { moved: FolderMoved; now: number }): { threadIds: number[]; opIds: string[] } {
  const opIds: string[] = [];
  const threads = new Set<number>();
  const messages = T(c, "messages");
  for (const { payload, messageIds } of leaveFolderOps(o.moved)) {
    for (const id of messageIds) {
      const m = messages.get(id);
      if (m) threads.add(m.thread_id as number);
    }
    const id = enqueueOp(c, { accountId: o.moved.accountId, kind: LEAVE_FOLDER, target: { messageIds }, payload }, o.now);
    if (id) opIds.push(id);
  }
  recomputeThreads(c, threads);
  return { threadIds: [...threads], opIds };
}

/**
 * A folder op settled. Gmail's labels change now, not at the drop: a failed one has nothing to take back, and a read
 * from before it can't undo it. Its threads' membership stops reading the op. The threads it touched.
 */
export function settleFolderOp(c: Ctx, op: { kind: string; account_id: number; target_json: string; payload_json: string }, succeeded: boolean): number[] {
  const messages = T(c, "messages");
  const rows = ((JSON.parse(op.target_json) as { messageIds?: number[] }).messageIds ?? []).flatMap((id) => messages.get(id) ?? []);
  if (succeeded && isGmail(c, op.account_id)) {
    for (const m of rows) {
      const labels = labelsOf(m);
      let next: string[] | null;
      if (op.kind === MOVE_TO_FOLDER) {
        const p = JSON.parse(op.payload_json) as MoveToFolderPayload;
        next = labelsMoved(labels, p.folder, p.from);
      } else {
        const p = JSON.parse(op.payload_json) as LeaveFolderPayload;
        next = labelsLeft(labels, p.folder, p.back, p.stays);
      }
      if (next) messages.update(m, { gmail_labels: JSON.stringify(next) });
    }
  }
  const threads = [...new Set(rows.map((m) => m.thread_id as number))];
  recomputeThreads(c, threads);
  return threads;
}
