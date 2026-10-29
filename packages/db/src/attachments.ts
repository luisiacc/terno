import type { AssetDb, AssetRow } from "@terno/store";
import type { Db } from "./sqlite";

export function sqlAssets(db: Db): AssetDb {
  return {
    account: (id) => !!db.get("SELECT 1 FROM accounts WHERE id = ?", id),
    get: (id) => db.get<AssetRow>("SELECT * FROM attachment_assets WHERE id = ?", id),
    insert: (r) => { db.run("INSERT INTO attachment_assets (id, account_id, filename, mime, size, content_id, received, chunks, complete, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)", r.id, r.account_id, r.filename, r.mime, r.size, r.content_id, r.received, r.chunks, r.complete, r.created_at); },
    update: (r) => { db.run("UPDATE attachment_assets SET received = ?, chunks = ?, complete = ? WHERE id = ?", r.received, r.chunks, r.complete, r.id); },
    remove: (id) => { db.run("DELETE FROM attachment_assets WHERE id = ?", id); },
    removeChunks: (id, limit) => {
      const rows = db.all<{ id: string }>("SELECT id FROM attachment_chunks WHERE asset_id = ? ORDER BY position LIMIT ?", id, limit);
      for (const row of rows) db.run("DELETE FROM attachment_chunks WHERE id = ?", row.id);
      return !!db.get("SELECT 1 FROM attachment_chunks WHERE asset_id = ? LIMIT 1", id);
    },
    used: (id) => (db.get<{ bytes: number }>("SELECT bytes FROM attachment_usage WHERE account_id = ?", id)?.bytes ?? 0) + (db.get<{ bytes: number }>("SELECT coalesce(sum(reserved),0) AS bytes FROM send_copies WHERE accountId=?", id)?.bytes ?? 0),
    beginOrphanGrace: (id, now) => { db.run("UPDATE attachment_orphans SET grace_started_at = ? WHERE asset_id IN (SELECT asset_id FROM attachment_orphans WHERE account_id = ? AND grace_started_at IS NULL ORDER BY asset_id LIMIT 50)", now, id); },
    orphans: (id, before) => db.all<{ id: string }>("SELECT asset_id AS id FROM attachment_orphans WHERE account_id = ? AND grace_started_at < ? ORDER BY grace_started_at, asset_id LIMIT 50", id, before).map((a) => a.id),
    // an orphan row exists only while nothing pins the asset (the unpin trigger): the pinned ones are left alone
    expireGrace: (ids) => {
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        db.run(`UPDATE attachment_orphans SET grace_started_at = 0 WHERE asset_id IN (${chunk.map(() => "?").join(",")})`, ...chunk);
      }
    },
    pinned: (id) => !!db.get("SELECT 1 FROM attachment_links WHERE asset_id = ? LIMIT 1", id),
    chunk: (id) => db.get<{ data_base64: string }>("SELECT data_base64 FROM attachment_bytes WHERE chunk_id = ?", id)?.data_base64,
    putChunk: (id, assetId, index, size, data) => {
      db.run("INSERT INTO attachment_chunks (id,asset_id,position,size) VALUES (?,?,?,?)", id, assetId, index, size);
      db.run("INSERT INTO attachment_bytes (chunk_id,data_base64) VALUES (?,?)", id, data);
    },
    link: (assetId, kind, owner) => { db.run(`INSERT OR IGNORE INTO attachment_links (id,asset_id,${kind}_id) VALUES (?,?,?)`, `${assetId}:${kind}:${owner}`, assetId, owner); },
    unlink: (kind, owner) => { db.run(`DELETE FROM attachment_links WHERE ${kind}_id = ?`, owner); },
  };
}

export function replaceAttachments(db: Db, messageId: number, parts: import("@terno/store").IncomingAttachment[]): void {
  const owner = db.get<{ account_id: number }>("SELECT account_id FROM messages WHERE id = ?", messageId);
  if (!owner) return;
  const assets = sqlAssets(db);
  const refs = parts.filter((p): p is typeof p & { assetId: string } => !!p.assetId);
  validateAssets(assets, owner.account_id, refs);
  db.run("DELETE FROM attachments WHERE message_id = ?", messageId);
  for (const a of parts) db.run("INSERT INTO attachments (message_id,filename,mime,size,content_id,provider_ref,asset_id) VALUES (?,?,?,?,?,?,?)", messageId, attachmentFilename(a.filename), attachmentMime(a.mime), a.size, a.contentId ?? null, a.providerRef ?? null, a.assetId ?? null);
  linkAssets(assets, "message", messageId, refs);
  db.run("UPDATE messages SET attachments_captured = ?, has_attachments = ? WHERE id = ?", parts.every((p) => p.assetId) ? 1 : 2, Number(parts.length > 0), messageId);
}
import { attachmentFilename, attachmentMime } from "@terno/core";
import { linkAssets, validateAssets } from "@terno/store";
