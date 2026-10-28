import { IdbMailStore, databaseName } from "@terno/idb";
import { UNCERTAINTY_KEY, UncertainWriteError } from "@terno/idb/uncertainty";
import { ingest, msg, withAccounts } from "@terno/store/conformance";
import { expect, it } from "./shim";
import { legacyStores } from "../../../../packages/idb/src/test/legacy-stores";
import { IDB_VERSION, openIdb } from "../../../../packages/idb/src/schema";

const request = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setTimeout(resolve, 0)) };

export function defineUncertaintyConformance() {
  for (const instantSearch of [false, true]) for (const refuseAbort of [false, true]) {
    it(`native IndexedDB ${instantSearch ? "instant" : "scan"}: ${refuseAbort ? "refuses completed partial writes" : "rolls back an aborted write"}`, async () => {
      const name = `uncertainty-${crypto.randomUUID()}`;
      const store = await IdbMailStore.open({ name, factory: indexedDB, instantSearch, platform });
      const transaction = IDBDatabase.prototype.transaction, put = IDBObjectStore.prototype.put;
      let raw: IDBDatabase | undefined, reopened: IdbMailStore | undefined;
      try {
        const [account] = await withAccounts(store, 1);
        const id = (await ingest(store, [msg({ accountId: account!, providerMsgId: "native-prefix", bodyText: "original native body" })])).inserted[0]!;
        if (store.instant) expect(await store.instant.settled()).toBe(true);
        const head = await store.feed.head();
        const originalBody = (await store.debug.snapshot()).messages[0]!.bodyText;
        let target: IDBTransaction | undefined, terminal: string | null = null, bodyEnqueued = false, faults = 0;
        const failure = new Error("synthetic native enqueue refusal");
        IDBDatabase.prototype.transaction = function (...args) {
          const tx = transaction.call(this, ...args), names = typeof args[0] === "string" ? [args[0]] : Array.from(args[0]);
          if (!target && args[1] === "readwrite" && names.includes("message_bodies")) {
            target = tx;
            tx.addEventListener("complete", () => { terminal = "complete"; });
            tx.addEventListener("abort", () => { terminal = "abort"; });
            if (refuseAbort) tx.abort = () => { throw new Error("deliberately refused native abort"); };
          }
          return tx;
        };
        IDBObjectStore.prototype.put = function (value, key) {
          if (this.transaction === target) {
            if (this.name === "message_bodies") bodyEnqueued = true;
            if (this.name === "threads") {
              faults++;
              if (refuseAbort) throw failure;
              return put.call(this, { ...value, uncloneable: () => {} }, key);
            }
          }
          return put.call(this, value, key);
        };
        const error = await store.sync.setBody(id, "native changed body", null, { now: 1, classifier: null }).then(() => null, (value: unknown) => value);
        IDBDatabase.prototype.transaction = transaction;
        IDBObjectStore.prototype.put = put;
        expect({ terminal, bodyEnqueued, faults, open: store.isOpen }).toEqual({ terminal: refuseAbort ? "complete" : "abort", bodyEnqueued: true, faults: 1, open: !refuseAbort });
        if (refuseAbort) expect(error).toBe(failure);
        else expect(error).toMatchObject({ name: "DataCloneError" });
        await store.close();
        raw = await request(indexedDB.open(databaseName(name)));
        const tx = raw.transaction(["message_bodies", "search_state", "meta"]);
        const ended = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
        const [body, state, marker] = await Promise.all([
          request(tx.objectStore("message_bodies").get(id)), request(tx.objectStore("search_state").get(1)), request(tx.objectStore("meta").getKey(UNCERTAINTY_KEY)),
        ]);
        await ended;
        expect(body.body_text).toBe(refuseAbort ? "native changed body" : originalBody);
        expect({ epoch: state.epoch, seq: state.seq }).toEqual(head);
        expect(marker).toBe(refuseAbort ? UNCERTAINTY_KEY : undefined);
        raw.close(); raw = undefined;
        if (refuseAbort) {
          await expect(IdbMailStore.open({ name, factory: indexedDB, instantSearch, platform })).rejects.toBeInstanceOf(UncertainWriteError);
        } else {
          reopened = await IdbMailStore.open({ name, factory: indexedDB, instantSearch, platform });
          expect((await reopened.debug.snapshot()).messages[0]!.bodyText).toBe(originalBody);
          await reopened.debug.verify();
        }
      } finally {
        IDBDatabase.prototype.transaction = transaction;
        IDBObjectStore.prototype.put = put;
        raw?.close(); await reopened?.close(); await store.close();
        await request(indexedDB.deleteDatabase(databaseName(name)));
      }
    });
  }
  for (const preventError of [false, true]) {
    it(`native versionchange: ${preventError ? "marks a prevented migration error" : "atomically aborts a migration error"}`, async () => {
      const name = `uncertainty-upgrade-${crypto.randomUUID()}`;
      const old = indexedDB.open(databaseName(name), 1);
      old.onupgradeneeded = () => {
        for (const store of legacyStores(1)) old.result.createObjectStore(store);
        old.result.createObjectStore("meta");
        const tx = old.transaction!;
        tx.objectStore("cat_batches").put({ id: 5, scope_json: JSON.stringify({ from: 1 }) }, 5);
        for (const id of [9, 10]) tx.objectStore("cat_move_rows").put({ batch_id: 5, thread_id: id }, [5, id]);
      };
      (await request(old)).close();
      const put = IDBObjectStore.prototype.put;
      let writes = 0, errors = 0, terminal: string | null = null, raw: IDBDatabase | undefined, exposed: IdbMailStore | undefined;
      IDBObjectStore.prototype.put = function (value, key) {
        if (this.transaction.mode !== "versionchange" || this.name !== "cat_move_rows") return put.call(this, value, key);
        writes++;
        if (writes === 1) {
          this.transaction.addEventListener("complete", () => { terminal = "complete"; });
          this.transaction.addEventListener("abort", () => { terminal = "abort"; });
        }
        if (writes !== 2) return put.call(this, value, key);
        const r = this.add(value, [5, 9, 1]);
        r.addEventListener("error", (event) => { errors++; if (preventError) event.preventDefault(); });
        return r;
      };
      try {
        const error = await IdbMailStore.open({ name, factory: indexedDB, instantSearch: true, platform }).then((store) => { exposed = store; return null; }, (failure: unknown) => failure);
        IDBObjectStore.prototype.put = put;
        expect({ writes, errors, terminal, exposed: exposed !== undefined }).toEqual({ writes: 2, errors: 1, terminal: preventError ? "complete" : "abort", exposed: false });
        raw = await request(indexedDB.open(databaseName(name)));
        const tx = raw.transaction(["cat_move_rows", "meta"]), rows = tx.objectStore("cat_move_rows");
        const [keys, marker] = await Promise.all([request(rows.getAllKeys()), request(tx.objectStore("meta").getKey(UNCERTAINTY_KEY))]);
        expect({ version: raw.version, keys, marker }).toEqual(preventError ? { version: IDB_VERSION, keys: [[5, 9, 1]], marker: UNCERTAINTY_KEY } : { version: 1, keys: [[5, 9], [5, 10]], marker: undefined });
        raw.close(); raw = undefined;
        if (preventError) {
          expect(error).toBeInstanceOf(UncertainWriteError);
          await expect(openIdb(indexedDB, name)).rejects.toMatchObject({ name: "UncertainWriteError", reason: "dirty" });
        } else {
          expect(error).toMatchObject({ name: "ConstraintError" });
          raw = await openIdb(indexedDB, name);
          expect(await request(raw.transaction("cat_move_rows").objectStore("cat_move_rows").getAllKeys())).toEqual([[5, 9, 1], [5, 10, 1]]);
        }
      } finally {
        IDBObjectStore.prototype.put = put;
        raw?.close(); await exposed?.close();
        await request(indexedDB.deleteDatabase(databaseName(name)));
      }
    });
  }
}
