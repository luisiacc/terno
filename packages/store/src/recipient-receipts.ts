import type { Address } from "@terno/core";
import { RpcError } from "@terno/core/rpc";
import { L } from "@terno/i18n";

export const RECIPIENT_RECEIPT_LIMIT = 128;
export const RECIPIENT_RECEIPT_BYTES = 4 * 1024 * 1024;
export const RECIPIENT_OCCURRENCE_LIMIT = 3000;
export const RECIPIENT_PART_BYTES = 16384;

export async function recipientReceiptParts(fields: { to: Address[]; cc: Address[]; bcc: Address[] }, yieldTo: () => Promise<void>): Promise<{ parts: string[]; count: number; charge: number }> {
  const count = fields.to.length + fields.cc.length + fields.bcc.length;
  if (count > RECIPIENT_OCCURRENCE_LIMIT) throw new RpcError("BAD_REQUEST", L("errors.recipientReceipt.capacity"));
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let part: string[] = [], size = 2, bytes = 0, processed = 0;
  for (const role of ["to", "cc", "bcc"] as const) for (const address of fields[role]) {
    const item = JSON.stringify({ role, ...address });
    const itemBytes = encoder.encode(item).length;
    if (itemBytes + 2 > RECIPIENT_PART_BYTES) throw new RpcError("BAD_REQUEST", L("errors.recipientReceipt.capacity"));
    if (size + itemBytes + (part.length ? 1 : 0) > RECIPIENT_PART_BYTES) {
      const serialized = `[${part.join(",")}]`; parts.push(serialized); bytes += encoder.encode(serialized).length; part = []; size = 2;
    }
    size += itemBytes + (part.length ? 1 : 0); part.push(item);
    if (++processed % 32 === 0) await yieldTo();
  }
  if (part.length) { const serialized = `[${part.join(",")}]`; parts.push(serialized); bytes += encoder.encode(serialized).length; }
  return { parts, count, charge: bytes + count * 16 + parts.length * 128 + 1024 };
}

export type RecipientOutcome = { email: string; outcome: "accepted" | "rejected" | "unknown" };
export interface RecipientReceiptHeader {
  opId: string; accountId: number; createdAt: number; charge: number; count: number; parts: number;
  state: "pending" | "accepted"; retired: boolean; childOpId: string | null; deleteAfter: number;
}
export interface RecipientReceiptDb {
  all(): RecipientReceiptHeader[];
  get(id: string): RecipientReceiptHeader | null;
  put(row: RecipientReceiptHeader): void;
  putPart(id: string, kind: "envelope" | "outcomes", index: number, data: string): void;
  removePart(id: string, kind: "envelope" | "outcomes", index: number): void;
  remove(id: string): void;
}
export function reserveRecipientReceipt(db: RecipientReceiptDb, opId: string, accountId: number, now: number, prepared: Awaited<ReturnType<typeof recipientReceiptParts>>): void {
  const rows = db.all();
  if (rows.length >= RECIPIENT_RECEIPT_LIMIT || rows.reduce((sum, row) => sum + row.charge, 0) + prepared.charge > RECIPIENT_RECEIPT_BYTES) throw new RpcError("BAD_REQUEST", L("errors.recipientReceipt.capacity"));
  db.put({ opId, accountId, createdAt: now, charge: prepared.charge, count: prepared.count, parts: prepared.parts.length, state: "pending", retired: false, childOpId: null, deleteAfter: 0 });
  prepared.parts.forEach((part, index) => db.putPart(opId, "envelope", index, part));
}

export type AcceptedRecipientEvidence = { warning: string | null; outcomes?: RecipientOutcome[] };
export function publishRecipientReceipt(db: RecipientReceiptDb, id: string, outcomes?: RecipientOutcome[]): void {
  const row = db.get(id);
  if (!row || row.retired || row.state !== "pending") return;
  if (outcomes && outcomes.length === row.count && outcomes.every((entry) => entry.outcome === "accepted" || entry.outcome === "rejected" || entry.outcome === "unknown")) {
    for (let i = 0; i < outcomes.length; i += 128) db.putPart(id, "outcomes", i / 128, JSON.stringify(outcomes.slice(i, i + 128).map((entry) => entry.outcome)));
  }
  db.put({ ...row, state: "accepted" });
}

export function retireRecipientSlice(db: RecipientReceiptDb, id: string): boolean {
  const row = db.get(id);
  if (!row) return false;
  const total = row.parts + Math.ceil(row.count / 128);
  let position = row.deleteAfter;
  for (let n = 0; n < 8 && position < total; n++, position++) {
    if (position < row.parts) db.removePart(id, "envelope", position);
    else db.removePart(id, "outcomes", position - row.parts);
  }
  if (position === total) { db.remove(id); return false; }
  db.put({ ...row, retired: true, deleteAfter: position });
  return true;
}
