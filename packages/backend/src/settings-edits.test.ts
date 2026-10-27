import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient, type RpcError } from "@terno/core/rpc";
import { createAccount, sqlDb } from "@terno/db";
import type { IncomingMessage } from "@terno/store";
import type { GmailConnectResult, MailProvider, ProviderRegistry, SyncSink } from "@terno/mail";
import { afterEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const NOW = Date.UTC(2026, 9, 22, 12);
const DAY = 86_400_000;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function setup(o: { gmail?: (hint?: string) => Promise<GmailConnectResult> } = {}) {
  const windows: { accountId: number; windowStart: number }[] = [];
  const registry: ProviderRegistry = {
    create: ({ account }): MailProvider => ({
      async verify() {},
      async sync(sink: SyncSink) {
        windows.push({ accountId: account.id, windowStart: sink.windowStart });
      },
      async execute() {},
      async close() {},
    }),
    async verifyImap(config, password) {
      if (password !== `pw-${config.imap.user}`) throw new Error("AUTHENTICATIONFAILED");
    },
    connectGmail: async (c) => (o.gmail ? o.gmail(c.loginHint) : Promise.reject(new Error("no gmail here"))),
  };
  const dir = mkdtempSync(join(tmpdir(), "terno-accounts-"));
  const backend = new Backend({ dbPath: join(dir, "u.db"), version: "t", cipher: plaintextCipher, providers: registry, now: () => NOW, autoSync: false, openExternal: async () => {} });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "r", origin: "renderer" });
  const client = new RpcClient(c);
  const [mc, ms] = createMemoryTransportPair();
  backend.connect(ms, { clientId: "m", origin: "mcp" });
  const mcp = new RpcClient(mc);
  cleanups.push(async () => {
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return { backend, client, mcp, windows };
}

const imap = (email: string) => ({
  email,
  displayName: "Luis Cordero",
  imap: { host: "imap.fastmail.com", port: 993, secure: true, user: email },
  smtp: { host: "smtp.fastmail.com", port: 465, secure: true, user: email },
  password: `pw-${email}`,
});
const errorOf = (p: Promise<unknown>) => p.then(() => null, (e: RpcError) => e);
const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
};

it("draft discard RPC requires the acknowledged generation for fresh targets, while repeated exact deletion is idempotent", async () => {
  const { client } = setup(); const a = await client.call("accounts.addImap", imap("synthetic-discard@example.test"));
  const d = (await client.call("drafts.save", { accountId: a.id, to: [], subject: "exact", bodyText: "keep" }))!;
  await expect(client.call("drafts.delete", { id: d.id })).rejects.toMatchObject({ code: "STALE", details: { reason: "draftMissing" } });
  await expect(client.call("drafts.delete", { id: d.id, generation: "old-generation" })).rejects.toMatchObject({ code: "STALE", details: { reason: "draftMissing" } });
  expect((await client.call("drafts.list", {}))[0]).toMatchObject({ id: d.id, bodyText: "keep" });
  await client.call("drafts.delete", { id: d.id, generation: d.generation });
  await expect(client.call("drafts.delete", { id: d.id, generation: d.generation })).resolves.toEqual({ ok: true });
  expect(await client.call("drafts.list", {})).toEqual([]);
});

describe("accounts.update", () => {
  it("renames, recolors and sets the sender name, signature and sync window; announces it; null goes back to the general window", async () => {
    const { client, windows } = setup();
    const a = await client.call("accounts.addImap", imap("luis@fastmail.com"));
    // its first sync settles before (it changes the sync state)
    await until(() => windows.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(a).toMatchObject({ displayName: "Luis Cordero", senderName: "Luis Cordero", signature: "", syncWindowDays: null });
    const events: unknown[] = [];
    client.on("accounts", (list) => events.push(list));
    const edited = await client.call("accounts.update", { id: a.id, displayName: "Personal", color: "rose", senderName: "Luis C.", signature: "--\nLuis", syncWindowDays: 30 });
    expect(edited).toMatchObject({ displayName: "Personal", color: "rose", senderName: "Luis C.", signature: "--\nLuis", syncWindowDays: 30 });
    expect((await client.call("app.bootstrap", {})).accounts[0]).toMatchObject(edited);
    await until(() => events.length > 0);
    expect(events.at(-1)).toEqual([edited]);
    expect(await client.call("accounts.update", { id: a.id, syncWindowDays: null })).toMatchObject({ syncWindowDays: null });
  });

  it("refuses what isn't valid: an empty name, a color off the palette, a window out of range, an unknown account", async () => {
    const { client } = setup();
    const a = await client.call("accounts.addImap", imap("luis@fastmail.com"));
    for (const bad of [{ displayName: "  " }, { color: "#ff0000" }, { syncWindowDays: 3 }, { syncWindowDays: 4000 }]) {
      expect(await errorOf(client.call("accounts.update", { id: a.id, ...bad } as never))).toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(await errorOf(client.call("accounts.update", { id: 999, displayName: "x" }))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("the account's sync window is the one its sync uses, else the general one", async () => {
    const { client, windows } = setup();
    const a = await client.call("accounts.addImap", imap("luis@fastmail.com"));
    await until(() => windows.length === 1);
    expect(windows[0]).toEqual({ accountId: a.id, windowStart: NOW - 90 * DAY });
    await client.call("accounts.update", { id: a.id, syncWindowDays: 14 });
    await client.call("sync.now", { accountId: a.id });
    await until(() => windows.length === 2);
    expect(windows[1]!.windowStart).toBe(NOW - 14 * DAY);
    await client.call("accounts.update", { id: a.id, syncWindowDays: null });
    await client.call("settings.update", { syncWindowDays: 365 });
    await client.call("sync.now", { accountId: a.id });
    await until(() => windows.length === 3);
    expect(windows[2]!.windowStart).toBe(NOW - 365 * DAY);
  });
});

describe("accounts.reconnect", () => {
  it("IMAP: a new password counts only after a live login; it replaces the stored one and the account syncs again", async () => {
    const { backend, client, windows } = setup();
    const a = await client.call("accounts.addImap", imap("luis@fastmail.com"));
    await backend.store.accounts.setSyncState(a.id, { status: "error", lastError: "AUTHENTICATIONFAILED" });
    expect(await errorOf(client.call("accounts.reconnect", { id: a.id }))).toMatchObject({ code: "BAD_REQUEST" });
    expect(await errorOf(client.call("accounts.reconnect", { id: a.id, password: "wrong" }))).toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/^Couldn’t connect luis@fastmail\.com: /) });
    await backend.setSecret(`account:${a.id}:password`, "old");
    const syncs = windows.length;
    const r = await client.call("accounts.reconnect", { id: a.id, password: "pw-luis@fastmail.com" });
    expect(r.syncState).toMatchObject({ status: "idle", lastError: null });
    expect(await backend.getSecret(`account:${a.id}:password`)).toBe("pw-luis@fastmail.com");
    await until(() => windows.length > syncs);
    expect(windows.length).toBe(syncs + 1);
  });

  it("Gmail: signs in again for the same address only", async () => {
    let email = "other@gmail.com";
    const hints: (string | undefined)[] = [];
    const { backend, client } = setup({
      gmail: async (hint) => {
        hints.push(hint);
        return { email, name: "Luis", sub: "1", emailVerified: true, refreshToken: `rt-${email}` };
      },
    });
    await client.call("settings.update", { gmailClientId: "id.apps.googleusercontent.com" });
    const a = createAccount(sqlDb(backend.store), { kind: "gmail", email: "luis@gmail.com", displayName: "luis", color: "indigo" });
    expect(await errorOf(client.call("accounts.reconnect", { id: a.id }))).toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/not luis@gmail.com/) });
    expect(await backend.getSecret(`account:${a.id}:refreshToken`)).toBeNull();
    email = "luis@gmail.com";
    await client.call("accounts.reconnect", { id: a.id });
    expect(hints).toEqual(["luis@gmail.com", "luis@gmail.com"]);
    expect(await backend.getSecret(`account:${a.id}:refreshToken`)).toBe("rt-luis@gmail.com");
  });

  it("is not for agents", async () => {
    const { client, mcp } = setup();
    const a = await client.call("accounts.addImap", imap("luis@fastmail.com"));
    expect(await errorOf(mcp.call("accounts.reconnect", { id: a.id, password: "pw-luis@fastmail.com" }))).toMatchObject({ code: "FORBIDDEN" });
    expect(await errorOf(mcp.call("accounts.update", { id: a.id, signature: "x" }))).toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("categories from Ajustes", () => {
  it("rename, recolor, reorder and delete are announced to every window; agents can't reorder or delete", async () => {
    const { client, mcp } = setup();
    const a = await client.call("categories.create", { name: "Facturas", color: "amber" });
    const b = await client.call("categories.create", { name: "Viajes", color: "cyan" });
    const events: { name: string }[][] = [];
    client.on("categories", (list) => events.push(list));
    expect(await client.call("categories.update", { id: a.id, name: "Recibos", color: "rose" })).toMatchObject({ name: "Recibos", color: "rose" });
    expect((await client.call("categories.reorder", { ids: [b.id, a.id] })).map((c) => c.name)).toEqual(["Viajes", "Recibos"]);
    await until(() => events.length >= 2);
    expect(events.at(-1)!.map((c) => c.name)).toEqual(["Viajes", "Recibos"]);
    expect(await errorOf(client.call("categories.update", { id: a.id, name: " " }))).toMatchObject({ code: "BAD_REQUEST" });
    expect(await errorOf(mcp.call("categories.reorder", { ids: [a.id, b.id] }))).toMatchObject({ code: "FORBIDDEN" });
    await client.call("categories.delete", { id: b.id });
    expect((await client.call("app.bootstrap", {})).categories.map((c) => c.name)).toEqual(["Recibos"]);
  });
});

describe("app.import", () => {
  it("brings an export back: categories by name, filters remapped (or left out), drafts of mailboxes here, settings never less private", async () => {
    const from = setup();
    const a = await from.client.call("accounts.addImap", imap("luis@fastmail.com"));
    const gone = await from.client.call("accounts.addImap", imap("old@other.dev"));
    const facturas = await from.client.call("categories.create", { name: "Facturas", color: "amber" });
    const viajes = await from.client.call("categories.create", { name: "Viajes", color: "cyan" });
    await from.client.call("categories.update", { id: viajes.id, autoApply: false });
    const rule = (conditions: object[], actions: object[]) => ({ match: "all" as const, conditions, actions }) as never;
    await from.client.call("filters.save", { name: "Recibos", enabled: true, source: "manual", rule: rule([{ field: "fromDomain", op: "equals", value: "uber.com" }], [{ type: "addCategory", categoryId: facturas.id }]) });
    await from.client.call("filters.save", { name: "Trabajo", enabled: false, source: "ai", rule: rule([{ field: "account", op: "is", value: a.id }], [{ type: "star" }]) });
    await from.client.call("filters.save", { name: "Viejo", enabled: true, source: "manual", rule: rule([{ field: "account", op: "is", value: gone.id }], [{ type: "archive" }]) });
    await from.client.call("drafts.save", { accountId: a.id, to: [{ name: "", email: "ana@" }], subject: "Pendiente", bodyText: "Hola Ana" });
    await from.client.call("settings.update", { localMode: false, density: "compact", layout: "list", motionMs: 50, allowAgentSend: true, ai: { provider: "fake" } });
    const dump = await from.client.call("app.export", {});

    const to = setup();
    const here = await to.client.call("accounts.addImap", imap("luis@fastmail.com"));
    await to.client.call("categories.create", { name: "facturas", color: "rose" });
    const result = await to.client.call("app.import", { data: dump });
    // the filter on a mailbox that isn't connected here waits for it
    expect(result).toEqual({ categories: { added: 1, merged: 1 }, filters: { added: 2, existing: 0, skipped: [] }, drafts: 1, pending: { drafts: 0, filters: 1 }, settings: true });

    const boot = await to.client.call("app.bootstrap", {});
    expect(boot.categories.map((c) => [c.name, c.color, c.autoApply])).toEqual([["facturas", "rose", true], ["Viajes", "cyan", false]]);
    const filters = await to.client.call("filters.list", {});
    expect(filters.find((f) => f.name === "Recibos")!.rule.actions).toEqual([{ type: "addCategory", categoryId: boot.categories[0]!.id }]);
    expect(filters.find((f) => f.name === "Trabajo")).toMatchObject({ enabled: false, source: "ai", rule: { conditions: [{ field: "account", value: here.id }] } });
    expect((await to.client.call("drafts.list", {})).map((d) => [d.accountId, d.subject, d.to])).toEqual([[here.id, "Pendiente", [{ name: "", email: "ana@" }]]]);
    // density, the layout (plan 24) and motion come along; local mode stays on and agents still can't send
    expect(boot.settings).toMatchObject({ density: "compact", layout: "list", motionMs: 50, localMode: true, allowAgentSend: false });

    // a second import adds nothing new
    expect(await to.client.call("app.import", { data: dump })).toMatchObject({ categories: { added: 0, merged: 2 }, filters: { added: 0, existing: 2 } });
    await expect(to.client.call("app.import", { data: { ...dump, format: "otra" } as never })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(to.mcp.call("app.import", { data: dump })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("plan 35: a file can turn remote images to ask, never to always", async () => {
    const from = setup();
    await from.client.call("settings.update", { remoteImages: "always" });
    const always = await from.client.call("app.export", {});
    const to = setup();
    await to.client.call("app.import", { data: always });
    expect((await to.client.call("app.bootstrap", {})).settings.remoteImages).toBe("ask");
    // this install's own "always" stays through a file that says always, says nothing, or says garbage
    await to.client.call("settings.update", { remoteImages: "always" });
    const { remoteImages: _r, ...without } = always.settings;
    for (const settings of [always.settings, without, { ...always.settings, remoteImages: "sometimes" }]) {
      await to.client.call("app.import", { data: { ...always, settings: settings as never } });
      expect((await to.client.call("app.bootstrap", {})).settings.remoteImages).toBe("always");
    }
    // a file that says ask turns it off
    await to.client.call("app.import", { data: { ...always, settings: { ...always.settings, remoteImages: "ask" } } });
    expect((await to.client.call("app.bootstrap", {})).settings.remoteImages).toBe("ask");
  });

  it("carries the language; an old export without one, or with one Terno doesn't ship, leaves it alone", async () => {
    const from = setup();
    await from.client.call("settings.update", { language: "es" });
    const dump = await from.client.call("app.export", {});
    const to = setup();
    await to.client.call("app.import", { data: dump });
    expect((await to.client.call("app.bootstrap", {})).settings.language).toBe("es");
    const { language: _, ...old } = dump.settings;
    await to.client.call("app.import", { data: { ...dump, settings: old as never } });
    await to.client.call("app.import", { data: { ...dump, settings: { ...dump.settings, language: "fr" } as never } });
    expect((await to.client.call("app.bootstrap", {})).settings.language).toBe("es");
  });
});

describe("app.import: designs (plan 15)", () => {
  it("carries the design and the colors; a file from before designs only leaves its palettes as previous", async () => {
    const from = setup();
    await from.client.call("settings.update", { design: "atelier", lightTheme: "github-light", darkTheme: "design" });
    const dump = await from.client.call("app.export", {});
    const to = setup();
    await to.client.call("app.import", { data: dump });
    expect((await to.client.call("app.bootstrap", {})).settings).toMatchObject({ design: "atelier", lightTheme: "github-light", darkTheme: "design" });

    const fresh = setup();
    const { design: _d, previousLightTheme: _pl, previousDarkTheme: _pd, ...legacy } = dump.settings;
    await fresh.client.call("app.import", { data: { ...dump, settings: { ...legacy, lightTheme: "solarized-light", darkTheme: "nord" } as never } });
    expect((await fresh.client.call("app.bootstrap", {})).settings).toMatchObject({ design: "lumen", lightTheme: "design", darkTheme: "design", previousLightTheme: "solarized-light", previousDarkTheme: "nord" });
  });
});

describe("AI keys are bound to the endpoint they were saved for", () => {
  const exportWith = (ai: object) => ({ format: "terno-export" as const, version: 1 as const, exportedAt: NOW, app: "t", accounts: [], categories: [], filters: [], drafts: [], ops: [], settings: { ai } });

  it("an imported endpoint never gets the saved key: it asks to confirm or re-enter it", async () => {
    const { backend, client } = setup();
    await client.call("settings.update", { localMode: false, ai: { provider: "openai", model: "gpt-x" } });
    await client.call("ai.setKey", { provider: "openai", value: "sk-secret-0123456789" });
    expect((await backend.aiService.config({ provider: "openai", model: "gpt-x" })).apiKey).toBe("sk-secret-0123456789");

    await client.call("app.import", { data: exportWith({ provider: "openai", model: "gpt-x", baseURL: "https://evil.example/v1" }) as never });
    const ai = (await client.call("app.bootstrap", {})).settings.ai;
    expect(ai).toMatchObject({ baseURL: "https://evil.example/v1", hasKey: true, keyOrigin: "https://api.openai.com", keyConfirmed: false });
    await expect(backend.aiService.config({ provider: "openai", model: "gpt-x", baseURL: "https://evil.example/v1" })).rejects.toMatchObject({ kind: "not_configured" });
    await expect(client.call("ai.test", { provider: "openai", model: "gpt-x", baseURL: "https://evil.example/v1" })).resolves.toMatchObject({ ok: false, error: { kind: "not_configured" } });

    // the user confirms it for this endpoint (or saves a new key): then it's used there, and only there
    expect((await client.call("ai.confirmKey", { provider: "openai" })).ai).toMatchObject({ keyOrigin: "https://evil.example", keyConfirmed: true });
    expect((await backend.aiService.config({ provider: "openai", model: "gpt-x", baseURL: "https://evil.example/v1" })).apiKey).toBe("sk-secret-0123456789");
    await expect(backend.aiService.config({ provider: "openai", model: "gpt-x", baseURL: "https://other.example/v1" })).rejects.toMatchObject({ kind: "not_configured" });
  });

  it("changing the endpoint by hand asks too; a key saved before origins existed is bound before anything changes", async () => {
    const { backend, client } = setup();
    await client.call("settings.update", { localMode: false, ai: { provider: "compatible", preset: "azure", baseURL: "https://mine.openai.azure.com", model: "dep" } });
    // a key from before this release: no origin recorded
    await backend.setSecret("ai:compatible:azure:apiKey", "legacy-key-0123456789");
    await client.call("settings.update", { ai: { baseURL: "https://elsewhere.openai.azure.com" } });
    expect((await client.call("app.bootstrap", {})).settings.ai).toMatchObject({ keyOrigin: "https://mine.openai.azure.com", keyConfirmed: false });
    await client.call("settings.update", { ai: { baseURL: "https://mine.openai.azure.com/openai" } });
    expect((await client.call("app.bootstrap", {})).settings.ai).toMatchObject({ keyConfirmed: true });
    expect((await backend.aiService.config({ provider: "compatible", preset: "azure", model: "dep", baseURL: "https://mine.openai.azure.com/openai" })).apiKey).toBe("legacy-key-0123456789");
    await expect(client.call("ai.confirmKey", { provider: "openai" }).then(() => null, (e) => e)).resolves.toBeNull();
  });
});

describe("an account's preferences and its sync cursor", () => {
  it("a cursor saved while the user edits the signature never undoes the edit", async () => {
    let ctx: Parameters<ProviderRegistry["create"]>[0] | null = null;
    const registry: ProviderRegistry = {
      create: (c): MailProvider => ((ctx = c), { async verify() {}, async sync() {}, async execute() {}, async close() {} }),
      async verifyImap() {},
      connectGmail: () => Promise.reject(new Error("no")),
    };
    const dir = mkdtempSync(join(tmpdir(), "terno-cursor-"));
    const backend = new Backend({ dbPath: join(dir, "u.db"), version: "t", cipher: plaintextCipher, providers: registry, now: () => NOW, autoSync: false });
    cleanups.push(async () => {
      await backend.stop();
      rmSync(dir, { recursive: true, force: true });
    });
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId: "r", origin: "renderer" });
    const client = new RpcClient(c);
    const a = await client.call("accounts.addImap", imap("luis@fastmail.com"));
    await until(() => ctx !== null);
    // the sync reads the stored config, then the user's edit lands, then the cursor is written
    const store = backend.store.accounts;
    const config = store.config.bind(store);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    store.config = async <T,>(id: number) => {
      const v = await config<T>(id);
      await gate;
      return v;
    };
    const saving = ctx!.saveCursor({ uidNext: 42 });
    await new Promise((r) => setTimeout(r, 5));
    await client.call("accounts.update", { id: a.id, signature: "Luis", syncWindowDays: 30 });
    release();
    await saving;
    store.config = config;
    expect(await store.get(a.id)).toMatchObject({ signature: "Luis", syncWindowDays: 30 });
    expect((await store.config<{ cursor: unknown }>(a.id))!.config.cursor).toEqual({ uidNext: 42 });
  });
});

describe("drafts in an export (format 2)", () => {
  const original = (accountId: number, rfc: string): IncomingMessage => ({
    accountId, providerMsgId: rfc, providerThreadId: null, rfcMessageId: `<${rfc}@x>`, inReplyTo: null, references: [],
    from: { name: "Yuki", email: "yuki@acme.studio" }, to: [{ name: "Luis", email: "luis@fastmail.com" }], cc: [], bcc: [],
    subject: "Propuesta", date: NOW - DAY, snippet: "hola", bodyText: "hola", bodyHtml: null, bodyState: "full", listId: null,
    isRead: true, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 100,
  });
  const ingest = (b: Backend, m: IncomingMessage) => b.store.sync.ingest([m], { applyFilters: false, now: NOW, classifier: null });
  const messageId = (b: Backend, rfc: string) => sqlDb(b.store).get<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages WHERE rfc_message_id = ?", `${rfc}@x`)!;

  it("keep mode, Bcc, the quote and what they answer or forward (by Message-ID), and send as they would have", async () => {
    const from = setup();
    const a = await from.client.call("accounts.addImap", imap("luis@fastmail.com"));
    await ingest(from.backend, original(a.id, "orig"));
    await ingest(from.backend, original(a.id, "gone"));
    const src = messageId(from.backend, "orig");
    const bcc = [{ name: "", email: "jefe@acme.studio" }];
    await from.client.call("drafts.save", { accountId: a.id, threadId: src.thread_id, mode: "forward", to: [{ name: "", email: "ana@x.dev" }], bcc, subject: "Fwd: Propuesta", subjectEdited: true, bodyText: "Mira esto", quotedText: "---------- Mensaje reenviado ----------\nhola", includeQuote: true, forwardOfMessageId: src.id, uiState: "collapsed" });
    await from.client.call("drafts.save", { accountId: a.id, mode: "reply", to: [{ name: "Yuki", email: "yuki@acme.studio", auto: true }], subject: "Re: Propuesta", bodyText: "Sí", quotedText: "> hola", includeQuote: true, inReplyToMessageId: src.id });
    const gone = messageId(from.backend, "gone");
    await from.client.call("drafts.save", { accountId: a.id, mode: "reply", to: [{ name: "Yuki", email: "yuki@acme.studio" }], subject: "Re: Propuesta", bodyText: "Lo vemos", quotedText: "> otra", includeQuote: true, inReplyToMessageId: gone.id });
    const dump = await from.client.call("app.export", {});
    expect(dump.version).toBe(2);

    // elsewhere: the same mailbox, re-synced, has the original but not the other message
    const to = setup();
    const here = await to.client.call("accounts.addImap", imap("luis@fastmail.com"));
    await ingest(to.backend, { ...original(here.id, "orig"), providerMsgId: "other-id" });
    const dst = messageId(to.backend, "orig");
    await to.client.call("app.import", { data: dump });
    const drafts = await to.client.call("drafts.list", {});
    const fwd = drafts.find((d) => d.mode === "forward")!;
    expect(fwd).toMatchObject({ accountId: here.id, threadId: dst.thread_id, forwardOfMessageId: dst.id, to: [{ name: "", email: "ana@x.dev" }], bcc, subject: "Fwd: Propuesta", subjectEdited: true, bodyText: "Mira esto", quotedText: "---------- Mensaje reenviado ----------\nhola", includeQuote: true, uiState: "collapsed" });
    expect(drafts.find((d) => d.mode === "reply")).toMatchObject({ inReplyToMessageId: dst.id, threadId: dst.thread_id, to: [{ name: "Yuki", email: "yuki@acme.studio", auto: true }], quotedText: "> hola", includeQuote: true });
    // what it answered isn't here: a new message that still carries the quote, visibly, in its text
    expect(drafts.find((d) => d.bodyText.startsWith("Lo vemos"))).toMatchObject({ mode: "new", threadId: null, inReplyToMessageId: null, bodyText: "Lo vemos\n\n> otra", quotedText: "", includeQuote: false });

    // sending the imported forward: its Bcc and the forwarded text go out, and the draft is gone
    const sent = await to.client.call("compose.send", { accountId: here.id, to: fwd.to, cc: fwd.cc, bcc: fwd.bcc, subject: fwd.subject, bodyText: `${fwd.bodyText}\n\n${fwd.quotedText}`, forwardOfMessageId: fwd.forwardOfMessageId!, draftId: fwd.id, draftGeneration: fwd.generation });
    const op = sqlDb(to.backend.store).get<{ payload_json: string }>("SELECT payload_json FROM ops WHERE id = ?", sent.opId)!;
    expect(op.payload_json).toContain("jefe@acme.studio");
    expect(op.payload_json).toContain("Mensaje reenviado");
    expect((await to.client.call("drafts.list", {})).some((d) => d.id === fwd.id)).toBe(false);
  });

  it("an export from before (format 1, written when the app was called Única) still imports its drafts", async () => {
    const { client } = setup();
    const a = await client.call("accounts.addImap", imap("luis@fastmail.com"));
    const v1 = { format: "unica-export", version: 1, accounts: [], categories: [], filters: [], drafts: [{ accountEmail: a.email, to: [{ name: "", email: "ana@x.dev" }], cc: [], subject: "Hola", bodyText: "Texto", updatedAt: NOW }] };
    await client.call("app.import", { data: v1 as never });
    expect(await client.call("drafts.list", {})).toMatchObject([{ mode: "new", subject: "Hola", bodyText: "Texto", bcc: [] }]);
  });
});

describe("rich drafts (plan 16) in an export and over RPC", () => {
  it("carry their HTML; an orphaned reply's quote joins the HTML too; two drafts differing only in formatting stay two", async () => {
    const { client } = setup();
    const a = await client.call("accounts.addImap", imap("luis@fastmail.com"));
    const base = { accountEmail: a.email, to: [{ name: "", email: "ana@x.dev" }], cc: [], subject: "Hola", subjectEdited: true, bodyText: "Texto", quotedText: "", includeQuote: false, inReplyTo: null, forwardOf: null, uiState: "open", updatedAt: NOW };
    const file = {
      format: "terno-export", version: 2, accounts: [], categories: [], filters: [],
      drafts: [
        { ...base, mode: "new", bodyHtml: "<div><b>Texto</b></div>" },
        { ...base, mode: "new", bodyHtml: "<div><i>Texto</i></div>" },
        { ...base, mode: "reply", subject: "Re: x", bodyText: "Sí", bodyHtml: "<div><b>Sí</b></div>", quotedText: "El lunes, Ana escribió:\n> hola", includeQuote: true, inReplyTo: "missing@x" },
      ],
    };
    expect((await client.call("app.import", { data: file as never })).drafts).toBe(3);
    expect((await client.call("app.import", { data: file as never })).drafts).toBe(0);
    const drafts = await client.call("drafts.list", {});
    expect(drafts.filter((d) => d.subject === "Hola").map((d) => d.bodyHtml).sort()).toEqual(["<div><b>Texto</b></div>", "<div><i>Texto</i></div>"]);
    expect(drafts.find((d) => d.subject === "Re: x")).toMatchObject({
      mode: "new",
      bodyText: "Sí\n\nEl lunes, Ana escribió:\n> hola",
      bodyHtml: '<div><b>Sí</b></div><div><br></div><div>El lunes, Ana escribió:</div><blockquote style="margin:0 0 0 0.8ex;border-left:2px solid #ccc;padding-left:1ex"><div>hola</div></blockquote>',
    });
    const dump = await client.call("app.export", {});
    expect(dump.drafts.map((d) => d.bodyHtml).sort()).toEqual(drafts.map((d) => d.bodyHtml).sort());
  });

  it("an agent saves and sends text only: its HTML is dropped, and its save leaves no stale HTML", async () => {
    const { client, mcp, backend } = setup();
    const a = await client.call("accounts.addImap", imap("luis@fastmail.com"));
    const rich = await client.call("drafts.save", { accountId: a.id, to: [], cc: [], subject: "s", bodyText: "Hola", bodyHtml: "<div><b>Hola</b></div>" });
    expect(rich!.bodyHtml).toBe("<div><b>Hola</b></div>");
    const byAgent = await mcp.call("drafts.save", { id: rich!.id, generation: rich!.generation, baseRevision: rich!.revision, accountId: a.id, to: [], cc: [], subject: "s", bodyText: "Otro", bodyHtml: "<img src=x onerror=alert(1)>" });
    expect(byAgent).toMatchObject({ bodyText: "Otro", bodyHtml: "" });
    await backend.server.invoke("settings.update", { allowAgentSend: true }, { clientId: "setup", origin: "dev" });
    const sent = await mcp.call("compose.send", { accountId: a.id, to: [{ name: "", email: "ana@x.dev" }], subject: "s", bodyText: "texto", bodyHtml: "<b>no</b>" });
    const op = sqlDb(backend.store).get<{ payload_json: string }>("SELECT payload_json FROM ops WHERE id = ?", sent.opId)!;
    expect(JSON.parse(op.payload_json)).not.toHaveProperty("html");
    const mine = await client.call("compose.send", { accountId: a.id, to: [{ name: "", email: "ana@x.dev" }], subject: "s", bodyText: "texto", bodyHtml: "<div><b>sí</b></div>" });
    expect(JSON.parse(sqlDb(backend.store).get<{ payload_json: string }>("SELECT payload_json FROM ops WHERE id = ?", mine.opId)!.payload_json)).toMatchObject({ html: "<div><b>sí</b></div>" });
  });
});

describe("importing drafts twice", () => {
  it("adds each draft once, and tells every window to show them", async () => {
    const { client } = setup();
    const a = await client.call("accounts.addImap", imap("luis@fastmail.com"));
    const file = {
      format: "terno-export", version: 2, accounts: [], categories: [], filters: [],
      drafts: [
        { accountEmail: a.email, mode: "new", to: [{ name: "", email: "ana@x.dev" }], cc: [], bcc: [{ name: "", email: "b@x.dev" }], subject: "Hola", subjectEdited: true, bodyText: "Texto", quotedText: "", includeQuote: false, inReplyTo: null, forwardOf: null, uiState: "open", updatedAt: NOW },
        { accountEmail: a.email, mode: "reply", to: [], cc: [], subject: "Re: x", bodyText: "Sí", quotedText: "> x", includeQuote: true, inReplyTo: "missing@x", forwardOf: null, uiState: "open", updatedAt: NOW },
      ],
    };
    const events: unknown[] = [];
    client.on("drafts", (e) => events.push(e));
    expect((await client.call("app.import", { data: file as never })).drafts).toBe(2);
    expect((await client.call("app.import", { data: file as never })).drafts).toBe(0);
    expect((await client.call("drafts.list", {})).map((d) => d.subject).sort()).toEqual(["Hola", "Re: x"]);
    await until(() => events.length > 0);
    expect(events).toEqual([{ reason: "import" }]);
  });
});

describe("an import into a mailbox whose accounts aren't connected yet (a fresh storage engine)", () => {
  it("keeps their drafts and filters and puts them in when each mailbox connects; replies once their original has synced", async () => {
    const from = setup();
    const a = await from.client.call("accounts.addImap", imap("luis@fastmail.com"));
    const rfc = "orig@x";
    const message = (accountId: number): IncomingMessage => ({
      accountId, providerMsgId: "p1", providerThreadId: null, rfcMessageId: `<${rfc}>`, inReplyTo: null, references: [],
      from: { name: "Yuki", email: "yuki@acme.studio" }, to: [{ name: "Luis", email: "luis@fastmail.com" }], cc: [], bcc: [],
      subject: "Propuesta", date: NOW - DAY, snippet: "hola", bodyText: "hola", bodyHtml: null, bodyState: "full", listId: null,
      isRead: true, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 100,
    });
    await from.backend.store.sync.ingest([message(a.id)], { applyFilters: false, now: NOW, classifier: null });
    const orig = sqlDb(from.backend.store).get<{ id: number }>("SELECT id FROM messages WHERE rfc_message_id = ?", rfc)!;
    await from.client.call("filters.save", { name: "De Fastmail", enabled: true, source: "manual", rule: { match: "all", conditions: [{ field: "account", op: "is", value: a.id }], actions: [{ type: "star" }] } as never });
    await from.client.call("drafts.save", { accountId: a.id, to: [{ name: "", email: "ana@x.dev" }], subject: "Nuevo", bodyText: "Hola Ana" });
    await from.client.call("drafts.save", { accountId: a.id, mode: "reply", to: [{ name: "Yuki", email: "yuki@acme.studio" }], subject: "Re: Propuesta", bodyText: "Sí", quotedText: "> hola", includeQuote: true, inReplyToMessageId: orig.id });
    const dump = await from.client.call("app.export", {});

    // the other side: no accounts yet; its sync (when it comes) brings the original
    let syncs = 0;
    const dir = mkdtempSync(join(tmpdir(), "terno-pending-"));
    let gate!: () => void;
    const synced = new Promise<void>((r) => (gate = r));
    const registry: ProviderRegistry = {
      create: ({ account }): MailProvider => ({
        async verify() {},
        async sync(sink) {
          await synced;
          await sink.ingest([message(account.id)]);
          syncs++;
        },
        async execute() {},
        async close() {},
      }),
      async verifyImap() {},
      connectGmail: () => Promise.reject(new Error("no")),
    };
    const backend = new Backend({ dbPath: join(dir, "u.db"), version: "t", cipher: plaintextCipher, providers: registry, now: () => NOW, autoSync: false });
    cleanups.push(async () => {
      await backend.stop();
      rmSync(dir, { recursive: true, force: true });
    });
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId: "r", origin: "renderer" });
    const client = new RpcClient(c);
    const events: unknown[] = [];
    client.on("drafts", (e) => events.push(e));
    expect(await client.call("app.import", { data: dump })).toMatchObject({ drafts: 0, filters: { added: 0 }, pending: { drafts: 2, filters: 1 } });
    expect(await client.call("drafts.list", {})).toEqual([]);

    // connecting the mailbox: the filter (remapped) and the new message go in at once
    const here = await client.call("accounts.addImap", imap("luis@fastmail.com"));
    expect((await client.call("filters.list", {})).find((f) => f.name === "De Fastmail")!.rule.conditions).toEqual([{ field: "account", op: "is", value: here.id }]);
    expect((await client.call("drafts.list", {})).map((d) => d.subject)).toEqual(["Nuevo"]);
    // the reply waits for its original, then comes back as a reply to it
    gate();
    await until(() => syncs === 1);
    await until(() => (events.length >= 2));
    const reply = (await client.call("drafts.list", {})).find((d) => d.subject === "Re: Propuesta")!;
    const mine = sqlDb(backend.store).get<{ id: number }>("SELECT id FROM messages WHERE rfc_message_id = ?", rfc)!;
    expect(reply).toMatchObject({ mode: "reply", inReplyToMessageId: mine.id, quotedText: "> hola", includeQuote: true });
    expect(await backend.store.settings.get("import:pending", null)).toEqual({ drafts: [], filters: [] });
  });
});

describe("a large or partly broken import", () => {
  it("reads items one by one: a bad filter is skipped by name, the rest goes in", async () => {
    const { client } = setup();
    const ok = { name: "Bueno", enabled: true, source: "manual", rule: { match: "all", conditions: [{ field: "fromDomain", op: "equals", value: "a.dev" }], actions: [{ type: "star" }] } };
    const bad = { name: "Roto", enabled: true, source: "manual", rule: { match: "all", conditions: [{ field: "nope", op: "x", value: 1 }], actions: [] } };
    const r = await client.call("app.import", { data: { format: "terno-export", version: 2, categories: [{ id: 1, name: "Bien", color: "rose" }, { id: 2, name: "", color: "nope" }], filters: [ok, bad] } as never });
    expect(r).toMatchObject({ categories: { added: 1 }, filters: { added: 1, skipped: ["Roto"] } });
  });
});
