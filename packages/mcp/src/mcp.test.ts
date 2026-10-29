import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Backend, plaintextCipher, seedDemo, startAgentSocket, type AgentEndpoint } from "@terno/backend";
import { demoRegistry } from "@terno/mail";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppConnection } from "./connection";
import { createMcpServer } from "./server";
import { sqlDb } from "@terno/db";

let dir: string;
let backend: Backend;
let endpoint: AgentEndpoint;
let client: Client;
let app: AppConnection;

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  const raw = r.content[0]!.text;
  let json: any = null;
  try {
    json = JSON.parse(raw);
  } catch {
    /* plain-text error */
  }
  return { isError: Boolean(r.isError), json, raw };
}

beforeAll(async () => {
  // short path: unix socket paths are limited to ~104 bytes on macOS
  dir = mkdtempSync(join("/tmp", "umcp-"));
  backend = new Backend({ dbPath: join(dir, "u.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false });
  await seedDemo(backend.store, { threads: 400, accounts: 3 });
  endpoint = await startAgentSocket(backend, join(dir, "a.sock"), join(dir, "a.token"));
  app = new AppConnection({ socketPath: endpoint.socketPath, tokenPath: endpoint.tokenPath });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(app).connect(a);
  client = new Client({ name: "test", version: "1" });
  await client.connect(b);
});

afterAll(async () => {
  app.close();
  await endpoint.close();
  await backend.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("terno MCP server", () => {
  it("exposes the documented tools with annotations", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["categorize", "create_draft", "create_filter", "get_thread", "list_accounts", "list_filters", "list_threads", "search_emails", "send_email", "update_threads"].sort(),
    );
    expect(tools.find((t) => t.name === "search_emails")!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "send_email")!.annotations?.destructiveHint).toBe(true);
  });

  it("gives one view over all accounts and searches across them", async () => {
    const accounts = await call("list_accounts");
    expect(accounts.json.accounts).toHaveLength(3);
    const res = await call("search_emails", { query: "factura", limit: 50 });
    expect(res.json.results.length).toBeGreaterThan(0);
    const emails = new Set(res.json.results.map((r: { account: string }) => r.account));
    expect(emails.size).toBeGreaterThan(1); // results come from several accounts
    expect(res.json.results[0]).toMatchObject({ threadId: expect.any(Number), subject: expect.any(String), date: expect.stringMatching(/^\d{4}-/) });
  });

  it("searches everywhere, Spam and Trash too, and says where each result lives (plan 64)", async () => {
    const all = await call("search_emails", { query: "factura", limit: 100 });
    const [spam, trash] = all.json.results.slice(0, 2).map((r: { threadId: number }) => r.threadId);
    await backend.store.threads.act({ threadIds: [spam], action: "spam", signal: null, now: Date.now() });
    await backend.store.threads.act({ threadIds: [trash], action: "trash", signal: null, now: Date.now() });
    const res = await call("search_emails", { query: "factura", limit: 100 });
    const placeOf = (id: number) => res.json.results.find((r: { threadId: number }) => r.threadId === id)?.place;
    expect([placeOf(spam), placeOf(trash)]).toEqual(["spam", "trash"]);
    // in:all still means everything but Spam and Trash
    const scoped = await call("search_emails", { query: "in:all factura", limit: 100 });
    expect(scoped.json.results.map((r: { threadId: number }) => r.threadId)).not.toContain(spam);
    await backend.store.threads.act({ threadIds: [spam, trash], action: "moveToInbox", signal: null, now: Date.now() });
  });

  it("reads HTML-only mail as plain text", async () => {
    const res = await call("search_emails", { query: "from:boletin@xataka.com", limit: 1 });
    const thread = await call("get_thread", { threadId: res.json.results[0].threadId });
    const body: string = thread.json.messages[0].body;
    expect(body).not.toMatch(/<[a-z]/i);
    expect(body.length).toBeGreaterThan(20);
  });

  it("triages and categorizes through the backend (not learning signals)", async () => {
    const inbox = await call("list_threads", { view: "inbox", limit: 3 });
    const ids = inbox.json.threads.map((t: { threadId: number }) => t.threadId);
    expect((await call("update_threads", { threadIds: ids, action: "archive" })).json.affected).toBe(3);
    const after = await call("list_threads", { view: "inbox", limit: 50 });
    expect(after.json.threads.map((t: { threadId: number }) => t.threadId)).not.toContain(ids[0]);
    const cat = await call("categorize", { threadIds: ids, categoryName: "Agente" });
    expect(cat.json.added).toBe(3);
    expect(sqlDb(backend.store).get("SELECT count(*) c FROM thread_categories WHERE added_by = 'agent'")).toEqual({ c: 3 });
    expect(sqlDb(backend.store).get("SELECT count(*) c FROM user_actions WHERE at > ?", Date.now() - 60_000)).toEqual({ c: 0 });
  });

  it("refuses to send unless the user allowed it, but can always draft", async () => {
    const accountId = (await call("list_accounts")).json.accounts[0].id;
    const msg = { accountId, to: [{ name: "Ana", email: "ana@example.com" }], subject: "Hola", body: "Prueba" };
    const denied = await call("send_email", msg);
    expect(denied.isError).toBe(true);
    expect(denied.raw).toMatch(/create_draft/);
    const draft = await call("create_draft", msg);
    expect(draft.json.draftId).toEqual(expect.any(Number));
    sqlDb(backend.store).run("INSERT OR REPLACE INTO settings (key, value_json) VALUES ('app', ?)", JSON.stringify({ allowAgentSend: true }));
    expect((await call("send_email", msg)).json).toMatchObject({ queued: true, opId: expect.any(String) });
  });

  it("previews filters (dry run) before creating them and validates rules", async () => {
    const rule = { match: "all", conditions: [{ field: "fromDomain", op: "equals", value: "uber.com" }], actions: [{ type: "archive" }] };
    const dry = await call("create_filter", { name: "Uber", rule, dryRun: true });
    expect(dry.json.wouldMatch).toEqual(expect.any(Number));
    expect((await call("list_filters")).json.some((f: { name: string }) => f.name === "Uber")).toBe(false);
    expect((await call("create_filter", { name: "Uber", rule })).json.filterId).toEqual(expect.any(Number));
    const bad = await client.callTool({ name: "create_filter", arguments: { name: "x", rule: { match: "all", conditions: [], actions: [] } } });
    expect(bad.isError).toBe(true);
  });

  it("fails fast (no hang) if the app drops the connection during the handshake", async () => {
    const { createServer } = await import("node:net");
    const { writeFileSync } = await import("node:fs");
    const sock = join(dir, "drop.sock");
    const server = createServer((s) => s.destroy());
    await new Promise<void>((r) => server.listen(sock, () => r()));
    writeFileSync(join(dir, "drop.token"), "x");
    const { connectToApp } = await import("./connection");
    const started = Date.now();
    await expect(connectToApp({ socketPath: sock, tokenPath: join(dir, "drop.token") })).rejects.toThrow(/not running/);
    expect(Date.now() - started).toBeLessThan(2000);
    server.close();
  });

  it("reports clearly when the app is not running", async () => {
    const offline = new AppConnection({ socketPath: join(dir, "nope.sock"), tokenPath: join(dir, "nope.token") });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createMcpServer(offline).connect(a);
    const c = new Client({ name: "t2", version: "1" });
    await c.connect(b);
    const r = (await c.callTool({ name: "list_accounts", arguments: {} })) as { content: { text: string }[]; isError: boolean };
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/not running/);
  });
});
