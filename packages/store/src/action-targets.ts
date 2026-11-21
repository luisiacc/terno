import type { ThreadAction } from "@terno/core";

/**
 * Plan 229 (Codex code review): a conversation's messages named without changing, at most: its newest ones, where your
 * own reply just delivered and a change made elsewhere land. Twenty selected conversations of a hundred messages each
 * named whole were five times the act's own work (intents for each), over the event loop's budget.
 */
export const UNCHANGED_NAMED = 20;

/**
 * Plan 229: the messages each account's provider op names for an action. A Gmail conversation the action changes is
 * named whole: its newest messages the action governs too (`scope`, else all; Not spam only its spam ones, which it
 * moves to the Inbox; Trash only what isn't there already, since each is its own request and one Gmail no longer has
 * stops the rest), since this copy may be a step behind Gmail (your own mail delivered to your Inbox, unread; a change in
 * another app) and Gmail's labels change idempotently, as its own `threads.modify` does for a whole thread. A
 * conversation it doesn't change stays unsent (the reaffirmed intent covers it), as does anything not on Gmail: an IMAP
 * op moves and flags the locations this copy knows, a filter acts on mail just read.
 */
export function actionTargets<M extends { id: number; account_id: number; thread_id: number; date: number }>(
  msgs: readonly M[],
  action: ThreadAction,
  changed: ReadonlySet<number>,
  scope: readonly number[] | undefined,
  /** the Gmail accounts whose conversations go whole (none for explicit messages) */
  whole: ReadonlySet<number>,
): { accountId: number; messageIds: number[] }[] {
  const governed = new Set(action === "notSpam" || action === "trash" ? changed : (scope ?? msgs.map((m) => m.id)));
  const conversations = new Set<number>();
  for (const m of msgs) if (changed.has(m.id) && whole.has(m.account_id)) conversations.add(m.thread_id);
  // each conversation's newest governed messages that didn't change here
  const extra = new Map<number, M[]>();
  for (const m of msgs) {
    if (changed.has(m.id) || !conversations.has(m.thread_id) || !governed.has(m.id)) continue;
    const list = extra.get(m.thread_id);
    if (list) list.push(m);
    else extra.set(m.thread_id, [m]);
  }
  const named = new Set<number>();
  for (const list of extra.values()) for (const m of list.sort((x, y) => y.date - x.date || y.id - x.id).slice(0, UNCHANGED_NAMED)) named.add(m.id);
  const byAccount = new Map<number, number[]>();
  for (const m of msgs) {
    if (!changed.has(m.id) && !named.has(m.id)) continue;
    const list = byAccount.get(m.account_id);
    if (list) list.push(m.id);
    else byAccount.set(m.account_id, [m.id]);
  }
  return [...byAccount].map(([accountId, messageIds]) => ({ accountId, messageIds }));
}
