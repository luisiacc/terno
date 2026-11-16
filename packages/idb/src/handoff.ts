import { FOLLOWUPS_ACTIVE_MAX, handedPatch, handedToOf, handoffCloses, handoffOfTarget, handoffWait } from "@terno/store";
import { own } from "./followups";
import { T, type Ctx } from "./mail";

/** Plan 210 (iteration 4) on IndexedDB, as SQL's `handoffConfirmed` (packages/db/src/handoff.ts), in `ops.complete`'s commit. */
export function handoffConfirmed(c: Ctx, targetJson: string, messageId: number, now: number, o: { followup?: boolean; nudgeAfterDays?: number }): boolean {
  const h = handoffOfTarget(targetJson);
  if (!h) return false;
  const m = T(c, "messages").get(messageId);
  const to = m?.is_sent ? handedToOf(m.to_json) : null;
  if (!m || !to) return false;
  const table = (source: "dated" | "promise") => T(c, source === "dated" ? "dated_items" : "followups");
  const closing = handoffCloses(h, (i) => {
    const r = table(i.source).get(i.id);
    return r ? { state: r.state, revision: r.revision } : null;
  });
  if (!closing.length) return false;
  for (const i of closing) {
    const rows = table(i.source);
    const r = rows.get(i.id);
    if (!r || r.revision !== i.revision) continue;
    const p = handedPatch(i, to, now);
    rows.update(r, { state: i.source === "dated" ? p.state : "done", closed_reason: p.closedReason, closed_at: p.closedAt, handed_to: p.handedTo, revision: r.revision + 1, ...(i.source === "promise" && { inbox_state: "none" }) });
  }
  const wait = handoffWait(o, to, m.date, own(c));
  const followups = T(c, "followups");
  const room = followups.by("state", "open").length + followups.by("state", "due").length < FOLLOWUPS_ACTIVE_MAX;
  if (wait && room && !followups.by("identity", messageId, wait.item).length) {
    followups.put({ thread_id: m.thread_id, message_id: messageId, rfc_message_id: m.rfc_message_id ?? null, item: wait.item, kind: "awaiting", text: "", quote: null, person_name: wait.personName, person_email: wait.personEmail, sent_at: m.date, due_at: wait.dueAt, dated: wait.dated ? 1 : 0, deferred_until: null, state: "open", inbox_state: "none", closed_reason: null, closed_at: null, notified_at: null, from_scan: 0, revision: 0, model: null, provider: null, prompt_version: null, created_at: now, timed: 0 });
  }
  return true;
}
