import type { BackendToMain, MainToBackend } from "./ipc";

/** What main uses of Electron's safeStorage (its async API: the sync one is deprecated). */
export interface SafeStorageLike {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plain: string): Promise<Buffer>;
  decryptStringAsync(blob: Buffer): Promise<{ result: string }>;
}

type SecretRequest = Extract<BackendToMain, { type: "secret" }>;
type LegacyRequest = Extract<BackendToMain, { type: "legacy-secrets" }>;
type SecretResult = Extract<MainToBackend, { type: "secret-result" }>;

/**
 * Plan 293 (CASA 4.1.4): main's answer to the backend's seal or open. Whatever failed (no keychain, a refused item, a
 * blob that doesn't decrypt: bad padding, wrong key, truncated), the answer is `{ ok: false }` with no text, and the
 * log line holds the operation only. The backend turns that into its one generic error.
 */
export async function secretReply(msg: SecretRequest, safeStorage: SafeStorageLike, failed: (op: SecretRequest["op"]) => void): Promise<SecretResult> {
  try {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error("unavailable");
    const value = msg.op === "encrypt" ? [...(await safeStorage.encryptStringAsync(msg.plain))] : (await safeStorage.decryptStringAsync(Buffer.from(msg.blob))).result;
    return { type: "secret-result", id: msg.id, ok: true, value };
  } catch {
    failed(msg.op);
    return { type: "secret-result", id: msg.id, ok: false };
  }
}

/** The same for Única's blobs, opened by the keychain helper: one plaintext or null each, or `{ ok: false }`. */
export async function legacyReply(msg: LegacyRequest, read: (blobs: Uint8Array[]) => Promise<(string | null)[]>, failed: () => void): Promise<SecretResult> {
  try {
    return { type: "secret-result", id: msg.id, ok: true, value: await read(msg.blobs.map((b) => Uint8Array.from(b))) };
  } catch {
    failed();
    return { type: "secret-result", id: msg.id, ok: false };
  }
}
