import type { SendCopyDb, SendCopyRow } from "@terno/store";
import { assetAccounting } from "./asset-accounting";
import type { MemDb, Row } from "./mem";

export function idbSendCopies(db: MemDb): SendCopyDb {
  const rows = db.table("send_copies"), bytes = db.table("send_copy_bytes");
  return {
    get: (id) => rows.get(id) as unknown as SendCopyRow ?? null,
    all: () => [...rows.all()] as unknown as SendCopyRow[],
    put: (row) => { const prior = rows.get(row.opId); if (prior) rows.update(prior, row as unknown as Row); else rows.insert(row as unknown as Row); },
    remove: (id) => { rows.delete(id); },
    chunk: (id, index) => bytes.get(`${id}:${index}`)?.data as string ?? null,
    putChunk: (id, index, data) => { bytes.insert({ id: `${id}:${index}`, opId: id, position: index, data }); },
    removeChunks: (id, limit) => {
      let n = 0;
      // Only one receipt's bounded chunk keys; no lazy byte values are hydrated for deletion.
      const header = rows.get(id);
      const next = Number(header?.deleteAfter ?? 0);
      for (let i = next; i < Number(header?.chunks ?? 0) && n < limit; i++, n++) bytes.delete(`${id}:${i}`);
      if (header) rows.update(header, { deleteAfter: next + n });
      return n;
    },
    accountBytes: (id) => assetAccounting(db).used(id) + rows.by("fk_accountId", id).reduce((n, r) => n + Number(r.reserved), 0),
  };
}
