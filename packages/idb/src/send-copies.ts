import { acceptedSubmissionTarget, submissionAccepted } from "@terno/store";
import type { SendCopyDb, SendCopyRow } from "@terno/store";
import { assetAccounting } from "./asset-accounting";
import type { MemDb, Row } from "./mem";

export function idbSendCopies(db: MemDb): SendCopyDb {
  const rows = db.table("send_copies"), bytes = db.table("send_copy_bytes");
  return {
    get: (id) => { const row = rows.get(id); return row ? { ...row, copyRequested: row.copyRequested !== false } as unknown as SendCopyRow : null; },
    all: () => [...rows.all()].map((row) => ({ ...row, copyRequested: row.copyRequested !== false })) as unknown as SendCopyRow[],
    wireClaimed: (id) => [...db.table("recipient_receipts").all()].some((receipt) => { const child = receipt.childOpId; const state = typeof child === "string" ? db.table("ops").get(child)?.state : null; return (receipt.wireOwnerId ?? receipt.opId) === id && typeof child === "string" && state !== "succeeded" && state !== "failed" && state !== "unknown"; }),
    wirePinned: (id) => [...db.table("recipient_receipts").all()].some((receipt) => { const child = receipt.childOpId; const state = typeof child === "string" ? db.table("ops").get(child)?.state : null; return (receipt.wireOwnerId ?? receipt.opId) === id && (((receipt.hasRejected === true || (receipt.hasRejected === undefined && receipt.state === "accepted")) && !receipt.retired) || (typeof child === "string" && state !== "succeeded" && state !== "failed" && state !== "unknown")); }),
    put: (row) => { const prior = rows.get(row.opId); if (prior) rows.update(prior, row as unknown as Row); else rows.insert(row as unknown as Row); },
    markSubmissionAccepted: (id) => {
      const ops = db.table("ops"), op = ops.get(id);
      if (op?.kind === "send") {
        const current = { kind: op.kind, target_json: String(op.target_json) };
        if (!submissionAccepted(current)) ops.update(op, { target_json: acceptedSubmissionTarget(current) });
      }
    },
    remove: (id) => { rows.delete(id); },
    chunk: (id, index) => bytes.get(`${id}:${index}`)?.data as string ?? null,
    putChunk: (id, index, data) => { bytes.insert({ id: `${id}:${index}`, opId: id, position: index, data }); },
    removeChunks: (id, limit) => {
      let n = 0;
      // Only one receipt's bounded chunk keys; no lazy byte values are hydrated for deletion.
      const header = rows.get(id);
      const next = Number(header?.deleteAfter ?? 0);
      for (let i = next; i < Number(header?.chunks ?? 0) && n < limit; i++, n++) bytes.delete(`${id}:${i}`);
      if (header) rows.update(header, { deleteAfter: next + n });
      return n;
    },
    accountBytes: (id) => assetAccounting(db).used(id) + rows.by("fk_accountId", id).reduce((n, r) => n + Number(r.reserved), 0),
  };
}
