import type { SecretCipher } from "@terno/backend/portable";

const DB = "terno-keys";
const STORE = "keys";
const KEY_ID = "secrets-v1";
const VERSION = 1;

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function keyStore(): Promise<IDBDatabase> {
  const open = indexedDB.open(DB, 1);
  open.onupgradeneeded = () => open.result.createObjectStore(STORE);
  return request(open);
}

/** The install's secret key: AES-GCM 256, created non-extractable and kept as a CryptoKey in IndexedDB (never as bytes). */
async function installKey(): Promise<CryptoKey> {
  const db = await keyStore();
  try {
    const existing = await request(db.transaction(STORE).objectStore(STORE).get(KEY_ID));
    if (existing instanceof CryptoKey) return existing;
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const tx = db.transaction(STORE, "readwrite");
    // add, not put: if another context created one meanwhile, keep theirs
    tx.objectStore(STORE).add(key, KEY_ID);
    try {
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      return key;
    } catch {
      return (await request(db.transaction(STORE).objectStore(STORE).get(KEY_ID))) as CryptoKey;
    }
  } finally {
    db.close();
  }
}

/**
 * Secrets at rest on the web (Gmail sessions, AI keys): AES-GCM with a
 * random 96-bit IV per value under a non-extractable key. It protects the
 * stored mailbox and its exports; it does not protect against script running
 * in this origin (CSP and the sandboxed mail frame do that).
 * Format: [version, iv(12), ciphertext+tag].
 */
export async function webCipher(): Promise<SecretCipher> {
  const key = await installKey();
  return {
    async encrypt(plain) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain)));
      const out = new Uint8Array(1 + iv.length + sealed.length);
      out[0] = VERSION;
      out.set(iv, 1);
      out.set(sealed, 1 + iv.length);
      return out;
    },
    async decrypt(blob) {
      if (blob[0] !== VERSION || blob.length < 1 + 12 + 16) throw new Error("Unknown secret format");
      const bytes = blob.slice();
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(1, 13) }, key, bytes.subarray(13));
      return new TextDecoder().decode(plain);
    },
  };
}
