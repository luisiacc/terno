/** app.export: what a browser mailbox can't afford to lose (categories, filters, settings, unsent work), never secrets. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { demoRegistry } from "@terno/mail";
import { afterEach, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { seedDemo } from "./demo";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

it("exports categories, filters, settings, drafts and unsent ops, and no secret", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-export-"));
  const backend = new Backend({ dbPath: join(dir, "u.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false });
  cleanups.push(async () => {
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  await seedDemo(backend.store, { threads: 200, accounts: 2 });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "r", origin: "renderer" });
  const client = new RpcClient(c);
  await backend.setSecret("ai:anthropic:apiKey", "sk-ant-secret-1234");
  await client.call("settings.update", { gmailClientId: "client-1.apps.googleusercontent.com", density: "compact" });
  const { accounts } = await client.call("app.bootstrap", {});
  const thread = (await client.call("threads.list", { view: "inbox", limit: 1 })).items[0]!;
  await client.call("threads.act", { threadIds: [thread.id], action: "archive" });
  await client.call("drafts.save", { accountId: accounts[0]!.id, to: [{ name: "", email: "ana@example.com" }], cc: [], subject: "Borrador", bodyText: "hola" });

  const dump = await client.call("app.export", {});
  expect(dump).toMatchObject({ format: "terno-export", version: 2 });
  expect(dump.categories.length).toBeGreaterThan(0);
  expect(dump.filters.map((f) => f.name)).toContain("Notificaciones de GitHub → Desarrollo");
  expect(dump.settings).toMatchObject({ gmailClientId: "client-1.apps.googleusercontent.com", density: "compact" });
  expect(dump.accounts.map((a) => a.email)).toEqual(accounts.map((a) => a.email));
  expect(dump.drafts).toMatchObject([{ subject: "Borrador", mode: "new", bcc: [], quotedText: "", inReplyTo: null, forwardOf: null }]);
  expect(dump.ops).toMatchObject([{ kind: "archive", state: "queued" }]);
  expect(JSON.stringify(dump)).not.toContain("sk-ant-secret");
  // agents can't take it
  await expect(backend.server.invoke("app.export", {}, { clientId: "agent", origin: "mcp" })).rejects.toBeTruthy();
});

it("exports exact draft attachment bytes, imports with fresh account-owned IDs, and preserves byte-distinct drafts on repeated import", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-export-assets-"));
  const make = (name: string) => {
    const b = new Backend({ dbPath: join(dir, name), version: "test", cipher: plaintextCipher, providers: demoRegistry, autoSync: false });
    cleanups.push(() => b.stop());
    return b;
  };
  cleanups.push(async () => { rmSync(dir, { recursive: true, force: true }); });
  const source = make("source.db"); const target = make("target.db");
  const account = async (b: Backend) => (await b.store.accounts.create({ kind: "gmail", email: "a@test.com", displayName: "A", color: "indigo", now: 0 })).account.id;
  const a = await account(source); const other = await account(target);
  for (const dataBase64 of ["AP+A", "AQID"]) {
    const ref = await source.store.attachments.create({ accountId: a, filename: "same.bin", mime: "application/octet-stream", size: 3, now: 0 });
    await source.store.attachments.append(a, ref.assetId, 0, dataBase64); await source.store.attachments.seal(a, ref.assetId);
    await source.store.drafts.save({ accountId: a, to: [], cc: [], subject: "same draft", bodyText: "same", attachments: [ref] }, 0);
  }
  const invoke = (b: Backend) => { const [c,s] = createMemoryTransportPair(); b.connect(s, { clientId: "r", origin: "renderer" }); return new RpcClient(c); };
  const dump = await invoke(source).call("app.export", {});
  expect(dump.drafts.map((d) => d.attachments?.[0]?.chunks)).toEqual([["AP+A"], ["AQID"]]);
  const dest = invoke(target);
  expect((await dest.call("app.import", { data: dump })).drafts).toBe(2);
  const drafts = await target.store.drafts.list();
  expect(drafts).toHaveLength(2);
  const parts = drafts.map((d) => JSON.parse(d.attachments_json)[0]);
  expect(parts.map((a) => a.assetId)).not.toEqual((await source.store.drafts.list()).map((d) => JSON.parse(d.attachments_json)[0].assetId));
  expect(await Promise.all(parts.map((p) => target.store.attachments.read(other, p.assetId, 0)))).toEqual(["AP+A", "AQID"]);
  expect((await dest.call("app.import", { data: dump })).drafts).toBe(0);
  expect(await target.store.drafts.list()).toHaveLength(2);
  const damaged = structuredClone(dump);
  damaged.drafts[0]!.attachments![0]!.chunks = [];
  await expect(dest.call("app.import", { data: damaged })).rejects.toThrow();
  expect(await target.store.drafts.list()).toHaveLength(2);
  const disconnected = make("disconnected.db");
  await expect(invoke(disconnected).call("app.import", { data: dump })).rejects.toThrow();
  expect(await disconnected.store.drafts.list()).toHaveLength(0);
});
