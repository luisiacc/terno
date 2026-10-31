import { L } from "@terno/i18n";
import { RpcError } from "@terno/core/rpc";
import type { CaptureLocator, CaptureReason, CaptureRepair, CaptureRepairPage, CaptureTicket } from "@terno/core";

export const CAPTURE_REPAIR_COUNT = 1000;
export const CAPTURE_REPAIR_BYTES = 1024 * 1024;
export interface CaptureRepairRow {
  [column: string]: unknown;
  account_id: number; key: string; message_id: number | null;
  locator: string; reason: CaptureReason; state: "blocked" | "pending"; revision: number; bytes: number;
}
export interface CaptureRepairStorage {
  get(account: number, key: string): CaptureRepairRow | undefined;
  usage(account: number): { count: number; bytes: number };
  messageId(account: number, locator: CaptureLocator): number | null;
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
  retry(account: number, key: string, revision: number, check?: () => void): Promise<void>;
  retire(account: number, locator: CaptureLocator, check?: () => void): Promise<void>;
}
export function captureKey(locator: CaptureLocator): string {
  if (locator.kind === "gmail") {
    if (typeof locator.providerId !== "string" || !locator.providerId.trim() || locator.providerId.length > CAPTURE_REPAIR_BYTES || new TextDecoder().decode(new TextEncoder().encode(locator.providerId)) !== locator.providerId || locator.providerId.startsWith("local:")) throw new Error("Invalid capture identity");
  } else if (locator.kind === "imap") {
    if (typeof locator.mailbox !== "string" || !locator.mailbox || locator.mailbox.length > CAPTURE_REPAIR_BYTES || new TextDecoder().decode(new TextEncoder().encode(locator.mailbox)) !== locator.mailbox || ![locator.messageId, locator.uidvalidity, locator.uid].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error("Invalid capture identity");
  } else throw new Error("Invalid capture identity");
  return JSON.stringify(locator.kind === "gmail" ? ["gmail", locator.providerId] : ["imap", locator.messageId, locator.mailbox, locator.uidvalidity, locator.uid]);
}
export function captureLocator(key: string): CaptureLocator {
  const values: unknown = JSON.parse(key);
  if (!Array.isArray(values)) throw new Error("Invalid capture identity");
  const locator: CaptureLocator = values[0] === "gmail" ? { kind: "gmail", providerId: values[1] } : { kind: "imap", messageId: values[1], mailbox: values[2], uidvalidity: values[3], uid: values[4] };
  if (captureKey(locator) !== key) throw new Error("Invalid capture identity");
  return locator;
}
export const captureRepair = (r: CaptureRepairRow): CaptureRepair => ({ key: r.key, locator: JSON.parse(r.locator), reason: r.reason, state: r.state, revision: r.revision });
export function captureRowBytes(row: CaptureRepairRow): number {
  let bytes = 0;
  for (;;) {
    const next = new TextEncoder().encode(JSON.stringify({ ...row, bytes })).length;
    if (next === bytes) return bytes;
    bytes = next;
  }
}
export function blockCapture(db: CaptureRepairStorage, account: number, locator: CaptureLocator, reason: CaptureReason, revision: number): void {
  if (reason !== "mime-parts" && reason !== "mime-depth") throw new Error("Invalid capture reason");
  const key = captureKey(locator), previous = db.get(account, key);
  if (!db.valid(account, locator) || (previous?.revision ?? 0) !== revision) throw new RpcError("STALE", L("capture.changed"));
  const row: CaptureRepairRow = { account_id: account, key, message_id: locator.kind === "imap" ? locator.messageId : db.messageId(account,locator), locator: JSON.stringify(locator), reason, state: "blocked", revision, bytes: 0 };
  row.bytes = captureRowBytes(row);
  const used = db.usage(account);
  if (used.count + (previous ? 0 : 1) > CAPTURE_REPAIR_COUNT || used.bytes - (previous?.bytes ?? 0) + row.bytes > CAPTURE_REPAIR_BYTES) throw new RpcError("UNAVAILABLE", L("capture.capacity"));
  db.put(row);
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
