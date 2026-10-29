import type { SendCopyDb, SendCopyRow } from "@terno/store";
import type { Db } from "./sqlite";

const columns = ["opId", "accountId", "submission", "copy", "createdAt", "reserved", "size", "chunks", "ready", "mailbox", "uidValidity", "uid", "warning", "retiring"] as const;
const row = (r: SendCopyRow): SendCopyRow => ({ ...r, ready: !!r.ready, retiring: !!r.retiring });
export function sqlSendCopies(db: Db): SendCopyDb {
  return {
    get: (id) => { const r = db.get<SendCopyRow>("SELECT * FROM send_copies WHERE opId=?", id); return r ? row(r) : null; },
    all: () => db.all<SendCopyRow>("SELECT * FROM send_copies").map(row),
    put: (r) => { db.run(`INSERT INTO send_copies (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")}) ON CONFLICT(opId) DO UPDATE SET ${columns.slice(1).map((c) => `${c}=excluded.${c}`).join(",")}`, ...columns.map((c) => typeof r[c] === "boolean" ? Number(r[c]) : r[c])); },
    remove: (id) => { db.run("DELETE FROM send_copies WHERE opId=?", id); },
    chunk: (id, index) => db.get<{ data: string }>("SELECT data FROM send_copy_bytes WHERE opId=? AND position=?", id, index)?.data ?? null,
    putChunk: (id, index, data) => { db.run("INSERT INTO send_copy_bytes(opId,position,data) VALUES (?,?,?)", id, index, data); },
    removeChunks: (id, limit) => {
      const rows = db.all<{ position: number }>("SELECT position FROM send_copy_bytes WHERE opId=? ORDER BY position LIMIT ?", id, limit);
      for (const r of rows) db.run("DELETE FROM send_copy_bytes WHERE opId=? AND position=?", id, r.position);
      return rows.length;
    },
    accountBytes: (id) => (db.get<{ bytes: number }>("SELECT bytes FROM attachment_usage WHERE account_id=?", id)?.bytes ?? 0) + (db.get<{ bytes: number }>("SELECT coalesce(sum(reserved),0) AS bytes FROM send_copies WHERE accountId=?", id)?.bytes ?? 0),
  };
}
