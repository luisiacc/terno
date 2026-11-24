import { blockCapture, captureKey, captureRepair, describeCapture, retryCapture, type CaptureRepairs, type CaptureRepairRow, type CaptureRepairStorage } from "@terno/store";
import type { Db } from "./sqlite";
export function sqlCaptureStorage(db: Db): CaptureRepairStorage {
  return {
    get: (a, key) => db.get<CaptureRepairRow>("SELECT * FROM capture_repairs WHERE account_id=? AND key=?", a, key),
    usage: (a) => db.get<{ count: number; bytes: number }>("SELECT count,bytes FROM capture_repair_usage WHERE account_id=?", a) ?? { count: 0, bytes: 0 },
    envelope: (a,id) => { const m = db.get<{ subject: string; from_name: string | null; from_email: string | null; date: number }>("SELECT subject, from_name, from_email, date FROM messages WHERE id=? AND account_id=?", id, a); return m ? { subject: m.subject, from: m.from_name || m.from_email || undefined, date: m.date } : undefined; },
    messageId: (a,l) => l.kind === "imap" ? l.messageId : db.get<{id:number}>("SELECT id FROM messages WHERE account_id=? AND provider_msg_id=?",a,l.providerId)?.id ?? null,
    valid: (a, l) => l.kind === "gmail" ? Boolean(db.get("SELECT id FROM accounts WHERE id=? AND kind='gmail'", a)) : Boolean(db.get("SELECT m.id FROM messages m JOIN message_locations l ON l.message_id=m.id WHERE m.id=? AND m.account_id=? AND l.mailbox=? AND l.uidvalidity=? AND l.uid=? AND NOT EXISTS(SELECT 1 FROM imap_identity_holds h WHERE h.message_id=m.id)", l.messageId, a, l.mailbox, l.uidvalidity, l.uid)),
    put: (r) => { db.run("INSERT INTO capture_repairs(account_id,key,message_id,locator,reason,state,revision,bytes,detail) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,key) DO UPDATE SET reason=excluded.reason,state=excluded.state,revision=excluded.revision,bytes=excluded.bytes,detail=excluded.detail", r.account_id,r.key,r.message_id,r.locator,r.reason,r.state,r.revision,r.bytes,r.detail ?? null); },
    remove: (a,key) => { db.run("DELETE FROM capture_repairs WHERE account_id=? AND key=?",a,key); },
    page: (a,after,state) => state ? db.all<CaptureRepairRow>("SELECT * FROM capture_repairs WHERE account_id=? AND state=? AND key>? ORDER BY key LIMIT 50",a,state,after) : db.all<CaptureRepairRow>("SELECT * FROM capture_repairs WHERE account_id=? AND key>? ORDER BY key LIMIT 50",a,after),
  };
}
export function sqlCaptureRepairs(db: Db): CaptureRepairs {
  const storage = sqlCaptureStorage(db);
  return {
    forMessage: async (a,message) => { const row=db.get<CaptureRepairRow>("SELECT * FROM capture_repairs WHERE account_id=? AND message_id=? ORDER BY key LIMIT 1",a,message); return row ? captureRepair(row) : null; },
    get: async (a,l) => { const row=storage.get(a,captureKey(l)); return row ? captureRepair(row) : null; },
    list: async (a,after="",state) => { const rows=storage.page(a,after,state); return { items: rows.map(captureRepair), ...(rows.length === 50 && { next: rows.at(-1)!.key }) }; },
    block: async (a,l,r,v,check) => db.tx(() => { check?.(); blockCapture(storage,a,l,r,v); check?.(); }),
    describe: async (a,key,v,detail) => db.tx(() => describeCapture(storage,a,key,v,detail)),
    retry: async (a,key,v,check) => db.tx(() => { check?.(); retryCapture(storage,a,key,v); check?.(); }),
    retire: async (a,l,check) => db.tx(() => { check?.(); storage.remove(a,captureKey(l)); }),
  };
}
