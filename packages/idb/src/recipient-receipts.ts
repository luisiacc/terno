import type { RecipientReceiptDb, RecipientReceiptHeader } from "@terno/store";
import type { MemDb, Row } from "./mem";

export function idbRecipientReceipts(db: MemDb): RecipientReceiptDb {
  const rows = db.table("recipient_receipts"), parts = db.table("recipient_receipt_parts");
  return {
    all: () => [...rows.all()].map((row) => ({ ...row, hasRejected: row.hasRejected ?? row.state === "accepted", wireOwnerId: row.wireOwnerId ?? null })) as unknown as RecipientReceiptHeader[],
    markSummary: (id, partial, unknown) => {
      if (!partial && !unknown) return;
      const ops = db.table("ops"), op = ops.get(id);
      if (op?.kind === "send") ops.update(op, { target_json: JSON.stringify({ ...JSON.parse(String(op.target_json)), ...(partial && { recipientPartial: true }), ...(unknown && { recipientOutcomeUnknown: true }) }) });
    },
    childActive: (id) => { const state = db.table("ops").get(id)?.state; return state !== "succeeded" && state !== "failed" && state !== "unknown"; },
    get: (id) => { const row = rows.get(id); return row ? { ...row, hasRejected: row.hasRejected ?? row.state === "accepted", wireOwnerId: row.wireOwnerId ?? null } as unknown as RecipientReceiptHeader : null; },
    put: (row) => { const prior = rows.get(row.opId); if (prior) rows.update(prior, row as unknown as Row); else rows.insert(row as unknown as Row); },
    remove: (id) => { rows.delete(id); },
    removePart: (id, kind, index) => { parts.delete(`${id}:${kind}:${index}`); },
    putPart: (opId, kind, position, data) => { const id = `${opId}:${kind}:${position}`; const prior = parts.get(id); if (prior) parts.update(prior, { data }); else parts.insert({ id, opId, kind, position, data }); },
  };
}
