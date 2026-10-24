import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient, type OwnerIdentity, type RpcError } from "@terno/core/rpc";
import { createAccount, ownerHistory, sqlDb } from "@terno/db";
import { demoRegistry, type MailProvider, type ProviderRegistry } from "@terno/mail";
import { afterEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const NOW = Date.UTC(2026, 9, 22, 12);
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A real-looking registry: IMAP logins succeed only with the right password, after a little latency. */
const registry: ProviderRegistry = {
  create: (): MailProvider => ({ async verify() {}, async sync() {}, async execute() {}, async close() {} }),
  async verifyImap(config, password) {
    await new Promise((r) => setTimeout(r, 5));
    if (password !== `pw-${config.imap.user}`) throw new Error("AUTHENTICATIONFAILED");
  },
  async connectGmail() {
    throw new Error("not in these tests");
  },
};

function setup(providers: ProviderRegistry = registry) {
  const dir = mkdtempSync(join(tmpdir(), "terno-owner-"));
  let clock = NOW;
  const backend = new Backend({ dbPath: join(dir, "u.db"), version: "t", cipher: plaintextCipher, providers, now: () => clock, autoSync: false });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "r", origin: "renderer" });
  const client = new RpcClient(c);
  const ownerEvents: (OwnerIdentity | null)[] = [];
  client.on("owner", (o) => ownerEvents.push(o));
  const [mc, ms] = createMemoryTransportPair();
  backend.connect(ms, { clientId: "m", origin: "mcp" });
  const mcp = new RpcClient(mc);
  const mcpOwnerEvents: unknown[] = [];
  mcp.on("owner", (o) => mcpOwnerEvents.push(o));
  cleanups.push(async () => {
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return { backend, client, mcp, ownerEvents, mcpOwnerEvents, tick: (ms: number) => (clock += ms) };
}

const imap = (email: string, over: { password?: string; verify?: boolean; user?: string } = {}) => {
  const user = over.user ?? email;
  return {
    email,
    displayName: "Luis Cordero",
    imap: { host: `imap.${email.split("@")[1]}`, port: 993, secure: true, user },
    smtp: { host: `smtp.${email.split("@")[1]}`, port: 465, secure: true, user },
    password: over.password ?? `pw-${user}`,
    verify: over.verify,
  };
};
const settle = () => new Promise((r) => setTimeout(r, 0));
const errorOf = (p: Promise<unknown>) => p.then(() => null, (e: RpcError) => e);

describe("owner claim", () => {
  it("the first verified IMAP account becomes the owner; later accounts don't", async () => {
    const { client, ownerEvents } = setup();
    expect((await client.call("app.bootstrap", {})).owner).toBeNull();
    const first = await client.call("accounts.addImap", imap("luis@fastmail.com"));
    await client.call("accounts.addImap", imap("work@acme.studio"));
    const owner = (await client.call("app.bootstrap", {})).owner!;
    expect(owner).toMatchObject({ email: "luis@fastmail.com", displayName: "Luis Cordero", provider: "imap", verifiedBy: "imap_login", verifiedAt: NOW, migrated: false, accountId: first.id });
    expect(owner.userId).toMatch(/^[0-9a-f-]{36}$/);
    await settle();
    expect(ownerEvents).toEqual([owner]);
  });

  it("an unverified add (verify:false) never claims, nor does the demo registry's no-op check", async () => {
    const { client } = setup();
    await client.call("accounts.addImap", imap("luis@fastmail.com", { verify: false, password: "whatever" }));
    expect(await client.call("identity.get", {})).toBeNull();
    const demo = setup(demoRegistry);
    await demo.client.call("accounts.addImap", imap("ana@icloud.com", { password: "anything" }));
    expect(await demo.client.call("identity.get", {})).toBeNull();
    expect((await demo.client.call("app.bootstrap", {})).demo).toBe(true);
  });

  it("concurrent adds (two windows) leave exactly one owner", async () => {
    const { backend, client } = setup();
    const added = await Promise.all([client.call("accounts.addImap", imap("a@one.dev")), client.call("accounts.addImap", imap("b@two.dev"))]);
    expect(sqlDb(backend.store).get<{ n: number }>("SELECT count(*) AS n FROM owner")!.n).toBe(1);
    const owner = (await client.call("identity.get", {}))!;
    expect(added.map((a) => a.id)).toContain(owner.accountId);
  });

  it("records whether the IMAP login user is the address (a login doesn't prove the address)", async () => {
    const { backend, client } = setup();
    await client.call("accounts.addImap", imap("hola@luiscordero.dev", { user: "luis" }));
    const evidence = JSON.parse(sqlDb(backend.store).get<{ e: string }>("SELECT evidence_json AS e FROM owner")!.e);
    expect(evidence).toEqual({ imapHost: "imap.luiscordero.dev", loginUser: "luis", emailMatchesLogin: false });
    // evidence never crosses the RPC boundary
    expect(JSON.stringify(await client.call("app.bootstrap", {}))).not.toMatch(/loginUser|imapHost|emailMatchesLogin/);
  });
});

describe("owner and mailboxes are separate", () => {
  it("removing the owner's mailbox keeps the owner, clears accountId and notifies", async () => {
    const { client, ownerEvents } = setup();
    const a = await client.call("accounts.addImap", imap("luis@fastmail.com"));
    const before = (await client.call("identity.get", {}))!;
    await client.call("accounts.remove", { id: a.id });
    const after = (await client.call("identity.get", {}))!;
    expect(after).toEqual({ ...before, accountId: null });
    await settle();
    expect(ownerEvents.at(-1)).toEqual(after);
    // re-adding a mailbox does not silently re-link or replace the owner
    await client.call("accounts.addImap", imap("other@x.dev"));
    expect(await client.call("identity.get", {})).toEqual(after);
  });
});

describe("changing the owner", () => {
  it("requires a fresh, live verification of the target; failures leave the owner untouched", async () => {
    const { client } = setup();
    await client.call("accounts.addImap", imap("luis@fastmail.com"));
    const work = await client.call("accounts.addImap", imap("work@acme.studio"));
    const before = await client.call("identity.get", {});
    // the stored password does not count: one must be typed now
    expect(await errorOf(client.call("identity.changeOwner", { accountId: work.id }))).toMatchObject({ code: "BAD_REQUEST" });
    expect(await errorOf(client.call("identity.changeOwner", { accountId: work.id, password: "wrong" }))).toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/No se pudo verificar/) });
    expect(await client.call("identity.get", {})).toEqual(before);
    expect(await errorOf(client.call("identity.changeOwner", { accountId: before!.accountId!, password: "pw-luis@fastmail.com" }))).toMatchObject({ code: "BAD_REQUEST" });
    expect(await errorOf(client.call("identity.changeOwner", { accountId: 999, password: "x" }))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("moves ownership, keeps the user id, writes history and notifies", async () => {
    const { backend, client, tick, ownerEvents } = setup();
    await client.call("accounts.addImap", imap("luis@fastmail.com"));
    const work = await client.call("accounts.addImap", imap("work@acme.studio"));
    const before = (await client.call("identity.get", {}))!;
    tick(60_000);
    const after = await client.call("identity.changeOwner", { accountId: work.id, password: "pw-work@acme.studio" });
    expect(after).toMatchObject({ userId: before.userId, email: "work@acme.studio", accountId: work.id, verifiedAt: NOW + 60_000, createdAt: before.createdAt, updatedAt: NOW + 60_000 });
    expect(ownerHistory(sqlDb(backend.store))).toEqual([{ userId: before.userId, email: "luis@fastmail.com", provider: "imap", replacedAt: NOW + 60_000, reason: "changed by user" }]);
    // the freshly verified password replaces the stored one
    expect(await backend.getSecret(`account:${work.id}:password`)).toBe("pw-work@acme.studio");
    await settle();
    expect(ownerEvents.at(-1)).toEqual(after);
  });

  it("a mailbox removed (and its id's slot refilled) while verifying gets no credentials and no ownership", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: ProviderRegistry = {
      ...registry,
      async verifyImap(config, password) {
        if (password === "slow-pw") return gate;
        return registry.verifyImap(config, password);
      },
    };
    const { backend, client } = setup(slow);
    await client.call("accounts.addImap", imap("luis@fastmail.com"));
    const target = await client.call("accounts.addImap", imap("work@acme.studio"));
    const before = await client.call("identity.get", {});
    const pending = errorOf(client.call("identity.changeOwner", { accountId: target.id, password: "slow-pw" }));
    await new Promise((r) => setTimeout(r, 20));
    await client.call("accounts.remove", { id: target.id });
    const replacement = await client.call("accounts.addImap", imap("new@other.dev"));
    expect(replacement.id).not.toBe(target.id);
    release();
    expect(await pending).toMatchObject({ code: "NOT_FOUND" });
    expect(await client.call("identity.get", {})).toEqual(before);
    expect(await backend.getSecret(`account:${replacement.id}:password`)).toBe("pw-new@other.dev");
    expect(await backend.getSecret(`account:${target.id}:password`)).toBeNull();
  });

  it("refuses demo mailboxes", async () => {
    const { backend, client } = setup();
    const demo = createAccount(sqlDb(backend.store), { kind: "imap", email: "demo@demo.dev", displayName: "Demo", color: "indigo", providerConfig: { demo: true } });
    expect(await errorOf(client.call("identity.changeOwner", { accountId: demo.id, password: "x" }))).toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("agents (MCP)", () => {
  it("never see or change the owner", async () => {
    const { client, mcp, ownerEvents, mcpOwnerEvents } = setup();
    const a = await client.call("accounts.addImap", imap("luis@fastmail.com"));
    await client.call("accounts.remove", { id: a.id });
    await client.call("accounts.addImap", imap("luis@fastmail.com"));
    await settle();
    expect(ownerEvents.length).toBeGreaterThan(0);
    expect(mcpOwnerEvents).toEqual([]);
    expect((await client.call("app.bootstrap", {})).owner).not.toBeNull();
    expect((await mcp.call("app.bootstrap", {})).owner).toBeNull();
    expect(await errorOf(mcp.call("identity.get", {}))).toMatchObject({ code: "FORBIDDEN" });
    expect(await errorOf(mcp.call("identity.changeOwner", { accountId: 1, password: "x" }))).toMatchObject({ code: "FORBIDDEN" });
  });
});
