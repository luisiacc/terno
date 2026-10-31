import { addressKey, categoryOfJson, threadTab, type TabMessage } from "@terno/core";
import { ownAddresses } from "./facts";
import type { MemDb, Row } from "./mem";

/**
 * Plan 86's backfill (SQLite's tabs.ts): a mailbox from before it has no
 * categories and no tabs. Each Gmail message's category from its labels (a
 * window of message ids), then each Inbox thread's tab (a window of thread
 * ids). Until a thread is done it reads 0: shown, the safe direction.
 */
const KEY = "tabs_backfill";
/** `max`: the last id when the phase began (later rows come with their category and tab) */
type Progress = { phase: "messages" | "threads"; after: number; max?: number };
type R = Row & Record<string, any>;

const t = (db: MemDb, name: string) => db.table<R>(name);
const lastId = (keys: Iterable<unknown>) => {
  let max = 0;
  for (const k of keys) max = Math.max(max, Number(k));
  return max;
};

/** Started by the upgrade (LOGICAL_SCHEMA 37) when the mailbox has a Gmail account. */
export function startTabsBackfill(db: MemDb): void {
  if ([...t(db, "accounts").all()].some((a) => a.kind === "gmail")) t(db, "settings").put({ key: KEY, value_json: JSON.stringify({ phase: "messages", after: 0 } satisfies Progress) });
}

/** A thread's tab from its messages (what recomputeThreads folds), written when it changed; the messages read. */
function writeTab(db: MemDb, thread: R, own: ReadonlySet<string>): number {
  const rows = t(db, "messages").by("fk_thread_id", thread.id);
  const tab = threadTab(rows as unknown as TabMessage[], (m) => own.has(addressKey((m as unknown as R).from_email)));
  if ((thread.tab ?? 0) !== tab) t(db, "threads").update(thread, { tab });
  return rows.length;
}

/**
 * What's yours changed (an alias, an account) or the facts learned it at last: a tab may change, since mail of
 * yours never decides one (Codex code review #3). The backfill's threads phase goes over the Inbox again, in its
 * own slices; one already under way keeps going (what it hasn't reached reads the new addresses).
 */
export function requestTabRefresh(db: MemDb): void {
  if (t(db, "settings").get(KEY) || ![...t(db, "accounts").all()].some((a) => a.kind === "gmail")) return;
  t(db, "settings").put({ key: KEY, value_json: JSON.stringify({ phase: "threads", after: 0 } satisfies Progress) });
}

export function tabsIdle(db: MemDb): boolean {
  return !t(db, "settings").get(KEY);
}

/** One slice, inside the caller's transaction: what it read is what it reports (the sizer's unit). */
export function tabsSlice(db: MemDb, limit: number): { processed: number; more: boolean } {
  const settings = t(db, "settings");
  const row = settings.get(KEY);
  if (!row) return { processed: 0, more: false };
  const state = JSON.parse(row.value_json as string) as Progress;
  const n = Math.max(1, Math.floor(limit));
  const save = (next: Progress | null) => (next ? settings.put({ key: KEY, value_json: JSON.stringify(next) }) : settings.delete(KEY));
  if (state.phase === "messages") {
    const messages = t(db, "messages");
    const max = state.max ?? lastId(messages.rows.keys());
    const to = Math.min(max, state.after + n);
    for (let id = state.after + 1; id <= to; id++) {
      const m = messages.get(id);
      // a move the user made meanwhile already wrote its category: only rows without one
      if (m && m.category === undefined && m.gmail_labels != null) messages.update(m, { category: categoryOfJson(m.gmail_labels) });
    }
    save(to >= max ? { phase: "threads", after: 0 } : { phase: "messages", after: to, max });
    return { processed: Math.max(1, to - state.after), more: true };
  }
  const threads = t(db, "threads");
  const gmail = new Set([...t(db, "accounts").all()].filter((a) => a.kind === "gmail").map((a) => a.id as number));
  const max = state.max ?? lastId(threads.rows.keys());
  const to = Math.min(max, state.after + n);
  let read = 0;
  let last = to;
  let own: Set<string> | null = null;
  for (let id = state.after + 1; id <= to; id++) {
    const thread = threads.get(id);
    if (!thread || thread.in_inbox !== 1 || !gmail.has(thread.account_id as number)) continue;
    own ??= ownAddresses(db);
    read += writeTab(db, thread, own);
    // the messages read bound the slice too (Codex code review #4): the window's rest waits for the next one
    if (read >= n && id < to) {
      last = id;
      break;
    }
  }
  save(last >= max ? null : { phase: "threads", after: last, max });
  return { processed: Math.max(1, last - state.after, read), more: last < max };
}
