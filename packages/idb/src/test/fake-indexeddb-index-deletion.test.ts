import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
const terminal = (tx: IDBTransaction) => new Promise<string>((resolve) => {
  tx.oncomplete = () => resolve('complete');
  tx.onabort = () => resolve('abort');
});
async function open(factory: IDBFactory, name: string, version = 1) {
  const r = factory.open(name, version);
  r.onupgradeneeded = () => {
    if (version === 1) {
      const s = r.result.createObjectStore('s');
      s.createIndex('key', 'key');
      s.createIndex('compound', ['key', 'other']);
      s.createIndex('multi', 'multi', { multiEntry: true });
      s.createIndex('unique', 'unique', { unique: true });
    } else {
      const s = r.transaction!.objectStore('s');
      s.deleteIndex('key');
      s.createIndex('key', 'key');
    }
  };
  return request(r);
}
async function write(db: IDBDatabase, fn: (s: IDBObjectStore) => void) {
  const tx = db.transaction('s', 'readwrite');
  const done = terminal(tx);
  fn(tx.objectStore('s'));
  expect(await done).toBe('complete');
}
async function keys(db: IDBDatabase, index: string, query?: IDBValidKey | IDBKeyRange) {
  const tx = db.transaction('s');
  const done = terminal(tx);
  const result = await request(tx.objectStore('s').index(index).getAllKeys(query));
  expect(await done).toBe('complete');
  return result;
}

const cjs = createRequire(import.meta.url)('fake-indexeddb') as { IDBFactory: typeof IDBFactory; IDBKeyRange: typeof IDBKeyRange };
for (const [entry, Factory, Range] of [
  ['ESM', IDBFactory, IDBKeyRange],
  ['CJS', cjs.IDBFactory, cjs.IDBKeyRange],
] as const) {
  it(`${entry}: removes old keys with structural comparison, ranges, clear and index recreation`, async () => {
    const factory = new Factory();
    const name = crypto.randomUUID();
    let db = await open(factory, name);
    const primary = [new Date(123), new Uint8Array([1, 2]).buffer];
    const oldKey = [new Date(456), new Uint8Array([0, 3, 4, 0]).subarray(1, 3)];
    try {
      await write(db, s => {
        s.put({ key: oldKey, other: 'a', multi: [new Date(7), new Date(7), ['x'], ['x'], null, false, new Uint8Array([9])], unique: 'owner' }, primary);
        s.put({ key: oldKey, other: 'a', multi: [new Date(7)], unique: 'other' }, 'neighbor');
        s.put({ key: false, multi: [null, false] }, 'invalid');
        s.put({}, 'missing');
      });
      expect(await keys(db, 'key', structuredClone(oldKey))).toEqual(['neighbor', primary]);
      expect(await keys(db, 'multi', new Date(7))).toEqual(['neighbor', primary]);
      expect(await keys(db, 'compound', [oldKey, 'a'])).toEqual(['neighbor', primary]);
      await write(db, s => s.put({ key: 'new', multi: ['new'], unique: 'owner' }, structuredClone(primary)));
      expect(await keys(db, 'key', oldKey)).toEqual(['neighbor']);
      expect(await keys(db, 'compound')).toEqual(['neighbor']);
      expect(await keys(db, 'multi', new Date(7))).toEqual(['neighbor']);
      expect(await keys(db, 'multi', ['x'])).toEqual([]);
      expect(await keys(db, 'multi', new Uint8Array([9]))).toEqual([]);
      await write(db, s => s.delete(structuredClone(primary)));
      expect(await keys(db, 'unique', 'owner')).toEqual([]);
      await write(db, s => {
        for (let i = 0; i < 100; i++) s.put({ key: i, multi: [i] }, i);
      });
      await write(db, s => s.delete(Range.bound(0, 90)));
      expect(await keys(db, 'key', Range.lowerBound(0))).toEqual([91, 92, 93, 94, 95, 96, 97, 98, 99, 'neighbor']);
      db.close();
      db = await open(factory, name, 2);
      expect(await keys(db, 'key', oldKey)).toEqual(['neighbor']);
      await write(db, s => s.clear());
      for (const index of ['key', 'multi', 'unique', 'compound']) expect(await keys(db, index)).toEqual([]);
      await write(db, s => s.put({ key: oldKey, unique: 'owner' }, primary));
      expect(await keys(db, 'key', oldKey)).toEqual([primary]);
    } finally { db.close(); }
  });

  it(`${entry}: overwrite and missing deletion do not scan duplicate index entries`, async () => {
    const db = await open(new Factory(), crypto.randomUUID());
    try {
      await write(db, s => { for (let i = 0; i < 2048; i++) s.put({ key: 'same' }, i); });
      const tx = db.transaction('s', 'readwrite');
      const done = terminal(tx);
      const s = tx.objectStore('s');
      const tree = (s.index('key') as unknown as { _rawIndex: { records: { records: { getRecords(...args: unknown[]): IterableIterator<unknown> } } } })._rawIndex.records.records;
      const original = tree.getRecords;
      let inspected = 0;
      const spy = vi.spyOn(tree, 'getRecords').mockImplementation(function* (...args) {
        for (const row of original.apply(tree, args)) { inspected++; yield row; }
      });
      try {
        s.put({ key: 'changed' }, 1000);
        s.delete('absent');
        expect(await done).toBe('complete');
      } finally { spy.mockRestore(); }
      expect(inspected).toBeLessThan(32);
      expect(await keys(db, 'key', 'same')).toEqual(Array.from({ length: 2048 }, (_, i) => i).filter(i => i !== 1000));
      expect(await keys(db, 'key', 'changed')).toEqual([1000]);
    } finally { db.close(); }
  });

  it(`${entry}: preserves unique owners after prevented errors and restores all indexes on abort`, async () => {
    const db = await open(new Factory(), crypto.randomUUID());
    try {
      await write(db, s => {
        s.put({ key: 'old', multi: ['a', 'b'], unique: 'a' }, 1);
        s.put({ key: 'neighbor', multi: ['c'], unique: 'b' }, 2);
      });
      const tx = db.transaction('s', 'readwrite');
      const done = terminal(tx);
      const s = tx.objectStore('s');
      const failed = s.put({ key: 'failed', multi: ['failed'], unique: 'b' }, 1);
      const error = new Promise<string>((resolve) => { failed.onerror = e => { e.preventDefault(); resolve(failed.error!.name); }; });
      const failedAdd = s.add({ key: 'failedAdd', unique: 'b' }, 3);
      failedAdd.onerror = e => e.preventDefault();
      const rows = request(s.getAll());
      expect(await error).toBe('ConstraintError');
      expect(await rows).toEqual([{ key: 'old', multi: ['a', 'b'], unique: 'a' }, { key: 'neighbor', multi: ['c'], unique: 'b' }]);
      expect(await done).toBe('complete');
      expect(await keys(db, 'unique', 'b')).toEqual([2]);
      expect(await keys(db, 'multi', 'failed')).toEqual([]);
      const abort = db.transaction('s', 'readwrite');
      const aborted = terminal(abort);
      const a = abort.objectStore('s');
      a.put({ key: 'changed', unique: 'a' }, 1);
      a.delete(Range.lowerBound(2));
      a.clear();
      a.put({ key: 'temporary', unique: 'temporary' }, 4).onsuccess = () => abort.abort();
      expect(await aborted).toBe('abort');
      expect(await keys(db, 'key')).toEqual([2, 1]);
      expect(await keys(db, 'multi')).toEqual([1, 1, 2]);
      expect(await keys(db, 'unique')).toEqual([1, 2]);
      const automatic = db.transaction('s', 'readwrite');
      const automaticDone = terminal(automatic);
      automatic.objectStore('s').put({ unique: 'b' }, 1);
      expect(await automaticDone).toBe('abort');
      expect(await keys(db, 'unique')).toEqual([1, 2]);
    } finally { db.close(); }
  });

  for (const direction of ['next', 'prev'] as const) {
  it(`${entry}: ${direction} cursors survive deletion, tombstone rebuild and reinsertion`, async () => {
    const db = await open(new Factory(), crypto.randomUUID());
    try {
      await write(db, s => { for (let i = 0; i < 100; i++) s.put({ key: i, multi: [i] }, i); });
      const tx = db.transaction('s', 'readwrite');
      const done = terminal(tx);
      const s = tx.objectStore('s');
      const seen: IDBValidKey[] = [];
      const cursor = s.index('key').openCursor(null, direction);
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) return;
        seen.push(c.primaryKey);
        if (seen.length === 1) {
          s.delete(Range.bound(0, 90));
          s.put({ key: 95.5, multi: [95.5] }, 95.5);
        }
        c.continue();
      };
      expect(await done).toBe('complete');
      expect(seen).toEqual(direction === 'next' ? [0, 91, 92, 93, 94, 95, 95.5, 96, 97, 98, 99] : [99, 98, 97, 96, 95.5, 95, 94, 93, 92, 91]);
      expect(await keys(db, 'multi')).toEqual([91, 92, 93, 94, 95, 95.5, 96, 97, 98, 99]);
    } finally { db.close(); }
  });
  }
}
