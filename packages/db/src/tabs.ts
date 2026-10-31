import { addressKey, threadTab, type TabMessage } from "@terno/core";
import { ownAddresses } from "./facts";
import type { Db } from "./sqlite";

/**
 * Plan 86's backfill: mail stored before v37 has no category and its threads
 * no tab. First each Gmail message's category from its labels (a window of
 * message ids), then each Inbox thread's tab (a window of thread ids). Until
 * a thread is done it reads 0: shown, the safe direction.
 */
const KEY = "tabs_backfill";
type Progress = { phase: "messages" | "threads"; after: number };
type Row = TabMessage & { from_email: string };

/** The labels' category in SQL, with the precedence of core's categoryOfJson. */
export const CATEGORY_SQL = `CASE WHEN instr(gmail_labels, '"CATEGORY_PROMOTIONS"') THEN 2 WHEN instr(gmail_labels, '"CATEGORY_SOCIAL"') THEN 3
  WHEN instr(gmail_labels, '"CATEGORY_UPDATES"') THEN 4 WHEN instr(gmail_labels, '"CATEGORY_FORUMS"') THEN 5 WHEN instr(gmail_labels, '"CATEGORY_PERSONAL"') THEN 1 ELSE 0 END`;

/** A thread's tab from its messages (what recomputeThreads folds), written when it changed; the messages read. */
function writeTab(db: Db, threadId: number, own: ReadonlySet<string>): number {
  const messages = db.all<Row>("SELECT id, date, category, in_inbox, is_trash, is_spam, is_sent, is_draft, from_email FROM messages INDEXED BY messages_thread WHERE thread_id = ?", threadId);
  const tab = threadTab(messages, (m) => own.has(addressKey((m as Row).from_email)));
  db.run("UPDATE threads SET tab = ? WHERE id = ? AND tab != ?", tab, threadId, tab);
  return messages.length;
}

/**
 * What's yours changed (an alias, an account) or the facts learned it at last: a tab may change, since mail of
 * yours never decides one (Codex code review #3). The backfill's threads phase goes over the Inbox again, in its
 * own slices; one already under way keeps going (what it hasn't reached reads the new addresses).
 */
export function requestTabRefresh(db: Db): void {
  if (db.get("SELECT 1 FROM settings WHERE key = ?", KEY) || !db.get("SELECT 1 FROM accounts WHERE kind = 'gmail'")) return;
  db.run("INSERT INTO settings (key, value_json) VALUES (?, ?)", KEY, JSON.stringify({ phase: "threads", after: 0 } satisfies Progress));
}

export function tabsIdle(db: Db): boolean {
  return !db.get("SELECT 1 FROM settings WHERE key = ?", KEY);
}

/** One slice, inside the caller's transaction: what it read is what it reports (the sizer's unit). */
export function tabsSlice(db: Db, limit: number): { processed: number; more: boolean } {
  const row = db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", KEY);
  if (!row) return { processed: 0, more: false };
  const state = JSON.parse(row.value_json) as Progress;
  const n = Math.max(1, Math.floor(limit));
  const save = (next: Progress | null) =>
    next ? db.run("UPDATE settings SET value_json = ? WHERE key = ?", JSON.stringify(next), KEY) : db.run("DELETE FROM settings WHERE key = ?", KEY);
  if (state.phase === "messages") {
    const max = db.get<{ m: number | null }>("SELECT max(id) AS m FROM messages")!.m ?? 0;
    const to = Math.min(max, state.after + n);
    // a move the user made meanwhile already wrote its category: only rows without one
    db.run(`UPDATE messages SET category = ${CATEGORY_SQL} WHERE id > ? AND id <= ? AND gmail_labels IS NOT NULL AND category IS NULL`, state.after, to);
    save(to >= max ? { phase: "threads", after: 0 } : { phase: "messages", after: to });
    return { processed: Math.max(1, to - state.after), more: true };
  }
  const max = db.get<{ m: number | null }>("SELECT max(id) AS m FROM threads")!.m ?? 0;
  const to = Math.min(max, state.after + n);
  const ids = db
    .all<{ id: number }>("SELECT t.id FROM threads t JOIN accounts a ON a.id = t.account_id WHERE t.id > ? AND t.id <= ? AND t.in_inbox = 1 AND a.kind = 'gmail'", state.after, to)
    .map((r) => r.id);
  let read = 0;
  let last = to;
  if (ids.length) {
    const own = ownAddresses(db);
    for (const id of ids) {
      read += writeTab(db, id, own);
      // the messages read bound the slice too (Codex code review #4): the window's rest waits for the next one
      if (read >= n && id < to) {
        last = id;
        break;
      }
    }
  }
  save(last >= max ? null : { phase: "threads", after: last });
  return { processed: Math.max(1, last - state.after, read), more: last < max };
}
