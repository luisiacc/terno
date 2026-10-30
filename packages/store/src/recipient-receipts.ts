import { asciiEmail, isValidEmail, normalizeEmail, type Address } from "@terno/core";
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
  childActive(id: string): boolean;
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

export function retireRecipientSlice(db: RecipientReceiptDb, id: string, force = false): boolean {
  const row = db.get(id);
  if (!row) return false;
  if (!force && row.childOpId && db.childActive(row.childOpId)) throw new RpcError("BAD_REQUEST", L("errors.recipientReceipt.unavailable"));
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

export async function rejectedRecipients(header: RecipientReceiptHeader, read: (kind: "envelope" | "outcomes", index: number) => Promise<string | null>, yieldTo: () => Promise<void>): Promise<string[]> {
  const unavailable = () => new RpcError("BAD_REQUEST", L("errors.recipientReceipt.unavailable"));
  if (header.state !== "accepted" || header.retired || header.count <= 0 || header.count > RECIPIENT_OCCURRENCE_LIMIT || header.parts <= 0 || header.parts > header.count) throw unavailable();
  const statuses: RecipientOutcome["outcome"][] = [];
  try {
    for (let index = 0; index < Math.ceil(header.count / 128); index++) {
      const data = await read("outcomes", index);
      if (data === null || data.length > 4096) throw unavailable();
      const part: unknown = JSON.parse(data);
      if (!Array.isArray(part) || part.length !== Math.min(128, header.count - index * 128) || part.some((value) => value !== "accepted" && value !== "rejected" && value !== "unknown")) throw unavailable();
      statuses.push(...part);
      await yieldTo();
    }
    if (!statuses.includes("accepted")) throw unavailable();
    const seen = new Map<string, { email: string; original: string; status: RecipientOutcome["outcome"] }>();
    let offset = 0;
    for (let index = 0; index < header.parts; index++) {
      const data = await read("envelope", index);
      if (data === null || new TextEncoder().encode(data).length > RECIPIENT_PART_BYTES) throw unavailable();
      const part: unknown = JSON.parse(data);
      if (!Array.isArray(part) || !part.length || offset + part.length > header.count) throw unavailable();
      for (const entry of part) {
        if (!entry || typeof entry !== "object" || !["to", "cc", "bcc"].includes(entry.role) || typeof entry.email !== "string" || entry.email.length > 320 || entry.email !== entry.email.trim() || !isValidEmail(entry.email)) throw unavailable();
        const email = asciiEmail(entry.email), key = normalizeEmail(email), status = statuses[offset++]!;
        const prior = seen.get(key);
        if (prior && (prior.original !== entry.email || prior.status !== status)) throw unavailable();
        seen.set(key, { email, original: entry.email, status });
      }
      await yieldTo();
    }
    if (offset !== header.count) throw unavailable();
    return [...seen.values()].filter(({ status }) => status === "rejected").map(({ email }) => email);
  } catch (error) {
    if (error instanceof RpcError) throw error;
    throw unavailable();
  }
}
