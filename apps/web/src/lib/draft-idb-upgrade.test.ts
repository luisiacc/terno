import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { databaseName, openIdb } from "../../../../packages/idb/src/schema";

it("upgrades a minimal v8 drafts+meta row fixture to physical10 without rewriting work and refuses v8 reopen", async () => {
  const name = crypto.randomUUID(), fullName = databaseName(name);
  const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(fullName, 8);
    req.onupgradeneeded = () => { req.result.createObjectStore("drafts"); req.result.createObjectStore("meta"); };
    req.onerror = () => reject(req.error); req.onsuccess = () => resolve(req.result);
  });
  const value = { id: 1, generation: "legacy", account_id: 2, thread_id: null, mode: "reply", in_reply_to_message_id: 9, body_text: "exact text", body_html: "<b>exact</b>" };
  await new Promise<void>((resolve, reject) => { const tx = legacy.transaction("drafts", "readwrite"); tx.objectStore("drafts").put(value, 1); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
  legacy.close();
  const current = await openIdb(indexedDB, name);
  expect(current.version).toBe(10);
  const restored = await new Promise<unknown>((resolve, reject) => { const req = current.transaction("drafts").objectStore("drafts").get(1); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  expect(restored).toEqual(value);
  expect(restored).not.toHaveProperty("show_source_context");
  current.close();
  const error = await new Promise<DOMException | null>((resolve) => { const req = indexedDB.open(fullName, 8); req.onerror = () => resolve(req.error); req.onsuccess = () => { req.result.close(); resolve(null); }; });
  expect(error?.name).toBe("VersionError");
  await new Promise<void>((resolve, reject) => { const req = indexedDB.deleteDatabase(fullName); req.onsuccess = () => resolve(); req.onerror = () => reject(req.error); });
});
