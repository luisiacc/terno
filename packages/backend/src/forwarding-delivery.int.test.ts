/**
 * Plan 116, end to end through each real provider: new mail filed into a
 * category that forwards is delivered after its 10 s, as a forward (subject,
 * quoted header, body, the original's file) to the rule's addresses only,
 * once, and a cancelled one never reaches the server.
 *
 * Forwarding has no provider code of its own: a forward is an ordinary `send`
 * op (store.compose.queueSend → Provider.execute with a SendPayload). A new
 * provider (Outlook) forwards as soon as its `execute` sends a `send` op,
 * attachments included. To prove it, add its harness to DELIVERIES below:
 * a local stand-in for its server that records what it was asked to deliver.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FORWARD_DELAY_MS } from "@terno/core";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createGmailProvider, createRegistry, parseRaw, type ProviderRegistry } from "@terno/mail";
import type { IncomingMessage } from "@terno/store";
import imapkit from "imapkit";
import { SMTPServer } from "smtp-server";
import { afterEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";

// plan 123: only Terno's own Google clients exist; tests carry a synthetic one
const TEST_GOOGLE = { preferred: "synthetic-client", clients: [{ clientId: "synthetic-client", clientSecret: "" }] };

const NOW = Date.UTC(2026, 10, 1, 12);
const ANA = { name: "Ana", email: "ana@books.test" };
const FILE = Buffer.from([0, 255, 128, 13, 10, 37]);

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

/** What a provider's server was asked to deliver: its envelope recipients and the message as sent. */
interface Delivered {
  recipients: string[];
  raw: Buffer;
}

/** One provider, its server stood in for locally, behind a real backend on a clock the test moves. */
interface Harness {
  backend: Backend;
  client: RpcClient;
  accountId: number;
  clock: { now: number };
  delivered: Delivered[];
}

function backendOn(providers: ProviderRegistry, clock: { now: number }) {
  const dir = mkdtempSync(join(tmpdir(), "terno-forward-delivery-"));
  const backend = new Backend({ googleClients: TEST_GOOGLE, dbPath: join(dir, "mail.db"), providers, version: "test", cipher: plaintextCipher, autoSync: false, instantSearch: false, iconTransport: null, now: () => clock.now });
  const [a, b] = createMemoryTransportPair();
  backend.connect(b, { clientId: "renderer", origin: "renderer" });
  const client = new RpcClient(a);
  return { backend, client, close: async () => { client.close(); await backend.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

/** IMAP for the mailbox, SMTP for sending: a local IMAP server and an SMTP server that keeps what it receives. */
async function smtpHarness(): Promise<Harness> {
  const imap = imapkit({ plugins: ["IDLE", "MOVE", "UIDPLUS", "SPECIAL-USE", "ENABLE", "CONDSTORE"], storage: { INBOX: {}, "": { separator: "/", folders: { Sent: { "special-use": "\\Sent" } } } } });
  const imapPort = await imap.start(0, "127.0.0.1");
  const delivered: Delivered[] = [];
  const smtp = new SMTPServer({ disabledCommands: ["STARTTLS"], authOptional: true, closeTimeout: 250,
    onAuth: (_auth, _session, cb) => cb(null, { user: "synthetic" }),
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        delivered.push({ raw: Buffer.concat(chunks), recipients: session.envelope.rcptTo.map((r) => r.address) });
        cb();
      });
    },
  });
  await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
  const clock = { now: NOW };
  const t = backendOn(createRegistry({ imap: { allowInsecure: true } }), clock);
  cleanup.push(async () => { await t.close(); await new Promise<void>((resolve) => smtp.close(resolve)); await imap.stop(); });
  const account = await t.client.call("accounts.addImap", {
    email: "sender@example.test", displayName: "Sender", password: "testpass",
    imap: { host: "127.0.0.1", port: imapPort, secure: false, user: "testuser" },
    smtp: { host: "127.0.0.1", port: (smtp.server.address() as { port: number }).port, secure: false, user: "testuser" },
  });
  return { backend: t.backend, client: t.client, accountId: account.id, clock, delivered };
}

/** Gmail's API (token, profile, messages/send) stood in for over HTTP, through the real Gmail provider. */
async function gmailHarness(): Promise<Harness> {
  const delivered: Delivered[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    res.setHeader("content-type", "application/json");
    if (req.url === "/token") res.end(JSON.stringify({ access_token: "synthetic-access", token_type: "Bearer", expires_in: 3600 }));
    else if (req.url === "/gmail/profile") res.end(JSON.stringify({ emailAddress: "synthetic@example.test", historyId: "1" }));
    else if (req.url === "/gmail/messages/send") {
      const raw = Buffer.from((JSON.parse(Buffer.concat(chunks).toString()) as { raw: string }).raw, "base64url");
      // Gmail takes the recipients from the message's own headers
      const parsed = await parseRaw(raw);
      delivered.push({ raw, recipients: [...parsed.to, ...parsed.cc, ...parsed.bcc].map((a) => a.email) });
      res.end(JSON.stringify({ id: `sent-${delivered.length}`, threadId: "thread-synthetic" }));
    } else { res.statusCode = 404; res.end("{}"); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const providers: ProviderRegistry = { create: (ctx) => createGmailProvider(ctx, { endpoints: { token: `${origin}/token`, api: `${origin}/gmail` } }), async verifyImap() {}, async connectGmail() { throw new Error("unused"); } };
  const clock = { now: NOW };
  const t = backendOn(providers, clock);
  cleanup.push(async () => { await t.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const { account } = await t.backend.store.accounts.create({ kind: "gmail", email: "synthetic@example.test", displayName: "Synthetic", color: "brown", providerConfig: {}, now: 1 });
  await t.backend.setSecret(`account:${account.id}:refreshToken`, "synthetic-refresh");
  await (await t.backend.provider(account.id))!.verify();
  return { backend: t.backend, client: t.client, accountId: account.id, clock, delivered };
}

/** Every provider Terno sends through. A new one (Outlook) adds its harness here. */
const DELIVERIES = { "IMAP + SMTP": smtpHarness, Gmail: gmailHarness } satisfies Record<string, () => Promise<Harness>>;

const turn = () => new Promise((r) => setImmediate(r));
async function settle() {
  for (let i = 0; i < 20; i++) await turn();
}

/** A category that forwards to Ana, a filter filing "Factura" mail there, and an invoice with a file arriving live. */
async function arriveInvoice(t: Harness, subject: string): Promise<number> {
  const cat = (await t.backend.store.categories.list()).find((c) => c.name === "Facturas") ?? await t.client.call("categories.create", { name: "Facturas", color: "amber" });
  if (!cat.forward) {
    await t.client.call("filters.save", { name: "Facturas", enabled: true, source: "manual", rule: { match: "all", conditions: [{ field: "subject", op: "contains", value: "Factura" }], actions: [{ type: "addCategory", categoryId: cat.id }] } });
    await t.client.call("categories.setForward", { categoryId: cat.id, forward: { addresses: [ANA], enabled: true } });
  }
  const message: IncomingMessage = {
    accountId: t.accountId, providerMsgId: `invoice-${subject}`, providerThreadId: null, rfcMessageId: `${subject.replace(/\W/g, "")}@shop.test`, inReplyTo: null, references: [],
    from: { name: "Tienda", email: "facturas@shop.test" }, to: [{ name: "Me", email: "me@example.test" }], cc: [], bcc: [],
    subject, date: t.clock.now - 60_000, snippet: "Total: 10", bodyText: "Total: 10", bodyHtml: null, bodyState: "full", listId: null,
    isRead: false, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: true, size: 200,
    attachments: [{ filename: "factura.pdf", mime: "application/pdf", size: FILE.length, bytes: new Uint8Array(FILE) }],
  };
  const { inserted } = await t.backend.ingestSliced([message], true, undefined, undefined, undefined, undefined, undefined, true);
  await settle();
  return inserted[0]!;
}

/** The clock past the 10 s, the queue's look, then the ops worker sending. */
async function letItGo(t: Harness) {
  t.clock.now += FORWARD_DELAY_MS;
  t.backend.forwards.poke();
  await settle();
  await t.backend.runWorker();
  await settle();
}

describe.each(Object.entries(DELIVERIES))("forwarding through %s (plan 116)", (_name, harness) => {
  it("delivers new mail filed into the category to the rule's addresses, as a forward with its file, once", async () => {
    const t = await harness();
    const id = await arriveInvoice(t, "Factura 0042");
    expect(t.delivered).toEqual([]);
    await letItGo(t);
    expect(t.delivered).toHaveLength(1);
    const [sent] = t.delivered;
    expect(sent!.recipients).toEqual([ANA.email]);
    const parsed = await parseRaw(sent!.raw);
    expect(parsed.subject).toBe("Fwd: Factura 0042");
    expect(parsed.text).toContain("---------- Forwarded message ----------\nFrom: Tienda <facturas@shop.test>");
    expect(parsed.text).toContain("Subject: Factura 0042");
    expect(parsed.text).toContain("Total: 10");
    expect(parsed.attachments.map((a) => a.filename)).toEqual(["factura.pdf"]);
    expect(Buffer.from(parsed.attachments[0]!.bytes!).equals(FILE)).toBe(true);
    // the windows hear it went
    expect((await t.client.call("forwards.list", {})).items.find((f) => f.messageId === id)?.status).toBe("sent");
    // never twice: another look, another worker pass
    await letItGo(t);
    expect(t.delivered).toHaveLength(1);
  });

  it("a forward cancelled within its 10 s never reaches the server", async () => {
    const t = await harness();
    const id = await arriveInvoice(t, "Factura 0043");
    const row = (await t.client.call("forwards.list", {})).items.find((f) => f.messageId === id)!;
    await t.client.call("forwards.cancel", { ids: [row.id] });
    await letItGo(t);
    expect(t.delivered).toEqual([]);
  });
});
