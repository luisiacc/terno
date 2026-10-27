import { ATTACHMENT_ACCOUNT_BYTES, ATTACHMENT_CHUNK, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_COUNT, attachmentCid, attachmentFilename, attachmentMessageBudget, attachmentMime, base64Bytes, type AttachmentRef } from "@terno/core";
import { RpcError } from "@terno/core/rpc";
import { L } from "@terno/i18n";

export interface AssetRow {
  id: string; account_id: number; filename: string; mime: string; size: number; content_id: string | null;
  received: number; chunks: number; complete: number; created_at: number;
  /** IDB persists grace here; SQL keeps it in attachment_orphans. Missing legacy values start fresh grace. */
  orphan_grace_started_at?: number | null;
}
export interface AssetDb {
  account(id: number): boolean;
  get(id: string): AssetRow | undefined;
  insert(row: AssetRow): void;
  update(row: AssetRow): void;
  remove(id: string): void;
  used(accountId: number): number;
  beginOrphanGrace(accountId: number, now: number): void;
  orphans(accountId: number, before: number): string[];
  pinned(id: string): boolean;
  chunk(id: string): string | undefined;
  putChunk(id: string, assetId: string, index: number, size: number, data: string): void;
  link(assetId: string, kind: "draft" | "message" | "op", owner: number | string): void;
  unlink(kind: "draft" | "message" | "op", owner: number | string): void;
}
export const assetRef = (r: AssetRow): AttachmentRef => ({ assetId: r.id, filename: r.filename, mime: r.mime, size: r.size, contentId: r.content_id });
export class AttachmentLimitError extends RpcError {
  constructor() { super("BAD_REQUEST", L("attachments.tooLarge")); }
}
export const assetError = () => new RpcError("BAD_REQUEST", L("attachments.unavailable"));

export function assetRow(db: AssetDb, accountId: number, id: string, complete = true): AssetRow {
  const row = db.get(id);
  if (!row || row.account_id !== accountId || (complete && !row.complete)) throw assetError();
  return row;
}

export interface AssetInput { accountId: number; filename: string; mime: string; size: number; contentId?: string | null; now: number }

export function validateAssetCreation(db: AssetDb, p: AssetInput): void {
  if (!db.account(p.accountId)) throw assetError();
  if (!Number.isSafeInteger(p.size) || p.size < 0 || p.size > MAX_ATTACHMENT_BYTES) throw new AttachmentLimitError();
}

/** A committed maintenance unit; reservation failure cannot undo safe cleanup progress. */
export function cleanupAssets(db: AssetDb, accountId: number, now: number): boolean {
  const ids = db.orphans(accountId, now - 86400000);
  for (const id of ids) if (!db.pinned(id)) db.remove(id);
  return ids.length > 0;
}

export function createAsset(db: AssetDb, uuid: () => string, p: AssetInput): AttachmentRef {
  validateAssetCreation(db, p);
  if (db.used(p.accountId) + p.size + 1024 > ATTACHMENT_ACCOUNT_BYTES) throw new AttachmentLimitError();
  const row: AssetRow = { id: uuid(), account_id: p.accountId, filename: attachmentFilename(p.filename), mime: attachmentMime(p.mime), size: p.size, content_id: attachmentCid(p.contentId), received: 0, chunks: 0, complete: 0, created_at: p.now, orphan_grace_started_at: p.now };
  db.insert(row);
  return assetRef(row);
}

export function appendAsset(db: AssetDb, accountId: number, id: string, index: number, data: string): void {
  const row = assetRow(db, accountId, id, false);
  if (row.complete || !Number.isSafeInteger(index) || index < 0) throw assetError();
  const size = base64Bytes(data).length;
  const key = `${id}:${index}`;
  if (index < row.chunks) { if (db.chunk(key) === data) return; throw assetError(); }
  if (index !== row.chunks || size === 0 || size !== Math.min(ATTACHMENT_CHUNK, row.size - row.received)) throw assetError();
  db.putChunk(key, id, index, size, data);
  db.update({ ...row, received: row.received + size, chunks: row.chunks + 1 });
}

export function sealAsset(db: AssetDb, accountId: number, id: string): void {
  const row = assetRow(db, accountId, id, false);
  if (row.received !== row.size || row.chunks !== Math.ceil(row.size / ATTACHMENT_CHUNK)) throw assetError();
  if (!row.complete) db.update({ ...row, complete: 1 });
}

export function validateAssets(db: AssetDb, accountId: number, refs: readonly AttachmentRef[]): AttachmentRef[] {
  if (refs.length > MAX_ATTACHMENT_COUNT) throw assetError();
  const seen = new Set<string>();
  const result = refs.map((ref) => {
    const canonical = assetRef(assetRow(db, accountId, ref.assetId));
    if (seen.has(ref.assetId) || ref.size !== canonical.size || ref.filename !== canonical.filename || ref.mime !== canonical.mime || (ref.contentId ?? null) !== canonical.contentId) throw assetError();
    seen.add(ref.assetId);
    return canonical;
  });
  if (!attachmentMessageBudget("", undefined, result)) throw new RpcError("BAD_REQUEST", L("attachments.tooLarge"));
  return result;
}

export function linkAssets(db: AssetDb, kind: "draft" | "message" | "op", owner: number | string, refs: readonly AttachmentRef[]): void {
  if (kind !== "op") db.unlink(kind, owner as number);
  for (const ref of refs) db.link(ref.assetId, kind, owner);
}
