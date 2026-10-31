import type { ScheduledRow, ScheduledSend } from "@terno/store";
import { T, type Ctx, type R } from "./mail";

/** Plan 89: drafts scheduled to send, like SQL's `scheduled_sends` (packages/db/src/scheduled.ts). */

const toRow = (r: R): ScheduledRow => ({ draftId: r.draft_id, sendAt: r.send_at, setAt: r.set_at, paramsJson: r.params_json, error: r.error ?? null, retryAt: r.retry_at ?? null });

export function listScheduled(c: Ctx): ScheduledSend[] {
  const drafts = T(c, "drafts");
  const out: ScheduledSend[] = [];
  for (const s of T(c, "scheduled_sends").all()) {
    const d = drafts.get(s.draft_id);
    if (!d) continue;
    out.push({ draftId: s.draft_id, sendAt: s.send_at, setAt: s.set_at, accountId: d.account_id, threadId: d.thread_id ?? null, mode: d.mode, to: JSON.parse(d.to_json || "[]") as unknown[], subject: d.subject, error: s.error ?? null, retryAt: s.retry_at ?? null });
  }
  return out.sort((a, b) => a.sendAt - b.sendAt || a.draftId - b.draftId);
}

export function getScheduled(c: Ctx, draftId: number): ScheduledRow | null {
  const r = T(c, "scheduled_sends").get(draftId);
  return r ? toRow(r) : null;
}

export function putScheduled(c: Ctx, row: Omit<ScheduledRow, "error" | "retryAt"> & { generation: string; revision: number }, cap: { count: number; bytes: number }): "ok" | "full" | "stale" {
  const draft = T(c, "drafts").get(row.draftId);
  if (!draft || (draft.generation ?? "") !== row.generation || draft.revision !== row.revision) return "stale";
  const table = T(c, "scheduled_sends");
  let count = 0, bytes = 0;
  for (const r of table.all()) if (r.draft_id !== row.draftId) { count++; bytes += (r.params_json as string).length; }
  if (count >= cap.count || bytes + row.paramsJson.length > cap.bytes) return "full";
  table.put({ draft_id: row.draftId, send_at: row.sendAt, set_at: row.setAt, params_json: row.paramsJson, error: null, retry_at: null });
  return "ok";
}

export function rescheduleScheduled(c: Ctx, draftId: number, sendAt: number): boolean {
  const table = T(c, "scheduled_sends");
  const r = table.get(draftId);
  if (!r) return false;
  table.update(r, { send_at: sendAt, error: null, retry_at: null });
  return true;
}

export function failScheduled(c: Ctx, draftId: number, sendAt: number, error: string, retryAt: number): boolean {
  const table = T(c, "scheduled_sends");
  const r = table.get(draftId);
  if (!r || r.send_at !== sendAt) return false;
  table.update(r, { error, retry_at: retryAt });
  return true;
}

export function deleteScheduled(c: Ctx, draftId: number): boolean {
  return T(c, "scheduled_sends").delete(draftId) !== undefined;
}

/** queueSend's fence: still scheduled for exactly this moment */
export function stillScheduled(c: Ctx, draftId: number | undefined, sendAt: number): boolean {
  return draftId !== undefined && T(c, "scheduled_sends").get(draftId)?.send_at === sendAt;
}
