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
  const dir = mkdtempSync(join(tmpdir(), "unica-export-"));
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
  expect(dump).toMatchObject({ format: "unica-export", version: 2 });
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
