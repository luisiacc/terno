/**
 * The web's diagnostics in IndexedDB (terno-diag), shared by every tab of the
 * origin: entries (a ring of 2,000) and records (the newest 20, none older
 * than 30 days). Retention is decided inside the writing transaction from
 * what the database holds, never from one tab's cached view (that would let
 * a tab delete a record another tab just wrote).
 */
import { RECORD_MAX_AGE_MS, RECORDS_MAX, sanitizeRecord, type DiagEntry, type ErrorRecord } from "@terno/core/diag";

export const DB_NAME = "terno-diag";
export const ENTRIES_MAX = 2000;

export function openDiagDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("entries", { autoIncrement: true });
      req.result.createObjectStore("records", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("blocked"));
  });
}

const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => ((tx.oncomplete = () => resolve()), (tx.onerror = () => reject(tx.error)), (tx.onabort = () => reject(tx.error))));

/** Newest first; anything forged is skipped. */
export async function readRecords(db: IDBDatabase): Promise<ErrorRecord[]> {
  const tx = db.transaction("records", "readonly");
  const req = tx.objectStore("records").getAll();
  await done(tx);
  return (req.result as unknown[]).map((r) => sanitizeRecord(r)).filter((r): r is ErrorRecord => r !== null).sort((a, b) => b.ts - a.ts);
}

export async function readEntries(db: IDBDatabase): Promise<unknown[]> {
  const tx = db.transaction("entries", "readonly");
  const req = tx.objectStore("entries").getAll();
  await done(tx);
  return req.result as unknown[];
}

/** One transaction: the new entries and records, then what the database as a whole keeps. */
export async function writeBatch(db: IDBDatabase, entries: readonly DiagEntry[], records: readonly ErrorRecord[], now = Date.now()): Promise<void> {
  const tx = db.transaction(["entries", "records"], "readwrite");
  const es = tx.objectStore("entries");
  const rs = tx.objectStore("records");
  for (const e of entries) es.add(e);
  for (const r of records) rs.put(r);
  es.count().onsuccess = (ev) => {
    let extra = (ev.target as IDBRequest<number>).result - ENTRIES_MAX;
    if (extra <= 0) return;
    es.openCursor().onsuccess = (c) => {
      const cur = (c.target as IDBRequest<IDBCursorWithValue | null>).result;
      if (cur && extra-- > 0) {
        cur.delete();
        cur.continue();
      }
    };
  };
  // every tab's records, as they are now: the newest 20 within 30 days stay
  rs.getAll().onsuccess = (ev) => {
    const all = ((ev.target as IDBRequest<{ id: string; ts: number }[]>).result ?? []).slice().sort((a, b) => b.ts - a.ts);
    all.forEach((r, i) => {
      if (i >= RECORDS_MAX || now - r.ts > RECORD_MAX_AGE_MS) rs.delete(r.id);
    });
  };
  await done(tx);
}

/** What the database held and what this tab captured meanwhile, by id: newest first, the newest 20. */
export function mergeRecords(stored: readonly ErrorRecord[], captured: readonly ErrorRecord[]): ErrorRecord[] {
  const byId = new Map<string, ErrorRecord>();
  for (const r of [...stored, ...captured]) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => b.ts - a.ts).slice(0, RECORDS_MAX);
}
