import type { ThreadAction } from "@unica/core";
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
}

/** Which messages an action changes, and the column updates applied to them. */
function plan(action: ThreadAction, msgs: Msg[], explicit = false): { ids: number[]; set: string } {
  const latestPerThread = new Map<number, Msg>();
  for (const m of msgs) {
    const cur = latestPerThread.get(m.thread_id);
    if (!cur || m.date > cur.date || (m.date === cur.date && m.id > cur.id)) latestPerThread.set(m.thread_id, m);
  }
  // Thread actions star / mark-unread the latest message; explicit message actions (filters) act on every message given.
  const latest = explicit ? msgs : [...latestPerThread.values()];
  const ids = (list: Msg[]) => list.map((m) => m.id);
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
      };
    }
    case "markRead":
      return { ids: ids(msgs.filter((m) => !m.is_read)), set: "is_read = 1" };
    case "markUnread":
      return { ids: ids(latest.filter((m) => m.is_read)), set: "is_read = 0" };
    case "star":
      return { ids: ids(latest.filter((m) => !m.is_starred)), set: "is_starred = 1" };
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
        ...db.all<Msg>(
          `SELECT id, account_id, thread_id, date, is_sent, is_trash, is_spam, in_inbox, is_read, is_starred
           FROM messages WHERE thread_id IN (${placeholders(chunk.length)})`,
          ...chunk,
        ),
      );
    }
    return applyToMessages(db, msgs, action, false);
  });
}

/** Same as applyThreadAction, but for explicit messages (filters act per message). */
export function applyMessageAction(db: Db, messageIds: readonly number[], action: ThreadAction): ActionResult {
  return db.tx(() => {
    const msgs: Msg[] = [];
    for (let i = 0; i < messageIds.length; i += 500) {
      const chunk = messageIds.slice(i, i + 500);
      msgs.push(
        ...db.all<Msg>(
          `SELECT id, account_id, thread_id, date, is_sent, is_trash, is_spam, in_inbox, is_read, is_starred
           FROM messages WHERE id IN (${placeholders(chunk.length)})`,
          ...chunk,
        ),
      );
    }
    return applyToMessages(db, msgs, action, true);
  });
}

function applyToMessages(db: Db, msgs: Msg[], action: ThreadAction, explicit: boolean): ActionResult {
  const { ids, set } = plan(action, msgs, explicit);
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
  };
}
