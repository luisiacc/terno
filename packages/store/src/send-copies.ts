import { ATTACHMENT_ACCOUNT_BYTES, ATTACHMENT_CHUNK, MAX_MIME_BYTES, base64Bytes, encodeText, decodeText, type SentCopyState } from "@terno/core";
import { RpcError } from "@terno/core/rpc";
import { L } from "@terno/i18n";

export const SEND_COPY_LIMIT = 128;
export const SEND_COPY_BYTES = 256 * 1024 * 1024;
export const SEND_RECIPIENT_LIMIT = 3000;

export interface SendCopyRow {
  opId: string;
  accountId: number;
  copyRequested: boolean;
  submission: "pending" | "accepted";
  copy: SentCopyState;
  createdAt: number;
  reserved: number;
  size: number;
  chunks: number;
  ready: boolean;
  mailbox: string | null;
  uidValidity: string | null;
  uid: number | null;
  warning: string | null;
  retiring: boolean;
  deleteAfter?: number;
}

export interface SendCopyDb {
  get(id: string): SendCopyRow | null;
  all(): SendCopyRow[];
  put(row: SendCopyRow): void;
  remove(id: string): void;
  markSubmissionAccepted(id: string): void;
  wirePinned(id: string): boolean;
  wireClaimed(id: string): boolean;
  chunk(id: string, index: number): string | null;
  putChunk(id: string, index: number, data: string): void;
  removeChunks(id: string, limit: number): number;
  accountBytes(accountId: number): number;
}
export const copyUnavailable = () => new RpcError("BAD_REQUEST", L("errors.sentCopy.unavailable"));

export function reserveSendCopy(db: SendCopyDb, opId: string, accountId: number, now: number, recipients: number, copyRequested = true): void {
  let rows = db.all();
  for (const old of rows) if (old.copy === "saved" && old.chunks === 0 && !db.wirePinned(old.opId)) {
    if (old.submission === "accepted") db.markSubmissionAccepted(old.opId);
    db.remove(old.opId);
  }
  rows = db.all();
  if (recipients > SEND_RECIPIENT_LIMIT || rows.length >= SEND_COPY_LIMIT || rows.reduce((n, r) => n + r.reserved, 0) + MAX_MIME_BYTES > SEND_COPY_BYTES || db.accountBytes(accountId) + MAX_MIME_BYTES > ATTACHMENT_ACCOUNT_BYTES) throw new RpcError("BAD_REQUEST", L(copyRequested ? "errors.sentCopy.capacity" : "errors.recipientReceipt.wireCapacity"));
  db.put({ opId, accountId, copyRequested, submission: "pending", copy: "pending", createdAt: now, reserved: MAX_MIME_BYTES, size: 0, chunks: 0, ready: false, mailbox: null, uidValidity: null, uid: null, warning: null, retiring: false });
}

export function requireSendCopy(db: SendCopyDb, id: string): SendCopyRow {
  const row = db.get(id);
  if (!row || row.retiring) throw copyUnavailable();
  return row;
}

export function startCopyWire(db: SendCopyDb, id: string, size: number): void {
  const row = requireSendCopy(db, id);
  if (db.wirePinned(id) || row.submission !== "pending" || row.ready || row.chunks || !Number.isSafeInteger(size) || size <= 0 || size > MAX_MIME_BYTES) throw copyUnavailable();
  db.put({ ...row, size });
}

export function appendCopyWire(db: SendCopyDb, id: string, index: number, data: string): void {
  const row = requireSendCopy(db, id);
  if (db.wirePinned(id) || row.submission !== "pending" || row.ready || index !== row.chunks || base64Bytes(data).length !== Math.min(ATTACHMENT_CHUNK, row.size - index * ATTACHMENT_CHUNK) || row.size === 0 || index * ATTACHMENT_CHUNK >= row.size) throw copyUnavailable();
  db.putChunk(id, index, data);
  db.put({ ...row, chunks: row.chunks + 1 });
}

export function sealCopyWire(db: SendCopyDb, id: string): void {
  const row = requireSendCopy(db, id);
  if (db.wirePinned(id) || row.size <= 0 || row.chunks !== Math.ceil(row.size / ATTACHMENT_CHUNK)) throw copyUnavailable();
  db.put({ ...row, ready: true, reserved: Math.min(MAX_MIME_BYTES, row.size + 1024) });
}

export function acceptCopySubmission(db: SendCopyDb, id: string, warning: string | null): void {
  const row = requireSendCopy(db, id);
  if (!row.ready || row.submission !== "pending") throw copyUnavailable();
  db.markSubmissionAccepted(id);
  db.put({ ...row, submission: "accepted", warning });
}

export function recordCopy(db: SendCopyDb, id: string, copy: SentCopyState, identity?: { mailbox: string; uidValidity?: string; uid?: number }): void {
  const row = requireSendCopy(db, id);
  if (row.submission !== "accepted" || row.copy === "saved") throw copyUnavailable();
  if (identity && (!identity.mailbox || identity.mailbox.length > 1024 || (identity.uid !== undefined && (!Number.isSafeInteger(identity.uid) || identity.uid <= 0)) || (identity.uidValidity !== undefined && !/^\d{1,20}$/.test(identity.uidValidity)))) throw copyUnavailable();
  db.put({ ...row, copy, ...(identity && { mailbox: identity.mailbox, uidValidity: identity.uidValidity ?? null, uid: identity.uid ?? null }) });
}

export function forgetCopySlice(db: SendCopyDb, id: string, force = false): boolean {
  const row = db.get(id);
  if (!row) return false;
  if (!force && db.wireClaimed(id)) throw copyUnavailable();
  if (row.submission === "accepted") db.markSubmissionAccepted(id);
  if (!row.retiring) db.put({ ...row, retiring: true });
  const removed = db.removeChunks(id, 8);
  if (removed < 8) { db.remove(id); return false; }
  return true;
}

export function pruneSavedCopySlice(db: SendCopyDb, id: string): boolean {
  const row = requireSendCopy(db, id);
  if (row.copy !== "saved" || db.wirePinned(id)) throw copyUnavailable();
  if (row.submission === "accepted") db.markSubmissionAccepted(id);
  const removed = db.removeChunks(id, 8);
  if (removed < 8) { db.put({ ...row, reserved: 1024, chunks: 0 }); return false; }
  return true;
}

export function resetCopyWireSlice(db: SendCopyDb, id: string): boolean {
  const row = requireSendCopy(db, id);
  if (db.wirePinned(id) || row.submission !== "pending" || row.ready) throw copyUnavailable();
  if (db.removeChunks(id, 8) === 8) return true;
  db.put({ ...row, chunks: 0, size: 0, deleteAfter: 0 });
  return false;
}

export function clearRecipientWarning(warning: string | null): string | null {
  if (!warning) return warning;
  const key = decodeText(warning).i18n?.key;
  if (key === "errors.smtp.notDeliveredTo") return encodeText(L("errors.smtp.partialDetailsCleared"));
  if (key === "errors.sentCopy.partialMissing") return encodeText(L("errors.sentCopy.partialClearedMissing"));
  if (key === "errors.sentCopy.partialUnknown") return encodeText(L("errors.sentCopy.partialClearedUnknown"));
  return warning;
}

export function copyWarningText(row: SendCopyRow): string | null {
  if (!row.copyRequested || row.copy === "saved") return row.warning;
  const warning = row.warning ? decodeText(row.warning) : null;
  if (warning?.i18n?.key === "errors.smtp.recipientOutcomeUnknown") return encodeText(L(row.copy === "rejected" ? "errors.sentCopy.recipientUnknownMissing" : "errors.sentCopy.recipientUnknownCopy"));
  if (warning?.i18n?.key === "errors.smtp.partialDetailsCleared") return encodeText(L(row.copy === "rejected" ? "errors.sentCopy.partialClearedMissing" : "errors.sentCopy.partialClearedUnknown"));
  const recipients = warning?.i18n?.key === "errors.smtp.notDeliveredTo" ? warning.i18n.params?.recipients : undefined;
  if (typeof recipients === "string") return encodeText(L(row.copy === "rejected" ? "errors.sentCopy.partialMissing" : "errors.sentCopy.partialUnknown", { recipients }));
  return encodeText(L(row.copy === "rejected" ? "errors.sentCopy.missing" : "errors.sentCopy.unknown"));
}

export function sendWarningFlags(warning: string | null): { partial: boolean; unknown: boolean } {
  const key = warning ? decodeText(warning).i18n?.key : undefined;
  return {
    partial: key === "errors.smtp.notDeliveredTo" || key === "errors.sentCopy.partialMissing" || key === "errors.sentCopy.partialUnknown" || key === "errors.smtp.partialDetailsCleared" || key === "errors.sentCopy.partialClearedMissing" || key === "errors.sentCopy.partialClearedUnknown",
    unknown: key === "errors.smtp.recipientOutcomeUnknown" || key === "errors.sentCopy.recipientUnknownMissing" || key === "errors.sentCopy.recipientUnknownCopy",
  };
}
