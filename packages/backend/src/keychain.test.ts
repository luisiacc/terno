/**
 * Secrets sealed under Única's keychain item, opened by the host's legacy
 * reader and sealed again under Terno's. Two fake keychains stand in for
 * safeStorage under each app name: "u:" blobs open only with Única's, "t:"
 * blobs only with Terno's (the real thing is exercised by the packaged smoke).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import type { MailProvider, ProviderRegistry } from "@terno/mail";
import { afterEach, describe, expect, it } from "vitest";
import { Backend, type SecretCipher } from "./backend";
import { KEYCHAIN_STATE_KEY, plausibleSecret, readKeychainState, type LegacySecretReader } from "./keychain";

const NOW = Date.UTC(2026, 9, 24, 12);
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const enc = new TextEncoder();
const dec = new TextDecoder();
function keychain(tag: string): SecretCipher & { opens(blob: Uint8Array): boolean } {
  const opens = (blob: Uint8Array) => dec.decode(blob).startsWith(`${tag}:`);
  return {
    opens,
    async encrypt(plain) {
      return enc.encode(`${tag}:${[...plain].reverse().join("")}`);
    },
    async decrypt(blob) {
      if (!opens(blob)) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
      return Array.from(dec.decode(blob).slice(tag.length + 1)).reverse().join("");
    },
  };
}
const unica = keychain("u");
const terno = keychain("t");

/** What main's helper does: opens what Única's keychain can, null for the rest. */
const helper = (calls: Uint8Array[][] = []): LegacySecretReader => async (blobs) => {
  calls.push(blobs);
  return Promise.all(blobs.map((b) => unica.decrypt(b).catch(() => null)));
};

/** Every IMAP sync needs the account's password, as the real provider does. */
const registry: ProviderRegistry = {
  create: ({ getSecret }): MailProvider => ({
    async verify() {},
    async sync() {
      if (!(await getSecret("password"))) throw new Error("no password");
    },
    async execute() {},
    async close() {},
  }),
  async verifyImap() {},
  connectGmail: async () => Promise.reject(new Error("no gmail here")),
};

const imap = (email: string, password: string) => ({
  email,
  displayName: "Luis",
  imap: { host: "imap.example.com", port: 993, secure: true, user: email },
  smtp: { host: "smtp.example.com", port: 465, secure: true, user: email },
  password,
});

function open(dir: string, cipher: SecretCipher, legacySecrets?: LegacySecretReader) {
  const backend = new Backend({ dbPath: join(dir, "terno.db"), version: "t", cipher, providers: registry, now: () => NOW, autoSync: false, openExternal: async () => {}, legacySecrets });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "r", origin: "renderer" });
  return { backend, client: new RpcClient(c) };
}

/** A profile as Única left it: an IMAP account, an AI key and a Google client secret, all sealed under Única's keychain. */
async function unicaProfile() {
  const dir = mkdtempSync(join(tmpdir(), "terno-keychain-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const { backend, client } = open(dir, unica);
  const a = await client.call("accounts.addImap", imap("luis@example.com", "imap-pässwörd 1"));
  await client.call("settings.update", { localMode: false });
  await client.call("settings.update", { ai: { provider: "openai", model: "gpt-x" } });
  await client.call("ai.setKey", { provider: "openai", value: "sk-legacy-0000-1234" });
  await client.call("settings.setSecret", { name: "gmailClientSecret", value: "GOCSPX-legacy" });
  const names = await backend.store.secrets.names();
  expect(names).toEqual(["account:1:password", "ai:openai:apiKey", "gmailClientSecret"]);
  for (const n of names) expect(unica.opens((await backend.store.secrets.get(n))!)).toBe(true);
  await backend.stop();
  return { dir, accountId: a.id, names };
}

async function startTerno(dir: string, reader?: LegacySecretReader, cipher: SecretCipher = terno) {
  const t = open(dir, cipher, reader);
  cleanups.push(async () => {
    if (t.backend.store.isOpen) await t.backend.stop();
  });
  await t.backend.start();
  return t;
}

describe("keychain migration (Única → Terno)", () => {
  it("seals every legacy secret again under the new keychain, once", async () => {
    const { dir, accountId, names } = await unicaProfile();
    const calls: Uint8Array[][] = [];
    const { backend, client } = await startTerno(dir, helper(calls));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(3);
    for (const n of names) expect(terno.opens((await backend.store.secrets.get(n))!)).toBe(true);
    expect(await readKeychainState(backend.store)).toEqual({ generation: "terno", pending: {} });
    expect(await backend.getSecret(`account:${accountId}:password`)).toBe("imap-pässwörd 1");
    expect(await backend.getSecret("ai:openai:apiKey")).toBe("sk-legacy-0000-1234");
    await backend.syncAccount(accountId);
    expect((await backend.store.accounts.list())[0]!.syncState).toMatchObject({ status: "idle", lastError: null });
    const settings = (await client.call("app.bootstrap", {})).settings;
    expect(settings).toMatchObject({ gmailClientSecretSet: true, gmailClientSecretUnreadable: false });
    await backend.stop();
    // the next start has nothing to do: the helper isn't launched again
    await startTerno(dir, helper(calls));
    expect(calls).toHaveLength(1);
  });

  it("a fresh install records an empty state and never launches the helper", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terno-keychain-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const calls: Uint8Array[][] = [];
    const { backend } = await startTerno(dir, helper(calls));
    expect(calls).toEqual([]);
    expect(await backend.store.settings.get(KEYCHAIN_STATE_KEY, null)).toEqual({ generation: "terno", pending: {} });
  });

  it("without the old keychain nothing is dropped: Settings asks for each secret again, per account and per key", async () => {
    const { dir, accountId, names } = await unicaProfile();
    const { backend, client } = await startTerno(dir, async () => {
      throw new Error("the keychain refused access");
    });
    // the legacy blobs are untouched and pending
    for (const n of names) expect(unica.opens((await backend.store.secrets.get(n))!)).toBe(true);
    expect(Object.keys((await readKeychainState(backend.store))!.pending).sort()).toEqual(names);
    // the account: its sync fails with what to do, and nothing crashes
    await backend.syncAccount(accountId);
    const account = (await backend.store.accounts.list())[0]!;
    expect(account.syncState.status).toBe("error");
    expect(account.syncState.lastError).toMatch(/no pudo abrir lo que guardó Única: la contraseña de esta cuenta\. Vuelve a introducirla en Ajustes → Cuentas/);
    // the AI key and the client secret
    let settings = (await client.call("app.bootstrap", {})).settings;
    expect(settings.ai).toMatchObject({ provider: "openai", hasKey: true, keyUnreadable: true });
    expect(settings).toMatchObject({ gmailClientSecretSet: true, gmailClientSecretUnreadable: true });
    await expect(backend.aiService.config({ provider: "openai", model: "gpt-x" })).rejects.toMatchObject({ kind: "not_configured", message: expect.stringMatching(/tu API key\. Vuelve a guardarla en Ajustes → IA/) });

    // entering them again clears each one, whichever way it is saved
    await client.call("accounts.reconnect", { id: accountId, password: "nueva" });
    await client.call("ai.setKey", { provider: "openai", value: "sk-new-0000-5678" });
    settings = (await client.call("app.bootstrap", {})).settings;
    expect(settings.ai).toMatchObject({ hasKey: true, keyUnreadable: false });
    expect(settings.gmailClientSecretUnreadable).toBe(true);
    expect(await backend.getSecret(`account:${accountId}:password`)).toBe("nueva");
    await backend.syncAccount(accountId);
    expect((await backend.store.accounts.list())[0]!.syncState).toMatchObject({ status: "idle", lastError: null });
    await backend.stop();

    // the next start retries only what is still pending (the client secret), and the helper can open it now
    const calls: Uint8Array[][] = [];
    const again = await startTerno(dir, helper(calls));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1);
    expect(await again.backend.getSecret("gmailClientSecret")).toBe("GOCSPX-legacy");
    expect(await again.backend.getSecret(`account:${accountId}:password`)).toBe("nueva");
    expect(await readKeychainState(again.backend.store)).toEqual({ generation: "terno", pending: {} });
  });

  it("replaces nothing whose new blob doesn't open to the same text", async () => {
    const { dir, names } = await unicaProfile();
    const broken: SecretCipher = { encrypt: terno.encrypt, decrypt: async (b) => `${await terno.decrypt(b)}!` };
    const { backend } = await startTerno(dir, helper(), broken);
    for (const n of names) expect(unica.opens((await backend.store.secrets.get(n))!)).toBe(true);
    expect(Object.keys((await readKeychainState(backend.store))!.pending)).toHaveLength(3);
  });

  it("rejects what a wrong key can produce (garbage that passed the padding check) and keeps the rest", async () => {
    const { dir, accountId } = await unicaProfile();
    const reader: LegacySecretReader = async (blobs) => {
      const plains = await helper()(blobs);
      return plains.map((p, i) => (i === 1 ? "\u0003�\u0010garbage" : p));
    };
    const { backend, client } = await startTerno(dir, reader);
    expect(await backend.getSecret(`account:${accountId}:password`)).toBe("imap-pässwörd 1");
    expect((await client.call("app.bootstrap", {})).settings.ai.keyUnreadable).toBe(true);
    expect(plausibleSecret("sk-ant-api03-abc_DEF-123")).toBe(true);
    expect(plausibleSecret("contraseña con espacios y ñ")).toBe(true);
    expect(plausibleSecret("")).toBe(false);
  });

  it("a host without a legacy reader (web, tests) leaves the state alone", async () => {
    const { dir } = await unicaProfile();
    const { backend } = await startTerno(dir, undefined, unica);
    expect(await readKeychainState(backend.store)).toBeNull();
    expect(await backend.getSecret("ai:openai:apiKey")).toBe("sk-legacy-0000-1234");
  });
});
