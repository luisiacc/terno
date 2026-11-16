import { FOLLOWUPS_ACTIVE_MAX, handedPatch, handedToOf, handoffCloses, handoffOfTarget, handoffWait } from "@terno/store";
import { ownAddresses } from "./facts";
import type { Db } from "./sqlite";

/**
 * Plan 210 (iteration 4): a forward's hand-off, in the commit that records its send as confirmed (`ops.complete`): its items
 * close as handed to whom it was sent to, when the row's own item is still open as it was handed (`handoffCloses`), and the
 * forward gets its own wait. True when it closed anything. See packages/store/src/handoff.ts.
 */
export function handoffConfirmed(db: Db, targetJson: string, messageId: number, now: number, o: { followup?: boolean; nudgeAfterDays?: number }): boolean {
  const h = handoffOfTarget(targetJson);
  if (!h) return false;
  const m = db.get<{ thread_id: number; rfc_message_id: string | null; date: number; to_json: string; is_sent: number }>("SELECT thread_id, rfc_message_id, date, to_json, is_sent FROM messages WHERE id = ?", messageId);
  const to = m?.is_sent === 1 ? handedToOf(m.to_json) : null;
  if (!m || !to) return false;
  const closing = handoffCloses(h, (i) => db.get<{ state: string; revision: number }>(`SELECT state, revision FROM ${i.source === "dated" ? "dated_items" : "followups"} WHERE id = ?`, i.id) ?? null);
  if (!closing.length) return false;
  for (const i of closing) {
    const p = handedPatch(i, to, now);
    if (i.source === "dated") db.run("UPDATE dated_items SET state = ?, closed_reason = ?, closed_at = ?, handed_to = ?, revision = revision + 1 WHERE id = ? AND revision = ?", p.state, p.closedReason, p.closedAt, p.handedTo, i.id, i.revision);
    else db.run("UPDATE followups SET state = 'done', closed_reason = ?, closed_at = ?, inbox_state = 'none', handed_to = ?, revision = revision + 1 WHERE id = ? AND revision = ?", p.closedReason, p.closedAt, p.handedTo, i.id, i.revision);
  }
  // the forward waits on its person, as any sent mail can: seeded here, so it never rests on the model's reading
  const wait = handoffWait(o, to, m.date, ownAddresses(db));
  const room = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM followups WHERE state IN ('open','due')")!.n < FOLLOWUPS_ACTIVE_MAX;
  if (wait && room) {
    db.run(
      `INSERT OR IGNORE INTO followups (thread_id, message_id, rfc_message_id, item, kind, text, quote, person_name, person_email, sent_at, due_at, dated, state, inbox_state, from_scan, created_at)
       VALUES (?, ?, ?, ?, 'awaiting', '', NULL, ?, ?, ?, ?, ?, 'open', 'none', 0, ?)`,
      m.thread_id, messageId, m.rfc_message_id, wait.item, wait.personName, wait.personEmail, m.date, wait.dueAt, wait.dated ? 1 : 0, now,
    );
  }
  return true;
}
