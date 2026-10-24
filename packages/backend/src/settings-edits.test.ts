import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient, type RpcError } from "@unica/core/rpc";
import { createAccount, sqlDb } from "@unica/db";
import type { GmailConnectResult, MailProvider, ProviderRegistry, SyncSink } from "@unica/mail";
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
  const dir = mkdtempSync(join(tmpdir(), "unica-accounts-"));
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
    expect(await errorOf(client.call("accounts.reconnect", { id: a.id, password: "wrong" }))).toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/No se pudo conectar/) });
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
    expect(await errorOf(client.call("accounts.reconnect", { id: a.id }))).toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/no luis@gmail.com/) });
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
    await from.client.call("settings.update", { localMode: false, density: "compact", motionMs: 50, allowAgentSend: true, ai: { provider: "fake" } });
    const dump = await from.client.call("app.export", {});

    const to = setup();
    const here = await to.client.call("accounts.addImap", imap("luis@fastmail.com"));
    await to.client.call("categories.create", { name: "facturas", color: "rose" });
    const result = await to.client.call("app.import", { data: dump });
    expect(result).toEqual({ categories: { added: 1, merged: 1 }, filters: { added: 2, existing: 0, skipped: ["Viejo"] }, drafts: 1, settings: true });

    const boot = await to.client.call("app.bootstrap", {});
    expect(boot.categories.map((c) => [c.name, c.color, c.autoApply])).toEqual([["facturas", "rose", true], ["Viajes", "cyan", false]]);
    const filters = await to.client.call("filters.list", {});
    expect(filters.find((f) => f.name === "Recibos")!.rule.actions).toEqual([{ type: "addCategory", categoryId: boot.categories[0]!.id }]);
    expect(filters.find((f) => f.name === "Trabajo")).toMatchObject({ enabled: false, source: "ai", rule: { conditions: [{ field: "account", value: here.id }] } });
    expect((await to.client.call("drafts.list", {})).map((d) => [d.accountId, d.subject, d.to])).toEqual([[here.id, "Pendiente", [{ name: "", email: "ana@" }]]]);
    // density and motion come along; local mode stays on and agents still can't send
    expect(boot.settings).toMatchObject({ density: "compact", motionMs: 50, localMode: true, allowAgentSend: false });

    // a second import adds nothing new
    expect(await to.client.call("app.import", { data: dump })).toMatchObject({ categories: { added: 0, merged: 2 }, filters: { added: 0, existing: 2 } });
    await expect(to.client.call("app.import", { data: { ...dump, format: "otra" } as never })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(to.mcp.call("app.import", { data: dump })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
