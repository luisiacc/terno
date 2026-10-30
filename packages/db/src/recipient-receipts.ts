import type { RecipientReceiptDb, RecipientReceiptHeader } from "@terno/store";
import type { Db } from "./sqlite";

const columns = ["opId", "accountId", "createdAt", "charge", "count", "parts", "state", "retired", "childOpId", "deleteAfter"] as const;
const read = (row: RecipientReceiptHeader): RecipientReceiptHeader => ({ ...row, retired: !!row.retired });
export function sqlRecipientReceipts(db: Db): RecipientReceiptDb {
  return {
    all: () => db.all<RecipientReceiptHeader>("SELECT * FROM recipient_receipts").map(read),
    get: (id) => { const row = db.get<RecipientReceiptHeader>("SELECT * FROM recipient_receipts WHERE opId=?", id); return row ? read(row) : null; },
    put: (row) => { db.run(`INSERT INTO recipient_receipts (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")}) ON CONFLICT(opId) DO UPDATE SET ${columns.slice(1).map((column) => `${column}=excluded.${column}`).join(",")}`, ...columns.map((column) => typeof row[column] === "boolean" ? Number(row[column]) : row[column])); },
    remove: (id) => { db.run("DELETE FROM recipient_receipts WHERE opId=?", id); },
    removePart: (id, kind, index) => { db.run("DELETE FROM recipient_receipt_parts WHERE id=?", `${id}:${kind}:${index}`); },
    putPart: (id, kind, index, data) => { db.run("INSERT INTO recipient_receipt_parts(id,opId,kind,position,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", `${id}:${kind}:${index}`, id, kind, index, data); },
  };
}
