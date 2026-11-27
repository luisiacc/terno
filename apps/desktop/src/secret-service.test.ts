import { describe, expect, it } from "vitest";
import { legacyReply, secretReply, type SafeStorageLike } from "./secret-service";

// Plan 293 (CASA 4.1.4): main's answer to the backend carries no text when safeStorage fails, whatever it said.
const SAID = ["Error while decrypting the ciphertext provided to safeStorage.decryptString.", "Encryption is not available.", "error:1C800064:Provider routines::bad decrypt"];

const failing = (said: string): SafeStorageLike => ({
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async () => {
    throw new Error(said);
  },
  decryptStringAsync: async () => {
    throw new Error(said);
  },
});

describe("main's safeStorage replies (plan 293)", () => {
  it("a failure is { ok: false } and a log of the operation only, for every cause", async () => {
    for (const said of SAID) {
      const logged: string[] = [];
      const enc = await secretReply({ type: "secret", id: 1, op: "encrypt", plain: "hunter2" }, failing(said), (op) => logged.push(op));
      const dec = await secretReply({ type: "secret", id: 2, op: "decrypt", blob: [1, 2, 3] }, failing(said), (op) => logged.push(op));
      expect(enc).toEqual({ type: "secret-result", id: 1, ok: false });
      expect(dec).toEqual({ type: "secret-result", id: 2, ok: false });
      expect(logged).toEqual(["encrypt", "decrypt"]);
      expect(JSON.stringify([enc, dec])).not.toContain(said.slice(0, 16));
    }
  });

  it("no keychain at all is the same answer", async () => {
    const none: SafeStorageLike = { ...failing("x"), isAsyncEncryptionAvailable: async () => false };
    expect(await secretReply({ type: "secret", id: 3, op: "decrypt", blob: [1] }, none, () => {})).toEqual({ type: "secret-result", id: 3, ok: false });
  });

  it("a success carries the value", async () => {
    const ok: SafeStorageLike = { isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async (p) => Buffer.from(`s:${p}`), decryptStringAsync: async (b) => ({ result: b.toString().slice(2) }) };
    expect(await secretReply({ type: "secret", id: 4, op: "encrypt", plain: "x" }, ok, () => {})).toEqual({ type: "secret-result", id: 4, ok: true, value: [...Buffer.from("s:x")] });
    expect(await secretReply({ type: "secret", id: 5, op: "decrypt", blob: [...Buffer.from("s:y")] }, ok, () => {})).toEqual({ type: "secret-result", id: 5, ok: true, value: "y" });
  });

  it("the legacy helper's failure is { ok: false } too", async () => {
    let logged = 0;
    const reply = await legacyReply({ type: "legacy-secrets", id: 6, blobs: [[1]] }, async () => Promise.reject(new Error(SAID[0])), () => logged++);
    expect(reply).toEqual({ type: "secret-result", id: 6, ok: false });
    expect(logged).toBe(1);
  });
});
