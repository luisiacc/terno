import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { expect, it } from "vitest";
import { nodePlatform } from "../../db/src/node-driver";
import { msg, withAccounts } from "../../store/src/conformance/fixtures";
import { IdbMailStore } from "./store";
import { databaseName, request } from "./schema";
import { upgradeLegacyIdbBodies } from "./body-upgrade";

const text = "😀e\u0301\r\nlegacy exact boundary phrase ".repeat(9000), html = `<p>${text}</p>`;
const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
async function legacy() {
  const factory = new IDBFactory(), sourceName = crypto.randomUUID(), name = crypto.randomUUID();
  const source = await IdbMailStore.open({ name: sourceName, factory, platform: nodePlatform, instantSearch: false });
  let accountId: number, threadId: number;
  try {
    [accountId] = await withAccounts(source, 1) as [number];
    const result = await source.sync.ingest([msg({ accountId, providerMsgId: "legacy", bodyState: "partial", bodyText: "cached", isStarred: true, attachments: [{ filename: "old.bin", mime: "application/octet-stream", size: 3, bytes: new Uint8Array([0, 255, 128]) }] })], { now: 1, classifier: null, applyFilters: false });
    threadId = result.touched[0]!;
  } finally { await source.close(); }
  const from = await request(factory.open(databaseName(sourceName))), opening = factory.open(databaseName(name), 22);
  const names = [...from.objectStoreNames].filter((name) => !name.startsWith("body_"));
  opening.onupgradeneeded = () => { for (const name of names) { const old = from.transaction(name).objectStore(name), table = opening.result.createObjectStore(name); for (const key of old.indexNames) { const index = old.index(key); table.createIndex(key, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry }); } } };
  const target = await request(opening);
  try {
    for (const name of names) {
      const read = from.transaction(name), table = read.objectStore(name), [keys, rows] = await Promise.all([request(table.getAllKeys()), request(table.getAll())]);
      const write = target.transaction(name, "readwrite"), complete = done(write);
      rows.forEach((row, index) => write.objectStore(name).put(name === "message_bodies" ? { ...row, body_text: text, body_html: html } : row, keys[index]));
      await complete;
    }
  } finally { from.close(); target.close(); }
  return { factory, name, accountId: accountId!, threadId: threadId! };
}

for (const mode of ["cancel", "credential", "ack"] as const) it(`resumes exact native-IDB legacy publication after ${mode}`, async () => {
  const t = await legacy(), abort = new AbortController();
  let touched = false;
  const run = upgradeLegacyIdbBodies(t.factory, t.name, nodePlatform.yield, async (progress) => {
    if (touched || progress.phase !== (mode === "ack" ? "committed" : "prepared")) return;
    touched = true;
    if (mode === "cancel") abort.abort(new DOMException("Synthetic cancellation", "AbortError"));
    else if (mode === "ack") throw new Error("Synthetic lost host acknowledgement");
    else {
      const db = await request(t.factory.open(databaseName(t.name))), tx = db.transaction("accounts", "readwrite"), complete = done(tx), table = tx.objectStore("accounts");
      const get = table.get(t.accountId); get.onsuccess = () => table.put({ ...get.result, provider_config: '{"syntheticGeneration":2}' }, t.accountId);
      try { await complete; } finally { db.close(); }
    }
  }, () => abort.signal.throwIfAborted());
  await expect(run).rejects.toThrow(); expect(touched).toBe(true);
  const inspect = await request(t.factory.open(databaseName(t.name)));
  try {
    expect(await request(inspect.transaction("body_heads").objectStore("body_heads").count())).toBe(mode === "ack" ? 1 : 0);
    if (mode !== "ack") { const [body] = await request(inspect.transaction("message_bodies").objectStore("message_bodies").getAll()); expect(body.body_text === text).toBe(true); expect(body.body_html === html).toBe(true); }
  } finally { inspect.close(); }
  await upgradeLegacyIdbBodies(t.factory, t.name, nodePlatform.yield, async () => {}, () => {});
  const store = await IdbMailStore.open({ ...t, platform: nodePlatform, instantSearch: false });
  try {
    const message = (await store.threads.get(t.threadId))!.messages[0]!;
    expect(message.bodyText === text).toBe(true); expect(message.bodyHtml === html).toBe(true); expect(message.isStarred).toBe(true);
    expect(await store.attachments.read(t.accountId, message.attachments[0]!.assetId!, 0)).toBe("AP+A");
    expect((await store.threads.searchText({ query: '"exact boundary phrase"', limit: 10, now: 1 })).items.map((row) => row.id)).toEqual([t.threadId]);
  } finally { await store.close(); }
  const final = await request(t.factory.open(databaseName(t.name)));
  try { expect(await request(final.transaction("body_captures").objectStore("body_captures").count())).toBe(1); expect(await request(final.transaction("body_heads").objectStore("body_heads").count())).toBe(1); }
  finally { final.close(); }
});
