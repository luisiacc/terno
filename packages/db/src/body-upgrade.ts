import { BODY_PART_UNITS } from "@terno/store";
import { cleanupBodies, finishBodyStage, stageBody } from "./body-parts";
import { setMessageBody } from "./ingest";
import type { Db } from "./sqlite";

/** SQLite header hint: an interrupted/copied upgrade must enter the asynchronous owner again. */
export const BODY_UPGRADE_APPLICATION_ID = 1413631824;
export const BODY_READY_APPLICATION_ID = 1413631812;
export interface BodyUpgradeProgress { scanned: number; converted: number; partBytes: number; phase?: "prepared" | "committed" }
export class BodyUpgradeRequired extends Error { constructor() { super("This mailbox needs asynchronous body upgrade admission"); this.name = "BodyUpgradeRequired"; } }

export function bodyUpgradePending(db: Db): boolean {
  const row = db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key='body_parts_upgrade'");
  return !!row && (JSON.parse(row.value_json) as { pending?: boolean }).pending === true;
}

/** Dedicated connection owner only. Never call this with an interactive host connection. */
export async function upgradeLegacyBodies(db: Db, yieldTo: () => Promise<void>, progress: (value: BodyUpgradeProgress) => Promise<void>, check: () => void): Promise<BodyUpgradeProgress> {
  const state = db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key='body_parts_upgrade'");
  let after = state ? Number((JSON.parse(state.value_json) as { after?: number }).after ?? 0) : 0;
  const result = { scanned: 0, converted: 0, partBytes: BODY_PART_UNITS * 2 };
  if (!bodyUpgradePending(db)) { db.exec(`PRAGMA application_id=${BODY_READY_APPLICATION_ID}`); return result; }
  await cleanupBodies(db, yieldTo);
  for (;;) {
    check();
    const row = db.get<{ id: number; account_id: number; provider_msg_id: string | null; body_state: "none" | "partial" | "full"; body_text: string | null; body_html: string | null; body_revision: number; provider_config: string; secret_ref: string | null; created_at: number }>(
      `SELECT m.id,m.account_id,m.provider_msg_id,m.body_state,b.body_text,b.body_html,b.body_revision,a.provider_config,a.secret_ref,a.created_at
       FROM message_bodies b JOIN messages m ON m.id=b.message_id JOIN accounts a ON a.id=m.account_id
       WHERE b.message_id>? AND b.capture_id IS NULL ORDER BY b.message_id LIMIT 1`, after);
    if (!row) break;
    result.scanned++;
    if (Math.max(row.body_text?.length ?? 0, row.body_html?.length ?? 0) <= BODY_PART_UNITS) {
      after = row.id;
      if (result.scanned % 50 === 0) {
        db.tx(() => db.run("UPDATE settings SET value_json=? WHERE key='body_parts_upgrade'", JSON.stringify({ pending: true, after })));
        await progress({ ...result, phase: "committed" });
        await yieldTo();
      }
      continue;
    }
    const secrets = db.all<{ name: string; blob: Uint8Array }>("SELECT name,blob FROM secrets WHERE name=? OR name GLOB ? ORDER BY name", row.secret_ref, `account:${row.account_id}:*`);
    const locations = JSON.stringify(db.all("SELECT mailbox,uidvalidity,uid FROM message_locations WHERE message_id=? ORDER BY mailbox,uidvalidity,uid", row.id));
    const repairs = JSON.stringify(db.all("SELECT key,revision,state FROM capture_repairs WHERE message_id=? ORDER BY key", row.id));
    const unchanged = () => {
      check();
      const current = db.get<{ provider_msg_id: string | null; body_revision: number; provider_config: string; secret_ref: string | null; created_at: number; body_state: string }>("SELECT m.provider_msg_id,m.body_state,b.body_revision,a.provider_config,a.secret_ref,a.created_at FROM messages m JOIN message_bodies b ON b.message_id=m.id JOIN accounts a ON a.id=m.account_id WHERE m.id=? AND m.account_id=? AND b.capture_id IS NULL", row.id, row.account_id);
      if (!current || current.provider_msg_id !== row.provider_msg_id || current.body_state !== row.body_state || current.body_revision !== row.body_revision || current.provider_config !== row.provider_config || current.secret_ref !== row.secret_ref || current.created_at !== row.created_at) throw new Error("Legacy body ownership changed during preparation");
      const now = db.all<{ name: string; blob: Uint8Array }>("SELECT name,blob FROM secrets WHERE name=? OR name GLOB ? ORDER BY name", row.secret_ref, `account:${row.account_id}:*`);
      if (now.length !== secrets.length || now.some((value, i) => value.name !== secrets[i]!.name || value.blob.length !== secrets[i]!.blob.length || value.blob.some((byte, j) => byte !== secrets[i]!.blob[j]))) throw new Error("Legacy credential ownership changed during preparation");
      if (locations !== JSON.stringify(db.all("SELECT mailbox,uidvalidity,uid FROM message_locations WHERE message_id=? ORDER BY mailbox,uidvalidity,uid", row.id)) || repairs !== JSON.stringify(db.all("SELECT key,revision,state FROM capture_repairs WHERE message_id=? ORDER BY key", row.id))) throw new Error("Legacy source ownership changed during preparation");
    };
    const body = await stageBody(db, { accountId: row.account_id, bodyText: row.body_text, bodyHtml: row.body_html, snippet: "" }, yieldTo, check, true);
    try {
      if (body.bodyCapture) await progress({ ...result, phase: "prepared" });
      db.tx(() => {
        unchanged();
        if (body.bodyCapture) { setMessageBody(db, row.id, body.bodyText, body.bodyHtml, row.body_state === "full" ? "full" : "partial", body.bodyCapture); db.run("UPDATE messages SET body_state=? WHERE id=?", row.body_state, row.id); result.converted++; }
        db.run("UPDATE settings SET value_json=? WHERE key='body_parts_upgrade'", JSON.stringify({ pending: true, after: row.id }));
      });
    } finally { if (body.bodyCapture) await finishBodyStage(db, body.bodyCapture.id, yieldTo); }
    after = row.id;
    await progress({ ...result, phase: "committed" });
    await yieldTo();
  }
  check();
  db.tx(() => { db.run("UPDATE settings SET value_json=? WHERE key='body_parts_upgrade'", JSON.stringify({ pending: false, after })); db.exec(`PRAGMA application_id=${BODY_READY_APPLICATION_ID}`); });
  return result;
}
