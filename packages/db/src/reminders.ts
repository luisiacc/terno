import { addressKey, type Reminder, type ReminderKind } from "@terno/core";
import { ownAddresses } from "./facts";
import type { Db } from "./sqlite";

/** Plan 87: threads' reminders (`reminders`, v34). */

interface Row {
  thread_id: number;
  due_at: number;
  kind: ReminderKind;
  set_at: number;
}

const toReminder = (r: Row): Reminder => ({ threadId: r.thread_id, dueAt: r.due_at, kind: r.kind, setAt: r.set_at });

export function listReminders(db: Db): Reminder[] {
  return db.all<Row>("SELECT thread_id, due_at, kind, set_at FROM reminders ORDER BY thread_id").map(toReminder);
}

function remindersOf(db: Db, threadIds: readonly number[]): Reminder[] {
  if (threadIds.length === 0) return [];
  return db.all<Row>("SELECT thread_id, due_at, kind, set_at FROM reminders WHERE thread_id IN (SELECT value FROM json_each(?)) ORDER BY thread_id", JSON.stringify(threadIds)).map(toReminder);
}

/** All or nothing (one transaction): the cap counts the reminders these don't replace. */
export function putReminders(db: Db, rows: readonly Reminder[], cap: number, ifAbsent = false): { ok: true; put: number[]; replaced: Reminder[] } | { ok: false } {
  return db.tx(() => {
    // the last of a thread's rows wins
    const byThread = new Map(rows.map((r) => [r.threadId, r]));
    if (ifAbsent) for (const r of remindersOf(db, [...byThread.keys()])) byThread.delete(r.threadId);
    const ids = [...byThread.keys()];
    const live = new Set(ids.length ? db.all<{ id: number }>("SELECT id FROM threads WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(ids)).map((r) => r.id) : []);
    const replaced = remindersOf(db, ids);
    const others = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reminders")!.n - replaced.length;
    if (others + live.size > cap) return { ok: false as const };
    const put: number[] = [];
    for (const r of byThread.values()) {
      if (!live.has(r.threadId)) continue;
      db.run("INSERT OR REPLACE INTO reminders (thread_id, due_at, kind, set_at) VALUES (?, ?, ?, ?)", r.threadId, r.dueAt, r.kind, r.setAt);
      put.push(r.threadId);
    }
    return { ok: true as const, put, replaced };
  });
}

export function deleteReminders(db: Db, threadIds: readonly number[], dueBy?: number): Reminder[] {
  return db.tx(() => {
    const gone = remindersOf(db, threadIds).filter((r) => dueBy === undefined || r.dueAt <= dueBy);
    for (const r of gone) db.run("DELETE FROM reminders WHERE thread_id = ?", r.threadId);
    return gone;
  });
}

export function deleteExactReminders(db: Db, rows: readonly Reminder[]): Reminder[] {
  return db.tx(() =>
    rows.filter((r) => db.run("DELETE FROM reminders WHERE thread_id = ? AND due_at = ? AND kind = ? AND set_at = ?", r.threadId, r.dueAt, r.kind, r.setAt).changes > 0),
  );
}

/** An answer: a message after it was set that is not a draft, spam or trash, and not from one of your addresses. */
export function answeredReminders(db: Db, rows: readonly Reminder[]): number[] {
  const noReply = rows.filter((r) => r.kind === "noReply");
  if (noReply.length === 0) return [];
  const own = ownAddresses(db);
  const answered: number[] = [];
  for (const r of noReply) {
    // newest first along messages_thread: the messages since it was set, usually none
    const since = db.all<{ from_email: string }>(
      "SELECT from_email FROM messages INDEXED BY messages_thread WHERE thread_id = ? AND date > ? AND is_sent = 0 AND is_draft = 0 AND is_spam = 0 AND is_trash = 0",
      r.threadId,
      r.setAt,
    );
    if (since.some((m) => !own.has(addressKey(m.from_email)))) answered.push(r.threadId);
  }
  return answered;
}

/** A merge: the vanished thread's reminder goes to the survivor when it has none, or replaces a later one. */
export function mergeReminder(db: Db, into: number, from: number): void {
  const moved = db.get<Row>("SELECT thread_id, due_at, kind, set_at FROM reminders WHERE thread_id = ?", from);
  if (!moved) return;
  const kept = db.get<{ due_at: number }>("SELECT due_at FROM reminders WHERE thread_id = ?", into);
  if (!kept || moved.due_at < kept.due_at) db.run("INSERT OR REPLACE INTO reminders (thread_id, due_at, kind, set_at) VALUES (?, ?, ?, ?)", into, moved.due_at, moved.kind, moved.set_at);
}
