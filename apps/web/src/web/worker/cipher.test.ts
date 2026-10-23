import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { webCipher } from "./cipher";

it("seals secrets with AES-GCM under one non-extractable key kept as a CryptoKey in IndexedDB", async () => {
  const a = await webCipher();
  const sealed = await a.encrypt("refresh-or-api-key ñ");
  expect(new TextDecoder().decode(sealed)).not.toContain("refresh-or-api-key");
  expect(sealed[0]).toBe(1);
  // a fresh IV per value
  expect(await a.encrypt("same")).not.toEqual(await a.encrypt("same"));
  // a second context (another worker start) finds the same key
  const b = await webCipher();
  expect(await b.decrypt(sealed)).toBe("refresh-or-api-key ñ");
  // the key can't leave the browser as bytes
  const key = await new Promise<CryptoKey>((resolve, reject) => {
    const open = indexedDB.open("unica-keys", 1);
    open.onsuccess = () => {
      const r = open.result.transaction("keys").objectStore("keys").get("secrets-v1");
      r.onsuccess = () => resolve(r.result as CryptoKey);
      r.onerror = () => reject(r.error);
    };
  });
  expect(key.extractable).toBe(false);
  await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
  // tampering is detected
  const tampered = sealed.slice();
  tampered[tampered.length - 1]! ^= 1;
  await expect(b.decrypt(tampered)).rejects.toThrow();
});
