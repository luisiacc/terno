import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createAccount, sqlDb } from "@terno/db";
import { msg } from "@terno/store/conformance";
import type { ProviderRegistry } from "@terno/mail";
import { afterEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";

/** Plan 18 through the RPC surface: warm, suggestions, the setting, account removal, MCP and the lifecycle. */
const NOW = Date.UTC(2026, 9, 22, 12);
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const registry: ProviderRegistry = {
  create: () => ({ async verify() {}, async sync() {}, async execute() {}, async close() {} }),
  async verifyImap() {},
  async connectGmail() {
    throw new Error("not in tests");
  },
} as unknown as ProviderRegistry;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "terno-ac-backend-"));
  const backend = new Backend({ dbPath: join(dir, "terno.db"), version: "test", cipher: plaintextCipher, providers: registry, now: () => NOW, autoSync: false });
  const connect = (origin: "renderer" | "mcp") => {
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId: origin, origin });
    return new RpcClient(c);
  };
  cleanups.push(async () => {
    await backend.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  const accountId = createAccount(sqlDb(backend.store), { kind: "imap", email: "me@example.com", displayName: "Me", color: "indigo", providerConfig: { senderName: "Luis" } }).id;
  return { backend, client: connect("renderer"), mcp: connect("mcp"), accountId, dir };
}

const me = { name: "Luis", email: "me@example.com" };
const ana = { name: "Ana Martínez", email: "ana@acme.studio" };

describe("autocomplete over RPC", () => {
  it("nothing is built until a composer warms it; then recipients and text answer from memory", async () => {
    const { backend, client, accountId } = setup();
    await backend.ingestSliced([
      msg({ accountId, from: { name: "Bob Stone", email: "bob@stone.io" }, to: [me] }),
      ...[1, 2, 3, 4].map(() => msg({ accountId, from: me, to: [ana], isSent: true, inInbox: false, bodyText: "Let me know if you have any questions." })),
    ]);
    await new Promise((r) => setTimeout(r, 20));
    expect(backend.autocomplete.report.state).toBe("cold");
    await client.call("compose.warm", {});
    // a first lookup waits briefly for the first build
    const r = await client.call("compose.suggestRecipients", { query: "an" });
    expect(r).toEqual({ items: [ana], ready: true });
    expect((await client.call("compose.suggestRecipients", { query: "b", exclude: [] })).items).toEqual([{ name: "Bob Stone", email: "bob@stone.io" }]);
    // what is already in the draft is skipped; own addresses only when typed in full
    expect((await client.call("compose.suggestRecipients", { query: "an", exclude: ["ANA@acme.studio"] })).items).toEqual([]);
    expect((await client.call("compose.suggestRecipients", { query: "me" })).items).toEqual([]);
    await backend.autocomplete.idle();
    expect(await client.call("compose.suggestText", { before: "Let me know if" })).toEqual({ text: " you have any questions." });
    // a new message after warm: followed through the change notification
    await backend.ingestSliced([msg({ accountId, from: { name: "Carla Ruiz", email: "carla@ruiz.mx" }, to: [me] })]);
    await backend.autocomplete.idle();
    expect((await client.call("compose.suggestRecipients", { query: "carl" })).items).toHaveLength(1);
  });

  it("the setting turns body suggestions off (model and snapshot gone) and on again", async () => {
    const { backend, client, accountId, dir } = setup();
    await backend.ingestSliced([1, 2, 3, 4].map(() => msg({ accountId, from: me, to: [ana], isSent: true, inInbox: false, bodyText: "Let me know if you have any questions." })));
    await client.call("compose.warm", {});
    await backend.autocomplete.idle();
    await backend.autocomplete.close();
    // closing wrote the snapshots beside the database
    expect(existsSync(join(dir, "terno.db.phrases"))).toBe(true);
    expect(existsSync(join(dir, "terno.db.contacts"))).toBe(true);
    const s = await client.call("settings.update", { composeSuggestions: false });
    expect(s.composeSuggestions).toBe(false);
    expect(existsSync(join(dir, "terno.db.phrases"))).toBe(false);
  });

  it("turning it off while warm drops the model; on again relearns it", async () => {
    const { backend, client, accountId } = setup();
    await backend.ingestSliced([1, 2, 3, 4].map(() => msg({ accountId, from: me, to: [ana], isSent: true, inInbox: false, bodyText: "Let me know if you have any questions." })));
    await client.call("compose.warm", {});
    await backend.autocomplete.idle();
    await client.call("settings.update", { composeSuggestions: false });
    expect(await client.call("compose.suggestText", { before: "Let me know if" })).toEqual({ text: null });
    await client.call("settings.update", { composeSuggestions: true });
    await backend.autocomplete.idle();
    expect((await client.call("compose.suggestText", { before: "Let me know if" })).text).toBe(" you have any questions.");
  });

  it("removing an account resets the models: none of its people linger", async () => {
    const { backend, client, accountId } = setup();
    const other = createAccount(sqlDb(backend.store), { kind: "imap", email: "two@example.com", displayName: "Two", color: "indigo", providerConfig: {} }).id;
    await backend.ingestSliced([msg({ accountId: other, from: { name: "Zed Zero", email: "zed@zero.io" }, to: [{ name: "", email: "two@example.com" }] }), msg({ accountId, from: ana, to: [me] })]);
    await client.call("compose.warm", {});
    expect((await client.call("compose.suggestRecipients", { query: "zed" })).items).toHaveLength(1);
    await client.call("accounts.remove", { id: other });
    await backend.autocomplete.idle();
    expect((await client.call("compose.suggestRecipients", { query: "zed" })).items).toEqual([]);
    expect((await client.call("compose.suggestRecipients", { query: "ana" })).items).toEqual([ana]);
  });

  it("agents (MCP) can't read suggestions", async () => {
    const { mcp } = setup();
    await expect(mcp.call("compose.suggestRecipients", { query: "a" })).rejects.toThrow();
    await expect(mcp.call("compose.suggestText", { before: "Hi" })).rejects.toThrow();
    await expect(mcp.call("compose.warm", {})).rejects.toThrow();
  });

  it("the request limits are enforced", async () => {
    const { client } = setup();
    await expect(client.call("compose.suggestRecipients", { query: "a".repeat(321) })).rejects.toThrow();
    await expect(client.call("compose.suggestText", { before: "a".repeat(2001) })).rejects.toThrow();
    await expect(client.call("compose.suggestRecipients", { query: "a", limit: 11 })).rejects.toThrow();
  });
});
