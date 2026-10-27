export const UNCERTAINTY_KEY = "uncertainWrite";

export class UncertainWriteError extends Error {
  readonly code = "IDB_UNCERTAIN_WRITE";
  constructor(readonly reason: "dirty" | "unreadable" = "dirty", cause?: unknown) {
    super(reason === "dirty" ? "IndexedDB contains an incomplete-save marker" : "Could not verify the IndexedDB save marker", { cause });
    this.name = "UncertainWriteError";
  }
}

/** A failed inspection cannot authorize opening or deleting mailbox data. */
export function assertCertain(idb: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try { tx = idb.transaction("meta", "readonly"); }
    catch (error) { reject(new UncertainWriteError("unreadable", error)); return; }
    let checked = false, present = false, failed = false, failure: unknown;
    tx.addEventListener("error", (event) => {
      failed = true;
      failure = (event.target as IDBRequest | null)?.error ?? tx.error;
    }, true);
    tx.addEventListener("abort", () => reject(new UncertainWriteError("unreadable", failure ?? tx.error)));
    tx.addEventListener("complete", () => {
      if (failed || !checked) reject(new UncertainWriteError("unreadable", failure));
      else if (present) reject(new UncertainWriteError());
      else resolve();
    });
    try {
      const request = tx.objectStore("meta").getKey(UNCERTAINTY_KEY);
      request.addEventListener("success", () => { present = request.result !== undefined; checked = true; });
    } catch (error) {
      failed = true;
      failure = error;
      try { tx.abort(); } catch { /* Wait for the terminal event. */ }
    }
  });
}
