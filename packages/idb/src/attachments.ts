import { assetAccounting } from "./asset-accounting";
import type { AssetDb, AssetRow } from "@terno/store";
import type { MemDb, Row } from "./mem";

export function idbAssets(db: MemDb): AssetDb {
  const assets = db.table("attachment_assets");
  const links = db.table("attachment_links");
  return {
    account: (id) => !!db.table("accounts").get(id),
    get: (id) => assets.get(id) as unknown as AssetRow | undefined,
    insert: (r) => { assets.insert(r as unknown as Row); },
    update: (r) => { assets.update(assets.get(r.id)!, r as unknown as Row); },
    remove: (id) => { assets.delete(id); },
    used: (id) => assetAccounting(db).used(id),
    orphans: (id, before) => assetAccounting(db).aged(id, before),
    pinned: (id) => links.count("fk_asset_id", id) > 0,
    chunk: (id) => db.table("attachment_bytes").get(id)?.data_base64 as string | undefined,
    putChunk: (id, assetId, position, size, data) => {
      db.table("attachment_chunks").insert({ id, asset_id: assetId, position, size });
      db.table("attachment_bytes").insert({ chunk_id: id, data_base64: data });
    },
    link: (assetId, kind, owner) => { const id = `${assetId}:${kind}:${owner}`; if (!links.get(id)) links.insert({ id, asset_id: assetId, [`${kind}_id`]: owner }); },
    unlink: (kind, owner) => { for (const row of links.by(`fk_${kind}_id`, owner)) links.deleteRow(row); },
  };
}

export function replaceAttachments(db: MemDb, messageId: number, parts: import("@terno/store").IncomingAttachment[]): void {
  const message = db.table("messages").get(messageId);
  if (!message) return;
  const assets = idbAssets(db);
  const refs = parts.filter((p): p is typeof p & { assetId: string } => !!p.assetId);
  validateAssets(assets, Number(message.account_id), refs);
  const attachments = db.table("attachments");
  for (const a of attachments.by("fk_message_id", messageId)) attachments.deleteRow(a);
  for (const a of parts) attachments.insert({ id: undefined, message_id: messageId, filename: attachmentFilename(a.filename), mime: attachmentMime(a.mime), size: a.size, content_id: a.contentId ?? null, provider_ref: a.providerRef ?? null, asset_id: a.assetId ?? null });
  linkAssets(assets, "message", messageId, refs);
  db.table("messages").update(message, { attachments_captured: parts.every((p) => p.assetId) ? 1 : 2, attachment_pending: 0, has_attachments: Number(parts.length > 0) });
}
import { attachmentFilename, attachmentMime } from "@terno/core";
import { linkAssets, validateAssets } from "@terno/store";
