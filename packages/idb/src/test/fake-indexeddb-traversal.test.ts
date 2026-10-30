import { createRequire } from "node:module";
import { expect, it } from "vitest";
import * as esm from "fake-indexeddb";

const cjs = createRequire(import.meta.url)("fake-indexeddb") as typeof esm;
for (const [entry, driver] of [["ESM", esm], ["CJS", cjs]] as const) {
  it(`${entry}: tree traversal preserves structural range bounds and every cursor direction`, async () => {
    const factory = new driver.IDBFactory();
    const r = factory.open(crypto.randomUUID());
    r.onupgradeneeded = () => r.result.createObjectStore("s").createIndex("key", "key");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const keys: IDBValidKey[] = [-1, 0, 7, new Date(0), new Date(7), "a", "z", new Uint8Array([1]).buffer,
      new Uint8Array([2]).buffer, [0], [0, new Date(7)], [1, ["a"]]];
    const rows = Array.from({ length: 192 }, (_, id) => ({ id, key: keys[id % keys.length]! }));
    const terminal = (tx: IDBTransaction) => new Promise<string>(resolve => {
      tx.oncomplete = () => resolve("complete"); tx.onabort = () => resolve("abort");
    });
    try {
      const write = db.transaction("s", "readwrite");
      const written = terminal(write);
      for (const row of rows) write.objectStore("s").put(row, row.id);
      expect(await written).toBe("complete");
      const ranges = [undefined, driver.IDBKeyRange.only(new Date(7)), driver.IDBKeyRange.bound(0, [0], true, true),
        driver.IDBKeyRange.bound(new Date(0), new Uint8Array([2]).buffer), driver.IDBKeyRange.lowerBound([0], true),
        driver.IDBKeyRange.upperBound("a", true)];
      for (const range of ranges) {
        for (const direction of ["next", "prev", "nextunique", "prevunique"] as const) {
          const sorted = rows.filter(row => !range || range.includes(row.key))
            .sort((a, b) => factory.cmp(a.key, b.key) || a.id - b.id);
          const unique = direction.endsWith("unique") ? sorted.filter((row, i) => !i || factory.cmp(row.key, sorted[i - 1]!.key) !== 0) : sorted;
          const expected = direction.startsWith("prev") ? [...unique].reverse() : unique;
          const tx = db.transaction("s");
          const done = terminal(tx);
          const cursor = tx.objectStore("s").index("key").openKeyCursor(range, direction);
          const actual: { key: IDBValidKey; id: IDBValidKey }[] = [];
          cursor.onsuccess = () => {
            const c = cursor.result;
            if (c) { actual.push({ key: c.key, id: c.primaryKey }); c.continue(); }
          };
          expect(await done).toBe("complete");
          expect(actual).toEqual(expected.map(row => ({ key: row.key, id: row.id })));
        }
      }
      for (const direction of ["next", "prev", "nextunique", "prevunique"] as const) {
        const tx = db.transaction("s");
        const done = terminal(tx);
        const cursor = tx.objectStore("s").index("key").openKeyCursor(driver.IDBKeyRange.bound(0, 7), direction);
        const seen: IDBValidKey[] = [];
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (c) { seen.push(c.key); c.continue(direction.startsWith("prev") ? -1 : new Date(0)); }
        };
        expect(await done).toBe("complete");
        expect(seen).toEqual([direction.startsWith("prev") ? 7 : 0]);
      }
      const tx = db.transaction("s", "readwrite");
      const done = terminal(tx);
      const s = tx.objectStore("s");
      const cursor = s.index("key").openKeyCursor(driver.IDBKeyRange.only(new Date(7)));
      const seen: IDBValidKey[] = [];
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) return;
        seen.push(c.primaryKey);
        if (seen.length === 1) c.continuePrimaryKey(new Date(7), 65);
        else if (seen.length === 2) c.advance(2);
        else c.continue();
      };
      expect(await done).toBe("complete");
      expect(seen).toEqual([4, 76, 100, 112, 124, 136, 148, 160, 172, 184]);
    } finally { db.close(); }
  });
}
