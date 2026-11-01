import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import imapkit from "imapkit";
import { ImapFlow } from "imapflow";
import { expect, it, vi } from "vitest";
import { createRegistry } from "@terno/mail";
import type { ProviderContext } from "@terno/mail/portable";
import { openDatabase, SqlMailStore } from "@terno/db";
import { nodePlatform } from "../../db/src/node-driver";
import { Backend, plaintextCipher } from "./backend";
import { createNodeIncomingProcessor } from "./incoming-worker";

it("retains one IMAP body obligation without reconnect or BODY replay after eight acknowledged preparation conflicts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "terno-body-conflict-"));
  const server = imapkit({ plugins: ["SPECIAL-USE"], storage: { INBOX: {} } });
  const port = await server.start(0, "127.0.0.1");
  const raw = `From: synthetic@example.test\r\nSubject: Synthetic\r\nMessage-ID: <conflict@example.test>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${"new complete phrase\r\n".repeat(8000)}`;
  server.control.addMessage("INBOX", { raw });
  const db = openDatabase(join(directory, "synthetic.db"));
  let armed = false, ready = false, read = false, conflicts = 0, bodies = 0, connections = 0;
  let filter!: Awaited<ReturnType<SqlMailStore["filters"]["save"]>>;
  let store!: SqlMailStore;
  const platform = { ...nodePlatform, async yield() {
    await nodePlatform.yield();
    if (armed && ready && read && conflicts < 8) {
      read = false; conflicts++;
      filter = await store.filters.save({ ...filter, rule: { ...filter.rule, conditions: [{ field: "body", op: "contains", value: `conflict${conflicts}` }] } }, conflicts + 10);
    }
  } };
  store = new SqlMailStore(db, { platform, instantSearch: false });
  const spies: { mockRestore(): void }[] = [];
  let context!: ProviderContext;
  const registry = createRegistry({ imap: { allowInsecure: true } });
  const fetch = ImapFlow.prototype.fetch, connect = ImapFlow.prototype.connect;
  spies.push(vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Unexpected HTTP in synthetic IMAP test"); }));
  spies.push(vi.spyOn(ImapFlow.prototype, "connect").mockImplementation(function (this: ImapFlow, ...args) { connections++; return connect.apply(this, args); }));
  spies.push(vi.spyOn(ImapFlow.prototype, "fetch").mockImplementation(async function* (this: ImapFlow, ...args) { if (args[1]?.source) bodies++; yield* fetch.apply(this, args); }));
  const get = db.get.bind(db), run = db.run.bind(db);
  spies.push(vi.spyOn(db, "get").mockImplementation((sql, ...args) => { const r = get(sql, ...args); if (armed && sql.includes("SELECT ordinal,value FROM body_parts") && args[1] === 2) read = true; return r; }));
  spies.push(vi.spyOn(db, "run").mockImplementation((sql, ...args) => { const r = run(sql, ...args); if (armed && sql.startsWith("UPDATE body_captures SET text_parts")) ready = true; return r; }));
  const backend = new Backend({ store, platform, incomingProcessor: createNodeIncomingProcessor(), providers: { ...registry, create(ctx) { context = ctx; return registry.create(ctx); } }, cipher: plaintextCipher, version: "test", autoSync: false, instantSearch: false, iconTransport: null });
  try {
    await backend.ready;
    const { account } = await store.accounts.create({ kind: "imap", email: "synthetic@example.test", displayName: "Synthetic", color: "indigo", now: 1 });
    await store.accounts.setProviderConfig(account.id, { imap: { host: "127.0.0.1", port, secure: false, user: "testuser" }, smtp: { host: "127.0.0.1", port: 1, secure: false, user: "testuser" } });
    await store.secrets.put(`account:${account.id}:password`, await plaintextCipher.encrypt("testpass"));
    await backend.syncAccount(account.id);
    const message = (await store.debug.snapshot()).messages[0]!, location = (await context.store.locations.of([message.id]))[0]!;
    await store.sync.setBody(message.id, "exact old cached body", "<p>old cached HTML</p>", { now: 2, classifier: null });
    await store.attachments.retry(account.id, message.id);
    const locator = { kind: "imap" as const, messageId: message.id, mailbox: location.mailbox, uid: location.uid, uidvalidity: location.uidvalidity };
    await store.captureRepairs.block(account.id, locator, "mime-depth", 0);
    const blocked = (await store.captureRepairs.get(account.id, locator))!;
    await store.captureRepairs.retry(account.id, blocked.key, blocked.revision);
    const before = await store.captureRepairs.get(account.id, locator);
    filter = await store.filters.save({ name: "concurrent edit", enabled: true, source: "manual", rule: { match: "all", conditions: [{ field: "body", op: "contains", value: "conflict0" }], actions: [{ type: "star" }] } }, 3);
    bodies = 0; connections = 0; armed = true;
    await backend.syncAccount(account.id);
    expect(conflicts).toBe(8);
    expect(bodies).toBe(1);
    expect(connections).toBe(0);
    const current = (await store.threads.get(message.threadId))!.messages[0]!;
    expect(current.bodyText === "exact old cached body" && current.bodyHtml === "<p>old cached HTML</p>").toBe(true);
    expect(await store.captureRepairs.get(account.id, locator)).toEqual(before);
    expect((await context.store.pendingBodies(10)).map((m) => m.id)).toEqual([message.id]);
  } finally { armed = false; await backend.stop(); for (const spy of spies) spy.mockRestore(); await server.stop(); rmSync(directory, { recursive: true, force: true }); }
});
