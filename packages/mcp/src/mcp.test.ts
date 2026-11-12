import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Backend, plaintextCipher, seedDemo } from "@terno/backend";
import { demoRegistry } from "@terno/mail";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppConnection } from "./connection";
import { createMcpServer } from "./server";
import { sqlDb } from "@terno/db";
import { msg } from "@terno/store/conformance";

let dir: string;
let backend: Backend;
let paths: { socketPath: string; tokenPath: string };
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
  paths = { socketPath: join(dir, "a.sock"), tokenPath: join(dir, "a.token") };
  backend = new Backend({ dbPath: join(dir, "u.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false, agentEndpoint: paths });
  await seedDemo(backend.store, { threads: 400, accounts: 3 });
  await backend.start();
  // plan 183: as the user would, in Settings → Agents
  await setAgents({ enabled: true, access: "organize" });
  app = new AppConnection(paths);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(app).connect(a);
  client = new Client({ name: "test", version: "1" });
  await client.connect(b);
});

function setAgents(agents: { enabled?: boolean; access?: "read" | "organize" | "send" }) {
  return backend.server.invoke("settings.update", { agents }, { clientId: "settings", origin: "renderer" });
}

afterAll(async () => {
  app.close();
  await backend.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("terno MCP server", () => {
  it("exposes the documented tools with annotations", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["categorize", "create_draft", "create_filter", "get_attachment", "get_thread", "list_accounts", "list_filters", "list_threads", "search_emails", "send_email", "update_threads", "wait_for_new_mail"].sort(),
    );
    expect(tools.find((t) => t.name === "search_emails")!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "get_attachment")!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "wait_for_new_mail")!.annotations?.readOnlyHint).toBe(true);
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

  it("plan 185: Spam and Trash only when the agent names them, and a thread there only when it asks (the owner's call)", async () => {
    const all = await call("search_emails", { query: "factura", limit: 100 });
    const [spam, trash] = all.json.results.slice(0, 2).map((r: { threadId: number }) => r.threadId);
    await backend.store.threads.act({ threadIds: [spam], action: "spam", signal: null, now: Date.now() });
    await backend.store.threads.act({ threadIds: [trash], action: "trash", signal: null, now: Date.now() });
    try {
      const ids = async (query: string) => (await call("search_emails", { query, limit: 100 })).json.results.map((r: { threadId: number }) => r.threadId);
      expect(await ids("factura")).not.toEqual(expect.arrayContaining([spam]));
      expect(await ids("factura")).not.toContain(trash);
      const named = await call("search_emails", { query: "in:spam factura", limit: 100 });
      expect(named.json.results.find((r: { threadId: number }) => r.threadId === spam)?.place).toBe("spam");
      expect(await ids("in:trash factura")).toContain(trash);
      expect((await call("list_threads", { view: "spam", limit: 100 })).json.threads.map((t: { threadId: number }) => t.threadId)).toContain(spam);
      // by id too: a thread can move to Spam after it was listed
      const refused = await call("get_thread", { threadId: spam });
      expect(refused.isError).toBe(true);
      expect(refused.raw).toMatch(/includeSpamTrash: true/);
      expect((await call("get_thread", { threadId: spam, includeSpamTrash: true })).json.place).toBe("spam");
      // the user's own search still looks everywhere (plan 64)
      const mine = await backend.server.invoke("threads.search", { query: "factura", limit: 100 }, { clientId: "renderer", origin: "renderer" });
      expect(mine.items.map((t) => t.id)).toEqual(expect.arrayContaining([spam, trash]));
    } finally {
      await backend.store.threads.act({ threadIds: [spam, trash], action: "moveToInbox", signal: null, now: Date.now() });
    }
  });

  it("plan 191: waits for new mail on one account, and says what to do when none comes", async () => {
    const accountId = (await call("list_accounts")).json.accounts[1].id;
    const waiting = call("wait_for_new_mail", { accountId, from: "github.com", waitSeconds: 30 });
    await expect.poll(() => backend.agentWaits.size).toBe(1);
    // as a pass ends with the mail it brought (agent-wait-sync.test.ts drives real passes)
    const r = await backend.store.sync.ingest([msg({ accountId, providerMsgId: "code-1", from: { name: "GitHub", email: "noreply@github.com" }, subject: "[GitHub] Your code is 314159", date: Date.now() })], { applyFilters: false, now: Date.now(), classifier: null });
    backend.agentWaits.arrived(accountId, r.inserted);
    const got = await waiting;
    expect(got.json.arrived).toEqual([expect.objectContaining({ subject: "[GitHub] Your code is 314159", from: "GitHub <noreply@github.com>" })]);
    // nothing new: the note (with autoSync off, the account isn't checked)
    const none = await call("wait_for_new_mail", { accountId, waitSeconds: 5 });
    expect(none.json).toMatchObject({ arrived: [], waitedSeconds: 5, note: expect.stringMatching(/search again.*may be there/s) });
    const unknown = await call("wait_for_new_mail", { accountId: 9999, waitSeconds: 5 });
    expect(unknown).toMatchObject({ isError: true, raw: "No account 9999. list_accounts gives the ids." });
  });

  describe("plan 185: files", () => {
    const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    const pdf = new Uint8Array(Buffer.from("%PDF-1.4\n%âãÏÓ\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n", "latin1"));
    // longer than a page: ~70k characters
    const notes = Array.from({ length: 7000 }, (_, i) => `line ${String(i).padStart(4, "0")}`).join("\n");
    let threadId: number;
    let messageId: number;
    let files: Record<string, { attachmentId: string; mime: string; size: number; inline?: true; unavailable?: string }>;

    beforeAll(async () => {
      const accountId = (await call("list_accounts")).json.accounts[0].id;
      const bytes = new TextEncoder().encode(notes);
      await backend.store.sync.ingest(
        [
          msg({
            accountId, providerMsgId: "files-1", providerThreadId: "files", subject: "Quarterly files", date: Date.now() - 60_000, hasAttachments: true,
            bodyText: "See attached.", bodyHtml: '<p>See attached.</p><!-- <img src="cid:pdf@x"> --><img src="cid:LOGO%40x" alt="">',
            attachments: [
              { filename: "logo.png", mime: "image/png", size: png.byteLength, contentId: "logo@x", bytes: png },
              { filename: "notes.txt", mime: "text/plain", size: bytes.byteLength, bytes },
              { filename: "invoice.pdf", mime: "application/pdf", size: pdf.byteLength, contentId: "pdf@x", bytes: pdf },
            ],
          }),
          // a message of the conversation that is in Spam
          msg({ accountId, providerMsgId: "files-2", providerThreadId: "files", subject: "Re: Quarterly files", date: Date.now() - 30_000, isSpam: true, inInbox: false }),
        ],
        { applyFilters: false, now: Date.now(), classifier: null },
      );
      const result = (await call("search_emails", { query: "subject:quarterly", limit: 5 })).json.results[0];
      threadId = result.threadId;
      // its summary's sender and lines could be the message in Spam's (Codex review #2)
      expect(result).toMatchObject({ subject: "Quarterly files", note: expect.stringMatching(/in Spam/) });
      expect(result.from).toBeUndefined();
      expect(result.snippet).toBeUndefined();
      const thread = await call("get_thread", { threadId });
      expect(thread.json.messages).toHaveLength(1);
      expect(thread.json.leftOut).toMatch(/1 message\(s\) in Spam or Trash/);
      messageId = thread.json.messages[0].messageId;
      files = Object.fromEntries(thread.json.messages[0].attachments.map((a: { filename: string }) => [a.filename, a]));
    });

    it("get_thread lists each file's id, type and size, and which show in the body", () => {
      expect(files["logo.png"]).toMatchObject({ mime: "image/png", size: png.byteLength, inline: true });
      expect(files["invoice.pdf"]).toMatchObject({ mime: "application/pdf", size: pdf.byteLength });
      // a reference inside a comment isn't one
      expect(files["invoice.pdf"]!.inline).toBeUndefined();
      expect(files["notes.txt"]!.attachmentId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("reads text a page at a time, an image as an image, anything else as a private copy", async () => {
      const read = (attachmentId: string, extra: Record<string, unknown> = {}) =>
        client.callTool({ name: "get_attachment", arguments: { threadId, messageId, attachmentId, ...extra } }) as Promise<{ content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean }>;
      let text = "";
      let offset: number | null = 0;
      let pages = 0;
      while (offset !== null) {
        const r = await read(files["notes.txt"]!.attachmentId, { offset });
        const meta = JSON.parse(r.content[0]!.text!);
        expect(r.content[1]!.text!.length).toBeLessThanOrEqual(32_000);
        text += r.content[1]!.text!;
        offset = meta.nextOffset;
        pages++;
      }
      expect(text).toBe(notes);
      expect(pages).toBeGreaterThan(2);
      const past = await read(files["notes.txt"]!.attachmentId, { offset: notes.length + 1 });
      expect(past.isError).toBe(true);

      const image = await read(files["logo.png"]!.attachmentId);
      expect(image.content[1]).toMatchObject({ type: "image", mimeType: "image/png", data: Buffer.from(png).toString("base64") });

      const copy = JSON.parse((await read(files["invoice.pdf"]!.attachmentId)).content[0]!.text!);
      expect(copy.path.endsWith("/invoice.pdf")).toBe(true);
      expect(new Uint8Array(readFileSync(copy.path))).toEqual(pdf);
      expect(statSync(copy.path).mode & 0o777).toBe(0o600);
      const asFile = JSON.parse((await read(files["logo.png"]!.attachmentId, { asFile: true })).content[0]!.text!);
      expect(new Uint8Array(readFileSync(asFile.path))).toEqual(png);
      // turning agents off takes the copies back
      await setAgents({ enabled: false });
      try {
        expect(existsSync(copy.path)).toBe(false);
      } finally {
        await setAgents({ enabled: true });
      }
    });

    it("a message not downloaded yet says its files are on the way; nothing is fetched for an agent", async () => {
      const accountId = (await call("list_accounts")).json.accounts[0].id;
      await backend.store.sync.ingest([msg({ accountId, providerMsgId: "late-1", subject: "Late invoice", bodyState: "none", bodyText: null, hasAttachments: true })], { applyFilters: false, now: Date.now(), classifier: null });
      const late = (await call("search_emails", { query: "subject:late", limit: 1 })).json.results[0].threadId;
      const message = (await call("get_thread", { threadId: late })).json.messages[0];
      expect(message.attachments).toEqual([]);
      expect(message.filesPending).toMatch(/next sync/);
    });

    it("refuses a file in Spam unless asked, and says plainly when ids are stale or a file isn't kept", async () => {
      await backend.store.threads.act({ threadIds: [threadId], action: "spam", signal: null, now: Date.now() });
      try {
        const refused = await call("get_attachment", { threadId, messageId, attachmentId: files["notes.txt"]!.attachmentId });
        expect(refused.isError).toBe(true);
        expect(refused.raw).toMatch(/includeSpamTrash: true/);
        expect((await call("get_attachment", { threadId, messageId, attachmentId: files["logo.png"]!.attachmentId, includeSpamTrash: true })).json.place).toBe("spam");
      } finally {
        await backend.store.threads.act({ threadIds: [threadId], action: "moveToInbox", signal: null, now: Date.now() });
      }
      const stale = await call("get_attachment", { threadId, messageId: messageId + 1000, attachmentId: files["notes.txt"]!.attachmentId });
      expect(stale.raw).toMatch(/get_thread/);
      const accountId = (await call("list_accounts")).json.accounts[0].id;
      await backend.store.sync.ingest(
        [msg({ accountId, providerMsgId: "huge-1", subject: "Huge scans", bodyState: "partial", bodyText: null })],
        { applyFilters: false, now: Date.now(), classifier: null },
      );
      const huge = (await call("search_emails", { query: "subject:huge", limit: 1 })).json.results[0].threadId;
      // captured past Terno's limits: the part is listed, its bytes weren't kept
      const id = (await call("get_thread", { threadId: huge })).json.messages[0].messageId;
      await backend.store.sync.setBody(id, "Scans", null, { now: Date.now(), classifier: null, attachments: [{ filename: "scan.zip", mime: "application/zip", size: 19_000_000 }] });
      const message = (await call("get_thread", { threadId: huge })).json.messages[0];
      expect(message.attachments[0]).toEqual({ filename: "scan.zip", mime: "application/zip", size: 19_000_000, unavailable: expect.stringMatching(/past Terno's limits/) });
    });
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
    await setAgents({ access: "send" });
    expect((await call("send_email", msg)).json).toMatchObject({ queued: true, opId: expect.any(String) });
    await setAgents({ access: "organize" });
  });

  it("plan 183: at Read only, a change is refused with what it needs and where the user changes it", async () => {
    await setAgents({ access: "read" });
    try {
      expect((await call("search_emails", { query: "factura", limit: 1 })).isError).toBe(false);
      const archived = await call("update_threads", { threadIds: [1], action: "archive" });
      expect(archived.isError).toBe(true);
      expect(archived.raw).toMatch(/'Read and organize'.*Settings → Agents/);
      expect((await client.listTools()).tools.find((t) => t.name === "update_threads")!.description).toMatch(/Needs 'Read and organize'/);
    } finally {
      await setAgents({ access: "organize" });
    }
  });

  it("plan 183: agents turned off cut the agent off, and what it read before isn't served from memory (Codex critique #10)", async () => {
    expect((await call("list_accounts")).isError).toBe(false);
    await setAgents({ enabled: false });
    try {
      const r = await call("list_accounts");
      expect(r.isError).toBe(true);
      expect(r.raw).toMatch(/Settings → Agents → Allow agents/);
    } finally {
      await setAgents({ enabled: true });
    }
    expect((await call("list_accounts")).isError).toBe(false);
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
    await expect(connectToApp({ socketPath: sock, tokenPath: join(dir, "drop.token") })).rejects.toThrow(/Can't reach Terno/);
    expect(Date.now() - started).toBeLessThan(2000);
    server.close();
  });

  it("reports clearly when the app is not running or agents are off", async () => {
    const offline = new AppConnection({ socketPath: join(dir, "nope.sock"), tokenPath: join(dir, "nope.token") });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createMcpServer(offline).connect(a);
    const c = new Client({ name: "t2", version: "1" });
    await c.connect(b);
    const r = (await c.callTool({ name: "list_accounts", arguments: {} })) as { content: { text: string }[]; isError: boolean };
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Open Terno and turn on Settings → Agents → Allow agents/);
  });
});
