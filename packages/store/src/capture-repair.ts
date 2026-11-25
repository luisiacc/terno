import { L } from "@terno/i18n";
import { RpcError } from "@terno/core/rpc";
import { CAPTURE_DETAIL_TEXT_MAX, isCaptureReason, type CaptureDetail, type CaptureLocator, type CaptureReason, type CaptureRepair, type CaptureRepairPage, type CaptureTicket } from "@terno/core";

export const CAPTURE_REPAIR_COUNT = 1000;
export const CAPTURE_REPAIR_BYTES = 1024 * 1024;
export interface CaptureRepairRow {
  [column: string]: unknown;
  account_id: number; key: string; message_id: number | null;
  /** plan 267: plain text in the database (no list there); written only from CAPTURE_REASONS, read whatever it is */
  locator: string; reason: string; state: "blocked" | "pending"; revision: number; bytes: number;
  /** plan 267: JSON of what's known about the message (CaptureDetail), or null */
  detail?: string | null;
}
export interface CaptureRepairStorage {
  get(account: number, key: string): CaptureRepairRow | undefined;
  usage(account: number): { count: number; bytes: number };
  messageId(account: number, locator: CaptureLocator): number | null;
  /** plan 267: the stored message's subject, sender and date, when it's stored (an IMAP repair's always is) */
  envelope(account: number, messageId: number): CaptureDetail | undefined;
  valid(account: number, locator: CaptureLocator): boolean;
  put(row: CaptureRepairRow): void;
  remove(account: number, key: string): void;
  page(account: number, after: string, state?: "pending"): CaptureRepairRow[];
}
export interface CaptureRepairs {
  forMessage(account: number, message: number): Promise<CaptureRepair | null>;
  get(account: number, locator: CaptureLocator): Promise<CaptureRepair | null>;
  list(account: number, after?: string, state?: "pending"): Promise<CaptureRepairPage>;
  block(account: number, locator: CaptureLocator, reason: CaptureReason, revision: number, check?: () => void): Promise<void>;
  /** plan 267: what's known about a repair's message, kept when the row is still at `revision` and has none */
  describe(account: number, key: string, revision: number, detail: CaptureDetail): Promise<void>;
  retry(account: number, key: string, revision: number, check?: () => void): Promise<void>;
  retire(account: number, locator: CaptureLocator, check?: () => void): Promise<void>;
}
export function captureKey(locator: CaptureLocator): string {
  if (locator.kind === "gmail" || locator.kind === "outlook") {
    if (typeof locator.providerId !== "string" || !locator.providerId.trim() || locator.providerId.length > CAPTURE_REPAIR_BYTES || new TextDecoder().decode(new TextEncoder().encode(locator.providerId)) !== locator.providerId || locator.providerId.startsWith("local:")) throw new Error("Invalid capture identity");
  } else if (locator.kind === "imap") {
    if (typeof locator.mailbox !== "string" || !locator.mailbox || locator.mailbox.length > CAPTURE_REPAIR_BYTES || new TextDecoder().decode(new TextEncoder().encode(locator.mailbox)) !== locator.mailbox || ![locator.messageId, locator.uidvalidity, locator.uid].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error("Invalid capture identity");
  } else throw new Error("Invalid capture identity");
  return JSON.stringify(locator.kind === "imap" ? ["imap", locator.messageId, locator.mailbox, locator.uidvalidity, locator.uid] : [locator.kind, locator.providerId]);
}
export function captureLocator(key: string): CaptureLocator {
  const values: unknown = JSON.parse(key);
  if (!Array.isArray(values)) throw new Error("Invalid capture identity");
  const locator: CaptureLocator = values[0] === "gmail" || values[0] === "outlook" ? { kind: values[0], providerId: values[1] } : { kind: "imap", messageId: values[1], mailbox: values[2], uidvalidity: values[3], uid: values[4] };
  if (captureKey(locator) !== key) throw new Error("Invalid capture identity");
  return locator;
}
/** A detail cut to its bounds, its unknown or malformed parts dropped (plan 267); undefined when nothing's left. */
export function captureDetail(value: unknown): CaptureDetail | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as Record<string, unknown>, out: CaptureDetail = {};
  const text = (x: unknown) => typeof x === "string" && x.trim() ? x.trim().slice(0, CAPTURE_DETAIL_TEXT_MAX) : undefined;
  const subject = text(v.subject), from = text(v.from);
  if (subject) out.subject = subject;
  if (from) out.from = from;
  // a date JavaScript can show (Date's own range), never one that makes formatting throw
  if (Number.isSafeInteger(v.date) && (v.date as number) > 0 && (v.date as number) <= 8_640_000_000_000_000) out.date = v.date as number;
  return Object.keys(out).length ? out : undefined;
}
function readDetail(json: string | null | undefined): CaptureDetail | undefined {
  if (!json) return;
  try { return captureDetail(JSON.parse(json)); } catch { return; }
}
/** plan 267: a reason this build doesn't know (a newer one wrote it on the same schema) reads as "unknown", never an error */
export const captureRepair = (r: CaptureRepairRow): CaptureRepair => {
  const detail = readDetail(r.detail);
  return { key: r.key, locator: JSON.parse(r.locator), reason: isCaptureReason(r.reason) ? r.reason : "unknown", state: r.state, revision: r.revision, ...(detail && { detail }) };
};
export function captureRowBytes(row: CaptureRepairRow): number {
  // plan 267: the detail isn't counted. It's optional and bounded on its own (CAPTURE_DETAIL_TEXT_MAX), so it never
  // takes the room a repair or a retry needs; the cap keeps bounding what repairs need, as it always did
  const { detail: _detail, ...counted } = row;
  let bytes = 0;
  for (;;) {
    const next = new TextEncoder().encode(JSON.stringify({ ...counted, bytes })).length;
    if (next === bytes) return bytes;
    bytes = next;
  }
}
export function blockCapture(db: CaptureRepairStorage, account: number, locator: CaptureLocator, reason: CaptureReason, revision: number): void {
  // plan 267: the database holds no list of reasons; this is where a reason is checked
  if (!isCaptureReason(reason)) throw new Error("Invalid capture reason");
  const key = captureKey(locator), previous = db.get(account, key);
  if (!db.valid(account, locator) || (previous?.revision ?? 0) !== revision) throw new RpcError("STALE", L("capture.changed"));
  const messageId = locator.kind === "imap" ? locator.messageId : db.messageId(account,locator);
  // the stored message's envelope (an IMAP repair's message always is), else what the row had (a Gmail one, read for the list)
  const detail = (messageId !== null ? captureDetail(db.envelope(account, messageId)) : undefined) ?? readDetail(previous?.detail);
  const row: CaptureRepairRow = { account_id: account, key, message_id: messageId, locator: JSON.stringify(locator), reason, state: "blocked", revision, bytes: 0, detail: detail ? JSON.stringify(detail) : null };
  row.bytes = captureRowBytes(row);
  const used = db.usage(account);
  if (used.count + (previous ? 0 : 1) > CAPTURE_REPAIR_COUNT || used.bytes - (previous?.bytes ?? 0) + row.bytes > CAPTURE_REPAIR_BYTES) throw new RpcError("UNAVAILABLE", L("capture.capacity"));
  db.put(row);
}
/**
 * Plan 267: what's known about a repair's message (Gmail's own parse of its headers, read when the list is opened), kept
 * only on the row it was read for: the same revision and still without one (else nothing changes).
 */
export function describeCapture(db: CaptureRepairStorage, account: number, key: string, revision: number, given: CaptureDetail): void {
  const row = db.get(account, key), detail = captureDetail(given);
  if (!row || !detail || row.revision !== revision || readDetail(row.detail)) return;
  db.put({ ...row, detail: JSON.stringify(detail) });
}
export function retryCapture(db: CaptureRepairStorage, account: number, key: string, revision: number): void {
  const row = db.get(account, key);
  if (!row || row.revision !== revision || row.state !== "blocked" || !db.valid(account, JSON.parse(row.locator))) throw new RpcError("STALE", L("capture.changed"));
  const next = { ...row, state: "pending" as const, revision: row.revision + 1 };
  next.bytes = captureRowBytes(next);
  if (db.usage(account).bytes - row.bytes + next.bytes > CAPTURE_REPAIR_BYTES) throw new RpcError("UNAVAILABLE", L("capture.capacity"));
  db.put(next);
}
export function completeCapture(db: CaptureRepairStorage, account: number, ticket?: CaptureTicket): void {
  if (!ticket) return;
  const row = db.get(account, ticket.key);
  if (!row || row.state !== "pending" || row.revision !== ticket.revision || !db.valid(account, JSON.parse(row.locator))) throw new RpcError("STALE", L("capture.changed"));
  db.remove(account, ticket.key);
}
