import type { ScheduledRow, ScheduledSend } from "@terno/store";
import type { Db } from "./sqlite";

/** Plan 89: drafts scheduled to send (`scheduled_sends`, v35). */

interface Joined {
  draft_id: number;
  send_at: number;
  set_at: number;
  error: string | null;
  retry_at: number | null;
  account_id: number;
  thread_id: number | null;
  mode: ScheduledSend["mode"];
  to_json: string;
  subject: string;
}

export function listScheduled(db: Db): ScheduledSend[] {
  return db
    .all<Joined>("SELECT s.draft_id, s.send_at, s.set_at, s.error, s.retry_at, d.account_id, d.thread_id, d.mode, d.to_json, d.subject FROM scheduled_sends s JOIN drafts d ON d.id = s.draft_id ORDER BY s.send_at, s.draft_id")
    .map((r) => ({ draftId: r.draft_id, sendAt: r.send_at, setAt: r.set_at, accountId: r.account_id, threadId: r.thread_id, mode: r.mode, to: JSON.parse(r.to_json || "[]") as unknown[], subject: r.subject, error: r.error, retryAt: r.retry_at }));
}

export function getScheduled(db: Db, draftId: number): ScheduledRow | null {
  const r = db.get<{ draft_id: number; send_at: number; set_at: number; params_json: string; error: string | null; retry_at: number | null }>("SELECT draft_id, send_at, set_at, params_json, error, retry_at FROM scheduled_sends WHERE draft_id = ?", draftId);
  return r ? { draftId: r.draft_id, sendAt: r.send_at, setAt: r.set_at, paramsJson: r.params_json, error: r.error, retryAt: r.retry_at } : null;
}

/** Only the draft as it was prepared (its generation and revision); the cap counts the others. */
export function putScheduled(db: Db, row: Omit<ScheduledRow, "error" | "retryAt"> & { generation: string; revision: number }, cap: { count: number; bytes: number }): "ok" | "full" | "stale" {
  return db.tx(() => {
    const draft = db.get<{ generation: string | null; revision: number }>("SELECT generation, revision FROM drafts WHERE id = ?", row.draftId);
    if (!draft || (draft.generation ?? "") !== row.generation || draft.revision !== row.revision) return "stale";
    const others = db.get<{ n: number; bytes: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(params_len), 0) AS bytes FROM scheduled_sends WHERE draft_id <> ?", row.draftId)!;
    if (others.n >= cap.count || others.bytes + row.paramsJson.length > cap.bytes) return "full";
    db.run("INSERT OR REPLACE INTO scheduled_sends (draft_id, send_at, set_at, params_json, params_len, error, retry_at) VALUES (?, ?, ?, ?, ?, NULL, NULL)", row.draftId, row.sendAt, row.setAt, row.paramsJson, row.paramsJson.length);
    return "ok";
  });
}

export function rescheduleScheduled(db: Db, draftId: number, sendAt: number): boolean {
  return db.run("UPDATE scheduled_sends SET send_at = ?, error = NULL, retry_at = NULL WHERE draft_id = ?", sendAt, draftId).changes > 0;
}

export function failScheduled(db: Db, draftId: number, sendAt: number, error: string, retryAt: number): boolean {
  return db.run("UPDATE scheduled_sends SET error = ?, retry_at = ? WHERE draft_id = ? AND send_at = ?", error, retryAt, draftId, sendAt).changes > 0;
}

export function deleteScheduled(db: Db, draftId: number): boolean {
  return db.run("DELETE FROM scheduled_sends WHERE draft_id = ?", draftId).changes > 0;
}

/** queueSend's fence: still scheduled for exactly this moment */
export function stillScheduled(db: Db, draftId: number | undefined, sendAt: number): boolean {
  return draftId !== undefined && db.get<{ send_at: number }>("SELECT send_at FROM scheduled_sends WHERE draft_id = ?", draftId)?.send_at === sendAt;
}
