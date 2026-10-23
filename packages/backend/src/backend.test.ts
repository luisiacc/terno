import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeProvider } from "@unica/ai";
import { createMemoryTransportPair, RpcClient, type Events } from "@unica/core/rpc";
import { claimReadyOps, createAccount, enqueueOp, getOp, type IncomingMessage } from "@unica/db";
import { ProviderError, type MailProvider, type ProviderOp, type ProviderRegistry, type SyncSink } from "@unica/mail";
import { afterEach, describe, expect, it } from "vitest";
import { startAgentSocket } from "./agent-socket";
import { Backend, plaintextCipher } from "./backend";
import { socketTransport } from "./transports";

const NOW = Date.UTC(2026, 9, 22, 12);
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface ScriptedProvider extends MailProvider {
  executed: ProviderOp[];
  failNext: ProviderError | null;
  beforeExecute?: (op: ProviderOp) => void;
  sink: SyncSink | null;
}

function scriptedRegistry() {
  const providers = new Map<number, ScriptedProvider>();
  const registry: ProviderRegistry = {
    create(ctx) {
      const p: ScriptedProvider = {
        executed: [],
        failNext: null,
        sink: null,
        async verify() {},
        async sync(sink) {
          p.sink = sink;
        },
        async execute(op) {
          p.beforeExecute?.(op);
          if (p.failNext) {
            const e = p.failNext;
            p.failNext = null;
            throw e;
          }
          p.executed.push(op);
          if (op.kind === "send") return { providerMsgId: `srv-${op.id}` };
        },
        async close() {},
      };
      providers.set(ctx.account.id, p);
      return p;
    },
    async verifyImap(_config, password) {
      if (password !== "correct") throw new Error("AUTHENTICATIONFAILED");
    },
    async connectGmail() {
      throw new Error("not in tests");
    },
  };
  return { registry, providers };
}

function setup(options: { dir?: string } = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "unica-backend-"));
  const { registry, providers } = scriptedRegistry();
  const backend = new Backend({
    dbPath: join(dir, "unica.db"),
    version: "test",
    cipher: plaintextCipher,
    providers: registry,
    aiFactory: (kind) => (kind === "fake" ? createFakeProvider() : null),
    now: () => NOW,
    autoSync: false,
  });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "renderer", origin: "renderer" });
  const client = new RpcClient(c);
  const events: { name: keyof Events; payload: unknown }[] = [];
  for (const name of ["changed", "counts", "op"] as const) client.on(name, (payload) => events.push({ name, payload }));
  cleanups.push(async () => {
    await backend.stop().catch(() => {});
    if (!options.dir) rmSync(dir, { recursive: true, force: true });
  });
  const accountId = createAccount(backend.db, { kind: "imap", email: "me@example.com", displayName: "Me", color: "indigo", providerConfig: { senderName: "Luis" } }).id;
  return { backend, client, events, providers, accountId, dir };
}

let n = 0;
function incoming(accountId: number, over: Partial<IncomingMessage> = {}): IncomingMessage {
  n++;
  return {
    accountId,
    providerMsgId: `p${n}`,
    providerThreadId: null,
    rfcMessageId: `m${n}@x`,
    inReplyTo: null,
    references: [],
    from: { name: "Morning Brew", email: "crew@morningbrew.com" },
    to: [{ name: "Me", email: "me@example.com" }],
    cc: [],
    bcc: [],
    subject: `Brief ${n}`,
    date: NOW - n * 60_000,
    snippet: "",
    bodyText: "Markets today",
    bodyHtml: null,
    bodyState: "full",
    listId: "daily.morningbrew.com",
    isRead: false,
    isStarred: false,
    inInbox: true,
    isSent: false,
    isDraft: false,
    isTrash: false,
    isSpam: false,
    hasAttachments: false,
    size: 10,
    ...over,
  };
}

const tick = () => new Promise((r) => setImmediate(r));

describe("local-first actions", () => {
  it("archive updates the inbox immediately, queues one op, and the worker settles it", async () => {
    const { backend, client, providers, accountId, events } = setup();
    await backend.ingestSliced([incoming(accountId), incoming(accountId)]);
    const inbox = await client.call("threads.list", { view: "inbox" });
    expect(inbox.items).toHaveLength(2);
    backend.provider(accountId);

    await client.call("threads.act", { threadIds: [inbox.items[0]!.id], action: "archive" });
    expect((await client.call("threads.list", { view: "inbox" })).items).toHaveLength(1);
    expect(providers.get(accountId)!.executed).toEqual([]); // provider not touched yet

    expect(await backend.runWorker()).toBe(1);
    const [op] = providers.get(accountId)!.executed;
    expect(op).toMatchObject({ kind: "archive", target: { messageIds: [expect.any(Number)] } });
    await tick();
    expect(events.some((e) => e.name === "changed")).toBe(true);
    expect(events.find((e) => e.name === "op")?.payload).toMatchObject({ state: "succeeded", kind: "archive" });
  });

  it("retryable provider failures back off; non-retryable ones fail", async () => {
    const { backend, client, providers, accountId } = setup();
    await backend.ingestSliced([incoming(accountId)]);
    const [t] = (await client.call("threads.list", { view: "inbox" })).items;
    backend.provider(accountId)!;
    providers.get(accountId)!.failNext = new ProviderError("ETIMEDOUT", true);
    await client.call("threads.act", { threadIds: [t!.id], action: "star" });
    await backend.runWorker();
    const [info] = await client.call("ops.list", {});
    expect(info).toMatchObject({ state: "queued", attempts: 1, lastError: "ETIMEDOUT" });
  });
});

describe("sending", () => {
  it("shows the reply in the thread instantly and adopts the provider id after sending", async () => {
    const { backend, client, providers, accountId } = setup();
    await backend.ingestSliced([incoming(accountId, { from: { name: "Ana", email: "ana@corp.io" }, listId: null })]);
    const [t] = (await client.call("threads.list", { view: "inbox" })).items;
    const original = (await client.call("threads.get", { threadId: t!.id })).messages[0]!;
    backend.provider(accountId);

    const sent = await client.call("compose.send", {
      accountId,
      to: [{ name: "Ana", email: "ana@corp.io" }],
      subject: "Re: hola",
      bodyText: "¡Gracias!",
      inReplyToMessageId: original.id,
    });
    expect(sent.threadId).toBe(t!.id);
    const thread = await client.call("threads.get", { threadId: t!.id });
    expect(thread.messages.map((m) => m.isSent)).toEqual([false, true]);
    expect(thread.messages[1]!.from).toEqual({ name: "Luis", email: "me@example.com" });

    await backend.runWorker();
    const payload = providers.get(accountId)!.executed[0]!.payload as { inReplyTo: string; references: string[] };
    expect(payload.inReplyTo).toBe(original.rfcMessageId);
    expect(payload.references).toContain(original.rfcMessageId);
    expect(backend.db.get("SELECT provider_msg_id FROM messages WHERE is_sent = 1")).toEqual({ provider_msg_id: `srv-${sent.opId}` });
  });

  it("discarding an unknown send leaves no empty thread behind", async () => {
    const { backend, client, providers, accountId } = setup();
    backend.provider(accountId);
    providers.get(accountId)!.failNext = new ProviderError("connection closed after DATA", false, true);
    const sent = await client.call("compose.send", { accountId, to: [{ name: "", email: "x@y.com" }], subject: "Solo", bodyText: "." });
    await backend.runWorker();
    await client.call("ops.resolveUnknown", { opId: sent.opId, resolution: "discard" });
    expect(backend.db.get("SELECT count(*) c FROM threads")).toEqual({ c: 0 });
    expect((await client.call("threads.list", { view: "sent" })).items).toEqual([]);
  });

  it("an ambiguous send failure becomes unknown; discarding removes the optimistic copy", async () => {
    const { backend, client, providers, accountId } = setup();
    backend.provider(accountId);
    providers.get(accountId)!.failNext = new ProviderError("connection closed after DATA", false, true);
    const sent = await client.call("compose.send", { accountId, to: [{ name: "", email: "x@y.com" }], subject: "Hi", bodyText: "." });
    await backend.runWorker();
    expect(getOp(backend.db, sent.opId)!.state).toBe("unknown");
    await backend.runWorker();
    expect(providers.get(accountId)!.executed).toEqual([]); // never retried automatically
    await client.call("ops.resolveUnknown", { opId: sent.opId, resolution: "discard" });
    expect(backend.db.get("SELECT count(*) c FROM messages")).toEqual({ c: 0 });
  });

  it("an op superseded while its batch runs is skipped and the rest of the batch still runs", async () => {
    const { backend, client, providers, accountId } = setup();
    await backend.ingestSliced([incoming(accountId, { listId: null, from: { name: "A", email: "a@x.io" } })]);
    const [t] = (await client.call("threads.list", { view: "inbox" })).items;
    backend.provider(accountId);
    const p = providers.get(accountId)!;
    await client.call("threads.act", { threadIds: [t!.id], action: "markRead" });
    const sent = await client.call("compose.send", { accountId, to: [{ name: "", email: "b@y.com" }], subject: "s", bodyText: "t" });
    const markRead = backend.db.get<{ id: string }>("SELECT id FROM ops WHERE kind = 'markRead'")!.id;
    p.beforeExecute = (op) => {
      if (op.kind !== "markRead") return;
      // the user flips it back while the provider call is in flight, then the call fails
      enqueueOp(backend.db, { accountId, kind: "markUnread", target: { messageIds: op.target.messageIds! } });
      p.failNext = new ProviderError("ETIMEDOUT", true);
    };
    await backend.runWorker();
    expect(getOp(backend.db, markRead)).toBeNull(); // superseded, never retried
    expect(getOp(backend.db, sent.opId)!.state).toBe("succeeded"); // not stranded in running
  });

  it("a send interrupted by a crash is reported as unknown after restart, not resent", async () => {
    const first = setup();
    first.backend.db.run("DELETE FROM accounts"); // keep this test's account list clean
    const accountId = createAccount(first.backend.db, { kind: "imap", email: "a@b.c", displayName: "A", color: "indigo" }).id;
    enqueueOp(first.backend.db, { accountId, kind: "send", target: {}, payload: { subject: "x" } });
    claimReadyOps(first.backend.db); // running when the process dies
    await first.backend.stop();
    const second = setup({ dir: first.dir });
    const [op] = await second.client.call("ops.list", {});
    expect(op).toMatchObject({ kind: "send", state: "unknown" });
  });
});

describe("filters on incoming mail", () => {
  it("applies enabled filters once, and they are not learning signals", async () => {
    const { backend, client, accountId } = setup();
    const cat = await client.call("categories.create", { name: "Lecturas", color: "violet" });
    await client.call("filters.save", {
      name: "Brew",
      enabled: true,
      source: "manual",
      rule: { match: "all", conditions: [{ field: "listId", op: "equals", value: "daily.morningbrew.com" }], actions: [{ type: "archive" }, { type: "addCategory", categoryId: cat.id }] },
    });
    await backend.ingestSliced([incoming(accountId), incoming(accountId), incoming(accountId, { listId: null, from: { name: "Ana", email: "ana@x.io" } })]);
    expect((await client.call("threads.list", { view: "inbox" })).items.map((t) => t.fromEmail)).toEqual(["ana@x.io"]);
    expect((await client.call("threads.list", { view: "all", categoryId: cat.id })).items).toHaveLength(2);
    expect(backend.db.get("SELECT count(*) c FROM user_actions")).toEqual({ c: 0 });
    expect(backend.db.get("SELECT count(*) c FROM ops WHERE kind = 'archive'")).toEqual({ c: 1 }); // one op for both messages
    const [filter] = await client.call("filters.list", {});
    expect(filter!.hits).toBe(2);
  });

  it("re-evaluates body filters when a body arrives later", async () => {
    const { backend, client, accountId, providers } = setup();
    await client.call("filters.save", {
      name: "Baja",
      enabled: true,
      source: "manual",
      rule: { match: "all", conditions: [{ field: "body", op: "contains", value: "darse de baja" }], actions: [{ type: "trash" }] },
    });
    await backend.ingestSliced([incoming(accountId, { bodyText: null, bodyState: "none", listId: null })]);
    expect((await client.call("threads.list", { view: "inbox" })).items).toHaveLength(1);
    await backend.syncAccount(accountId);
    const id = backend.db.get<{ id: number }>("SELECT id FROM messages")!.id;
    await providers.get(accountId)!.sink!.setBody(id, "Para darse de baja haz clic", null);
    expect((await client.call("threads.list", { view: "trash" })).items).toHaveLength(1);
    await providers.get(accountId)!.sink!.setBody(id, "Para darse de baja haz clic", null);
    expect(backend.db.get("SELECT count(*) c FROM ops WHERE kind = 'trash'")).toEqual({ c: 1 }); // applied once
  });

  it("re-evaluates body filters when the body arrives through an upsert of the same message", async () => {
    const { backend, client, accountId } = setup();
    await client.call("filters.save", {
      name: "Baja",
      enabled: true,
      source: "manual",
      rule: { match: "all", conditions: [{ field: "body", op: "contains", value: "darse de baja" }], actions: [{ type: "trash" }] },
    });
    const first = incoming(accountId, { bodyText: null, bodyState: "none", listId: null });
    await backend.ingestSliced([first]);
    await backend.ingestSliced([{ ...first, bodyText: "Para darse de baja", bodyState: "full" }]);
    expect((await client.call("threads.list", { view: "trash" })).items).toHaveLength(1);
  });

  it("a filter pointing at a deleted category doesn't block ingestion", async () => {
    const { backend, client, accountId } = setup();
    const cat = await client.call("categories.create", { name: "Temp", color: "rose" });
    await client.call("filters.save", { name: "c", enabled: true, source: "manual", rule: { match: "all", conditions: [{ field: "subject", op: "contains", value: "brief" }], actions: [{ type: "addCategory", categoryId: cat.id }] } });
    backend.db.run("PRAGMA foreign_keys = OFF");
    backend.db.run("DELETE FROM categories WHERE id = ?", cat.id);
    backend.db.run("PRAGMA foreign_keys = ON");
    await backend.ingestSliced([incoming(accountId)]);
    expect((await client.call("threads.list", { view: "inbox" })).items).toHaveLength(1);
    expect(backend.db.get("SELECT count(*) c FROM filter_applications")).toEqual({ c: 0 }); // claim rolled back with the failed action
  });

  it("editing a filter while it's being bulk-applied leaves no stale claims", async () => {
    const { backend, client, accountId } = setup();
    await backend.ingestSliced(Array.from({ length: 1500 }, () => incoming(accountId)));
    const rule = { match: "all" as const, conditions: [{ field: "fromDomain" as const, op: "equals" as const, value: "morningbrew.com" }], actions: [{ type: "markRead" as const }] };
    const f = await client.call("filters.save", { name: "r", enabled: true, source: "manual", rule });
    const applying = client.call("filters.apply", { id: f.id }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 5));
    await client.call("filters.save", { id: f.id, name: "r", enabled: true, source: "manual", rule: { ...rule, actions: [{ type: "star" as const }] } });
    await applying;
    expect(backend.db.get("SELECT count(*) c FROM filter_applications")).toEqual({ c: 0 });
  });

  it("previews and bulk-applies a filter to existing mail", async () => {
    const { backend, client, accountId } = setup();
    await backend.ingestSliced(Array.from({ length: 30 }, () => incoming(accountId)));
    const rule = { match: "all" as const, conditions: [{ field: "fromDomain" as const, op: "equals" as const, value: "morningbrew.com" }], actions: [{ type: "markRead" as const }] };
    const preview = await client.call("filters.preview", { rule, limit: 5 });
    expect(preview.count).toBe(30);
    expect(preview.sample).toHaveLength(5);
    const f = await client.call("filters.save", { name: "read", enabled: true, source: "manual", rule });
    expect(await client.call("filters.apply", { id: f.id })).toEqual({ matchedMessages: 30, affectedThreads: 30 });
    expect(await client.call("filters.apply", { id: f.id })).toEqual({ matchedMessages: 0, affectedThreads: 0 });
    expect((await client.call("counts.get", {})).inboxUnread).toBe(0);
  });
});

describe("learned filters", () => {
  it("proposes a rule after repeated explicit archives and turns it into a filter", async () => {
    const { backend, client, accountId } = setup();
    await backend.ingestSliced(Array.from({ length: 6 }, () => incoming(accountId)));
    const ids = (await client.call("threads.list", { view: "inbox" })).items.map((t) => t.id);
    for (const id of ids.slice(0, 5)) await client.call("threads.act", { threadIds: [id], action: "archive" });
    const [proposal] = await client.call("learning.proposals", {});
    expect(proposal).toMatchObject({ scope: "list", value: "daily.morningbrew.com", action: "archive", support: 5 });
    const filter = await client.call("learning.accept", { key: proposal!.key });
    expect(filter).toMatchObject({ source: "learned", enabled: true });
    expect(await client.call("learning.proposals", {})).toEqual([]);
  });

  it("repeated or no-op actions don't manufacture support", async () => {
    const { backend, client, accountId } = setup();
    await backend.ingestSliced([incoming(accountId)]);
    const [t] = (await client.call("threads.list", { view: "inbox" })).items;
    await client.call("threads.act", { threadIds: [t!.id, t!.id, t!.id, t!.id, t!.id], action: "archive" });
    await client.call("threads.act", { threadIds: [t!.id], action: "archive" }); // already archived
    expect(backend.db.get("SELECT count(*) c FROM user_actions")).toEqual({ c: 1 });
  });

  it("ignores actions taken by agents (MCP)", async () => {
    const { backend, accountId } = setup();
    await backend.ingestSliced(Array.from({ length: 6 }, () => incoming(accountId)));
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId: "agent", origin: "mcp" });
    const agent = new RpcClient(c);
    const ids = (await agent.call("threads.list", { view: "inbox" })).items.map((t) => t.id);
    for (const id of ids) await agent.call("threads.act", { threadIds: [id], action: "archive" });
    expect(await agent.call("threads.list", { view: "inbox" })).toMatchObject({ items: [] });
    expect(backend.db.get("SELECT count(*) c FROM user_actions")).toEqual({ c: 0 });
  });
});

describe("agent permissions", () => {
  it("MCP clients cannot send unless the user allows it, nor touch settings", async () => {
    const { backend, client, accountId } = setup();
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId: "agent", origin: "mcp" });
    const agent = new RpcClient(c);
    const send = { accountId, to: [{ name: "", email: "a@b.co" }], subject: "x", bodyText: "y" };
    await expect(agent.call("compose.send", send)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(agent.call("settings.update", { allowAgentSend: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await client.call("settings.update", { allowAgentSend: true });
    await expect(agent.call("compose.send", send)).resolves.toMatchObject({ opId: expect.any(String) });
  });
});

describe("search", () => {
  it("drops a superseded query from the same client (latest wins)", async () => {
    const { backend, client, accountId } = setup();
    await backend.ingestSliced([incoming(accountId)]);
    const first = client.call("threads.search", { query: "mark" });
    const second = client.call("threads.search", { query: "markets" });
    await expect(first).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(second).resolves.toMatchObject({ items: [expect.any(Object)], complete: true });
  });
});

describe("AI filters", () => {
  it("generates with the configured provider and explains when none is configured", async () => {
    const { client } = setup();
    await expect(client.call("filters.generate", { prompt: "archiva lo de uber.com" })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await client.call("settings.update", { aiProvider: "fake" });
    const out = await client.call("filters.generate", { prompt: "archiva lo de uber.com" });
    expect(out.rule.conditions).toEqual([{ field: "fromDomain", op: "equals", value: "uber.com" }]);
  });
});

describe("accounts", () => {
  it("rejects bad IMAP credentials and stores secrets encrypted-at-rest for good ones", async () => {
    const { client, backend } = setup();
    const base = {
      email: "hola@luiscordero.dev",
      displayName: "Freelance",
      imap: { host: "imap.fastmail.com", port: 993, secure: true, user: "hola@luiscordero.dev" },
      smtp: { host: "smtp.fastmail.com", port: 465, secure: true, user: "hola@luiscordero.dev" },
    };
    await expect(client.call("accounts.addImap", { ...base, password: "wrong" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const account = await client.call("accounts.addImap", { ...base, password: "correct" });
    expect(await backend.getSecret(`account:${account.id}:password`)).toBe("correct");
    // never exposed through bootstrap
    expect(JSON.stringify(await client.call("app.bootstrap", {}))).not.toContain("correct");
  });
});

describe("agent socket", () => {
  it("requires the token, then speaks the RPC envelope", async () => {
    const { backend } = setup();
    const dir = mkdtempSync(join(tmpdir(), "unica-sock-"));
    const endpoint = await startAgentSocket(backend, join(dir, "s.sock"), join(dir, "token"));
    cleanups.push(async () => {
      await endpoint.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const bad = connect(endpoint.socketPath);
    const rejected = await new Promise<string>((r) => bad.once("data", (d) => r(String(d))).write("nope\n"));
    expect(rejected).toContain("unauthorized");

    const { readFileSync } = await import("node:fs");
    const sock = connect(endpoint.socketPath);
    await new Promise<void>((r) => sock.once("data", () => r()).write(`${readFileSync(endpoint.tokenPath, "utf8")}\n`));
    const client = new RpcClient(socketTransport(sock));
    expect(await client.call("app.bootstrap", {})).toMatchObject({ version: "test" });
    client.close();
  });
});
