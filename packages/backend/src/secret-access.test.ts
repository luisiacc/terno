/**
 * Plan 293 (CASA 4.1.4 and 6.7.1): one generic error for every cryptographic failure, and a local record of every
 * access to a stored secret. The cipher below fails the ways a real one does (Electron's safeStorage, OpenSSL, Web
 * Crypto), with texts that name padding, a MAC, a key, a plaintext and a stack: none of it may reach the renderer or a
 * log line.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { breadcrumbs, installDiag, setDiagSink, type DiagEntry, type ErrorRecord } from "@terno/core/diag";
import { createMemoryTransportPair, RpcClient, RpcError, toErrorPayload } from "@terno/core/rpc";
import { demoRegistry } from "@terno/mail";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher, type SecretCipher } from "./backend";
import { describeSecret, SECRET_STORAGE_FAILED, SecretAccess, SecretStorageError } from "./secret-access";

const LEAKS = [
  "error:1C800064:Provider routines::bad decrypt",
  "Error while decrypting the ciphertext provided to safeStorage.decryptString.",
  "OperationError: The operation failed for an operation-specific reason (GCM tag mismatch)",
  "-----BEGIN PRIVATE KEY----- MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
  "the plaintext was sk-live-0000-SECRET",
  "imap-pässwörd 1",
  "    at decrypt (/Applications/Terno.app/Contents/Resources/app.asar/dist/main.cjs:12:345)",
];
let n = 0;
/** A cipher whose every call fails, with the next hostile text in turn. */
const failing: SecretCipher = {
  encrypt: async () => {
    throw new Error(LEAKS[n++ % LEAKS.length]);
  },
  decrypt: async () => {
    const e = new TypeError(LEAKS[n++ % LEAKS.length]);
    e.stack = LEAKS.join("\n");
    throw e;
  },
};

let entries: DiagEntry[] = [];
let records: ErrorRecord[] = [];
beforeEach(() => {
  entries = [];
  records = [];
  installDiag({ proc: "backend", version: "t", build: "t", channel: "dev" });
  setDiagSink({ write: (e) => void entries.push(e), capture: (r) => void records.push(r) });
});
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** Nothing the cipher said, anywhere in what's given. */
function expectNoLeak(what: unknown): void {
  const text = JSON.stringify(what);
  for (const leak of LEAKS) expect(text).not.toContain(leak.slice(0, 24));
  expect(text).not.toMatch(/at decrypt|main\.cjs|bad decrypt|GCM|padding|PRIVATE KEY|sk-live/i);
}

const access = (cipher: SecretCipher, store = memoryStore()) => ({ store, secrets: new SecretAccess(cipher, store) });
function memoryStore() {
  const blobs = new Map<string, Uint8Array>();
  const same = (a: Uint8Array | undefined, b: Uint8Array) => !!a && a.length === b.length && a.every((v, i) => v === b[i]);
  return {
    blobs,
    secrets: {
      names: async () => [...blobs.keys()].sort(),
      get: async (name: string) => blobs.get(name) ?? null,
      has: async (name: string) => blobs.has(name),
      put: async (name: string, blob: Uint8Array) => void blobs.set(name, blob),
      replace: async (name: string, expected: Uint8Array, next: Uint8Array) => (same(blobs.get(name), expected) ? (blobs.set(name, next), true) : false),
      commit: async () => false,
      delete: async (name: string) => void blobs.delete(name),
      remove: async (name: string, expected: Uint8Array) => (same(blobs.get(name), expected) ? blobs.delete(name) : false),
    },
  };
}
const lines = (): Record<string, unknown>[] => entries.filter((e) => e.code === "secret.access").map((e) => ({ level: e.level, ...e.fields }));

describe("CASA 4.1.4: a cryptographic failure is one generic error, whatever its cause", () => {
  it("sealing and opening fail as SecretStorageError: a fixed message and category, no text, no cause, no stack kept", async () => {
    const { secrets } = access(failing);
    for (let i = 0; i < LEAKS.length; i++) {
      const sealed = await secrets.seal("account:3:password", "imap-pässwörd 1", "signIn").catch((e: unknown) => e);
      const opened = await secrets.open("account:3:refreshToken", Uint8Array.of(1, 2, 3), "refresh").catch((e: unknown) => e);
      for (const error of [sealed, opened]) {
        expect(error).toBeInstanceOf(SecretStorageError);
        expect((error as Error).message).toBe("Terno couldn’t use the system keychain to protect your sign-in. Make sure the keychain is unlocked, then try again.");
        expect((error as Error).cause).toBeUndefined();
        expectNoLeak({ message: (error as Error).message, payload: toErrorPayload(error) });
      }
    }
    // the payload the renderer gets: one code, one category, the catalog message, expected (no crash record)
    const payload = toErrorPayload(new SecretStorageError());
    expect(payload).toMatchObject({ code: "UNAVAILABLE", details: { category: SECRET_STORAGE_FAILED }, expected: true, i18n: { key: "errors.secret.storage" } });
    expect(records).toEqual([]);
    expectNoLeak(entries);
    // every failure is logged by its category only
    expect(lines().filter((l) => l.secretOutcome === "failed").every((l) => l.errorCategory === SECRET_STORAGE_FAILED && l.level === "warn")).toBe(true);
  });

  it("through the RPC the renderer uses: adding an IMAP account or saving an AI key with a refusing keychain says the one thing, and logs no text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terno-secret-"));
    const backend = new Backend({ dbPath: join(dir, "t.db"), version: "t", cipher: failing, providers: demoRegistry, autoSync: false });
    cleanups.push(async () => {
      await backend.stop();
      rmSync(dir, { recursive: true, force: true });
    });
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId: "r", origin: "renderer" });
    const client = new RpcClient(c);
    await backend.start();
    const imap = { email: "luis@example.com", displayName: "Luis", imap: { host: "imap.example.com", port: 993, secure: true, user: "luis@example.com" }, smtp: { host: "smtp.example.com", port: 465, secure: true, user: "luis@example.com" }, password: "imap-pässwörd 1", verify: false };
    const add = await client.call("accounts.addImap", imap).catch((e: unknown) => e);
    await client.call("settings.update", { localMode: false });
    const key = await client.call("ai.setKey", { provider: "openai", value: "sk-live-0000-SECRET" }).catch((e: unknown) => e);
    for (const error of [add, key]) {
      expect(error).toBeInstanceOf(RpcError);
      expect(error).toMatchObject({ code: "UNAVAILABLE", details: { category: SECRET_STORAGE_FAILED }, i18n: { key: "errors.secret.storage" } });
      expectNoLeak({ message: (error as RpcError).message, details: (error as RpcError).details });
    }
    expect(await backend.store.accounts.list()).toEqual([]);
    expect(records).toEqual([]);
    expectNoLeak(entries);
  });
});

describe("CASA 6.7.1: every access to a stored secret is recorded, locally", () => {
  it("writes, reads, deletes and failures: time, operation, kind, component, the account's internal id, the outcome; never a value", async () => {
    const { secrets, store } = access(plaintextCipher);
    await secrets.put("account:7:password", "hunter2", "signIn");
    expect(await secrets.open("account:7:password", store.blobs.get("account:7:password")!, "mailLogin")).toBe("hunter2");
    const blob = store.blobs.get("account:7:password")!;
    expect(await secrets.remove("account:7:password", Uint8Array.of(9), "refresh")).toBe(false);
    expect(await secrets.remove("account:7:password", blob, "refresh")).toBe(true);
    secrets.missing("account:7:password", "recheck");
    await secrets.put("ai:openai:apiKey", "sk-live-0000-SECRET", "settings");
    await secrets.delete("ai:openai:apiKey", "settings");
    await access(failing).secrets.open("account:7:refreshToken", Uint8Array.of(1), "refresh").catch(() => {});
    expect(lines()).toEqual([
      { level: "info", secretOp: "write", secretKind: "password", accountId: 7, component: "signIn", secretOutcome: "ok" },
      { level: "info", secretOp: "read", secretKind: "password", accountId: 7, component: "mailLogin", secretOutcome: "ok" },
      { level: "info", secretOp: "delete", secretKind: "password", accountId: 7, component: "refresh", secretOutcome: "refused" },
      { level: "info", secretOp: "delete", secretKind: "password", accountId: 7, component: "refresh", secretOutcome: "ok" },
      { level: "info", secretOp: "read", secretKind: "password", accountId: 7, component: "recheck", secretOutcome: "missing" },
      { level: "info", secretOp: "write", secretKind: "apiKey", component: "settings", secretOutcome: "ok" },
      { level: "info", secretOp: "delete", secretKind: "apiKey", component: "settings", secretOutcome: "ok" },
      { level: "warn", secretOp: "read", secretKind: "refreshToken", accountId: 7, component: "refresh", secretOutcome: "failed", errorCategory: SECRET_STORAGE_FAILED },
    ]);
    for (const e of entries) expect(typeof e.ts).toBe("number");
    expectNoLeak(entries);
    expect(JSON.stringify(entries)).not.toContain("hunter2");
  });

  it("never becomes a breadcrumb: not in an error record or a report, whatever the consent", async () => {
    const { secrets } = access(plaintextCipher);
    await secrets.put("account:1:refreshToken", "1//token", "signIn");
    expect(lines()).toHaveLength(1);
    expect(breadcrumbs().filter((c) => c.code.startsWith("secret."))).toEqual([]);
  });

  it("folds repeated reads of one secret by one component: the first at once, the rest counted when the minute ends", async () => {
    vi.useFakeTimers();
    const { secrets, store } = access(plaintextCipher);
    await secrets.put("ai:openai:apiKey", "sk", "settings");
    const blob = store.blobs.get("ai:openai:apiKey")!;
    for (let i = 0; i < 100; i++) await secrets.open("ai:openai:apiKey", blob, "ai");
    await secrets.open("ai:openai:apiKey", blob, "settings");
    expect(lines().filter((l) => l.secretOp === "read")).toEqual([
      { level: "info", secretOp: "read", secretKind: "apiKey", component: "ai", secretOutcome: "ok" },
      { level: "info", secretOp: "read", secretKind: "apiKey", component: "settings", secretOutcome: "ok" },
    ]);
    vi.advanceTimersByTime(60_000);
    expect(lines().filter((l) => l.secretOp === "read").slice(2)).toEqual([{ level: "info", secretOp: "read", secretKind: "apiKey", component: "ai", secretOutcome: "ok", count: 99 }]);
    // nothing pending, nothing scheduled: idle is idle
    expect(vi.getTimerCount()).toBe(0);
  });

  it("three failed opens of one secret within ten minutes are one more line to find", async () => {
    const { secrets } = access(failing);
    for (let i = 0; i < 3; i++) await secrets.open("account:2:password", Uint8Array.of(1), "mailLogin").catch(() => {});
    expect(entries.filter((e) => e.code === "secret.failures_repeated").map((e) => ({ level: e.level, ...e.fields }))).toEqual([{ level: "warn", secretKind: "password", accountId: 2, component: "mailLogin", count: 3 }]);
  });

  it("names a secret by kind and account only", () => {
    expect(describeSecret("account:12:refreshToken")).toEqual({ secretKind: "refreshToken", accountId: 12 });
    expect(describeSecret("account:new:password")).toEqual({ secretKind: "password" });
    expect(describeSecret("ai:compatible:groq:apiKey")).toEqual({ secretKind: "apiKey" });
    expect(describeSecret("gmailClientSecret")).toEqual({ secretKind: "clientSecret" });
  });

  it("an IMAP account's life in order: written at sign-in, read to sync, deleted with the account", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terno-secret-"));
    const backend = new Backend({ dbPath: join(dir, "t.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false });
    cleanups.push(async () => {
      await backend.stop();
      rmSync(dir, { recursive: true, force: true });
    });
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId: "r", origin: "renderer" });
    const client = new RpcClient(c);
    await backend.start();
    const account = await client.call("accounts.addImap", { email: "luis@example.com", displayName: "Luis", imap: { host: "imap.example.com", port: 993, secure: true, user: "luis@example.com" }, smtp: { host: "smtp.example.com", port: 465, secure: true, user: "luis@example.com" }, password: "imap-pässwörd 1", verify: false });
    expect(await backend.getSecret(`account:${account.id}:password`, "recheck")).toBe("imap-pässwörd 1");
    await client.call("accounts.remove", { id: account.id });
    expect(lines()).toEqual([
      { level: "info", secretOp: "write", secretKind: "password", accountId: account.id, component: "signIn", secretOutcome: "ok" },
      { level: "info", secretOp: "read", secretKind: "password", accountId: account.id, component: "recheck", secretOutcome: "ok" },
      { level: "info", secretOp: "delete", secretKind: "password", accountId: account.id, component: "removal", secretOutcome: "ok" },
    ]);
    expect(await backend.store.secrets.names()).toEqual([]);
    expect(JSON.stringify(entries)).not.toContain("luis@example.com");
    expect(JSON.stringify(entries)).not.toContain("pässwörd");
  });
});

it("the backend seals, opens, writes and deletes secrets only through the seam (a source scan)", () => {
  const dir = join(__dirname);
  const offenders: string[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file === "secret-access.ts") continue;
    const code = readFileSync(join(dir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    if (/cipher\.(encrypt|decrypt)\(|options\.cipher\.|store\.secrets\.(put|replace|delete|remove)\(/.test(code)) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});
