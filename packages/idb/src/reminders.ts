import { addressKey, type Reminder } from "@terno/core";
import { ownAddresses } from "./facts";
import { T, type Ctx, type R } from "./mail";

/** Plan 87: threads' reminders, like SQL's `reminders` (packages/db/src/reminders.ts). */

const toReminder = (r: R): Reminder => ({ threadId: r.thread_id, dueAt: r.due_at, kind: r.kind, setAt: r.set_at });
const toRow = (r: Reminder, threadId = r.threadId): R => ({ thread_id: threadId, due_at: r.dueAt, kind: r.kind, set_at: r.setAt });

export function listReminders(c: Ctx): Reminder[] {
  return [...T(c, "reminders").all()].map(toReminder).sort((a, b) => a.threadId - b.threadId);
}

export function putReminders(c: Ctx, rows: readonly Reminder[], cap: number, ifAbsent = false): { ok: true; put: number[]; replaced: Reminder[] } | { ok: false } {
  const reminders = T(c, "reminders");
  const threads = T(c, "threads");
  const byThread = new Map(rows.map((r) => [r.threadId, r]));
  if (ifAbsent) for (const id of byThread.keys()) if (reminders.has(id)) byThread.delete(id);
  const replaced = [...byThread.keys()].flatMap((id) => {
    const r = reminders.get(id);
    return r ? [toReminder(r)] : [];
  });
  const live = [...byThread.values()].filter((r) => threads.has(r.threadId));
  if (reminders.rows.size - replaced.length + live.length > cap) return { ok: false };
  for (const r of live) reminders.put(toRow(r));
  return { ok: true, put: live.map((r) => r.threadId), replaced: replaced.sort((a, b) => a.threadId - b.threadId) };
}

export function deleteReminders(c: Ctx, threadIds: readonly number[], dueBy?: number): Reminder[] {
  const reminders = T(c, "reminders");
  const gone: Reminder[] = [];
  for (const id of new Set(threadIds)) {
    const r = reminders.get(id);
    if (!r || (dueBy !== undefined && r.due_at > dueBy)) continue;
    reminders.delete(id);
    gone.push(toReminder(r));
  }
  return gone.sort((a, b) => a.threadId - b.threadId);
}

export function deleteExactReminders(c: Ctx, rows: readonly Reminder[]): Reminder[] {
  const reminders = T(c, "reminders");
  return rows.filter((r) => {
    const now = reminders.get(r.threadId);
    if (!now || now.due_at !== r.dueAt || now.kind !== r.kind || now.set_at !== r.setAt) return false;
    reminders.delete(r.threadId);
    return true;
  });
}

/** An answer: a message after it was set that is not a draft, spam or trash, and not from one of your addresses. */
export function answeredReminders(c: Ctx, rows: readonly Reminder[]): number[] {
  const noReply = rows.filter((r) => r.kind === "noReply");
  if (noReply.length === 0) return [];
  const own = ownAddresses(c.db);
  const messages = T(c, "messages");
  return noReply
    .filter((r) => messages.by("fk_thread_id", r.threadId).some((m) => m.date > r.setAt && !m.is_sent && !m.is_draft && !m.is_spam && !m.is_trash && !own.has(addressKey(m.from_email))))
    .map((r) => r.threadId);
}

/** A merge: the vanished thread's reminder goes to the survivor when it has none, or replaces a later one. */
export function mergeReminder(c: Ctx, into: number, from: number): void {
  const reminders = T(c, "reminders");
  const moved = reminders.get(from);
  if (!moved) return;
  const kept = reminders.get(into);
  if (!kept || moved.due_at < kept.due_at) reminders.put(toRow(toReminder(moved), into));
}
