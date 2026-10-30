import { ATTACHMENT_CHUNK, asciiEmail, isValidEmail, normalizeEmail, normalizeText, type Address } from "@terno/core";
import { RpcError } from "@terno/core/rpc";
import { L } from "@terno/i18n";

export const RECIPIENT_RECEIPT_LIMIT = 128;
export const RECIPIENT_RECEIPT_BYTES = 4 * 1024 * 1024;
export const RECIPIENT_OCCURRENCE_LIMIT = 3000;
export const RECIPIENT_PART_BYTES = 16384;

export async function recipientReceiptParts(fields: { to: Address[]; cc: Address[]; bcc: Address[] }, yieldTo: () => Promise<void>): Promise<{ parts: string[]; count: number; charge: number; text: string; normalized: string }> {
  const count = fields.to.length + fields.cc.length + fields.bcc.length;
  if (count > RECIPIENT_OCCURRENCE_LIMIT) throw new RpcError("BAD_REQUEST", L("errors.recipientReceipt.capacity"));
  const encoder = new TextEncoder();
  const parts: string[] = [], textParts: string[] = [], normalizedParts: string[] = [];
  let part: string[] = [], size = 2, bytes = 0, processed = 0;
  for (const role of ["to", "cc", "bcc"] as const) for (const address of fields[role]) {
    const text = address.name ? `${address.name} ${address.email}` : address.email;
    textParts.push(text); normalizedParts.push(normalizeText(text));
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
  return { parts, count, charge: bytes + count * 16 + parts.length * 128 + 1024, text: textParts.join(" "), normalized: normalizedParts.join(" ") };
}

export type RecipientOutcome = { email: string; outcome: "accepted" | "rejected" | "unknown" };
export interface RecipientReceiptHeader {
  opId: string; accountId: number; createdAt: number; charge: number; count: number; parts: number;
  state: "pending" | "accepted"; retired: boolean; childOpId: string | null; deleteAfter: number; hasRejected: boolean; wireOwnerId: string | null;
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
export function reserveRecipientReceipt(db: RecipientReceiptDb, opId: string, accountId: number, now: number, prepared: Awaited<ReturnType<typeof recipientReceiptParts>>, wireOwnerId: string | null = null): void {
  const rows = db.all();
  if (rows.length >= RECIPIENT_RECEIPT_LIMIT || rows.reduce((sum, row) => sum + row.charge, 0) + prepared.charge > RECIPIENT_RECEIPT_BYTES) throw new RpcError("BAD_REQUEST", L("errors.recipientReceipt.capacity"));
  db.put({ opId, accountId, createdAt: now, charge: prepared.charge, count: prepared.count, parts: prepared.parts.length, state: "pending", retired: false, childOpId: null, deleteAfter: 0, hasRejected: false, wireOwnerId });
  prepared.parts.forEach((part, index) => db.putPart(opId, "envelope", index, part));
}

export type AcceptedRecipientEvidence = { warning: string | null; outcomes?: RecipientOutcome[] };
export function publishRecipientReceipt(db: RecipientReceiptDb, id: string, outcomes?: RecipientOutcome[]): void {
  const row = db.get(id);
  if (!row || row.retired || row.state !== "pending") return;
  if (outcomes && outcomes.length === row.count && outcomes.every((entry) => entry.outcome === "accepted" || entry.outcome === "rejected" || entry.outcome === "unknown")) {
    for (let i = 0; i < outcomes.length; i += 128) db.putPart(id, "outcomes", i / 128, JSON.stringify(outcomes.slice(i, i + 128).map((entry) => entry.outcome)));
  }
  db.put({ ...row, state: "accepted", hasRejected: !!outcomes && outcomes.length === row.count && outcomes.some((entry) => entry.outcome === "rejected") });
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
  db.put({ ...row, retired: true, deleteAfter: position });
  return position < total;
}

export async function rejectedRecipientSelection(header: RecipientReceiptHeader, read: (kind: "envelope" | "outcomes", index: number) => Promise<string | null>, yieldTo: () => Promise<void>): Promise<{ email: string; original: string; role: "to" | "cc" | "bcc"; name: string }[]> {
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
    const seen = new Map<string, { email: string; original: string; role: "to" | "cc" | "bcc"; name: string; status: RecipientOutcome["outcome"] }>();
    let offset = 0;
    for (let index = 0; index < header.parts; index++) {
      const data = await read("envelope", index);
      if (data === null || new TextEncoder().encode(data).length > RECIPIENT_PART_BYTES) throw unavailable();
      const part: unknown = JSON.parse(data);
      if (!Array.isArray(part) || !part.length || offset + part.length > header.count) throw unavailable();
      for (const entry of part) {
        if (!entry || typeof entry !== "object" || !["to", "cc", "bcc"].includes(entry.role) || typeof entry.name !== "string" || entry.name.length > 300 || typeof entry.email !== "string" || entry.email.length > 320 || entry.email !== entry.email.trim() || !isValidEmail(entry.email)) throw unavailable();
        const email = asciiEmail(entry.email), key = normalizeEmail(email), status = statuses[offset++]!;
        const prior = seen.get(key);
        if (prior && (prior.original !== entry.email || prior.status !== status)) throw unavailable();
        if (!prior) seen.set(key, { email, original: entry.email, role: entry.role, name: entry.name, status });
      }
      await yieldTo();
    }
    if (offset !== header.count) throw unavailable();
    return [...seen.values()].filter(({ status }) => status === "rejected").map(({ email, original, role, name }) => ({ email, original, role, name }));
  } catch (error) {
    if (error instanceof RpcError) throw error;
    throw unavailable();
  }
}

export async function rejectedRecipients(header: RecipientReceiptHeader, read: (kind: "envelope" | "outcomes", index: number) => Promise<string | null>, yieldTo: () => Promise<void>): Promise<string[]> {
  return (await rejectedRecipientSelection(header, read, yieldTo)).map((entry) => entry.email);
}

export function requireRecoverySource(row: RecipientReceiptHeader | null, expected: RecipientReceiptHeader, source: import("./send-copies").SendCopyRow | null): RecipientReceiptHeader {
  const unavailable = () => new RpcError("BAD_REQUEST", L("errors.recipientReceipt.unavailable"));
  if (!row || row.retired || row.state !== "accepted" || row.childOpId || row.opId !== expected.opId || row.accountId !== expected.accountId || row.createdAt !== expected.createdAt || row.count !== expected.count || row.parts !== expected.parts || row.charge !== expected.charge || row.wireOwnerId !== expected.wireOwnerId || expected.retired || expected.state !== "accepted" || expected.childOpId || !source || source.accountId !== row.accountId || source.retiring || !source.ready || !source.size || source.chunks !== Math.ceil(source.size / ATTACHMENT_CHUNK)) throw unavailable();
  return row;
}

export function finishRecipientRetirement(db: RecipientReceiptDb, id: string, source: import("./send-copies").SendCopyRow | null, retainedByOther: boolean): void {
  const row = db.get(id);
  if (!row) return;
  if (!row.retired || row.deleteAfter < row.parts + Math.ceil(row.count / 128) || (source && !retainedByOther && (!source.copyRequested || (source.copy === "saved" && source.chunks > 0)))) throw new RpcError("BAD_REQUEST", L("errors.recipientReceipt.unavailable"));
  db.remove(id);
}
