import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { webCipher } from "./cipher";
import { copyIdbDatabase, fileName, idbExists, idbName, mailboxName, migrateLegacyIdb } from "./legacy-storage";

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** A database as Única's builds left it: out-of-line keys like the mailbox, plus an indexed in-line store. */
async function legacyDb(name: string, version: number, rows: number): Promise<void> {
  const open = indexedDB.open(name, version);
  open.onupgradeneeded = () => {
    open.result.createObjectStore("threads");
    open.result.createObjectStore("meta");
    open.result.createObjectStore("log", { keyPath: "id", autoIncrement: true }).createIndex("byKind", "kind", { unique: false });
  };
  const db = await request(open);
  const tx = db.transaction(["threads", "meta", "log"], "readwrite");
  for (let i = 0; i < rows; i++) tx.objectStore("threads").put({ id: i, subject: `Asunto ${i} ñ`, bytes: new Uint8Array([i % 256]) }, i);
  tx.objectStore("meta").put({ revision: 7 }, "state");
  tx.objectStore("log").put({ kind: "a" });
  tx.objectStore("log").put({ kind: "b" });
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** Única's key store, with a secret sealed under it the way webCipher seals ([1, iv, ciphertext]). */
async function legacyKeyStore(secret: string): Promise<Uint8Array> {
  const open = indexedDB.open("unica-keys", 1);
  open.onupgradeneeded = () => open.result.createObjectStore("keys");
  const db = await request(open);
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await request(db.transaction("keys", "readwrite").objectStore("keys").add(key, "secrets-v1"));
  db.close();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(secret)));
  return Uint8Array.from([1, ...iv, ...sealed]);
}

afterEach(async () => {
  for (const d of await indexedDB.databases()) await request(indexedDB.deleteDatabase(d.name!));
});

describe("web storage from when the app was called Única", () => {
  it("names: unica-* databases, the default mailbox and the caches beside it", () => {
    expect(mailboxName("unica")).toBe("terno");
    expect(mailboxName("demo-50k")).toBe("demo-50k");
    expect(idbName("unica-unica")).toBe("terno-terno");
    expect(idbName("unica-keys")).toBe("terno-keys");
    expect(idbName("unica-demo")).toBe("terno-demo");
    expect(idbName("something-else")).toBeNull();
    expect(fileName("unica.db.search")).toBe("terno.db.search");
    expect(fileName("unica.idb.search")).toBe("terno.idb.search");
    expect(fileName("unica.pagecache")).toBe("terno.pagecache");
    expect(fileName("demo.db.search")).toBe("demo.db.search");
  });

  it("copies a database whole: version, stores, indexes, keys and records", async () => {
    await legacyDb("unica-x", 3, 1200);
    expect(await copyIdbDatabase(indexedDB, "unica-x", "terno-x")).toEqual({ threads: 1200, meta: 1, log: 2 });
    const db = await request(indexedDB.open("terno-x"));
    expect(db.version).toBe(3);
    const tx = db.transaction(["threads", "meta", "log"]);
    expect(await request(tx.objectStore("threads").get(1199))).toEqual({ id: 1199, subject: "Asunto 1199 ñ", bytes: new Uint8Array([1199 % 256]) });
    expect(await request(tx.objectStore("meta").get("state"))).toEqual({ revision: 7 });
    expect(await request(tx.objectStore("log").index("byKind").get("b"))).toMatchObject({ kind: "b" });
    // the key generator continues after the copied keys
    const write = db.transaction("log", "readwrite");
    expect(await request(write.objectStore("log").add({ kind: "c" }))).toBe(3);
    db.close();
  });

  it("moves the key store first and every mailbox, then deletes the legacy databases; secrets still open", async () => {
    const sealed = await legacyKeyStore("refresh-token ñ");
    await legacyDb("unica-unica", 4, 50);
    await legacyDb("unica-demo", 4, 5);
    const report = await migrateLegacyIdb(indexedDB, "terno");
    expect(report[0]).toMatch(/^IndexedDB unica-keys → terno-keys/);
    expect(report).toHaveLength(3);
    expect((await indexedDB.databases()).map((d) => d.name).sort()).toEqual(["terno-demo", "terno-keys", "terno-terno"]);
    // the same non-extractable key, so what Única sealed opens now
    expect(await (await webCipher()).decrypt(sealed)).toBe("refresh-token ñ");
    // nothing left to do the next time
    expect(await migrateLegacyIdb(indexedDB, "terno")).toEqual([]);
  });

  it("leaves both alone when the Terno database already exists", async () => {
    await legacyDb("unica-unica", 4, 3);
    await legacyDb("terno-terno", 4, 9);
    const notes: string[] = [];
    expect(await migrateLegacyIdb(indexedDB, "terno", (m) => notes.push(m))).toEqual([]);
    expect(notes).toEqual(["IndexedDB unica-unica left alone: terno-terno exists"]);
    expect(await idbExists(indexedDB, "unica-unica")).toBe(true);
    const db = await request(indexedDB.open("terno-terno"));
    expect(await request(db.transaction("threads").objectStore("threads").count())).toBe(9);
    db.close();
  });

  it("knows whether a database exists without creating it, also without databases()", async () => {
    await legacyDb("unica-unica", 2, 1);
    const factory = Object.create(indexedDB, { databases: { value: undefined } }) as IDBFactory;
    factory.open = indexedDB.open.bind(indexedDB);
    expect(await idbExists(factory, "unica-unica")).toBe(true);
    expect(await idbExists(factory, "unica-nope")).toBe(false);
    expect((await indexedDB.databases()).map((d) => d.name)).toEqual(["unica-unica"]);
  });
});
