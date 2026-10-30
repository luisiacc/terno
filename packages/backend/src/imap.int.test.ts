import nodemailer from "../../mail/node_modules/nodemailer/dist/esm/nodemailer.js";
/**
 * Real imapflow ↔ in-process ImapKit (strict RFC server) and nodemailer ↔
 * in-process smtp-server, driven through the real Backend.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createRegistry, ProviderError } from "@terno/mail";
import imapkit from "imapkit";
import { SMTPServer } from "smtp-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { sqlDb } from "@terno/db";
import { AWAITING_IDENTITY } from "@terno/store";

type ImapKitServer = ReturnType<typeof imapkit>;

const STORAGE = {
  INBOX: {},
  "": {
    separator: "/",
    folders: {
      Sent: { "special-use": "\\Sent" },
      Archive: { "special-use": "\\Archive" },
      Junk: { "special-use": "\\Junk" },
      Trash: { "special-use": "\\Trash" },
      Drafts: { "special-use": "\\Drafts" },
    },
  },
};

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const c of cleanups.splice(0).reverse()) {
    try {
      await c();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "IMAP fixture cleanup failed");
});

let seq = 0;
function raw(o: { from?: string; to?: string; subject: string; replyTo?: string; body?: string; html?: string; id?: string; inReplyTo?: string; listId?: string; date?: Date }) {
  const id = o.id ?? `m${++seq}@test.local`;
  const headers = [
    `From: ${o.from ?? "Ana Pérez <ana@example.com>"}`,
    `To: ${o.to ?? "Luis <luis@test.local>"}`,
    `Subject: ${o.subject}`,
    ...(o.replyTo ? [`Reply-To: ${o.replyTo}`] : []),
    `Message-ID: <${id}>`,
    `Date: ${(o.date ?? new Date()).toUTCString()}`,
    "MIME-Version: 1.0",
    ...(o.inReplyTo ? [`In-Reply-To: <${o.inReplyTo}>`, `References: <${o.inReplyTo}>`] : []),
    ...(o.listId ? [`List-Id: News <${o.listId}>`] : []),
    `Content-Type: ${o.html ? "text/html" : "text/plain"}; charset=utf-8`,
  ];
  return `${headers.join("\r\n")}\r\n\r\n${o.html ?? o.body ?? "hola"}\r\n`;
}

async function startImap(extra: Record<string, unknown> = {}) {
  const server: ImapKitServer = imapkit({ plugins: ["IDLE", "MOVE", "UIDPLUS", "SPECIAL-USE", "ENABLE", "CONDSTORE"], storage: structuredClone(STORAGE), ...extra });
  const port = await server.start(0, "127.0.0.1");
  cleanups.push(() => server.stop());
  return { server, port };
}

interface Captured {
  raw: string;
  rcpt: string[];
}

async function startSmtp(behaviour: { rejectRcpt?: string; dropDuringData?: boolean; tempFailRcpt?: string } = {}) {
  const received: Captured[] = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS"],
    logger: false,
    onAuth: (_auth, _session, cb) => cb(null, { user: "testuser" }),
    onRcptTo(address, _session, cb) {
      if (behaviour.rejectRcpt && address.address === behaviour.rejectRcpt) return cb(Object.assign(new Error("No such user"), { responseCode: 550 }));
      if (behaviour.tempFailRcpt && address.address === behaviour.tempFailRcpt) return cb(Object.assign(new Error("Greylisted, try later"), { responseCode: 450 }));
      cb();
    },
    onData(stream, session, cb) {
      let data = "";
      stream.on("data", (c) => (data += c));
      stream.on("end", () => {
        if (behaviour.dropDuringData) {
          // the message was transmitted but we never answer: the client can't know if it was accepted
          (session as unknown as { _socket?: { destroy(): void } })._socket?.destroy();
          return;
        }
        received.push({ raw: data, rcpt: session.envelope.rcptTo.map((r) => r.address) });
        cb();
      });
    },
  });
  if (behaviour.dropDuringData) {
    server.on("connect" as never, () => {});
  }
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.server.address() as { port: number }).port;
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return { received, port, server };
}

/**
 * Minimal SMTP server that accepts the whole message and then hangs up
 * without answering: the client cannot know whether it was delivered.
 */
async function startDroppingSmtp() {
  const server = createTcpServer((socket) => {
    socket.write("220 drop.test ESMTP\r\n");
    let inData = false;
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (inData) {
        if (buffer.includes("\r\n.\r\n")) socket.destroy();
        return;
      }
      let nl: number;
      while ((nl = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, nl).toUpperCase();
        buffer = buffer.slice(nl + 2);
        if (line.startsWith("EHLO") || line.startsWith("HELO")) socket.write("250-drop.test\r\n250 AUTH PLAIN LOGIN\r\n");
        else if (line.startsWith("AUTH")) socket.write("235 ok\r\n");
        else if (line.startsWith("MAIL") || line.startsWith("RCPT")) socket.write("250 ok\r\n");
        else if (line.startsWith("DATA")) {
          socket.write("354 go ahead\r\n");
          inData = true;
        } else if (line.startsWith("QUIT")) socket.end("221 bye\r\n");
        else socket.write("250 ok\r\n");
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return { received: [] as Captured[], port: (server.address() as { port: number }).port };
}

async function setup(opts: { smtp?: Parameters<typeof startSmtp>[0]; imap?: Record<string, unknown>; attention?: import("./attention").AttentionHost } = {}) {
  const imap = await startImap(opts.imap);
  const smtp = opts.smtp?.dropDuringData ? await startDroppingSmtp() : await startSmtp(opts.smtp);
  const dir = mkdtempSync(join(tmpdir(), "terno-imap-"));
  const backend = new Backend({
    dbPath: join(dir, "u.db"),
    version: "t",
    cipher: plaintextCipher,
    providers: createRegistry({ imap: { allowInsecure: true } }),
    autoSync: false,
    attention: opts.attention,
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    await backend.stop();
    stopped = true;
  };
  cleanups.push(async () => {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "r", origin: "renderer" });
  const client = new RpcClient(c);
  const addAccount = (port: number, email = "luis@test.local") =>
    client.call("accounts.addImap", {
      email,
      displayName: "Luis",
      imap: { host: "127.0.0.1", port, secure: false, user: "testuser" },
      smtp: { host: "127.0.0.1", port: smtp.port, secure: false, user: "testuser" },
      password: "testpass",
    });
  return { imap, smtp, backend, client, addAccount, dir, stop };
}

const count = (backend: Backend, sql: string, ...p: (string | number)[]) => sqlDb(backend.store).get<{ c: number }>(`SELECT count(*) AS c FROM (${sql})`, ...p)!.c;

describe("IMAP provider against ImapKit", () => {
  it("retains parsed multi-address Reply-To through envelope sync, body download, and later flag refresh", async () => {
    const { imap, backend, client, addAccount } = await setup();
    imap.server.control.addMessage("INBOX", { raw: raw({ subject: "Helpdesk Reply-To", from: "No reply <noreply@help.test>", replyTo: '"Support, Session" <Session@help.test>, List <list@help.test>' }) });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const [thread] = (await client.call("threads.list", { view: "inbox" })).items;
    const expected = { from: { name: "No reply", email: "noreply@help.test" }, replyTo: [{ name: "Support, Session", email: "session@help.test" }, { name: "List", email: "list@help.test" }], bodyState: "full" };
    expect((await client.call("threads.get", { threadId: thread!.id }))!.messages[0]).toMatchObject(expected);
    await backend.syncAccount(account.id);
    expect((await client.call("threads.get", { threadId: thread!.id }))!.messages[0]).toMatchObject(expected);
  });

  it("rejects a wrong password when adding the account", async () => {
    const { client, imap, smtp } = await setup();
    await expect(
      client.call("accounts.addImap", {
        email: "x@test.local",
        displayName: "x",
        imap: { host: "127.0.0.1", port: imap.port, secure: false, user: "testuser" },
        smtp: { host: "127.0.0.1", port: smtp.port, secure: false, user: "testuser" },
        password: "wrong",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("syncs folders, threads replies, downloads bodies and derives state from folders", async () => {
    const { imap, backend, client, addAccount } = await setup();
    const ctl = imap.server.control;
    ctl.addMessage("INBOX", { raw: raw({ subject: "Presupuesto", id: "root@x", body: "Te mando el presupuesto final." }) });
    ctl.addMessage("INBOX", { raw: raw({ subject: "Re: Presupuesto", inReplyTo: "root@x", body: "¡Gracias!" }), flags: ["\\Seen"] });
    ctl.addMessage("INBOX", { raw: raw({ subject: "Boletín", from: "Xataka <boletin@xataka.com>", listId: "boletin.xataka.com", html: "<h1>Novedades</h1><p>Baterías de <b>estado sólido</b></p>" }) });
    ctl.addMessage("Sent", { raw: raw({ subject: "Hola", from: "Luis <luis@test.local>", to: "ana@example.com" }), flags: ["\\Seen"] });
    ctl.addMessage("Junk", { raw: raw({ subject: "Ganaste", from: "spam@spam.biz" }) });

    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);

    const inbox = await client.call("threads.list", { view: "inbox" });
    expect(inbox.items.map((t) => t.subject).sort()).toEqual(["Boletín", "Presupuesto"]);
    expect(inbox.items.find((t) => t.subject === "Presupuesto")!.messageCount).toBe(2);
    expect((await client.call("threads.list", { view: "sent" })).items).toHaveLength(1);
    expect((await client.call("threads.list", { view: "spam" })).items).toHaveLength(1);
    // bodies were downloaded and indexed: HTML-only mail is searchable as text
    expect((await client.call("threads.search", { query: "estado solido" })).items.map((t) => t.subject)).toEqual(["Boletín"]);
    expect(count(backend, "SELECT 1 FROM messages WHERE body_state != 'full'")).toBe(0);
    expect(sqlDb(backend.store).get("SELECT list_id FROM messages WHERE subject = 'Boletín'")).toEqual({ list_id: "boletin.xataka.com" });

    // a second sync is a no-op (no duplicates)
    await backend.syncAccount(account.id);
    expect(count(backend, "SELECT 1 FROM messages")).toBe(5);
  });

  it("refuses archive without targeted expunge support and preserves unrelated Deleted mail", async () => {
    const { imap, backend, client, addAccount, dir, stop } = await setup({ imap: { plugins: ["IDLE", "SPECIAL-USE", "ENABLE", "CONDSTORE"] } });
    const ctl = imap.server.control;
    const targetRaw = raw({ subject: "Keep target", body: "Exact target body" });
    const otherRaw = raw({ subject: "Keep unrelated", body: "Exact unrelated body" });
    const target = ctl.addMessage("INBOX", { raw: targetRaw });
    const other = ctl.addMessage("INBOX", { raw: otherRaw });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const thread = (await client.call("threads.list", { view: "inbox" })).items.find((t) => t.subject === "Keep target")!;
    expect(thread).toBeDefined();
    const original = (await client.call("threads.get", { threadId: thread.id })).messages[0]!;
    const beforeLocations = await backend.store.providerStore(account.id).locations!.of([original.id]);
    ctl.setFlags("INBOX", [other.uid], ["\\Deleted"], "add");
    expect(ctl.getMessage("INBOX", other.uid).flags).toContain("\\Deleted");
    const mutations: string[] = [];
    imap.server.script.add({ on: "command", run: true, when: (context) => {
      if (/^(?:UID )?(?:COPY|MOVE|STORE|EXPUNGE)$/.test(context.command ?? "")) {
        if (mutations.length >= 32) throw new Error("Unexpected unbounded IMAP mutations");
        mutations.push(context.command!);
      }
      return false;
    } });
    const action = await client.call("threads.act", { threadIds: [thread.id], action: "archive" });
    await backend.runWorker();
    expect.soft(mutations).toEqual([]);
    const remaining = ctl.listMessages("INBOX", { raw: true });
    expect.soft(remaining.map((m) => m.uid)).toEqual([target.uid, other.uid]);
    expect.soft(remaining.find((m) => m.uid === target.uid)?.raw?.toString()).toBe(targetRaw);
    expect.soft(remaining.find((m) => m.uid === other.uid)?.raw?.toString()).toBe(otherRaw);
    expect.soft(remaining.find((m) => m.uid === other.uid)?.flags).toContain("\\Deleted");
    expect.soft(ctl.listMessages("Archive")).toHaveLength(0);
    expect.soft(await client.call("ops.list", {})).toEqual([expect.objectContaining({ kind: "archive", state: "failed", attempts: 1, lastErrorI18n: { key: "errors.imap.unsafeMove" } })]);
    expect((await client.call("threads.get", { threadId: thread.id })).messages[0]?.bodyText).toBe("Exact target body\n");
    expect(action.undoId).not.toBeNull();
    expect(await client.call("threads.undo", { undoId: action.undoId! })).toEqual({ restored: 1 });
    await backend.runWorker();
    const restored = await client.call("threads.get", { threadId: thread.id });
    expect(restored.thread.inInbox).toBe(true);
    expect(restored.messages[0]).toMatchObject({ id: original.id, bodyText: original.bodyText });
    const persisted = await client.call("ops.list", {});
    await stop();
    const reopened = new Backend({ dbPath: join(dir, "u.db"), version: "t", cipher: plaintextCipher, providers: createRegistry({ imap: { allowInsecure: true } }), autoSync: false });
    cleanups.push(() => reopened.stop());
    const [c, s] = createMemoryTransportPair();
    reopened.connect(s, { clientId: "reopen", origin: "renderer" });
    const next = new RpcClient(c);
    expect(await next.call("ops.list", {})).toEqual(persisted);
    expect(await reopened.store.providerStore(account.id).locations!.of([original.id])).toEqual(beforeLocations);
    expect((await next.call("threads.get", { threadId: thread.id })).messages[0]).toMatchObject({ id: original.id, bodyText: original.bodyText });
    expect((await next.call("threads.get", { threadId: thread.id })).thread.inInbox).toBe(true);
    expect(mutations).toEqual([]);
    expect(ctl.listMessages("INBOX", { raw: true }).map((m) => [m.uid, m.raw?.toString()])).toEqual([[target.uid, targetRaw], [other.uid, otherRaw]]);
    expect(ctl.getMessage("INBOX", other.uid).flags).toContain("\\Deleted");
  });

  it("uses UIDPLUS fallback without expunging unrelated Deleted mail", async () => {
    const { imap, backend, client, addAccount } = await setup({ imap: { plugins: ["IDLE", "UIDPLUS", "SPECIAL-USE", "ENABLE", "CONDSTORE"] } });
    const ctl = imap.server.control;
    const targetRaw = raw({ subject: "Targeted fallback", body: "Exact fallback body" });
    const otherRaw = raw({ subject: "Unrelated Deleted", body: "Exact unrelated body" });
    const target = ctl.addMessage("INBOX", { raw: targetRaw });
    const other = ctl.addMessage("INBOX", { raw: otherRaw });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const thread = (await client.call("threads.list", { view: "inbox" })).items.find((t) => t.subject === "Targeted fallback")!;
    ctl.setFlags("INBOX", [other.uid], ["\\Deleted"], "add");
    expect(ctl.getMessage("INBOX", other.uid).flags).toContain("\\Deleted");
    const commands: { command: string; mailbox: string | null; line: string }[] = [];
    imap.server.script.add({ on: "command", run: true, when: (context) => {
      if (/^(?:UID )?(?:COPY|MOVE|STORE|EXPUNGE)$/.test(context.command ?? "")) {
        if (commands.length >= 32) throw new Error("Unexpected unbounded IMAP mutations");
        commands.push({ command: context.command!, mailbox: context.mailbox, line: context.data.trim() });
      }
      return false;
    } });
    await client.call("threads.act", { threadIds: [thread.id], action: "archive" });
    await backend.runWorker();
    expect(commands.map((c) => c.command)).toEqual(["UID COPY", "UID STORE", "UID EXPUNGE"]);
    expect(commands.every((c) => c.mailbox === "INBOX")).toBe(true);
    expect(commands[2]!.line).toMatch(new RegExp(`UID EXPUNGE ${target.uid}$`));
    const remaining = ctl.listMessages("INBOX", { raw: true });
    expect(remaining.map((m) => m.uid)).toEqual([other.uid]);
    expect(remaining[0]!.raw?.toString()).toBe(otherRaw);
    expect(remaining[0]!.flags).toContain("\\Deleted");
    expect(ctl.listMessages("Archive", { raw: true }).map((m) => m.raw?.toString())).toEqual([targetRaw]);
    expect(await client.call("ops.list", {})).toEqual([expect.objectContaining({ kind: "archive", state: "succeeded", attempts: 1 })]);
    await backend.syncAccount(account.id);
    expect((await client.call("threads.get", { threadId: thread.id })).messages[0]?.bodyText).toBe("Exact fallback body\n");
  });

  it.each([false, true])("refuses All Mail archive without UIDPLUS (MOVE %s)", async (move) => {
    const { imap, backend, client, addAccount } = await setup({ imap: {
      plugins: ["IDLE", "SPECIAL-USE", "ENABLE", "CONDSTORE", ...(move ? ["MOVE"] : [])],
      storage: { INBOX: {}, "": { separator: "/", folders: { Sent: { "special-use": "\\Sent" }, All: { "special-use": "\\All" }, Junk: { "special-use": "\\Junk" }, Trash: { "special-use": "\\Trash" } } } },
    } });
    const ctl = imap.server.control;
    const targetRaw = raw({ subject: "All Mail target", body: "Exact All Mail body" });
    const target = ctl.addMessage("INBOX", { raw: targetRaw });
    const otherRaw = raw({ subject: "All Mail unrelated", body: "Exact unrelated body" });
    const other = ctl.addMessage("INBOX", { raw: otherRaw });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const thread = (await client.call("threads.list", { view: "inbox" })).items.find((t) => t.subject === "All Mail target")!;
    const message = (await client.call("threads.get", { threadId: thread.id })).messages[0]!;
    const locations = backend.store.providerStore(account.id).locations!;
    const sourceProof = (await locations.of([message.id])).find((l) => l.mailbox === "INBOX")!;
    ctl.copyMessages("INBOX", [sourceProof.uid], "All");
    const copyProof = ctl.listMessages("All", { raw: true }).find((m) => m.raw!.equals(ctl.getMessage("INBOX", sourceProof.uid, { raw: true }).raw!))!;
    expect(copyProof).toBeDefined();
    const holdOwner = await locations.dispatch([message.id], [sourceProof], async (token) => token!, [message.id]);
    await locations.mappedMove([sourceProof], "All", ctl.getMailbox("All").uidvalidity, [{ messageId: message.id, uid: copyProof.uid }], true, [sourceProof], holdOwner);
    const before = await locations.of([message.id]);
    expect(before.map((l) => l.mailbox).sort()).toEqual(["All", "INBOX"]);
    ctl.setFlags("INBOX", [other.uid], ["\\Deleted"], "add");
    expect(ctl.getMessage("INBOX", other.uid).flags).toContain("\\Deleted");
    const mutations: string[] = [];
    imap.server.script.add({ on: "command", run: true, when: (context) => {
      if (/^(?:UID )?(?:COPY|MOVE|STORE|EXPUNGE|CREATE)$/.test(context.command ?? "")) {
        if (mutations.length >= 32) throw new Error("Unexpected unbounded IMAP mutations");
        mutations.push(context.command!);
      }
      return false;
    } });
    await client.call("threads.act", { threadIds: [thread.id], action: "archive" });
    await backend.runWorker();
    expect.soft(mutations).toEqual([]);
    const remaining = ctl.listMessages("INBOX", { raw: true });
    expect.soft(remaining.map((m) => m.uid)).toEqual([target.uid, other.uid]);
    expect.soft(remaining.find((m) => m.uid === target.uid)?.raw?.toString()).toBe(targetRaw);
    expect.soft(remaining.find((m) => m.uid === other.uid)?.raw?.toString()).toBe(otherRaw);
    expect.soft(ctl.listMessages("All", { raw: true }).map((m) => m.raw?.toString())).toEqual([targetRaw]);
    expect.soft(await locations.of([message.id])).toEqual(before);
    expect.soft(await client.call("ops.list", {})).toEqual([expect.objectContaining({ kind: "archive", state: "failed", attempts: 1 })]);
    expect((await client.call("threads.get", { threadId: thread.id })).messages[0]?.bodyText).toBe("Exact All Mail body\n");
  });

  it.each(["UID STORE", "UID EXPUNGE"])("retains All Mail locations after server refuses %s", async (refused) => {
    const { imap, backend, client, addAccount } = await setup({ imap: {
      plugins: ["IDLE", "SPECIAL-USE", "ENABLE", "CONDSTORE", "MOVE", "UIDPLUS"],
      storage: { INBOX: {}, "": { separator: "/", folders: { Sent: { "special-use": "\\Sent" }, All: { "special-use": "\\All" }, Junk: { "special-use": "\\Junk" }, Trash: { "special-use": "\\Trash" } } } },
    } });
    const ctl = imap.server.control;
    const targetRaw = raw({ subject: "All Mail target", body: "Exact All Mail body" });
    const target = ctl.addMessage("INBOX", { raw: targetRaw });
    const otherRaw = raw({ subject: "All Mail unrelated", body: "Exact unrelated body" });
    const other = ctl.addMessage("INBOX", { raw: otherRaw });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const thread = (await client.call("threads.list", { view: "inbox" })).items.find((t) => t.subject === "All Mail target")!;
    const message = (await client.call("threads.get", { threadId: thread.id })).messages[0]!;
    const locations = backend.store.providerStore(account.id).locations!;
    const sourceProof = (await locations.of([message.id])).find((l) => l.mailbox === "INBOX")!;
    ctl.copyMessages("INBOX", [sourceProof.uid], "All");
    const copyProof = ctl.listMessages("All", { raw: true }).find((m) => m.raw!.equals(ctl.getMessage("INBOX", sourceProof.uid, { raw: true }).raw!))!;
    expect(copyProof).toBeDefined();
    const holdOwner = await locations.dispatch([message.id], [sourceProof], async (token) => token!, [message.id]);
    await locations.mappedMove([sourceProof], "All", ctl.getMailbox("All").uidvalidity, [{ messageId: message.id, uid: copyProof.uid }], true, [sourceProof], holdOwner);
    const before = await locations.of([message.id]);
    expect(before.map((l) => l.mailbox).sort()).toEqual(["All", "INBOX"]);
    ctl.setFlags("INBOX", [other.uid], ["\\Deleted"], "add");
    expect(ctl.getMessage("INBOX", other.uid).flags).toContain("\\Deleted");
    const mutations: string[] = [];
    imap.server.script.add({ on: "command", run: true, when: (context) => {
      if (/^(?:UID )?(?:COPY|MOVE|STORE|EXPUNGE|CREATE)$/.test(context.command ?? "")) {
        if (mutations.length >= 32) throw new Error("Unexpected unbounded IMAP mutations");
        mutations.push(context.command!);
      }
      return false;
    } });
    imap.server.script.add({ on: "command", command: refused, send: "$TAG NO change refused\r\n" });
    await client.call("threads.act", { threadIds: [thread.id], action: "archive" });
    await backend.runWorker();
    expect.soft(mutations).toEqual(refused === "UID STORE" ? ["UID STORE"] : ["UID STORE", "UID EXPUNGE"]);
    const remaining = ctl.listMessages("INBOX", { raw: true });
    expect.soft(remaining.map((m) => m.uid)).toEqual([target.uid, other.uid]);
    expect.soft(remaining.find((m) => m.uid === target.uid)?.flags.includes("\\Deleted")).toBe(refused === "UID EXPUNGE");
    expect.soft(remaining.find((m) => m.uid === target.uid)?.raw?.toString()).toBe(targetRaw);
    expect.soft(remaining.find((m) => m.uid === other.uid)?.raw?.toString()).toBe(otherRaw);
    expect.soft(ctl.listMessages("All", { raw: true }).map((m) => m.raw?.toString())).toEqual([targetRaw]);
    expect.soft(await locations.of([message.id])).toEqual(before);
    expect.soft(await client.call("ops.list", {})).toEqual([expect.objectContaining({ kind: "archive", state: "failed", attempts: 1, lastErrorI18n: { key: "errors.imap.changeRefused" } })]);
    expect((await client.call("threads.get", { threadId: thread.id })).messages[0]?.bodyText).toBe("Exact All Mail body\n");
  });

  it.each([false, true])("refuses move from a read-only source before COPY (MOVE %s)", async (move) => {
    const folders = Object.fromEntries(Object.entries(STORAGE[""].folders).map(([name, folder]) => [name, { ...folder, acl: { testuser: "lrswipkxtea" } }]));
    const { imap, backend, client, addAccount } = await setup({ imap: {
      plugins: ["IDLE", "UIDPLUS", "SPECIAL-USE", "ENABLE", "CONDSTORE", "ACL", ...(move ? ["MOVE"] : [])],
      aclOwner: "mailbox-owner", storage: { INBOX: { acl: { testuser: "lr" } }, "": { separator: "/", folders } },
    } });
    const ctl = imap.server.control;
    const targetRaw = raw({ subject: "Read-only target", body: "Exact read-only body" });
    const target = ctl.addMessage("INBOX", { raw: targetRaw });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const thread = (await client.call("threads.list", { view: "inbox" })).items.find((t) => t.subject === "Read-only target")!;
    expect(thread).toBeDefined();
    expect(ctl.sessions().some((session) => session.mailbox === "INBOX" && session.readOnly)).toBe(true);
    const mutations: string[] = [];
    imap.server.script.add({ on: "command", run: true, when: (context) => {
      if (/^(?:UID )?(?:COPY|MOVE|STORE|EXPUNGE)$/.test(context.command ?? "")) {
        if (mutations.length >= 32) throw new Error("Unexpected unbounded IMAP mutations");
        mutations.push(context.command!);
      }
      return false;
    } });
    await client.call("threads.act", { threadIds: [thread.id], action: "archive" });
    await backend.runWorker();
    expect.soft(mutations).toEqual([]);
    expect.soft(ctl.listMessages("INBOX", { raw: true }).map((m) => [m.uid, m.raw?.toString()])).toEqual([[target.uid, targetRaw]]);
    expect.soft(ctl.listMessages("Archive")).toHaveLength(0);
    expect.soft(await client.call("ops.list", {})).toEqual([expect.objectContaining({ kind: "archive", state: "failed", attempts: 1, lastErrorI18n: { key: "errors.imap.readOnly" } })]);
    expect((await client.call("threads.get", { threadId: thread.id })).messages[0]?.bodyText).toBe("Exact read-only body\n");
  });

  it("refuses All Mail archive from a read-only Inbox before STORE", async () => {
    const { imap, backend, client, addAccount } = await setup({ imap: {
      plugins: ["IDLE", "UIDPLUS", "SPECIAL-USE", "ENABLE", "CONDSTORE", "ACL"],
      aclOwner: "mailbox-owner", storage: { INBOX: { acl: { testuser: "lr" } }, "": { separator: "/", folders: { All: { "special-use": "\\All", acl: { testuser: "lrswipkxtea" } } } } },
    } });
    const ctl = imap.server.control;
    const targetRaw = raw({ subject: "Read-only All Mail", body: "Exact All Mail readonly body" });
    const target = ctl.addMessage("INBOX", { raw: targetRaw });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const thread = (await client.call("threads.list", { view: "inbox" })).items.find((t) => t.subject === "Read-only All Mail")!;
    const message = (await client.call("threads.get", { threadId: thread.id })).messages[0]!;
    const locations = backend.store.providerStore(account.id).locations!;
    const sourceProof = (await locations.of([message.id])).find((l) => l.mailbox === "INBOX")!;
    ctl.copyMessages("INBOX", [sourceProof.uid], "All");
    const copyProof = ctl.listMessages("All", { raw: true }).find((m) => m.raw!.equals(ctl.getMessage("INBOX", sourceProof.uid, { raw: true }).raw!))!;
    expect(copyProof).toBeDefined();
    const holdOwner = await locations.dispatch([message.id], [sourceProof], async (token) => token!, [message.id]);
    await locations.mappedMove([sourceProof], "All", ctl.getMailbox("All").uidvalidity, [{ messageId: message.id, uid: copyProof.uid }], true, [sourceProof], holdOwner);
    const before = await locations.of([message.id]);
    expect(before.map((l) => l.mailbox).sort()).toEqual(["All", "INBOX"]);
    expect(ctl.sessions().some((session) => session.mailbox === "INBOX" && session.readOnly)).toBe(true);
    const mutations: string[] = [];
    imap.server.script.add({ on: "command", run: true, when: (context) => {
      if (/^(?:UID )?(?:COPY|MOVE|STORE|EXPUNGE)$/.test(context.command ?? "")) {
        if (mutations.length >= 32) throw new Error("Unexpected unbounded IMAP mutations");
        mutations.push(context.command!);
      }
      return false;
    } });
    await client.call("threads.act", { threadIds: [thread.id], action: "archive" });
    await backend.runWorker();
    expect.soft(mutations).toEqual([]);
    expect.soft(ctl.listMessages("INBOX", { raw: true }).map((m) => [m.uid, m.raw?.toString()])).toEqual([[target.uid, targetRaw]]);
    expect.soft(ctl.listMessages("All", { raw: true }).map((m) => m.raw?.toString())).toEqual([targetRaw]);
    expect.soft(await locations.of([message.id])).toEqual(before);
    expect.soft(await client.call("ops.list", {})).toEqual([expect.objectContaining({ kind: "archive", state: "failed", attempts: 1, lastErrorI18n: { key: "errors.imap.readOnly" } })]);
    expect((await client.call("threads.get", { threadId: thread.id })).messages[0]?.bodyText).toBe("Exact All Mail readonly body\n");
  });

  it("copies a read-only All Mail source to Inbox without MOVE or UIDPLUS", async () => {
    const { imap, backend, client, addAccount } = await setup({ imap: {
      plugins: ["IDLE", "SPECIAL-USE", "ENABLE", "CONDSTORE", "ACL"],
      aclOwner: "mailbox-owner", storage: { INBOX: { acl: { testuser: "lrswipkxtea" } }, "": { separator: "/", folders: { All: { "special-use": "\\All", acl: { testuser: "lr" } } } } },
    } });
    const ctl = imap.server.control;
    const targetRaw = raw({ subject: "Read-only copy", body: "Exact read-only copy body" });
    const target = ctl.addMessage("All", { raw: targetRaw });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const thread = (await client.call("threads.list", { view: "all" })).items.find((t) => t.subject === "Read-only copy")!;
    expect(thread).toBeDefined();
    expect(ctl.sessions().some((session) => session.mailbox === "All" && session.readOnly)).toBe(true);
    const mutations: string[] = [];
    imap.server.script.add({ on: "command", run: true, when: (context) => {
      if (/^(?:UID )?(?:COPY|MOVE|STORE|EXPUNGE)$/.test(context.command ?? "")) {
        if (mutations.length >= 32) throw new Error("Unexpected unbounded IMAP mutations");
        mutations.push(context.command!);
      }
      return false;
    } });
    await client.call("threads.act", { threadIds: [thread.id], action: "moveToInbox" });
    await backend.runWorker();
    expect(mutations).toEqual(["UID COPY"]);
    expect(ctl.listMessages("All", { raw: true }).map((m) => [m.uid, m.raw?.toString()])).toEqual([[target.uid, targetRaw]]);
    expect(ctl.listMessages("INBOX", { raw: true }).map((m) => m.raw?.toString())).toEqual([targetRaw]);
    expect(await client.call("ops.list", {})).toEqual([expect.objectContaining({ kind: "moveToInbox", state: "succeeded", attempts: 1 })]);
    expect((await client.call("threads.get", { threadId: thread.id })).messages[0]?.bodyText).toBe("Exact read-only copy body\n");
  });

  it.each(["archive", "trash", "spam"] as const)("refuses unsupported %s before creating its missing destination", async (action) => {
    const { imap, backend, client, addAccount } = await setup({ imap: {
      plugins: ["IDLE", "SPECIAL-USE", "ENABLE", "CONDSTORE"], storage: { INBOX: {}, "": { separator: "/", folders: { Sent: { "special-use": "\\Sent" } } } },
    } });
    const ctl = imap.server.control;
    const targetRaw = raw({ subject: "Missing destination", body: "Exact destination body" });
    const target = ctl.addMessage("INBOX", { raw: targetRaw });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const thread = (await client.call("threads.list", { view: "inbox" })).items.find((t) => t.subject === "Missing destination")!;
    const mutations: string[] = [];
    imap.server.script.add({ on: "command", run: true, when: (context) => {
      if (/^(?:UID )?(?:COPY|MOVE|STORE|EXPUNGE|CREATE)$/.test(context.command ?? "")) {
        if (mutations.length >= 32) throw new Error("Unexpected unbounded IMAP mutations");
        mutations.push(context.command!);
      }
      return false;
    } });
    await client.call("threads.act", { threadIds: [thread.id], action });
    await backend.runWorker();
    expect.soft(mutations).toEqual([]);
    expect.soft(ctl.listMessages("INBOX", { raw: true }).map((m) => [m.uid, m.raw?.toString()])).toEqual([[target.uid, targetRaw]]);
    expect.soft(await client.call("ops.list", {})).toEqual([expect.objectContaining({ kind: action, state: "failed", attempts: 1, lastErrorI18n: { key: "errors.imap.unsafeMove" } })]);
    expect((await client.call("threads.get", { threadId: thread.id })).messages[0]?.bodyText).toBe("Exact destination body\n");
  });

  it.each([false, true])("creates a missing Archive only for an admitted move (MOVE %s)", async (move) => {
    const { imap, backend, client, addAccount } = await setup({ imap: {
      plugins: ["IDLE", "UIDPLUS", "SPECIAL-USE", "ENABLE", "CONDSTORE", ...(move ? ["MOVE"] : [])], storage: { INBOX: {}, "": { separator: "/", folders: { Sent: { "special-use": "\\Sent" } } } },
    } });
    const ctl = imap.server.control;
    const targetRaw = raw({ subject: "Create admitted Archive", body: "Exact admitted body" });
    ctl.addMessage("INBOX", { raw: targetRaw });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const thread = (await client.call("threads.list", { view: "inbox" })).items.find((t) => t.subject === "Create admitted Archive")!;
    const mutations: string[] = [];
    imap.server.script.add({ on: "command", run: true, when: (context) => {
      if (/^(?:UID )?(?:COPY|MOVE|STORE|EXPUNGE|CREATE)$/.test(context.command ?? "")) {
        if (mutations.length >= 32) throw new Error("Unexpected unbounded IMAP mutations");
        mutations.push(context.command!);
      }
      return false;
    } });
    await client.call("threads.act", { threadIds: [thread.id], action: "archive" });
    await backend.runWorker();
    expect(mutations).toEqual(move ? ["CREATE", "UID MOVE"] : ["CREATE", "UID COPY", "UID STORE", "UID EXPUNGE"]);
    expect(ctl.listMessages("INBOX")).toHaveLength(0);
    expect(ctl.listMessages("Archive", { raw: true }).map((m) => m.raw?.toString())).toEqual([targetRaw]);
    expect(await client.call("ops.list", {})).toEqual([expect.objectContaining({ kind: "archive", state: "succeeded", attempts: 1 })]);
    expect((await client.call("threads.get", { threadId: thread.id })).messages[0]?.bodyText).toBe("Exact admitted body\n");
  });

  it("does not create Junk when spam has no movable Sent source", async () => {
    const { imap, backend, client, addAccount } = await setup({ imap: {
      plugins: ["IDLE", "SPECIAL-USE", "ENABLE", "CONDSTORE"], storage: { INBOX: {}, "": { separator: "/", folders: { Sent: { "special-use": "\\Sent" } } } },
    } });
    const ctl = imap.server.control;
    const targetRaw = raw({ subject: "Sent-only no-op", from: "Luis <luis@test.local>", body: "Exact Sent body" });
    const target = ctl.addMessage("Sent", { raw: targetRaw });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const thread = (await client.call("threads.list", { view: "sent" })).items.find((t) => t.subject === "Sent-only no-op")!;
    const mutations: string[] = [];
    imap.server.script.add({ on: "command", run: true, when: (context) => {
      if (/^(?:UID )?(?:COPY|MOVE|STORE|EXPUNGE|CREATE)$/.test(context.command ?? "")) {
        if (mutations.length >= 32) throw new Error("Unexpected unbounded IMAP mutations");
        mutations.push(context.command!);
      }
      return false;
    } });
    await client.call("threads.act", { threadIds: [thread.id], action: "spam" });
    await backend.runWorker();
    expect.soft(mutations).toEqual([]);
    expect.soft(ctl.listMessages("Sent", { raw: true }).map((m) => [m.uid, m.raw?.toString()])).toEqual([[target.uid, targetRaw]]);
    expect.soft(await client.call("ops.list", {})).toEqual([expect.objectContaining({ kind: "spam", state: "succeeded", attempts: 1 })]);
    expect((await client.call("threads.get", { threadId: thread.id })).messages[0]?.bodyText).toBe("Exact Sent body\n");
  });

  it.each([
    { revision: "dual-unenabled", allMail: false },
    { revision: "dual-enabled", allMail: false },
    { revision: "rev2-only", allMail: false },
    { revision: "dual-unenabled", allMail: true },
    { revision: "dual-enabled", allMail: true },
    { revision: "rev2-only", allMail: true },
  ])("matches folded capability wire semantics ($revision, All Mail $allMail)", async ({ revision, allMail }) => {
    const destination = allMail ? "All" : "Archive";
    const { imap, backend, client, addAccount } = await setup({ imap: {
      plugins: ["IMAP4rev2", "SPECIAL-USE", "ENABLE"], storage: { INBOX: {}, "": { separator: "/", folders: { [destination]: { "special-use": allMail ? "\\All" : "\\Archive" } } } },
    } });
    imap.server.registerCapability("MOVE", () => false);
    imap.server.registerCapability("UIDPLUS", () => false);
    const capabilities: string[][] = [];
    imap.server.script.add({ on: "response", description: "CAPABILITY LIST", mutate: (response) => {
      if (revision === "rev2-only") response.attributes = response.attributes.filter((attribute: { value: string }) => attribute.value !== "IMAP4rev1");
      if (capabilities.length >= 16) throw new Error("Unexpected unbounded capability responses");
      capabilities.push(response.attributes.map((attribute: { value: string }) => attribute.value));
    } });
    if (revision === "dual-unenabled") imap.server.script.add({ on: "command", command: "ENABLE", send: "$TAG OK no extensions enabled\r\n" });
    const ctl = imap.server.control;
    const targetRaw = raw({ subject: "Folded capabilities", body: "Exact folded body" });
    const otherRaw = raw({ subject: "Folded unrelated", body: "Exact folded unrelated" });
    const target = ctl.addMessage("INBOX", { raw: targetRaw });
    const other = ctl.addMessage("INBOX", { raw: otherRaw });
    if (allMail) ctl.addMessage("All", { raw: targetRaw });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    expect(capabilities.length).toBeGreaterThan(0);
    for (const tokens of capabilities) {
      expect(tokens).not.toContain("MOVE");
      expect(tokens).not.toContain("UIDPLUS");
      expect(tokens).toContain("IMAP4rev2");
      expect(tokens.includes("IMAP4rev1")).toBe(revision !== "rev2-only");
    }
    expect(ctl.sessions().some((session) => session.enabled.includes("IMAP4rev2"))).toBe(revision !== "dual-unenabled");
    const thread = (await client.call("threads.list", { view: "inbox" })).items.find((t) => t.subject === "Folded capabilities")!;
    ctl.setFlags("INBOX", [other.uid], ["\\Deleted"], "add");
    expect(ctl.getMessage("INBOX", other.uid).flags).toContain("\\Deleted");
    const mutations: string[] = [];
    imap.server.script.add({ on: "command", run: true, when: (context) => {
      if (/^(?:UID )?(?:COPY|MOVE|STORE|EXPUNGE|CREATE)$/.test(context.command ?? "")) {
        if (mutations.length >= 32) throw new Error("Unexpected unbounded IMAP mutations");
        mutations.push(context.command!);
      }
      return false;
    } });
    await client.call("threads.act", { threadIds: [thread.id], action: "archive" });
    await backend.runWorker();
    const allowed = revision !== "dual-unenabled";
    expect(mutations).toEqual(allowed ? allMail ? ["UID STORE", "UID EXPUNGE"] : ["UID MOVE"] : []);
    expect(ctl.listMessages("INBOX", { raw: true }).map((m) => [m.uid, m.raw?.toString()])).toEqual(allowed ? [[other.uid, otherRaw]] : [[target.uid, targetRaw], [other.uid, otherRaw]]);
    expect(ctl.getMessage("INBOX", other.uid).flags).toContain("\\Deleted");
    expect(ctl.listMessages(destination, { raw: true }).map((m) => m.raw?.toString())).toEqual(allowed || allMail ? [targetRaw] : []);
    expect(await client.call("ops.list", {})).toEqual([expect.objectContaining({ kind: "archive", state: allowed ? "succeeded" : "failed", attempts: 1 })]);
    expect((await client.call("threads.get", { threadId: thread.id })).messages[0]?.bodyText).toBe("Exact folded body\n");
  });

  it.each([false, true])("uses the reconnected session's move capabilities (initial safe %s)", async (initial) => {
    const { imap, backend, client, addAccount } = await setup();
    let safe = initial;
    imap.server.registerCapability("MOVE", () => safe);
    imap.server.registerCapability("UIDPLUS", () => safe);
    const ctl = imap.server.control;
    const targetRaw = raw({ subject: "Reconnected target", body: "Exact reconnect body" });
    const otherRaw = raw({ subject: "Reconnected unrelated", body: "Exact reconnect unrelated" });
    const target = ctl.addMessage("INBOX", { raw: targetRaw });
    const other = ctl.addMessage("INBOX", { raw: otherRaw });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const thread = (await client.call("threads.list", { view: "inbox" })).items.find((t) => t.subject === "Reconnected target")!;
    const priorSessions = ctl.sessions().map((session) => session.session);
    expect(priorSessions.length).toBeGreaterThan(0);
    safe = !initial;
    expect(ctl.disconnect({ user: "testuser" })).toBeGreaterThan(0);
    await backend.syncAccount(account.id);
    expect(ctl.sessions().some((session) => !priorSessions.includes(session.session))).toBe(true);
    ctl.setFlags("INBOX", [other.uid], ["\\Deleted"], "add");
    expect(ctl.getMessage("INBOX", other.uid).flags).toContain("\\Deleted");
    const mutations: string[] = [];
    imap.server.script.add({ on: "command", run: true, when: (context) => {
      if (/^(?:UID )?(?:COPY|MOVE|STORE|EXPUNGE|CREATE)$/.test(context.command ?? "")) {
        if (mutations.length >= 32) throw new Error("Unexpected unbounded IMAP mutations");
        mutations.push(context.command!);
      }
      return false;
    } });
    await client.call("threads.act", { threadIds: [thread.id], action: "archive" });
    await backend.runWorker();
    expect(mutations).toEqual(safe ? ["UID MOVE"] : []);
    expect(ctl.listMessages("INBOX", { raw: true }).map((m) => [m.uid, m.raw?.toString()])).toEqual(safe ? [[other.uid, otherRaw]] : [[target.uid, targetRaw], [other.uid, otherRaw]]);
    expect(ctl.getMessage("INBOX", other.uid).flags).toContain("\\Deleted");
    expect(ctl.listMessages("Archive", { raw: true }).map((m) => m.raw?.toString())).toEqual(safe ? [targetRaw] : []);
    expect(await client.call("ops.list", {})).toEqual([expect.objectContaining({ kind: "archive", state: safe ? "succeeded" : "failed", attempts: 1 })]);
    expect((await client.call("threads.get", { threadId: thread.id })).messages[0]?.bodyText).toBe("Exact reconnect body\n");
  });

  it.each([
    { fault: "MOVE ACK on reconnect", native: true, command: "UID MOVE", gone: true, wire: ["UID MOVE"] },
    { fault: "native MOVE ACK", native: true, command: "UID MOVE", gone: true, wire: ["UID MOVE"] },
    { fault: "fallback COPY ACK", native: false, command: "UID COPY", gone: false, wire: ["UID COPY"] },
    { fault: "fallback STORE ACK", native: false, command: "UID STORE", gone: false, wire: ["UID COPY", "UID STORE"] },
    { fault: "fallback EXPUNGE ACK", native: false, command: "UID EXPUNGE", gone: true, wire: ["UID COPY", "UID STORE", "UID EXPUNGE"] },
  ])("does not replay after losing $fault following real application", async ({ fault, native, command, gone, wire }) => {
    const { imap, backend, client, addAccount, stop, dir } = await setup({ imap: { plugins: ["IDLE", "UIDPLUS", "SPECIAL-USE", "ENABLE", "CONDSTORE", ...(native ? ["MOVE"] : [])] } });
    const ctl = imap.server.control;
    const bytes = raw({ subject: "Uncertain move", body: "Exact uncertain move bytes" });
    const otherBytes = raw({ subject: "Unrelated deleted", body: "Preserve unrelated bytes" });
    const source = ctl.addMessage("INBOX", { raw: bytes });
    const other = ctl.addMessage("INBOX", { raw: otherBytes });
    const destBefore = ctl.getMailbox("Archive");
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const thread = (await client.call("threads.list", { view: "inbox" })).items.find((t) => t.subject === "Uncertain move")!;
    const message = (await client.call("threads.get", { threadId: thread.id })).messages[0]!;
    const locations = backend.store.providerStore(account.id).locations!;
    const before = await locations.of([message.id]);
    expect(before).toEqual([expect.objectContaining({ mailbox: "INBOX", uid: source.uid, uidvalidity: source.uidvalidity })]);
    ctl.setFlags("INBOX", [other.uid], ["\\Deleted"], "add");
    const commands: string[] = [];
    imap.server.script.add({ on: "command", run: true, when: (context) => {
      if (/^UID (MOVE|COPY|STORE|EXPUNGE)$/.test(context.command ?? "")) {
        if (commands.length >= 32) throw new Error("Unexpected unbounded mutations");
        commands.push(context.command!);
      }
      return false;
    } });
    if (fault === "MOVE ACK on reconnect") {
      (await backend.provider(account.id))!.reset!();
      imap.server.script.add({ on: "command", command: "SELECT", times: 1, drop: true, close: "reset" });
    }
    const lost = imap.server.script.add({ on: "response", command, untagged: false, times: 1, drop: true, close: "reset" });
    await client.call("threads.act", { threadIds: [thread.id], action: "archive" });
    await backend.runWorker();
    expect(lost!.hits).toBe(1);
    const remote = () => ({
      sourceEpoch: ctl.getMailbox("INBOX").uidvalidity,
      destinationEpoch: ctl.getMailbox("Archive").uidvalidity,
      source: ctl.listMessages("INBOX", { raw: true }).map((m) => ({ uid: m.uid, bytes: m.raw?.toString(), size: m.raw?.length, flags: m.flags })),
      destination: ctl.listMessages("Archive", { raw: true }).map((m) => ({ uid: m.uid, bytes: m.raw?.toString(), size: m.raw?.length })),
    });
    const actual = remote();
    expect.soft(commands).toEqual(wire);
    expect.soft(actual.sourceEpoch).toBe(source.uidvalidity);
    expect.soft(actual.destinationEpoch).toBe(destBefore.uidvalidity);
    expect.soft(actual.destination).toEqual([{ uid: destBefore.uidnext, bytes, size: Buffer.byteLength(bytes) }]);
    expect.soft(actual.source.map((m) => m.uid)).toEqual(gone ? [other.uid] : [source.uid, other.uid]);
    if (!gone) expect.soft(actual.source.find((m) => m.uid === source.uid)).toMatchObject({ bytes, size: Buffer.byteLength(bytes), flags: command === "UID STORE" ? expect.arrayContaining(["\\Deleted"]) : expect.not.arrayContaining(["\\Deleted"]) });
    expect.soft(actual.source.find((m) => m.uid === other.uid)).toMatchObject({ bytes: otherBytes, size: Buffer.byteLength(otherBytes), flags: expect.arrayContaining(["\\Deleted"]) });
    expect.soft(await client.call("ops.list", {})).toEqual([expect.objectContaining({ kind: "archive", state: "unknown", attempts: 1, lastErrorI18n: { key: "errors.imap.changeUnknown" } })]);
    expect.soft(await locations.of([message.id])).toEqual(before);
    expect((await client.call("threads.get", { threadId: thread.id })).messages[0]?.bodyText).toBe("Exact uncertain move bytes\n");
    await backend.runWorker();
    backend.networkChanged(true, "network");
    await backend.runWorker();
    expect.soft(remote()).toEqual(actual);
    expect.soft(commands).toEqual(wire);
    expect.soft((await client.call("ops.list", {}))[0]).toMatchObject({ state: "unknown", attempts: 1 });
    await backend.syncAccount(account.id);
    const synced = await locations.of([message.id]);
    expect(synced.some((l) => l.mailbox === "Archive")).toBe(false);
    expect(await locations.unresolved([message.id])).toEqual([message.id]);
    expect(synced.some((l) => l.mailbox === "INBOX")).toBe(!gone);
    expect((await client.call("threads.get", { threadId: thread.id })).messages[0]?.bodyText).toBe("Exact uncertain move bytes\n");
    if (fault === "native MOVE ACK") {
      await stop();
      const reopened = new Backend({ dbPath: join(dir, "u.db"), version: "t", cipher: plaintextCipher, providers: createRegistry({ imap: { allowInsecure: true } }), autoSync: false });
      cleanups.push(() => reopened.stop());
      await reopened.runWorker();
      const [c, server] = createMemoryTransportPair();
      reopened.connect(server, { clientId: "reopen-uncertain", origin: "renderer" });
      const rpc = new RpcClient(c);
      expect(await rpc.call("ops.list", {})).toEqual([expect.objectContaining({ state: "unknown", attempts: 1 })]);
      expect(remote()).toEqual(actual);
      expect(commands).toEqual(wire);
    }
  });

  it("does not duplicate a copy-only All Mail action after a lost COPY ACK without MOVE or UIDPLUS", async () => {
    const { imap, backend, client, addAccount } = await setup({ imap: {
      plugins: ["IDLE", "SPECIAL-USE", "ENABLE", "CONDSTORE"],
      storage: { INBOX: {}, "": { separator: "/", folders: { All: { "special-use": "\\All" }, Sent: { "special-use": "\\Sent" } } } },
    } });
    const ctl = imap.server.control;
    const bytes = raw({ subject: "Copy once", body: "Exact copy bytes" });
    const source = ctl.addMessage("All", { raw: bytes });
    const inbox = ctl.getMailbox("INBOX");
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const thread = (await client.call("threads.list", { view: "archive" })).items.find((t) => t.subject === "Copy once")!;
    const message = (await client.call("threads.get", { threadId: thread.id })).messages[0]!;
    const locations = backend.store.providerStore(account.id).locations!;
    const before = await locations.of([message.id]);
    expect(before).toEqual([expect.objectContaining({ mailbox: "All", uid: source.uid, uidvalidity: source.uidvalidity })]);
    const lost = imap.server.script.add({ on: "response", command: "UID COPY", untagged: false, times: 1, drop: true, close: "reset" });
    await client.call("threads.act", { threadIds: [thread.id], action: "moveToInbox" });
    await backend.runWorker();
    expect(lost!.hits).toBe(1);
    const check = async () => {
      expect.soft(ctl.getMailbox("All").uidvalidity).toBe(source.uidvalidity);
      expect.soft(ctl.getMailbox("INBOX").uidvalidity).toBe(inbox.uidvalidity);
      expect.soft(ctl.listMessages("All", { raw: true }).map((m) => [m.uid, m.raw?.toString(), m.raw?.length])).toEqual([[source.uid, bytes, Buffer.byteLength(bytes)]]);
      expect.soft(ctl.listMessages("INBOX", { raw: true }).map((m) => [m.uid, m.raw?.toString(), m.raw?.length])).toEqual([[inbox.uidnext, bytes, Buffer.byteLength(bytes)]]);
      expect.soft(await client.call("ops.list", {})).toEqual([expect.objectContaining({ state: "unknown", attempts: 1 })]);
      expect.soft(await locations.of([message.id])).toEqual(before);
    };
    await check();
    await backend.runWorker();
    await check();
  });

  it.each(["UID STORE", "UID EXPUNGE"])("reports unknown when All Mail deletion loses %s acknowledgement", async (command) => {
    const { imap, backend, client, addAccount } = await setup({ imap: {
      plugins: ["IDLE", "UIDPLUS", "SPECIAL-USE", "ENABLE", "CONDSTORE"],
      storage: { INBOX: {}, "": { separator: "/", folders: { All: { "special-use": "\\All" }, Sent: { "special-use": "\\Sent" } } } },
    } });
    const ctl = imap.server.control;
    const bytes = raw({ subject: "Delete once", body: "Exact delete bytes" });
    const target = ctl.addMessage("INBOX", { raw: bytes });
    const all = ctl.addMessage("All", { raw: bytes });
    const unrelatedBytes = raw({ subject: "Unrelated", body: "Unrelated delete bytes" });
    const other = ctl.addMessage("INBOX", { raw: unrelatedBytes });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const thread = (await client.call("threads.list", { view: "inbox" })).items.find((t) => t.subject === "Delete once")!;
    const message = (await client.call("threads.get", { threadId: thread.id })).messages[0]!;
    const locations = backend.store.providerStore(account.id).locations!;
    const before = await locations.of([message.id]);
    ctl.setFlags("INBOX", [other.uid], ["\\Deleted"], "add");
    const lost = imap.server.script.add({ on: "response", command, untagged: false, times: 1, drop: true, close: "reset" });
    await client.call("threads.act", { threadIds: [thread.id], action: "archive" });
    await backend.runWorker();
    expect(lost!.hits).toBe(1);
    const check = async () => {
      expect.soft(ctl.getMailbox("INBOX").uidvalidity).toBe(target.uidvalidity);
      expect.soft(ctl.getMailbox("All").uidvalidity).toBe(all.uidvalidity);
      expect.soft(ctl.listMessages("All", { raw: true }).map((m) => [m.uid, m.raw?.toString(), m.raw?.length])).toEqual([[all.uid, bytes, Buffer.byteLength(bytes)]]);
      const remaining = ctl.listMessages("INBOX", { raw: true });
      expect.soft(remaining.map((m) => [m.uid, m.raw?.toString(), m.raw?.length])).toEqual(command === "UID STORE" ? [[target.uid, bytes, Buffer.byteLength(bytes)], [other.uid, unrelatedBytes, Buffer.byteLength(unrelatedBytes)]] : [[other.uid, unrelatedBytes, Buffer.byteLength(unrelatedBytes)]]);
      expect.soft(remaining.every((m) => m.flags.includes("\\Deleted"))).toBe(true);
      expect.soft(await locations.of([message.id])).toEqual(before);
      expect.soft((await client.call("ops.list", {}))[0]).toMatchObject({ state: "unknown", attempts: 1, lastErrorI18n: { key: "errors.imap.changeUnknown" } });
    };
    await check();
    await backend.runWorker();
    await check();
  });

  it("does not replay an acknowledged move when recording local locations fails", async () => {
    const { imap, backend, client, addAccount } = await setup();
    const ctl = imap.server.control;
    const bytes = raw({ subject: "Record once", body: "Exact recorded bytes" });
    const source = ctl.addMessage("INBOX", { raw: bytes });
    const dest = ctl.getMailbox("Archive");
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const thread = (await client.call("threads.list", { view: "inbox" })).items[0]!;
    const message = (await client.call("threads.get", { threadId: thread.id })).messages[0]!;
    const locations = backend.store.providerStore(account.id).locations!;
    const before = await locations.of([message.id]);
    const proto = Object.getPrototypeOf(locations) as { mappedMove(...args: unknown[]): Promise<void> };
    const fail = vi.spyOn(proto, "mappedMove").mockRejectedValueOnce(new Error("Synthetic local location failure"));
    try {
      await client.call("threads.act", { threadIds: [thread.id], action: "archive" });
      await backend.runWorker();
    } finally { fail.mockRestore(); }
    expect.soft(await client.call("ops.list", {})).toEqual([expect.objectContaining({ state: "unknown", attempts: 1 })]);
    expect.soft(await locations.of([message.id])).toEqual(before);
    expect(ctl.getMailbox("INBOX").uidvalidity).toBe(source.uidvalidity);
    expect(ctl.getMailbox("Archive").uidvalidity).toBe(dest.uidvalidity);
    expect(ctl.listMessages("INBOX")).toHaveLength(0);
    expect(ctl.listMessages("Archive", { raw: true }).map((m) => [m.uid, m.raw?.toString(), m.raw?.length])).toEqual([[dest.uidnext, bytes, Buffer.byteLength(bytes)]]);
    await backend.runWorker();
    expect.soft((await client.call("ops.list", {}))[0]).toMatchObject({ state: "unknown", attempts: 1 });
  });

  it("retries a lost read-only FETCH acknowledgement without changing remote bytes", async () => {
    const { imap, backend, client, addAccount } = await setup();
    const ctl = imap.server.control;
    const bytes = raw({ subject: "Safe read retry", body: "Exact safe read bytes" });
    const source = ctl.addMessage("INBOX", { raw: bytes });
    const account = await addAccount(imap.port);
    const lost = imap.server.script.add({ on: "response", command: "UID FETCH", untagged: false, times: 1, drop: true, close: "reset" });
    await backend.syncAccount(account.id);
    expect(lost!.hits).toBe(1);
    expect(ctl.getMailbox("INBOX").uidvalidity).toBe(source.uidvalidity);
    expect(ctl.listMessages("INBOX", { raw: true }).map((m) => [m.uid, m.raw?.toString(), m.raw?.length])).toEqual([[source.uid, bytes, Buffer.byteLength(bytes)]]);
    const [thread] = (await client.call("threads.list", { view: "inbox" })).items;
    const message = (await client.call("threads.get", { threadId: thread!.id })).messages[0]!;
    expect(message.bodyText).toBe("Exact safe read bytes\n");
    expect(await backend.store.providerStore(account.id).locations!.of([message.id])).toEqual([expect.objectContaining({ mailbox: "INBOX", uid: source.uid, uidvalidity: source.uidvalidity })]);
    expect(await client.call("ops.list", {})).toEqual([]);
  });

  it.each([false, true])("retries a pre-mutation SELECT failure but never a later-source failure (earlier progress %s)", async (progress) => {
    const { imap, backend, client, addAccount } = await setup();
    const ctl = imap.server.control;
    const boxes = progress ? ["Archive", "Projects"] : ["Archive"];
    if (progress) ctl.createMailbox("Projects");
    const seeded = boxes.map((box, i) => {
      const bytes = raw({ subject: `Source ${i}`, body: `Exact source ${i}` });
      return { box, bytes, ...ctl.addMessage(box, { raw: bytes }) };
    });
    const inbox = ctl.getMailbox("INBOX");
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const ids = seeded.map(({ bytes }) => sqlDb(backend.store).get<{ id: number }>("SELECT id FROM messages WHERE subject = ?", /Subject: (.*)\r/.exec(bytes)![1]!)!.id);
    const locations = backend.store.providerStore(account.id).locations!;
    const before = await locations.of(ids);
    expect(before).toHaveLength(boxes.length);
    const order = [...new Set(before.map((l) => l.mailbox))];
    const selected: string[] = [];
    imap.server.script.add({ on: "command", command: "SELECT", run: true, when: (c) => {
      selected.push(c.data);
      return false;
    } });
    const failedBox = order[progress ? 1 : 0]!;
    const lost = imap.server.script.add({ on: "command", command: "SELECT", match: new RegExp(failedBox), times: 1, drop: true, close: "reset" });
    // Separate threads still form one provider operation with multiple source folders.
    const threads = (await client.call("threads.list", { view: "all" })).items.filter((t) => t.subject.startsWith("Source "));
    expect(threads).toHaveLength(boxes.length);
    await client.call("threads.act", { threadIds: threads.map((t) => t.id), action: "moveToInbox" });
    await backend.runWorker();
    expect(lost!.hits).toBe(1);
    const expected = seeded.filter((s) => !progress || s.box === order[0]);
    expect.soft(ctl.getMailbox("INBOX").uidvalidity).toBe(inbox.uidvalidity);
    expect.soft(ctl.listMessages("INBOX", { raw: true }).map((m) => [m.uid, m.raw?.toString(), m.raw?.length])).toEqual(expected.map((s, i) => [inbox.uidnext + i, s.bytes, Buffer.byteLength(s.bytes)]));
    for (const s of seeded) {
      expect.soft(ctl.getMailbox(s.box).uidvalidity).toBe(s.uidvalidity);
      expect.soft(ctl.listMessages(s.box, { raw: true }).map((m) => [m.uid, m.raw?.toString()])).toEqual(expected.includes(s) ? [] : [[s.uid, s.bytes]]);
    }
    expect.soft((await client.call("ops.list", {}))[0]).toMatchObject({ state: progress ? "unknown" : "succeeded", attempts: 1 });
    expect.soft(selected.filter((line) => line.includes(failedBox))).toHaveLength(progress ? 1 : 2);
    await backend.runWorker();
    expect.soft((await client.call("ops.list", {}))[0]).toMatchObject({ state: progress ? "unknown" : "succeeded", attempts: 1 });
  });

  it("archives on the server with MOVE and keeps the message (now in Archive) after resync", async () => {
    const { imap, backend, client, addAccount } = await setup();
    imap.server.control.addMessage("INBOX", { raw: raw({ subject: "Archívame" }) });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const [t] = (await client.call("threads.list", { view: "inbox" })).items;
    await client.call("threads.act", { threadIds: [t!.id], action: "archive" });
    await backend.runWorker();
    expect(imap.server.control.listMessages("INBOX")).toHaveLength(0);
    expect(imap.server.control.listMessages("Archive")).toHaveLength(1);
    await backend.syncAccount(account.id);
    expect((await client.call("threads.list", { view: "archive" })).items.map((x) => x.subject)).toEqual(["Archívame"]);
    expect(count(backend, "SELECT 1 FROM messages")).toBe(1);
    expect(sqlDb(backend.store).all("SELECT mailbox FROM message_locations")).toEqual([{ mailbox: "Archive" }]);
  });

  it("applies flag changes, expunges and moves made by other clients", async () => {
    const { imap, backend, client, addAccount } = await setup();
    const ctl = imap.server.control;
    const a = ctl.addMessage("INBOX", { raw: raw({ subject: "A" }) });
    const b = ctl.addMessage("INBOX", { raw: raw({ subject: "B" }) });
    const c = ctl.addMessage("INBOX", { raw: raw({ subject: "C" }) });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    ctl.setFlags("INBOX", [a.uid], ["\\Seen", "\\Flagged"], "add");
    ctl.expungeMessages("INBOX", [b.uid]);
    ctl.moveMessages("INBOX", [c.uid], "Archive");
    ctl.addMessage("INBOX", { raw: raw({ subject: "D" }) });
    await backend.syncAccount(account.id);
    const rows = sqlDb(backend.store).all<{ subject: string; is_read: number; is_starred: number; in_inbox: number }>("SELECT subject, is_read, is_starred, in_inbox FROM messages ORDER BY subject");
    expect(rows).toEqual([
      { subject: "A", is_read: 1, is_starred: 1, in_inbox: 1 },
      { subject: "B", is_read: 0, is_starred: 0, in_inbox: 1 },
      { subject: "C", is_read: 0, is_starred: 0, in_inbox: 1 },
      { subject: "D", is_read: 0, is_starred: 0, in_inbox: 1 },
    ]);
    expect((await client.call("counts.get", {})).inboxUnread).toBe(3);
  });

  it("holds mail across a UIDVALIDITY reset without duplicating mail", async () => {
    const { imap, backend, addAccount } = await setup();
    const ctl = imap.server.control;
    for (const s of ["uno", "dos", "tres"]) ctl.addMessage("INBOX", { raw: raw({ subject: s }) });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const before = sqlDb(backend.store).all<{ uid: number; uidvalidity: number }>("SELECT uid, uidvalidity FROM message_locations ORDER BY uid");
    ctl.resetUidValidity("INBOX", { uids: "offset", offset: 100 });
    await backend.syncAccount(account.id);
    const after = sqlDb(backend.store).all<{ uid: number; uidvalidity: number }>("SELECT uid, uidvalidity FROM message_locations ORDER BY uid");
    expect(count(backend, "SELECT 1 FROM messages")).toBe(3);
    expect(before).toHaveLength(3);
    expect(after).toEqual([]);
    // ops still target the right message after the reset
    const thread = sqlDb(backend.store).get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE subject = 'dos'")!.thread_id;
    await backend.server.invoke("threads.act", { threadIds: [thread], action: "markRead" }, { clientId: "t", origin: "renderer" });
    await backend.runWorker();
    expect(ctl.listMessages("INBOX").every((m) => !m.flags.includes("\\Seen"))).toBe(true);
    expect((await backend.store.ops.recent(20))[0]).toMatchObject({ state: "queued", attempts: 0, next_attempt_at: AWAITING_IDENTITY });
  });

  it("does not let a sync clobber an optimistic change whose op hasn't run yet", async () => {
    const { imap, backend, client, addAccount } = await setup();
    imap.server.control.addMessage("INBOX", { raw: raw({ subject: "pendiente" }) });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const [t] = (await client.call("threads.list", { view: "inbox" })).items;
    await client.call("threads.act", { threadIds: [t!.id], action: "markRead" });
    await backend.syncAccount(account.id); // server still says unseen
    expect(sqlDb(backend.store).get("SELECT is_read FROM messages")).toEqual({ is_read: 1 });
    await backend.runWorker();
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).get("SELECT is_read FROM messages")).toEqual({ is_read: 1 });
  });

  it("shows two IMAP accounts in one unified inbox", async () => {
    const { imap, backend, client, addAccount } = await setup();
    const other = await startImap();
    imap.server.control.addMessage("INBOX", { raw: raw({ subject: "de la cuenta 1" }) });
    other.server.control.addMessage("INBOX", { raw: raw({ subject: "de la cuenta 2" }) });
    const a1 = await addAccount(imap.port, "uno@test.local");
    const a2 = await addAccount(other.port, "dos@test.local");
    await Promise.all([backend.syncAccount(a1.id), backend.syncAccount(a2.id)]);
    const items = (await client.call("threads.list", { view: "inbox" })).items;
    expect(new Set(items.map((t) => t.accountId))).toEqual(new Set([a1.id, a2.id]));
  });

  it("picks up new mail through IDLE without polling", async () => {
    const { imap, client, addAccount } = await setup();
    await addAccount(imap.port);
    await new Promise((r) => setTimeout(r, 500)); // IDLE connection established
    imap.server.control.addMessage("INBOX", { raw: raw({ subject: "¡Llegó por IDLE!" }) });
    await expect.poll(async () => (await client.call("threads.list", { view: "inbox" })).items.map((t) => t.subject), { timeout: 8000 }).toContain("¡Llegó por IDLE!");
  });

  it("plan 41: after the first sync, a person's mail arriving through IDLE notifies once; list mail and the first sync never do", async () => {
    const notices: import("@terno/core").MailNotice[] = [];
    const { imap, backend, client, addAccount } = await setup({ attention: { badge: () => {}, notify: (n) => notices.push(n) } });
    await backend.start();
    // you wrote to Ana before; the first sync brings her old mail, which is no news
    imap.server.control.addMessage("Sent", { raw: raw({ subject: "Hola Ana", from: "Luis <luis@test.local>", to: "Ana Pérez <ana@example.com>" }), flags: ["\\Seen"] });
    imap.server.control.addMessage("INBOX", { raw: raw({ subject: "Ya estaba" }) });
    await addAccount(imap.port);
    await expect.poll(async () => (await client.call("threads.list", { view: "inbox" })).items.length, { timeout: 8000 }).toBe(1);
    await new Promise((r) => setTimeout(r, 1500)); // the first pass over, IDLE established
    expect(notices).toEqual([]);
    imap.server.control.addMessage("INBOX", { raw: raw({ subject: "Boletín", from: "Xataka <boletin@xataka.com>", listId: "boletin.xataka.com" }) });
    imap.server.control.addMessage("INBOX", { raw: raw({ subject: "¿Comemos?", body: "¿El jueves?" }) });
    await expect.poll(() => notices.length, { timeout: 10_000 }).toBe(1);
    expect(notices[0]).toMatchObject({ count: 1, senders: ["Ana Pérez"], subject: "¿Comemos?" });
  });
});

describe("a new account's first sync (plan 76)", () => {
  /** each ingest's subjects and each body set, in order, through the backend's own sink */
  const record = (backend: Backend) => {
    const events: string[] = [];
    const core = backend as unknown as { ingestSliced: (m: { subject: string }[], ...rest: unknown[]) => Promise<unknown>; store: { sync: { setBody: (...a: unknown[]) => Promise<unknown> } } };
    const ingest = core.ingestSliced.bind(core);
    vi.spyOn(core, "ingestSliced").mockImplementation((m, ...rest) => {
      if (m.length) events.push(`ingest:${m.length}:${m.map((x) => Number(x.subject.slice(4))).sort((a, b) => a - b)[0]}`);
      return ingest(m, ...rest);
    });
    const setBody = core.store.sync.setBody.bind(core.store.sync);
    vi.spyOn(core.store.sync, "setBody").mockImplementation((...a) => {
      if (events.at(-1) !== "bodies") events.push("bodies");
      return setBody(...a);
    });
    return events;
  };

  it("brings the newest 250 Inbox messages, with their bodies, before the rest; the end is a plain read's", async () => {
    const { imap, backend, addAccount } = await setup();
    for (let i = 1; i <= 300; i++) imap.server.control.addMessage("INBOX", { raw: raw({ subject: `msg ${i}` }) });
    const account = await addAccount(imap.port);
    const events = record(backend);
    await backend.syncAccount(account.id);
    // the newest 250 (msg 51…300), their bodies, then the 50 older ones, then theirs
    expect(events).toEqual(["ingest:250:51", "bodies", "ingest:50:1", "bodies"]);
    expect(count(backend, "SELECT 1 FROM messages")).toBe(300);
    expect(count(backend, "SELECT 1 FROM message_locations")).toBe(300);
    expect(count(backend, "SELECT message_id FROM message_locations GROUP BY message_id HAVING count(*) > 1")).toBe(0);
    expect(count(backend, "SELECT 1 FROM messages WHERE body_state = 'full'")).toBe(300);
    // a later pass reads only what's new: no preview
    events.length = 0;
    imap.server.control.addMessage("INBOX", { raw: raw({ subject: "msg 301" }) });
    await backend.syncAccount(account.id);
    expect(events).toEqual(["ingest:1:301", "bodies"]);
  });

  /** the pass stops right after the preview (its bodies in): the full read's first ingest fails, once; the sizes of every ingest */
  const stopAfterPreview = (backend: Backend) => {
    const core = backend as unknown as { ingestSliced: (...a: unknown[]) => Promise<unknown> };
    const ingest = core.ingestSliced.bind(core);
    const sizes: number[] = [];
    vi.spyOn(core, "ingestSliced").mockImplementation((...a) => {
      sizes.push((a[0] as unknown[]).length);
      if (sizes.length === 2) throw new Error("synthetic stop after the preview");
      return ingest(...a);
    });
    return sizes;
  };
  const placed = (backend: Backend) => sqlDb(backend.store).all<{ subject: string; uid: number; uidvalidity: number }>("SELECT m.subject, l.uid, l.uidvalidity FROM messages m JOIN message_locations l ON l.message_id = m.id ORDER BY l.uid");

  it("a first pass that stopped after the preview doesn't preview again, and writes nothing twice (twins on both sides of its edge)", async () => {
    const { imap, backend, addAccount } = await setup();
    // the same message twice: UID 1, before the preview's edge, and UID 272, inside it
    imap.server.control.addMessage("INBOX", { raw: raw({ subject: "msg 0", id: "twice@test.local" }) });
    for (let i = 1; i <= 270; i++) imap.server.control.addMessage("INBOX", { raw: raw({ subject: `msg ${i}` }) });
    imap.server.control.addMessage("INBOX", { raw: raw({ subject: "msg 0", id: "twice@test.local" }) });
    const account = await addAccount(imap.port);
    const sizes = stopAfterPreview(backend);
    await backend.syncAccount(account.id);
    await backend.syncAccount(account.id);
    // the preview, the stopped read, then (its retry) only the 22 older ones (UIDs 1…22): never a second preview
    expect(sizes).toEqual([250, 22, 22]);
    // the preview was written down when it was done, and the Inbox's full read took its place
    const cursor = JSON.parse(sqlDb(backend.store).get<{ c: string }>("SELECT provider_config AS c FROM accounts WHERE id = ?", account.id)!.c).cursor as { previewed?: object; mailboxes: object };
    expect(cursor.previewed).toBeUndefined();
    expect(cursor.mailboxes).toHaveProperty("INBOX");
    const rows = placed(backend);
    expect(rows.map((r) => r.uid)).toEqual(Array.from({ length: 272 }, (_, i) => i + 1));
    expect(count(backend, "SELECT 1 FROM messages")).toBe(272);
    expect(count(backend, "SELECT 1 FROM messages WHERE rfc_message_id = 'twice@test.local'")).toBe(2);
  });

  it("a folder named constructor is a folder, not the preview's mark (Codex R2)", async () => {
    const { imap, backend, addAccount } = await setup();
    for (let i = 1; i <= 260; i++) imap.server.control.addMessage("INBOX", { raw: raw({ subject: `msg ${i}` }) });
    imap.server.control.createMailbox("constructor");
    imap.server.control.addMessage("constructor", { raw: raw({ subject: "in a folder called constructor" }) });
    const account = await addAccount(imap.port);
    // the retry reads a cursor with the preview's mark in it, back from JSON
    stopAfterPreview(backend);
    await backend.syncAccount(account.id);
    await backend.syncAccount(account.id);
    expect(count(backend, "SELECT 1 FROM messages")).toBe(261);
    expect(count(backend, "SELECT 1 FROM message_locations WHERE mailbox = 'constructor'")).toBe(1);
  });

  it("a UIDVALIDITY reset between the preview and the full read is a reset: what the server dropped goes", async () => {
    const { imap, backend, addAccount } = await setup();
    const ctl = imap.server.control;
    for (let i = 1; i <= 260; i++) ctl.addMessage("INBOX", { raw: raw({ subject: `msg ${i}` }) });
    const account = await addAccount(imap.port);
    // the server resets while the pass is stopped (before its retry reads the Inbox)
    const core = backend as unknown as { ingestSliced: (...a: unknown[]) => Promise<unknown> };
    const ingest = core.ingestSliced.bind(core);
    let calls = 0;
    let before = 0;
    vi.spyOn(core, "ingestSliced").mockImplementation((...a) => {
      if (++calls === 2) {
        before = placed(backend)[0]!.uidvalidity;
        ctl.expungeMessages("INBOX", [260]);
        ctl.resetUidValidity("INBOX", { uids: "offset", offset: 1000 });
        throw new Error("synthetic stop after the preview");
      }
      return ingest(...a);
    });
    await backend.syncAccount(account.id);
    await backend.syncAccount(account.id);
    expect(before).toBeGreaterThan(0);
    const rows = placed(backend);
    expect(rows).toHaveLength(259);
    expect(count(backend, "SELECT 1 FROM messages")).toBe(259);
    expect(rows.some((r) => r.subject === "msg 260")).toBe(false);
    expect(rows.every((r) => r.uidvalidity !== before && r.uid > 1000)).toBe(true);
  });

  it("a preview body the server won't give doesn't hold back the rest of the first sync", async () => {
    const { imap, backend, addAccount } = await setup();
    for (let i = 1; i <= 260; i++) imap.server.control.addMessage("INBOX", { raw: raw({ subject: `msg ${i}` }) });
    const account = await addAccount(imap.port);
    const core = backend as unknown as { store: { sync: { setBody: (...a: unknown[]) => Promise<unknown> } } };
    const setBody = core.store.sync.setBody.bind(core.store.sync);
    // one message's body never comes, however often it's asked for
    let refused: unknown;
    vi.spyOn(core.store.sync, "setBody").mockImplementation((...a) => {
      refused ??= a[0];
      if (a[0] === refused) throw new ProviderError("synthetic refused body", false);
      return setBody(...a);
    });
    await backend.syncAccount(account.id);
    // every envelope is in all the same (the body waits like any other that failed)
    expect(count(backend, "SELECT 1 FROM messages")).toBe(260);
    expect(count(backend, "SELECT 1 FROM message_locations")).toBe(260);
  });

  it("a refused login while the preview's bodies come in stops the pass: a sign-in to redo, not a body to skip", async () => {
    const { imap, backend, addAccount } = await setup();
    for (let i = 1; i <= 260; i++) imap.server.control.addMessage("INBOX", { raw: raw({ subject: `msg ${i}` }) });
    const account = await addAccount(imap.port);
    const core = backend as unknown as { store: { sync: { setBody: (...a: unknown[]) => Promise<unknown> } } };
    const setBody = core.store.sync.setBody.bind(core.store.sync);
    // the first body meets the server's refusal as the IMAP client reports it (raw, not yet a ProviderAuthError)
    let once = false;
    vi.spyOn(core.store.sync, "setBody").mockImplementation((...a) => {
      if (!once) {
        once = true;
        throw Object.assign(new Error("AUTHENTICATIONFAILED"), { authenticationFailed: true });
      }
      return setBody(...a);
    });
    const states = vi.spyOn(backend.store.accounts, "setSyncState");
    await backend.syncAccount(account.id);
    // the pass stopped there and asked for a sign-in (the server lets the next one in: it completes)
    expect(states.mock.calls.some(([, patch]) => patch.authRequired === true)).toBe(true);
  });

  it("downloads the window chosen when connecting, kept as the account's own", async () => {
    const { imap, smtp, backend, client } = await setup();
    const DAY = 86_400_000;
    imap.server.control.addMessage("INBOX", { raw: raw({ subject: "recent" }), internaldate: new Date(Date.now() - 10 * DAY) });
    imap.server.control.addMessage("INBOX", { raw: raw({ subject: "older" }), internaldate: new Date(Date.now() - 60 * DAY) });
    const account = await client.call("accounts.addImap", {
      email: "luis@test.local",
      displayName: "Luis",
      imap: { host: "127.0.0.1", port: imap.port, secure: false, user: "testuser" },
      smtp: { host: "127.0.0.1", port: smtp.port, secure: false, user: "testuser" },
      password: "testpass",
      syncWindowDays: 30,
    });
    expect(account.syncWindowDays).toBe(30);
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).all<{ subject: string }>("SELECT subject FROM messages")).toEqual([{ subject: "recent" }]);
    expect((await client.call("app.bootstrap", {})).accounts[0]!.syncWindowDays).toBe(30);
  });
});

describe("an account's own folders (plan 68)", () => {
  const folderOf = async (client: RpcClient, accountId: number, folder: string) => (await client.call("threads.list", { view: "all", accountId, folder })).items.map((t) => t.subject).sort();

  const captureIdentity = (backend: Backend) => sqlDb(backend.store).all<{ id: number; thread_id: number; body_state: string; body_text: string | null; body_html: string | null }>(
    "SELECT m.id, m.thread_id, m.body_state, b.body_text, b.body_html FROM messages m LEFT JOIN message_bodies b ON b.message_id=m.id ORDER BY m.id",
  );
  const expectRetained = async (backend: Backend, accountId: number, before: ReturnType<typeof captureIdentity>, held: number[]) => {
    expect(before.length).toBeGreaterThan(0);
    const after = captureIdentity(backend);
    for (const row of before) expect(after.find((m) => m.id === row.id)).toEqual(row);
    const locations = backend.store.providerStore(accountId).locations;
    expect(await locations.unresolved(before.map((m) => m.id))).toEqual([...held].sort((a, b) => a - b));
    if (held.length) {
      expect(await locations.of(held)).toEqual([]);
      let issued = false;
      await expect(locations.dispatch(held, [], async () => { issued = true; })).rejects.toThrow("IMAP identity unavailable");
      expect(issued).toBe(false);
    }
  };


  it("lists its own folders (nested; roles and specials left out) and syncs them; a message only in one is archived mail", async () => {
    const { imap, backend, client, addAccount } = await setup();
    const ctl = imap.server.control;
    ctl.createMailbox("Work");
    ctl.createMailbox("Work/Clients");
    ctl.addMessage("Work", { raw: raw({ subject: "Contrato" }) });
    ctl.addMessage("Work/Clients", { raw: raw({ subject: "Logo" }), flags: ["\\Seen"] });
    ctl.addMessage("INBOX", { raw: raw({ subject: "Hola" }) });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    expect((await backend.store.folders.list()).map((f) => [f.key, f.path, f.selectable])).toEqual([
      ["Work", ["Work"], true],
      ["Work/Clients", ["Work", "Clients"], true],
    ]);
    expect(await folderOf(client, account.id, "Work")).toEqual(["Contrato"]);
    expect(await folderOf(client, account.id, "Work/Clients")).toEqual(["Logo"]);
    expect((await client.call("threads.list", { view: "archive" })).items.map((t) => t.subject).sort()).toEqual(["Contrato", "Logo"]);
    expect((await client.call("counts.get", {})).folderUnread).toEqual({ [`${account.id}:Work`]: 1 });
  });

  it("external moves, renames and folder deletion retain cached mail without inferring a destination", async () => {
    const { imap, backend, client, addAccount } = await setup();
    const ctl = imap.server.control;
    ctl.createMailbox("Work");
    ctl.createMailbox("Clients");
    const m = ctl.addMessage("Work", { raw: raw({ subject: "Contrato" }) });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const retained = captureIdentity(backend);
    const id = sqlDb(backend.store).get<{ id: number }>("SELECT id FROM messages WHERE subject = 'Contrato'")!.id;
    ctl.moveMessages("Work", [m.uid], "Clients");
    await backend.syncAccount(account.id);
    expect(await folderOf(client, account.id, "Work")).toEqual([]);
    expect(await folderOf(client, account.id, "Clients")).toEqual([]);
    ctl.renameMailbox("Clients", "Proyectos");
    await backend.syncAccount(account.id);
    expect((await backend.store.folders.list()).map((f) => f.key).sort()).toEqual(["Proyectos", "Work"]);
    expect(await folderOf(client, account.id, "Proyectos")).toEqual([]);
    // the same message, never removed and fetched again; its old path's locations are gone
    expect(sqlDb(backend.store).get<{ id: number }>("SELECT id FROM messages WHERE subject = 'Contrato'")!.id).toBe(id);
    expect(count(backend, "SELECT 1 FROM message_locations WHERE mailbox = 'Clients'")).toBe(0);
    ctl.deleteMailbox("Proyectos");
    await backend.syncAccount(account.id);
    expect((await backend.store.folders.list()).map((f) => f.key)).toEqual(["Work"]);
    // the pass skipped quiet "Work" (STATUS), so it may have missed a move there: the orphan waits for the next
    // pass, which reads every folder (Codex R9), and goes then
    expect(count(backend, "SELECT 1 FROM messages")).toBe(1);
    await backend.syncAccount(account.id);
    expect(count(backend, "SELECT 1 FROM messages")).toBe(1);
    await expectRetained(backend, account.id, retained, retained.map((m) => m.id));
  });

  it("Codex R1: a rename retains old and ID-less mail, threads and categories without rebinding", async () => {
    const { imap, backend, client, addAccount } = await setup();
    const ctl = imap.server.control;
    const twoYears = new Date(Date.now() - 2 * 365 * 86_400_000);
    await client.call("settings.update", { syncWindowDays: 3650 });
    ctl.createMailbox("Work");
    ctl.addMessage("Work", { raw: raw({ subject: "Contrato viejo", date: twoYears }), internaldate: twoYears });
    // no Message-ID: identified by its envelope
    ctl.addMessage("Work", { raw: raw({ subject: "Sin identificador" }).replace(/^Message-ID: .*\r\n/m, "") });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const retained = captureIdentity(backend);
    const before = sqlDb(backend.store).all<{ id: number; thread_id: number; subject: string }>("SELECT id, thread_id, subject FROM messages ORDER BY subject");
    expect(before.map((m) => m.subject)).toEqual(["Contrato viejo", "Sin identificador"]);
    const category = await client.call("categories.create", { name: "Guardado", color: "rose" });
    await client.call("categories.addThreads", { categoryId: category.id, threadIds: before.map((m) => m.thread_id) });
    // the window shrinks: the old contract is now older than it
    await client.call("settings.update", { syncWindowDays: 30 });
    ctl.renameMailbox("Work", "Proyectos");
    await backend.syncAccount(account.id);
    const after = sqlDb(backend.store).all<{ id: number; thread_id: number; subject: string }>("SELECT id, thread_id, subject FROM messages ORDER BY subject");
    expect(after).toEqual(before);
    expect(await folderOf(client, account.id, "Proyectos")).toEqual([]);
    expect(count(backend, "SELECT 1 FROM thread_categories WHERE category_id = ?", category.id)).toBe(2);
    expect(count(backend, "SELECT 1 FROM message_locations WHERE mailbox = 'Work'")).toBe(0);
    await expectRetained(backend, account.id, retained, retained.map((m) => m.id));
  });

  it("Codex R2: a failed destination read and its retry keep the renamed identity unresolved", async () => {
    const { ImapFlow } = await import("imapflow");
    const { imap, backend, client, addAccount } = await setup();
    const ctl = imap.server.control;
    const old = new Date(Date.now() - 400 * 86_400_000);
    await client.call("settings.update", { syncWindowDays: 3650 });
    ctl.createMailbox("Work");
    ctl.addMessage("Work", { raw: raw({ subject: "Contrato", date: old }), internaldate: old });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const retained = captureIdentity(backend);
    const id = sqlDb(backend.store).get<{ id: number }>("SELECT id FROM messages")!.id;
    await client.call("settings.update", { syncWindowDays: 30 });
    ctl.renameMailbox("Work", "Proyectos");
    const original = ImapFlow.prototype.getMailboxLock;
    const refuse = vi.spyOn(ImapFlow.prototype, "getMailboxLock").mockImplementation(function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
      if (String(args[0]) === "Proyectos") return Promise.reject(Object.assign(new Error("Mailbox unavailable"), { responseStatus: "NO", serverResponseCode: "UNAVAILABLE" }));
      return original.apply(this, args);
    });
    try {
      await backend.syncAccount(account.id);
    } finally {
      refuse.mockRestore();
    }
    // nothing lost while the new name couldn't be read
    expect(sqlDb(backend.store).get<{ id: number }>("SELECT id FROM messages")?.id).toBe(id);
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).get<{ id: number }>("SELECT id FROM messages")?.id).toBe(id);
    expect(await folderOf(client, account.id, "Proyectos")).toEqual([]);
    expect(count(backend, "SELECT 1 FROM message_locations WHERE mailbox = 'Work'")).toBe(0);
    await expectRetained(backend, account.id, retained, retained.map((m) => m.id));
  });

  it("Codex R2: a rename retains both indistinguishable older Message-ID twins unresolved", async () => {
    const { imap, backend, client, addAccount } = await setup();
    const ctl = imap.server.control;
    const old = new Date(Date.now() - 400 * 86_400_000);
    await client.call("settings.update", { syncWindowDays: 3650 });
    ctl.createMailbox("Work");
    const twin = raw({ subject: "Gemelo", id: "twin@x", date: old });
    ctl.addMessage("Work", { raw: twin, internaldate: old });
    ctl.addMessage("Work", { raw: twin, internaldate: old });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const retained = captureIdentity(backend);
    const before = sqlDb(backend.store).all<{ id: number }>("SELECT id FROM messages ORDER BY id").map((r) => r.id);
    expect(before).toHaveLength(2);
    await client.call("settings.update", { syncWindowDays: 30 });
    ctl.renameMailbox("Work", "Proyectos");
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).all<{ id: number }>("SELECT id FROM messages ORDER BY id").map((r) => r.id)).toEqual(before);
    expect(count(backend, "SELECT 1 FROM message_locations WHERE mailbox = 'Proyectos'")).toBe(0);
    await expectRetained(backend, account.id, retained, retained.map((m) => m.id));
  });

  it("Codex R3: a UIDVALIDITY reset that fails part-way never deletes the folder's mail; the next pass finds it again", async () => {
    const { ImapFlow } = await import("imapflow");
    const { imap, backend, client, addAccount } = await setup();
    const ctl = imap.server.control;
    const old = new Date(Date.now() - 400 * 86_400_000);
    await client.call("settings.update", { syncWindowDays: 3650 });
    ctl.createMailbox("Work");
    ctl.addMessage("Work", { raw: raw({ subject: "Contrato", date: old }), internaldate: old });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const id = sqlDb(backend.store).get<{ id: number }>("SELECT id FROM messages")!.id;
    await client.call("settings.update", { syncWindowDays: 30 });
    ctl.resetUidValidity("Work");
    const original = ImapFlow.prototype.search;
    const failing = vi.spyOn(ImapFlow.prototype, "search").mockImplementation(function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
      if (this.mailbox && (this.mailbox as { path: string }).path === "Work") return Promise.reject(Object.assign(new Error("Search refused"), { responseStatus: "NO" }));
      return original.apply(this, args);
    });
    try {
      await backend.syncAccount(account.id);
    } finally {
      failing.mockRestore();
    }
    expect(sqlDb(backend.store).get<{ id: number }>("SELECT id FROM messages")?.id).toBe(id);
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).get<{ id: number }>("SELECT id FROM messages")?.id).toBe(id);
    expect(await folderOf(client, account.id, "Work")).toEqual([]);
    expect(await backend.store.providerStore(account.id).locations.unresolved([id])).toEqual([id]);
  });

  it("Codex R4: completing a failed reset does not prove disappearance or identity", async () => {
    const { ImapFlow } = await import("imapflow");
    const { imap, backend, client, addAccount } = await setup();
    const ctl = imap.server.control;
    const old = new Date(Date.now() - 400 * 86_400_000);
    await client.call("settings.update", { syncWindowDays: 3650 });
    ctl.createMailbox("Work");
    const gone = ctl.addMessage("Work", { raw: raw({ subject: "Borrado", date: old }), internaldate: old });
    ctl.addMessage("Work", { raw: raw({ subject: "Contrato", date: old }), internaldate: old });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const retained = captureIdentity(backend);
    await client.call("settings.update", { syncWindowDays: 30 });
    ctl.expungeMessages("Work", [gone.uid]);
    ctl.resetUidValidity("Work");
    const original = ImapFlow.prototype.search;
    const failing = vi.spyOn(ImapFlow.prototype, "search").mockImplementation(function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
      if (this.mailbox && (this.mailbox as { path: string }).path === "Work") return Promise.reject(Object.assign(new Error("Search refused"), { responseStatus: "NO" }));
      return original.apply(this, args);
    });
    try {
      await backend.syncAccount(account.id);
    } finally {
      failing.mockRestore();
    }
    expect(sqlDb(backend.store).all<{ subject: string }>("SELECT subject FROM messages ORDER BY subject").map((m) => m.subject)).toEqual(["Borrado", "Contrato"]);
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).all<{ subject: string }>("SELECT subject FROM messages ORDER BY subject").map((m) => m.subject)).toEqual(["Borrado", "Contrato"]);
    await expectRetained(backend, account.id, retained, retained.map((m) => m.id));
  });

  it("Codex R5: interrupted reset retains old ID-less twins without assigning their new UIDs", async () => {
    const { ImapFlow } = await import("imapflow");
    const { imap, backend, client, addAccount } = await setup();
    const ctl = imap.server.control;
    const old = new Date(Date.now() - 400 * 86_400_000);
    await client.call("settings.update", { syncWindowDays: 3650 });
    ctl.createMailbox("Work");
    const twin = raw({ subject: "Gemelo sin id", date: old }).replace(/^Message-ID: .*\r\n/m, "");
    ctl.addMessage("Work", { raw: twin, internaldate: old });
    ctl.addMessage("Work", { raw: twin, internaldate: old });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const retained = captureIdentity(backend);
    const before = sqlDb(backend.store).all<{ id: number }>("SELECT id FROM messages ORDER BY id").map((r) => r.id);
    expect(before).toHaveLength(2);
    await client.call("settings.update", { syncWindowDays: 30 });
    ctl.resetUidValidity("Work");
    const original = ImapFlow.prototype.search;
    const failing = vi.spyOn(ImapFlow.prototype, "search").mockImplementation(function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
      if (this.mailbox && (this.mailbox as { path: string }).path === "Work") return Promise.reject(Object.assign(new Error("Search refused"), { responseStatus: "NO" }));
      return original.apply(this, args);
    });
    try {
      await backend.syncAccount(account.id);
    } finally {
      failing.mockRestore();
    }
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).all<{ id: number }>("SELECT id FROM messages ORDER BY id").map((r) => r.id)).toEqual(before);
    expect(count(backend, "SELECT 1 FROM message_locations WHERE mailbox = 'Work'")).toBe(0);
    await expectRetained(backend, account.id, retained, retained.map((m) => m.id));
  });

  it("Codex R5: a move to an earlier folder retains its logical target, body and category unresolved", async () => {
    const { imap, backend, client, addAccount } = await setup();
    const ctl = imap.server.control;
    ctl.createMailbox("A");
    ctl.createMailbox("Z");
    const m = ctl.addMessage("Z", { raw: raw({ subject: "Sin id movido" }).replace(/^Message-ID: .*\r\n/m, "") });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const retained = captureIdentity(backend);
    const before = sqlDb(backend.store).get<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages")!;
    const category = await client.call("categories.create", { name: "Guardado", color: "rose" });
    await client.call("categories.addThreads", { categoryId: category.id, threadIds: [before.thread_id] });
    ctl.moveMessages("Z", [m.uid], "A");
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).all<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages")).toEqual([before]);
    expect(count(backend, "SELECT 1 FROM thread_categories WHERE category_id = ?", category.id)).toBe(1);
    expect(await folderOf(client, account.id, "A")).toEqual([]);
    expect(await folderOf(client, account.id, "Z")).toEqual([]);
    await expectRetained(backend, account.id, retained, retained.map((m) => m.id));
  });

  it("Codex R6: disconnect after reset preserves ID-less twins across the next sync", async () => {
    const { ImapFlow } = await import("imapflow");
    const { imap, backend, client, addAccount } = await setup();
    const ctl = imap.server.control;
    const old = new Date(Date.now() - 400 * 86_400_000);
    await client.call("settings.update", { syncWindowDays: 3650 });
    ctl.createMailbox("Work");
    const twin = raw({ subject: "Gemelo sin id", date: old }).replace(/^Message-ID: .*\r\n/m, "");
    ctl.addMessage("Work", { raw: twin, internaldate: old });
    ctl.addMessage("Work", { raw: twin, internaldate: old });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const retained = captureIdentity(backend);
    const before = sqlDb(backend.store).all<{ id: number }>("SELECT id FROM messages ORDER BY id").map((r) => r.id);
    await client.call("settings.update", { syncWindowDays: 30 });
    ctl.resetUidValidity("Work");
    // the connection drops as the reset's search goes out, on the retry too: the pass fails whole, nothing saved at its end
    const original = ImapFlow.prototype.search;
    const dropping = vi.spyOn(ImapFlow.prototype, "search").mockImplementation(function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
      if (this.mailbox && (this.mailbox as { path: string }).path === "Work") return Promise.reject(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
      return original.apply(this, args);
    });
    try {
      await backend.syncAccount(account.id).catch(() => {});
    } finally {
      dropping.mockRestore();
    }
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).all<{ id: number }>("SELECT id FROM messages ORDER BY id").map((r) => r.id)).toEqual(before);
    expect(count(backend, "SELECT 1 FROM message_locations WHERE mailbox = 'Work'")).toBe(0);
    await expectRetained(backend, account.id, retained, retained.map((m) => m.id));
  });

  it("Codex R6: a sweep that fails acknowledges nothing: a flag change it missed is read on a later pass", async () => {
    const { ImapFlow } = await import("imapflow");
    const { imap, backend, addAccount } = await setup();
    const ctl = imap.server.control;
    ctl.createMailbox("Work");
    const m = ctl.addMessage("Work", { raw: raw({ subject: "Leído fuera" }) });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    ctl.setFlags("Work", [m.uid], ["\\Seen"], "add");
    // the sweep's whole-mailbox search fails; the identification's (new UIDs) works
    const original = ImapFlow.prototype.search;
    const failing = vi.spyOn(ImapFlow.prototype, "search").mockImplementation(function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
      const query = args[0] as { all?: boolean };
      if (query?.all && this.mailbox && (this.mailbox as { path: string }).path === "Work") return Promise.reject(Object.assign(new Error("Search refused"), { responseStatus: "NO" }));
      return original.apply(this, args);
    });
    try {
      await backend.syncAccount(account.id);
    } finally {
      failing.mockRestore();
    }
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).get<{ is_read: number }>("SELECT is_read FROM messages")!.is_read).toBe(1);
  });

  it("Codex R7: a UIDVALIDITY reset keeps both messages that share a Message-ID and an envelope, older than the window", async () => {
    const { imap, backend, client, addAccount } = await setup();
    const ctl = imap.server.control;
    const old = new Date(Date.now() - 400 * 86_400_000);
    await client.call("settings.update", { syncWindowDays: 3650 });
    ctl.createMailbox("Work");
    const twin = raw({ subject: "Gemelo", id: "twin-reset@x", date: old });
    ctl.addMessage("Work", { raw: twin, internaldate: old });
    ctl.addMessage("Work", { raw: twin, internaldate: old });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const before = sqlDb(backend.store).all<{ id: number }>("SELECT id FROM messages ORDER BY id").map((r) => r.id);
    expect(before).toHaveLength(2);
    await client.call("settings.update", { syncWindowDays: 30 });
    ctl.resetUidValidity("Work");
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).all<{ id: number }>("SELECT id FROM messages ORDER BY id").map((r) => r.id)).toEqual(before);
    expect(count(backend, "SELECT 1 FROM message_locations WHERE mailbox = 'Work'")).toBe(0);
  });

  for (const into of ["an existing folder", "a new folder, the mail older than the window"] as const) {
    it(`Codex R8: identical twins moved into ${into} retain both cached identities unresolved`, async () => {
      const { imap, backend, client, addAccount } = await setup();
      const ctl = imap.server.control;
      const old = new Date(Date.now() - 400 * 86_400_000);
      const fresh = into === "an existing folder";
      await client.call("settings.update", { syncWindowDays: 3650 });
      if (fresh) ctl.createMailbox("A");
      ctl.createMailbox("Z");
      const twin = raw({ subject: "Gemelo movido", date: old }).replace(/^Message-ID: .*\r\n/m, "");
      const a = ctl.addMessage("Z", { raw: twin, internaldate: old });
      const b = ctl.addMessage("Z", { raw: twin, internaldate: old });
      const account = await addAccount(imap.port);
      await backend.syncAccount(account.id);
      const retained = captureIdentity(backend);
      const before = sqlDb(backend.store).all<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages ORDER BY id");
      expect(before).toHaveLength(2);
      const category = await client.call("categories.create", { name: "Guardado", color: "rose" });
      await client.call("categories.addThreads", { categoryId: category.id, threadIds: [...new Set(before.map((m) => m.thread_id))] });
      if (!fresh) {
        await client.call("settings.update", { syncWindowDays: 30 });
        ctl.createMailbox("A");
      }
      ctl.moveMessages("Z", [a.uid, b.uid], "A");
      await backend.syncAccount(account.id);
      expect(sqlDb(backend.store).all<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages ORDER BY id")).toEqual(before);
      expect(count(backend, "SELECT 1 FROM message_locations WHERE mailbox = 'A'")).toBe(0);
      expect(count(backend, "SELECT DISTINCT thread_id FROM thread_categories WHERE category_id = ?", category.id)).toBe(new Set(before.map((m) => m.thread_id)).size);
    await expectRetained(backend, account.id, retained, retained.map((m) => m.id));
    });
  }

  it("Codex R8: disconnect after a sweep preserves the missing target while importing unrelated mail", async () => {
    const { ImapFlow } = await import("imapflow");
    const { imap, backend, addAccount } = await setup();
    const ctl = imap.server.control;
    ctl.createMailbox("Work");
    const x = ctl.addMessage("Work", { raw: raw({ subject: "Borrado" }) });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const retained = captureIdentity(backend);
    ctl.expungeMessages("Work", [x.uid]);
    ctl.addMessage("Work", { raw: raw({ subject: "Nuevo" }) });
    // the identification's fetch (envelopes of new mail) drops, the retry too; the sweep before it has run
    const original = ImapFlow.prototype.fetch;
    const dropping = vi.spyOn(ImapFlow.prototype, "fetch").mockImplementation(function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
      const query = args[1] as { envelope?: boolean };
      if (query?.envelope && this.mailbox && (this.mailbox as { path: string }).path === "Work") throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
      return original.apply(this, args);
    });
    try {
      await backend.syncAccount(account.id).catch(() => {});
    } finally {
      dropping.mockRestore();
    }
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).all<{ subject: string }>("SELECT subject FROM messages ORDER BY subject").map((m) => m.subject)).toEqual(["Borrado", "Nuevo"]);
    await expectRetained(backend, account.id, retained, retained.map((m) => m.id));
  });

  it("Codex R9: moving behind STATUS leaves a retained unresolved target after a full pass", async () => {
    const { ImapFlow } = await import("imapflow");
    const { imap, backend, client, addAccount } = await setup();
    const ctl = imap.server.control;
    ctl.createMailbox("A");
    ctl.createMailbox("Z");
    const m = ctl.addMessage("Z", { raw: raw({ subject: "Movido entre STATUS" }) });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const retained = captureIdentity(backend);
    const before = sqlDb(backend.store).get<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages")!;
    const category = await client.call("categories.create", { name: "Guardado", color: "rose" });
    await client.call("categories.addThreads", { categoryId: category.id, threadIds: [before.thread_id] });
    // another client moves it right after STATUS(A) says A is quiet, before Z is looked at
    const original = ImapFlow.prototype.status;
    let moved = false;
    const status = vi.spyOn(ImapFlow.prototype, "status").mockImplementation(async function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
      const r = await original.apply(this, args);
      if (String(args[0]) === "A" && !moved) {
        moved = true;
        ctl.moveMessages("Z", [m.uid], "A");
      }
      return r;
    });
    try {
      await backend.syncAccount(account.id);
    } finally {
      status.mockRestore();
    }
    expect(moved).toBe(true);
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).all<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages")).toEqual([before]);
    expect(count(backend, "SELECT 1 FROM thread_categories WHERE category_id = ?", category.id)).toBe(1);
    expect(await folderOf(client, account.id, "A")).toEqual([]);
    await expectRetained(backend, account.id, retained, retained.map((m) => m.id));
  });

  it("Codex R9: sequential reset passes cannot discard or rebind either folder’s cached mail", async () => {
    const { ImapFlow } = await import("imapflow");
    const { imap, backend, addAccount } = await setup();
    const ctl = imap.server.control;
    ctl.createMailbox("A");
    ctl.createMailbox("B");
    const gone = ctl.addMessage("A", { raw: raw({ subject: "Borrado en A" }) });
    ctl.addMessage("A", { raw: raw({ subject: "Queda en A" }) });
    ctl.addMessage("B", { raw: raw({ subject: "En B" }) });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const retained = captureIdentity(backend);
    ctl.expungeMessages("A", [gone.uid]);
    ctl.resetUidValidity("A");
    ctl.resetUidValidity("B");
    const original = ImapFlow.prototype.search;
    const dropping = vi.spyOn(ImapFlow.prototype, "search").mockImplementation(function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
      if (this.mailbox && (this.mailbox as { path: string }).path === "B") return Promise.reject(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
      return original.apply(this, args);
    });
    try {
      await backend.syncAccount(account.id).catch(() => {});
    } finally {
      dropping.mockRestore();
    }
    await backend.syncAccount(account.id);
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).all<{ subject: string }>("SELECT subject FROM messages ORDER BY subject").map((r) => r.subject)).toEqual(["Borrado en A", "En B", "Queda en A"]);
    await expectRetained(backend, account.id, retained, retained.map((m) => m.id));
  });

  it("Codex R10: an ID-less message moved out of a folder that's then deleted, all between syncs, keeps its identity", async () => {
    const { imap, backend, client, addAccount } = await setup();
    const ctl = imap.server.control;
    ctl.createMailbox("A");
    ctl.createMailbox("Z");
    const m = ctl.addMessage("Z", { raw: raw({ subject: "Movido y borrado" }).replace(/^Message-ID: .*\r\n/m, "") });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const before = sqlDb(backend.store).get<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages")!;
    const category = await client.call("categories.create", { name: "Guardado", color: "rose" });
    await client.call("categories.addThreads", { categoryId: category.id, threadIds: [before.thread_id] });
    ctl.moveMessages("Z", [m.uid], "A");
    ctl.deleteMailbox("Z");
    await backend.syncAccount(account.id);
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).all<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages")).toEqual([before]);
    expect(count(backend, "SELECT 1 FROM thread_categories WHERE category_id = ?", category.id)).toBe(1);
  });

  it("Codex R10: moving identical twins behind STATUS retains both without guessing their order", async () => {
    const { ImapFlow } = await import("imapflow");
    const { imap, backend, addAccount } = await setup();
    const ctl = imap.server.control;
    ctl.createMailbox("A");
    ctl.createMailbox("Z");
    const twin = raw({ subject: "Gemelos entre STATUS" }).replace(/^Message-ID: .*\r\n/m, "");
    const a = ctl.addMessage("Z", { raw: twin });
    const b = ctl.addMessage("Z", { raw: twin });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const retained = captureIdentity(backend);
    const before = sqlDb(backend.store).all<{ id: number }>("SELECT id FROM messages ORDER BY id").map((r) => r.id);
    const original = ImapFlow.prototype.status;
    let moved = false;
    const status = vi.spyOn(ImapFlow.prototype, "status").mockImplementation(async function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
      const r = await original.apply(this, args);
      if (String(args[0]) === "A" && !moved) {
        moved = true;
        ctl.moveMessages("Z", [a.uid, b.uid], "A");
      }
      return r;
    });
    try {
      await backend.syncAccount(account.id);
    } finally {
      status.mockRestore();
    }
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).all<{ id: number }>("SELECT id FROM messages ORDER BY id").map((r) => r.id)).toEqual(before);
    expect(count(backend, "SELECT 1 FROM message_locations WHERE mailbox = 'A'")).toBe(0);
    await expectRetained(backend, account.id, retained, retained.map((m) => m.id));
  });

  it("Codex R11: reset plus cross-folder move retains both indistinguishable targets unresolved", async () => {
    const { imap, backend, client, addAccount } = await setup();
    const ctl = imap.server.control;
    ctl.createMailbox("A");
    ctl.createMailbox("B");
    const twin = raw({ subject: "Gemelo reset y movido" }).replace(/^Message-ID: .*\r\n/m, "");
    ctl.addMessage("A", { raw: twin });
    const second = ctl.addMessage("A", { raw: twin });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const retained = captureIdentity(backend);
    const before = sqlDb(backend.store).all<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages ORDER BY id");
    const category = await client.call("categories.create", { name: "Guardado", color: "rose" });
    await client.call("categories.addThreads", { categoryId: category.id, threadIds: [...new Set(before.map((m) => m.thread_id))] });
    ctl.moveMessages("A", [second.uid], "B");
    ctl.resetUidValidity("A");
    await backend.syncAccount(account.id);
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).all<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages ORDER BY id")).toEqual(before);
    expect(count(backend, "SELECT 1 FROM message_locations WHERE mailbox = 'B'")).toBe(0);
    await expectRetained(backend, account.id, retained, retained.map((m) => m.id));
  });

  it("Codex R12: reset after the sweep withholds old twins while importing unrelated new mail", async () => {
    const { imap, backend, client, addAccount } = await setup();
    const ctl = imap.server.control;
    const old = new Date(Date.now() - 400 * 86_400_000);
    await client.call("settings.update", { syncWindowDays: 3650 });
    ctl.createMailbox("A");
    const twin = raw({ subject: "Gemelo tardío", id: "late-twin@x", date: old });
    ctl.addMessage("A", { raw: twin, internaldate: old });
    ctl.addMessage("A", { raw: twin, internaldate: old });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const retained = captureIdentity(backend);
    const before = sqlDb(backend.store).all<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages ORDER BY id");
    expect(before).toHaveLength(2);
    await client.call("settings.update", { syncWindowDays: 30 });
    // new mail in A, so the pass opens it (STATUS would skip a quiet folder); its second lock (the read, after
    // the sweep) comes after a reset
    ctl.addMessage("A", { raw: raw({ subject: "Nuevo en A" }) });
    const { ImapFlow } = await import("imapflow");
    const original = ImapFlow.prototype.getMailboxLock;
    let locks = 0;
    const late = vi.spyOn(ImapFlow.prototype, "getMailboxLock").mockImplementation(function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
      if (String(args[0]) === "A" && ++locks === 2) ctl.resetUidValidity("A");
      return original.apply(this, args);
    });
    try {
      await backend.syncAccount(account.id);
    } finally {
      late.mockRestore();
    }
    expect(locks).toBeGreaterThanOrEqual(2);
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).all<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages ORDER BY id").slice(0, 2)).toEqual(before);
    expect(count(backend, "SELECT 1 FROM message_locations WHERE mailbox = 'A'")).toBe(1);
    await expectRetained(backend, account.id, retained, retained.map((m) => m.id));
  });

  it("Codex R13: moving one twin before reset does not establish either twin’s new identity", async () => {
    const { imap, backend, client, addAccount } = await setup();
    const ctl = imap.server.control;
    ctl.createMailbox("A");
    ctl.createMailbox("Z");
    const twin = raw({ subject: "Gemelo primero movido" }).replace(/^Message-ID: .*\r\n/m, "");
    const first = ctl.addMessage("Z", { raw: twin });
    ctl.addMessage("Z", { raw: twin });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const retained = captureIdentity(backend);
    const before = sqlDb(backend.store).all<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages ORDER BY id");
    expect(before).toHaveLength(2);
    const category = await client.call("categories.create", { name: "Guardado", color: "rose" });
    await client.call("categories.addThreads", { categoryId: category.id, threadIds: [...new Set(before.map((m) => m.thread_id))] });
    ctl.moveMessages("Z", [first.uid], "A");
    ctl.resetUidValidity("Z");
    await backend.syncAccount(account.id);
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).all<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages ORDER BY id")).toEqual(before);
    expect(count(backend, "SELECT 1 FROM message_locations WHERE mailbox = 'A'")).toBe(0);
    expect(count(backend, "SELECT 1 FROM message_locations WHERE mailbox = 'Z'")).toBe(0);
    await expectRetained(backend, account.id, retained, retained.map((m) => m.id));
  });

  it("Codex R15: journal overflow cannot discard unlocated targets on a full pass", async () => {
    const { IMAP_JOURNAL_LIMITS } = await import("@terno/mail");
    const limits = { ...IMAP_JOURNAL_LIMITS };
    Object.assign(IMAP_JOURNAL_LIMITS, { unlocated: 2, resetPending: 2, orphans: 2 });
    try {
      const { imap, backend, addAccount } = await setup();
      const ctl = imap.server.control;
      ctl.createMailbox("A");
      ctl.createMailbox("Z");
      ctl.addMessage("A", { raw: raw({ subject: "Quieto en A" }) });
      const gone = Array.from({ length: 5 }, (_, i) => ctl.addMessage("Z", { raw: raw({ subject: `Borrado ${i}` }) }));
      const kept = ctl.addMessage("Z", { raw: raw({ subject: "Queda en Z" }) });
      const account = await addAccount(imap.port);
      await backend.syncAccount(account.id);
      const retained = captureIdentity(backend);
      expect(count(backend, "SELECT 1 FROM messages")).toBe(7);
      // five expunged while A is quiet (STATUS skips it: not a pass that may delete), more than any journal keeps
      ctl.expungeMessages("Z", gone.map((m) => m.uid));
      await backend.syncAccount(account.id);
      // then a pass that reads every folder, as after a restart
      await backend.syncAccount(account.id);
      await backend.syncAccount(account.id);
      expect(count(backend, "SELECT 1 FROM messages")).toBe(7);
      expect(count(backend, "SELECT 1 FROM messages m WHERE NOT EXISTS (SELECT 1 FROM message_locations l WHERE l.message_id = m.id)")).toBe(5);
      expect(kept.uid).toBeGreaterThan(0);
      await expectRetained(backend, account.id, retained, retained.slice(1, 6).map((m) => m.id));
    } finally {
      Object.assign(IMAP_JOURNAL_LIMITS, limits);
    }
  });

  it("Codex R16: moved ID-less twins survive journal overflow with all identity holds intact", async () => {
    const { IMAP_JOURNAL_LIMITS } = await import("@terno/mail");
    const { ImapFlow } = await import("imapflow");
    const limits = { ...IMAP_JOURNAL_LIMITS };
    Object.assign(IMAP_JOURNAL_LIMITS, { unlocated: 2, resetPending: 2, orphans: 2 });
    try {
      const { imap, backend, client, addAccount } = await setup();
      const ctl = imap.server.control;
      ctl.createMailbox("A");
      ctl.createMailbox("Z");
      ctl.addMessage("A", { raw: raw({ subject: "Quieto en A" }) });
      const twin = raw({ subject: "Gemelo en masa" }).replace(/^Message-ID: .*\r\n/m, "");
      const twins = Array.from({ length: 5 }, () => ctl.addMessage("Z", { raw: twin }));
      const account = await addAccount(imap.port);
      await backend.syncAccount(account.id);
      const retained = captureIdentity(backend);
      const before = sqlDb(backend.store).all<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages ORDER BY id");
      expect(before).toHaveLength(6);
      const category = await client.call("categories.create", { name: "Guardado", color: "rose" });
      await client.call("categories.addThreads", { categoryId: category.id, threadIds: [...new Set(before.map((m) => m.thread_id))] });
      // moved into A right after STATUS(A) says it's quiet: this pass skips A and keeps more orphans than it may
      const original = ImapFlow.prototype.status;
      let moved = false;
      const status = vi.spyOn(ImapFlow.prototype, "status").mockImplementation(async function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
        const r = await original.apply(this, args);
        if (String(args[0]) === "A" && !moved) {
          moved = true;
          ctl.moveMessages("Z", twins.map((m) => m.uid), "A");
        }
        return r;
      });
      try {
        await backend.syncAccount(account.id);
      } finally {
        status.mockRestore();
      }
      expect(moved).toBe(true);
      await backend.syncAccount(account.id);
      await backend.syncAccount(account.id);
      expect(sqlDb(backend.store).all<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages ORDER BY id")).toEqual(before);
      expect(count(backend, "SELECT 1 FROM message_locations WHERE mailbox = 'A'")).toBe(1);
      await expectRetained(backend, account.id, retained, retained.slice(1).map((m) => m.id));
    } finally {
      Object.assign(IMAP_JOURNAL_LIMITS, limits);
    }
  });

  it("Codex R18: a move after the source sweep keeps the old target unresolved", async () => {
    const { ImapFlow } = await import("imapflow");
    const { imap, backend, client, addAccount } = await setup();
    const ctl = imap.server.control;
    ctl.createMailbox("A");
    ctl.createMailbox("Z");
    const lone = ctl.addMessage("Z", { raw: raw({ subject: "Solo, sin Message-ID" }).replace(/^Message-ID: .*\r\n/m, "") });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const retained = captureIdentity(backend);
    const before = sqlDb(backend.store).all<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages ORDER BY id");
    expect(before).toHaveLength(1);
    const category = await client.call("categories.create", { name: "Guardado", color: "rose" });
    await client.call("categories.addThreads", { categoryId: category.id, threadIds: [before[0]!.thread_id] });
    // both folders have news (so both are swept, then read); the move comes on A's second lock: after every sweep
    ctl.addMessage("A", { raw: raw({ subject: "Nuevo en A" }) });
    ctl.addMessage("Z", { raw: raw({ subject: "Nuevo en Z" }) });
    const original = ImapFlow.prototype.getMailboxLock;
    let locks = 0;
    const late = vi.spyOn(ImapFlow.prototype, "getMailboxLock").mockImplementation(function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
      if (String(args[0]) === "A" && ++locks === 2) ctl.moveMessages("Z", [lone.uid], "A");
      return original.apply(this, args);
    });
    try {
      await backend.syncAccount(account.id);
    } finally {
      late.mockRestore();
    }
    expect(locks).toBeGreaterThanOrEqual(2);
    await backend.syncAccount(account.id);
    const after = sqlDb(backend.store).all<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages WHERE subject = 'Solo, sin Message-ID'");
    expect(after).toEqual(before);
    expect(count(backend, "SELECT 1 FROM thread_categories WHERE category_id = ? AND thread_id = ?", category.id, before[0]!.thread_id)).toBe(1);
    expect(await folderOf(client, account.id, "A")).toEqual(["Nuevo en A"]);
    expect(count(backend, "SELECT 1 FROM message_locations WHERE message_id = ? AND mailbox = 'Z'", before[0]!.id)).toBe(0);
    await expectRetained(backend, account.id, retained, retained.map((m) => m.id));
  });

  it("Codex R25: one duplicate Message-ID twin moves; its target is held and the other stays located", async () => {
    const { imap, backend, client, addAccount } = await setup();
    const ctl = imap.server.control;
    ctl.createMailbox("A");
    ctl.createMailbox("Z");
    const twin = raw({ subject: "Gemelos con Message-ID", id: "shared-twin@x" });
    ctl.addMessage("Z", { raw: twin });
    const second = ctl.addMessage("Z", { raw: twin });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const retained = captureIdentity(backend);
    const before = sqlDb(backend.store).all<{ id: number; thread_id: number; provider_msg_id: string }>("SELECT id, thread_id, provider_msg_id FROM messages ORDER BY id");
    expect(before).toHaveLength(2);
    const moved = sqlDb(backend.store).get<{ id: number }>("SELECT message_id AS id FROM message_locations WHERE mailbox = 'Z' AND uid = ?", second.uid)!.id;
    const stays = before.find((m) => m.id !== moved)!.id;
    const category = await client.call("categories.create", { name: "Guardado", color: "rose" });
    await client.call("categories.addThreads", { categoryId: category.id, threadIds: [...new Set(before.map((m) => m.thread_id))] });
    ctl.moveMessages("Z", [second.uid], "A");
    await backend.syncAccount(account.id);
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).all<{ id: number; thread_id: number; provider_msg_id: string }>("SELECT id, thread_id, provider_msg_id FROM messages ORDER BY id")).toEqual(before);
    expect(sqlDb(backend.store).all<{ mailbox: string }>("SELECT mailbox FROM message_locations WHERE message_id = ?", moved)).toEqual([]);
    expect(sqlDb(backend.store).all<{ mailbox: string }>("SELECT mailbox FROM message_locations WHERE message_id = ?", stays)).toEqual([{ mailbox: "Z" }]);
    await expectRetained(backend, account.id, retained, [moved]);
  });

  it("Codex R26: a late duplicate Message-ID move cannot bind the moved target speculatively", async () => {
    const { ImapFlow } = await import("imapflow");
    const { imap, backend, addAccount } = await setup();
    const ctl = imap.server.control;
    ctl.createMailbox("A");
    ctl.createMailbox("Z");
    const twin = raw({ subject: "Gemelos tardíos con Message-ID", id: "late-shared@x" });
    ctl.addMessage("Z", { raw: twin });
    const second = ctl.addMessage("Z", { raw: twin });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const retained = captureIdentity(backend);
    const before = sqlDb(backend.store).all<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages ORDER BY id");
    expect(before).toHaveLength(2);
    const moved = sqlDb(backend.store).get<{ id: number }>("SELECT message_id AS id FROM message_locations WHERE mailbox = 'Z' AND uid = ?", second.uid)!.id;
    const stays = before.find((m) => m.id !== moved)!.id;
    ctl.addMessage("A", { raw: raw({ subject: "Nuevo en A" }) });
    ctl.addMessage("Z", { raw: raw({ subject: "Nuevo en Z" }) });
    const original = ImapFlow.prototype.getMailboxLock;
    let locks = 0;
    const late = vi.spyOn(ImapFlow.prototype, "getMailboxLock").mockImplementation(function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
      if (String(args[0]) === "A" && ++locks === 2) ctl.moveMessages("Z", [second.uid], "A");
      return original.apply(this, args);
    });
    try {
      await backend.syncAccount(account.id);
    } finally {
      late.mockRestore();
    }
    expect(locks).toBeGreaterThanOrEqual(2);
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).all<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages WHERE subject = 'Gemelos tardíos con Message-ID' ORDER BY id")).toEqual(before);
    expect(sqlDb(backend.store).all<{ mailbox: string }>("SELECT mailbox FROM message_locations WHERE message_id = ?", moved)).toEqual([]);
    expect(sqlDb(backend.store).all<{ mailbox: string }>("SELECT mailbox FROM message_locations WHERE message_id = ?", stays)).toEqual([{ mailbox: "Z" }]);
    await expectRetained(backend, account.id, retained, [moved]);
  });

  it("Codex R27: duplicate Message-ID arrivals elsewhere cannot attach to either existing target", async () => {
    const { imap, backend, addAccount } = await setup();
    const ctl = imap.server.control;
    ctl.createMailbox("A");
    ctl.createMailbox("Z");
    const twin = raw({ subject: "Gemelos copiados dos veces", id: "copied-twice@x" });
    ctl.addMessage("Z", { raw: twin });
    ctl.addMessage("Z", { raw: twin });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const retained = captureIdentity(backend);
    const before = sqlDb(backend.store).all<{ id: number }>("SELECT id FROM messages ORDER BY id").map((m) => m.id);
    const a1 = ctl.addMessage("A", { raw: twin });
    const a2 = ctl.addMessage("A", { raw: twin });
    await backend.syncAccount(account.id);
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).all<{ uid: number }>("SELECT uid FROM message_locations WHERE mailbox = 'A' ORDER BY uid").map((l) => l.uid)).toEqual([]);
    expect(sqlDb(backend.store).all<{ id: number }>("SELECT id FROM messages ORDER BY id").map((m) => m.id).slice(0, 2)).toEqual(before);
    expect(count(backend, "SELECT 1 FROM message_locations WHERE mailbox = 'Z'")).toBe(2);
    await expectRetained(backend, account.id, retained, []);
    expect(ctl.listMessages("A", { raw: true }).map((m) => [m.uid, m.raw])).toEqual([[a1.uid, Buffer.from(twin)], [a2.uid, Buffer.from(twin)]]);
  });

  it("Codex R27: sequential late twin moves preserve both targets without assigning new UIDs", async () => {
    const { ImapFlow } = await import("imapflow");
    const { imap, backend, addAccount } = await setup();
    const ctl = imap.server.control;
    ctl.createMailbox("A");
    ctl.createMailbox("Z");
    const twin = raw({ subject: "Gemelo hacia el otro", id: "towards-other@x" });
    // two in Z (one under the plain key, one suffixed); the plain-key one then moves to A, recognised
    ctl.addMessage("Z", { raw: twin });
    ctl.addMessage("Z", { raw: twin });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const retained = captureIdentity(backend);
    const before = sqlDb(backend.store).all<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages ORDER BY id");
    expect(before).toHaveLength(2);
    const plain = sqlDb(backend.store).get<{ id: number; uid: number }>("SELECT m.id, l.uid FROM messages m JOIN message_locations l ON l.message_id = m.id WHERE m.provider_msg_id NOT LIKE '%#%'")!;
    ctl.moveMessages("Z", [plain.uid], "A");
    await backend.syncAccount(account.id);
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).all<{ mailbox: string }>("SELECT mailbox FROM message_locations WHERE message_id = ?", plain.id)).toEqual([]);
    // then the other (in Z) moves into A after the sweeps, before A is read
    const moved = before.find((m) => m.id !== plain.id)!.id;
    const P = "A";
    const S = "Z";
    const movedUid = sqlDb(backend.store).get<{ uid: number }>("SELECT uid FROM message_locations WHERE message_id = ?", moved)!.uid;
    ctl.addMessage(P, { raw: raw({ subject: "Nuevo en P" }) });
    ctl.addMessage(S, { raw: raw({ subject: "Nuevo en S" }) });
    const original = ImapFlow.prototype.getMailboxLock;
    let locks = 0;
    const late = vi.spyOn(ImapFlow.prototype, "getMailboxLock").mockImplementation(function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
      if (String(args[0]) === P && ++locks === 2) ctl.moveMessages(S, [movedUid], P);
      return original.apply(this, args);
    });
    try {
      await backend.syncAccount(account.id);
    } finally {
      late.mockRestore();
    }
    expect(locks).toBeGreaterThanOrEqual(2);
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).all<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages WHERE subject = 'Gemelo hacia el otro' ORDER BY id")).toEqual(before);
    expect(sqlDb(backend.store).all<{ mailbox: string }>("SELECT mailbox FROM message_locations WHERE message_id = ?", moved)).toEqual([]);
    expect(sqlDb(backend.store).all<{ mailbox: string }>("SELECT mailbox FROM message_locations WHERE message_id = ?", plain.id)).toEqual([]);
    await expectRetained(backend, account.id, retained, retained.map((m) => m.id));
  });

  it("Codex R28: a late move and identical copy cannot assign either new UID to the old target", async () => {
    const { ImapFlow } = await import("imapflow");
    const { imap, backend, addAccount } = await setup();
    const ctl = imap.server.control;
    ctl.createMailbox("A");
    ctl.createMailbox("Z");
    const twin = raw({ subject: "Movido y copiado", id: "moved-and-copied@x" });
    ctl.addMessage("Z", { raw: twin });
    ctl.addMessage("Z", { raw: twin });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const retained = captureIdentity(backend);
    const before = sqlDb(backend.store).all<{ id: number }>("SELECT id FROM messages ORDER BY id").map((m) => m.id);
    const plain = sqlDb(backend.store).get<{ id: number; uid: number }>("SELECT m.id, l.uid FROM messages m JOIN message_locations l ON l.message_id = m.id WHERE m.provider_msg_id NOT LIKE '%#%'")!;
    ctl.addMessage("Z", { raw: raw({ subject: "Nuevo en Z" }) });
    ctl.addMessage("A", { raw: raw({ subject: "Nuevo en A" }) });
    const original = ImapFlow.prototype.getMailboxLock;
    let locks = 0;
    const late = vi.spyOn(ImapFlow.prototype, "getMailboxLock").mockImplementation(function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
      if (String(args[0]) === "A" && ++locks === 2) {
        ctl.moveMessages("Z", [plain.uid], "A");
        ctl.addMessage("A", { raw: twin });
      }
      return original.apply(this, args);
    });
    try {
      await backend.syncAccount(account.id);
    } finally {
      late.mockRestore();
    }
    expect(locks).toBeGreaterThanOrEqual(2);
    await backend.syncAccount(account.id);
    const inA = (ctl as unknown as { listMessages(path: string, o: { raw: boolean }): { uid: number; raw: Buffer }[] }).listMessages("A", { raw: true }).filter((x) => x.raw.toString().includes("Movido y copiado")).map((x) => x.uid).sort((a, b) => a - b);
    expect(inA).toHaveLength(2);
    expect(sqlDb(backend.store).all<{ uid: number }>("SELECT uid FROM message_locations WHERE mailbox = 'A' AND message_id IN (SELECT id FROM messages WHERE subject = 'Movido y copiado') ORDER BY uid").map((l) => l.uid)).toEqual([]);
    expect(sqlDb(backend.store).all<{ id: number }>("SELECT id FROM messages WHERE subject = 'Movido y copiado' ORDER BY id").map((m) => m.id).slice(0, 2)).toEqual(before);
    await expectRetained(backend, account.id, retained, [plain.id]);
  });

  for (const how of ["moved between passes", "moved into a new folder, older than the window"] as const) {
    it(`Codex R28: a missing plain-key twin and a twin ${how} remain cached unresolved`, async () => {
      const { imap, backend, client, addAccount } = await setup();
      const ctl = imap.server.control;
      const old = new Date(Date.now() - 400 * 86_400_000);
      const outside = how !== "moved between passes";
      if (outside) await client.call("settings.update", { syncWindowDays: 3650 });
      ctl.createMailbox("Z");
      if (!outside) ctl.createMailbox("A");
      const twin = raw({ subject: "Superviviente con Message-ID", id: "survivor@x", ...(outside && { date: old }) });
      const opts = outside ? { raw: twin, internaldate: old } : { raw: twin };
      ctl.addMessage("Z", opts);
      ctl.addMessage("Z", opts);
      const account = await addAccount(imap.port);
      await backend.syncAccount(account.id);
      const retained = captureIdentity(backend);
      const plain = sqlDb(backend.store).get<{ id: number; uid: number }>("SELECT m.id, l.uid FROM messages m JOIN message_locations l ON l.message_id = m.id WHERE m.provider_msg_id NOT LIKE '%#%'")!;
      const survivor = sqlDb(backend.store).get<{ id: number; thread_id: number; uid: number }>("SELECT m.id, m.thread_id, l.uid FROM messages m JOIN message_locations l ON l.message_id = m.id WHERE m.provider_msg_id LIKE '%#%'")!;
      const category = await client.call("categories.create", { name: "Guardado", color: "rose" });
      await client.call("categories.addThreads", { categoryId: category.id, threadIds: [survivor.thread_id] });
      ctl.expungeMessages("Z", [plain.uid]);
      await backend.syncAccount(account.id);
      await backend.syncAccount(account.id);
      expect(sqlDb(backend.store).all<{ id: number }>("SELECT id FROM messages").map((m) => m.id)).toEqual(retained.map((m) => m.id));
      if (outside) {
        await client.call("settings.update", { syncWindowDays: 30 });
        ctl.createMailbox("A");
      }
      ctl.moveMessages("Z", [survivor.uid], "A");
      await backend.syncAccount(account.id);
      await backend.syncAccount(account.id);
      expect(sqlDb(backend.store).all<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages WHERE subject = 'Superviviente con Message-ID'")).toEqual(retained.map(({ id, thread_id }) => ({ id, thread_id })));
      expect(sqlDb(backend.store).all<{ mailbox: string }>("SELECT mailbox FROM message_locations WHERE message_id = ?", survivor.id)).toEqual([]);
      expect(count(backend, "SELECT 1 FROM thread_categories WHERE category_id = ? AND thread_id = ?", category.id, survivor.thread_id)).toBe(1);
    await expectRetained(backend, account.id, retained, retained.map((m) => m.id));
    });
  }

  for (const how of ["into a folder it already knew", "into a new folder, older than the window"] as const) {
    it(`Codex R29: an external copy ${how} cannot bind to an existing twin`, async () => {
      const { imap, backend, client, addAccount } = await setup();
      const ctl = imap.server.control;
      const old = new Date(Date.now() - 400 * 86_400_000);
      const outside = how !== "into a folder it already knew";
      if (outside) await client.call("settings.update", { syncWindowDays: 3650 });
      ctl.createMailbox("Z");
      if (!outside) ctl.createMailbox("A");
      const twin = raw({ subject: "Superviviente copiado", id: "copied-survivor@x", ...(outside && { date: old }) });
      const opts = outside ? { raw: twin, internaldate: old } : { raw: twin };
      ctl.addMessage("Z", opts);
      ctl.addMessage("Z", opts);
      const account = await addAccount(imap.port);
      await backend.syncAccount(account.id);
      const retained = captureIdentity(backend);
      const plain = sqlDb(backend.store).get<{ uid: number }>("SELECT l.uid FROM messages m JOIN message_locations l ON l.message_id = m.id WHERE m.provider_msg_id NOT LIKE '%#%'")!;
      const survivor = sqlDb(backend.store).get<{ id: number; uid: number }>("SELECT m.id, l.uid FROM messages m JOIN message_locations l ON l.message_id = m.id WHERE m.provider_msg_id LIKE '%#%'")!;
      ctl.expungeMessages("Z", [plain.uid]);
      await backend.syncAccount(account.id);
      await backend.syncAccount(account.id);
      if (outside) {
        await client.call("settings.update", { syncWindowDays: 30 });
        ctl.createMailbox("A");
      }
      ctl.copyMessages("Z", [survivor.uid], "A");
      await backend.syncAccount(account.id);
      await backend.syncAccount(account.id);
      expect(sqlDb(backend.store).all<{ id: number }>("SELECT id FROM messages WHERE subject = 'Superviviente copiado'").map((m) => m.id)).toEqual(retained.map((m) => m.id));
      expect(sqlDb(backend.store).all<{ mailbox: string }>("SELECT mailbox FROM message_locations WHERE message_id = ? ORDER BY mailbox", survivor.id)).toEqual([{ mailbox: "Z" }]);
    await expectRetained(backend, account.id, retained, retained.filter((m) => m.id !== survivor.id).map((m) => m.id));
    });
  }

  it("Codex R34: a duplicate imported then moved keeps its own cached target unresolved", async () => {
    const { ImapFlow } = await import("imapflow");
    const { imap, backend, addAccount } = await setup();
    const ctl = imap.server.control;
    ctl.createMailbox("A");
    ctl.createMailbox("B");
    const twin = raw({ subject: "Duplicado que sigue", id: "moves-on@x" });
    ctl.addMessage("A", { raw: twin });
    ctl.addMessage("B", { raw: raw({ subject: "En B" }) });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const retained = captureIdentity(backend);
    const original = sqlDb(backend.store).get<{ id: number }>("SELECT id FROM messages WHERE subject = 'Duplicado que sigue'")!.id;
    // a duplicate in A (read this pass, written as its own message), moved to B as B is read
    const dup = ctl.addMessage("A", { raw: twin });
    ctl.addMessage("B", { raw: raw({ subject: "Nuevo en B" }) });
    const lockOriginal = ImapFlow.prototype.getMailboxLock;
    let locks = 0;
    const late = vi.spyOn(ImapFlow.prototype, "getMailboxLock").mockImplementation(function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof lockOriginal>) {
      if (String(args[0]) === "B" && ++locks === 2) ctl.moveMessages("A", [dup.uid], "B");
      return lockOriginal.apply(this, args);
    });
    try {
      await backend.syncAccount(account.id);
    } finally {
      late.mockRestore();
    }
    expect(locks).toBeGreaterThanOrEqual(2);
    await backend.syncAccount(account.id);
    const rows = sqlDb(backend.store).all<{ id: number }>("SELECT id FROM messages WHERE subject = 'Duplicado que sigue' ORDER BY id").map((r) => r.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toBe(original);
    expect(sqlDb(backend.store).all<{ mailbox: string }>("SELECT mailbox FROM message_locations WHERE message_id = ?", original)).toEqual([{ mailbox: "A" }]);
    expect(sqlDb(backend.store).all<{ mailbox: string }>("SELECT mailbox FROM message_locations WHERE message_id = ?", rows[1]!)).toEqual([]);
    await expectRetained(backend, account.id, retained, []);
    expect(await backend.store.providerStore(account.id).locations.unresolved([rows[1]!])).toEqual([rows[1]!]);
  });

  it("Codex R37: an interrupted move and identical arrival cannot rebind the old target", async () => {
    const { ImapFlow } = await import("imapflow");
    const { imap, backend, addAccount } = await setup();
    const ctl = imap.server.control;
    ctl.createMailbox("A");
    ctl.createMailbox("C");
    ctl.createMailbox("Z");
    const twin = raw({ subject: "Colocado y copiado" }).replace(/^Message-ID: .*\r\n/m, "");
    const lone = ctl.addMessage("Z", { raw: twin });
    ctl.addMessage("C", { raw: raw({ subject: "En C" }) });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const retained = captureIdentity(backend);
    const id = sqlDb(backend.store).get<{ id: number }>("SELECT id FROM messages WHERE subject = 'Colocado y copiado'")!.id;
    // moved to A, and an identical copy appears in C; the pass stops (a dropped connection) as C is read
    ctl.moveMessages("Z", [lone.uid], "A");
    ctl.addMessage("C", { raw: twin });
    const original = ImapFlow.prototype.fetch;
    let dropped = false;
    const failing = vi.spyOn(ImapFlow.prototype, "fetch").mockImplementation(function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
      const reading = (args[1] as { envelope?: boolean } | undefined)?.envelope === true;
      if (!dropped && reading && (this.mailbox && this.mailbox.path) === "C") {
        dropped = true;
        throw Object.assign(new Error("Connection closed"), { code: "EConnectionClosed" });
      }
      return original.apply(this, args);
    });
    try {
      await backend.syncAccount(account.id).catch(() => {});
    } finally {
      failing.mockRestore();
    }
    expect(dropped).toBe(true);
    await backend.syncAccount(account.id);
    await backend.syncAccount(account.id);
    const rows = sqlDb(backend.store).all<{ id: number }>("SELECT id FROM messages WHERE subject = 'Colocado y copiado' ORDER BY id").map((r) => r.id);
    expect(rows).toEqual([id]);
    expect(rows[0]).toBe(id);
    expect(sqlDb(backend.store).all<{ mailbox: string }>("SELECT mailbox FROM message_locations WHERE message_id = ?", id)).toEqual([]);

    await expectRetained(backend, account.id, retained, [id]);
  });

  it("Codex R38: reading the identical copy first still cannot rebind the interrupted move", async () => {
    const { ImapFlow } = await import("imapflow");
    const { imap, backend, addAccount } = await setup();
    const ctl = imap.server.control;
    ctl.createMailbox("A");
    ctl.createMailbox("Y");
    ctl.createMailbox("Z");
    ctl.createMailbox("ZZ");
    const twin = raw({ subject: "Colocado, copia antes" }).replace(/^Message-ID: .*\r\n/m, "");
    const lone = ctl.addMessage("Y", { raw: twin });
    ctl.addMessage("ZZ", { raw: raw({ subject: "En ZZ" }) });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const retained = captureIdentity(backend);
    const id = sqlDb(backend.store).get<{ id: number }>("SELECT id FROM messages WHERE subject = 'Colocado, copia antes'")!.id;
    // moved Y → Z; the pass places it in Z, then drops as ZZ is read (after Z)
    ctl.moveMessages("Y", [lone.uid], "Z");
    ctl.addMessage("ZZ", { raw: raw({ subject: "Nuevo en ZZ" }) });
    const original = ImapFlow.prototype.fetch;
    let dropped = false;
    const failing = vi.spyOn(ImapFlow.prototype, "fetch").mockImplementation(function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
      const reading = (args[1] as { envelope?: boolean } | undefined)?.envelope === true;
      if (!dropped && reading && (this.mailbox && this.mailbox.path) === "ZZ") {
        dropped = true;
        // an identical copy arrives in A as the connection drops: the retry reads A before Z
        ctl.addMessage("A", { raw: twin });
        throw Object.assign(new Error("Connection closed"), { code: "EConnectionClosed" });
      }
      return original.apply(this, args);
    });
    try {
      await backend.syncAccount(account.id).catch(() => {});
    } finally {
      failing.mockRestore();
    }
    expect(dropped).toBe(true);
    await backend.syncAccount(account.id);
    await backend.syncAccount(account.id);
    const rows = sqlDb(backend.store).all<{ id: number }>("SELECT id FROM messages WHERE subject = 'Colocado, copia antes' ORDER BY id").map((r) => r.id);
    expect(rows).toEqual([id]);
    expect(rows[0]).toBe(id);
    expect(sqlDb(backend.store).all<{ mailbox: string }>("SELECT mailbox FROM message_locations WHERE message_id = ?", id)).toEqual([]);

    await expectRetained(backend, account.id, retained, [id]);
  });

  it("Codex R54: moving a long conversation to Inbox takes its old places away together, never one at a time", async () => {
    const { imap, backend, client, addAccount } = await setup();
    const ctl = imap.server.control;
    // an ordinary folder (Archive here is All Mail: a move to Inbox from it is a copy)
    ctl.createMailbox("Proyectos");
    const first = raw({ subject: "Conversación larga", id: "long-0@x" });
    ctl.addMessage("Proyectos", { raw: first });
    for (let i = 1; i < 60; i++) ctl.addMessage("Proyectos", { raw: raw({ subject: "Re: Conversación larga", id: `long-${i}@x`, inReplyTo: "long-0@x" }) });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const thread = sqlDb(backend.store).get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE subject = 'Conversación larga'")!.thread_id;
    expect(count(backend, "SELECT 1 FROM messages WHERE thread_id = ?", thread)).toBe(60);
    // the deletes the store runs: one a message, or a slice at a time
    const db = sqlDb(backend.store);
    const run = db.run.bind(db);
    let singles = 0;
    let slices = 0;
    const spy = vi.spyOn(db, "run").mockImplementation((sql: string, ...params: Parameters<typeof run> extends [string, ...infer P] ? P : never) => {
      if (/DELETE FROM message_locations WHERE message_id = \? AND mailbox = \?/.test(sql)) singles++;
      if (/DELETE FROM message_locations WHERE mailbox = \? AND message_id IN/.test(sql)) slices++;
      return run(sql, ...params);
    });
    try {
      await client.call("threads.act", { threadIds: [thread], action: "moveToInbox" });
      await backend.runWorker();
      await expect.poll(() => count(backend, "SELECT 1 FROM message_locations l JOIN messages m ON m.id = l.message_id WHERE m.thread_id = ? AND l.mailbox = 'INBOX'", thread), { timeout: 10_000 }).toBe(60);
    } finally {
      spy.mockRestore();
    }
    expect(singles).toBe(0);
    expect(slices).toBeGreaterThan(0);
    expect(count(backend, "SELECT 1 FROM message_locations l JOIN messages m ON m.id = l.message_id WHERE m.thread_id = ? AND l.mailbox = 'Proyectos'", thread)).toBe(0);
  });

  it("Codex R24: a deleted parent remains a hierarchy group and its missing mail stays cached", async () => {
    const { imap, backend, client, addAccount } = await setup();
    const ctl = imap.server.control;
    ctl.createMailbox("P");
    ctl.createMailbox("P/C");
    ctl.addMessage("P", { raw: raw({ subject: "En el padre" }) });
    ctl.addMessage("P/C", { raw: raw({ subject: "En el hijo" }) });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const retained = captureIdentity(backend);
    expect(count(backend, "SELECT 1 FROM messages WHERE subject = 'En el padre'")).toBe(1);
    ctl.deleteMailbox("P");
    await backend.syncAccount(account.id);
    await backend.syncAccount(account.id);
    expect(count(backend, "SELECT 1 FROM messages WHERE subject = 'En el padre'")).toBe(1);
    expect(count(backend, "SELECT 1 FROM message_locations WHERE mailbox = 'P'")).toBe(0);
    expect(count(backend, "SELECT 1 FROM messages WHERE subject = 'En el hijo'")).toBe(1);
    const folders = (await client.call("app.bootstrap", {})).folders.filter((f) => f.accountId === account.id);
    expect(folders.find((f) => f.key === "P")).toMatchObject({ selectable: false });
    await expectRetained(backend, account.id, retained, [retained[0]!.id]);
  });

  it("Codex R24: late moves told apart take their old places away a mailbox at a time, never one by one", async () => {
    const { ImapFlow } = await import("imapflow");
    const { imap, backend, addAccount } = await setup();
    const ctl = imap.server.control;
    ctl.createMailbox("A");
    ctl.createMailbox("Z");
    const twin = raw({ subject: "Muchos movidos" }).replace(/^Message-ID: .*\r\n/m, "");
    const all = Array.from({ length: 30 }, () => ctl.addMessage("Z", { raw: twin }));
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const before = sqlDb(backend.store).all<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages ORDER BY id");
    ctl.addMessage("A", { raw: raw({ subject: "Nuevo en A" }) });
    ctl.addMessage("Z", { raw: raw({ subject: "Nuevo en Z" }) });
    const original = ImapFlow.prototype.getMailboxLock;
    let locks = 0;
    const late = vi.spyOn(ImapFlow.prototype, "getMailboxLock").mockImplementation(function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
      if (String(args[0]) === "A" && ++locks === 2) ctl.moveMessages("Z", all.map((m) => m.uid), "A");
      return original.apply(this, args);
    });
    const proto = Object.getPrototypeOf(backend.store.providerStore(account.id).locations) as { remove(...a: unknown[]): Promise<void> };
    const removes = vi.spyOn(proto, "remove");
    try {
      await backend.syncAccount(account.id);
    } finally {
      late.mockRestore();
    }
    const singles = removes.mock.calls.length;
    removes.mockRestore();
    expect(singles).toBe(0);
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).all<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages WHERE subject = 'Muchos movidos' ORDER BY id")).toEqual(before);
    expect(count(backend, "SELECT 1 FROM message_locations l JOIN messages m ON m.id = l.message_id WHERE m.subject = 'Muchos movidos' AND l.mailbox = 'Z'")).toBe(0);
  });

  it("Codex R23: partial fetch preserves its checkpoint and withholds ambiguous arrivals on retry", async () => {
    const { ImapFlow } = await import("imapflow");
    const { imap, backend, addAccount } = await setup();
    const ctl = imap.server.control;
    ctl.createMailbox("A");
    ctl.createMailbox("Z");
    const twin = raw({ subject: "Copia retenida" }).replace(/^Message-ID: .*\r\n/m, "");
    ctl.addMessage("Z", { raw: twin });
    ctl.addMessage("A", { raw: raw({ subject: "Primero en A" }) });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const retained = captureIdentity(backend);
    // a copy of Z's (held back: its twin is placed), then a message after it
    ctl.addMessage("A", { raw: twin });
    ctl.addMessage("A", { raw: raw({ subject: "Tercero en A" }) });
    const original = ImapFlow.prototype.fetch;
    let failed = false;
    const failing = vi.spyOn(ImapFlow.prototype, "fetch").mockImplementation(function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
      const it = original.apply(this, args);
      const reading = (args[1] as { envelope?: boolean } | undefined)?.envelope === true;
      if (failed || !reading || (this.mailbox && this.mailbox.path) !== "A") return it;
      failed = true;
      return (async function* () {
        for await (const m of it) {
          yield m;
          throw Object.assign(new Error("Fetch failed"), { responseStatus: "NO", serverResponseCode: "UNAVAILABLE" });
        }
      })() as unknown as ReturnType<typeof original>;
    });
    try {
      await backend.syncAccount(account.id).catch(() => {});
    } finally {
      failing.mockRestore();
    }
    expect(failed).toBe(true);
    await backend.syncAccount(account.id);
    await backend.syncAccount(account.id);
    expect(count(backend, "SELECT 1 FROM messages WHERE subject = 'Tercero en A'")).toBe(1);
    expect(count(backend, "SELECT 1 FROM messages WHERE subject = 'Copia retenida'")).toBe(1);
    await expectRetained(backend, account.id, retained, []);
  });

  it("Codex R22: a late move never attempts speculative upsert; later disappearance retains the target", async () => {
    const { ImapFlow } = await import("imapflow");
    const { imap, backend, addAccount } = await setup();
    const ctl = imap.server.control;
    ctl.createMailbox("A");
    ctl.createMailbox("Z");
    const lone = ctl.addMessage("Z", { raw: raw({ subject: "Movido y cortado" }).replace(/^Message-ID: .*\r\n/m, "") });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const retained = captureIdentity(backend);
    const id = sqlDb(backend.store).get<{ id: number }>("SELECT id FROM messages")!.id;
    ctl.addMessage("A", { raw: raw({ subject: "Nuevo en A" }) });
    ctl.addMessage("Z", { raw: raw({ subject: "Nuevo en Z" }) });
    const original = ImapFlow.prototype.getMailboxLock;
    let locks = 0;
    const late = vi.spyOn(ImapFlow.prototype, "getMailboxLock").mockImplementation(function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
      if (String(args[0]) === "A" && ++locks === 2) ctl.moveMessages("Z", [lone.uid], "A");
      return original.apply(this, args);
    });
    // writing its new place fails once (a crash, a full disk)
    const proto = Object.getPrototypeOf(backend.store.providerStore(account.id).locations) as { upsert(id: number, mailbox: string, ...rest: unknown[]): Promise<void> };
    const upsert = proto.upsert;
    let failed = false;
    const failing = vi.spyOn(proto, "upsert").mockImplementation(async function (this: unknown, messageId: number, mailbox: string, ...rest: unknown[]) {
      if (messageId === id && mailbox === "A" && !failed) {
        failed = true;
        // and it's deleted where it went, before any retry sees it there
        const there = (ctl as unknown as { listMessages(path: string, o: { raw: boolean }): { uid: number; raw: Buffer }[] }).listMessages("A", { raw: true }).filter((x) => x.raw.toString().includes("Movido y cortado")).map((x) => x.uid);
        ctl.expungeMessages("A", there);
        throw new Error("synthetic write failure");
      }
      return upsert.call(this, messageId, mailbox, ...rest);
    });
    try {
      await backend.syncAccount(account.id).catch(() => {});
    } finally {
      late.mockRestore();
      failing.mockRestore();
    }
    expect(failed).toBe(false);
    const remote = ctl.listMessages("A", { raw: true }).find((m) => m.raw!.toString().includes("Movido y cortado"))!;
    expect(remote).toBeDefined();
    ctl.expungeMessages("A", [remote.uid]);
    await backend.syncAccount(account.id);
    await backend.syncAccount(account.id);
    expect(count(backend, "SELECT 1 FROM messages m WHERE NOT EXISTS (SELECT 1 FROM message_locations l WHERE l.message_id = m.id)")).toBe(1);
    expect(count(backend, "SELECT 1 FROM messages WHERE id = ?", id)).toBe(1);
    await expectRetained(backend, account.id, retained, retained.map((m) => m.id));
  });

  it("Codex R19: an ID-less twin appended to the same folder is a copy; the first keeps its own UID", async () => {
    const { imap, backend, addAccount } = await setup();
    const ctl = imap.server.control;
    ctl.createMailbox("A");
    const twin = raw({ subject: "Gemelo añadido" }).replace(/^Message-ID: .*\r\n/m, "");
    const first = ctl.addMessage("A", { raw: twin });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const id = sqlDb(backend.store).get<{ id: number }>("SELECT id FROM messages")!.id;
    const second = ctl.addMessage("A", { raw: twin });
    await backend.syncAccount(account.id);
    await backend.syncAccount(account.id);
    expect(count(backend, "SELECT 1 FROM messages")).toBe(2);
    expect(sqlDb(backend.store).get<{ uid: number }>("SELECT uid FROM message_locations WHERE message_id = ?", id)!.uid).toBe(first.uid);
    expect(count(backend, "SELECT 1 FROM message_locations WHERE mailbox = 'A' AND uid = ?", second.uid)).toBe(1);
  });

  it("Codex R19: a late move outside the window retains the cached target without rebinding", async () => {
    const { ImapFlow } = await import("imapflow");
    const { imap, backend, client, addAccount } = await setup();
    const ctl = imap.server.control;
    const old = new Date(Date.now() - 400 * 86_400_000);
    await client.call("settings.update", { syncWindowDays: 3650 });
    ctl.createMailbox("Z");
    const lone = ctl.addMessage("Z", { raw: raw({ subject: "Viejo sin Message-ID", date: old }).replace(/^Message-ID: .*\r\n/m, ""), internaldate: old });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const retained = captureIdentity(backend);
    const before = sqlDb(backend.store).all<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages");
    expect(before).toHaveLength(1);
    await client.call("settings.update", { syncWindowDays: 30 });
    // Z has news (so it's swept); A is new (read whole); the move comes as A is read, after every sweep
    ctl.addMessage("Z", { raw: raw({ subject: "Nuevo en Z" }) });
    ctl.createMailbox("A");
    const original = ImapFlow.prototype.getMailboxLock;
    let moved = false;
    const late = vi.spyOn(ImapFlow.prototype, "getMailboxLock").mockImplementation(function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
      if (String(args[0]) === "A" && !moved) {
        moved = true;
        ctl.moveMessages("Z", [lone.uid], "A");
      }
      return original.apply(this, args);
    });
    try {
      await backend.syncAccount(account.id);
    } finally {
      late.mockRestore();
    }
    expect(moved).toBe(true);
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).all<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages WHERE subject = 'Viejo sin Message-ID'")).toEqual(before);
    expect(count(backend, "SELECT 1 FROM message_locations WHERE message_id = ? AND mailbox = 'A'", before[0]!.id)).toBe(0);
    await expectRetained(backend, account.id, retained, retained.map((m) => m.id));
  });

  it("Codex R19: a suffixed ID-less twin moved late stays unresolved while its sibling stays located", async () => {
    const { ImapFlow } = await import("imapflow");
    const { imap, backend, client, addAccount } = await setup();
    const ctl = imap.server.control;
    ctl.createMailbox("A");
    ctl.createMailbox("X");
    ctl.createMailbox("Z");
    const twin = raw({ subject: "Gemelos repartidos" }).replace(/^Message-ID: .*\r\n/m, "");
    const inX = ctl.addMessage("X", { raw: twin });
    const inZ = ctl.addMessage("Z", { raw: twin });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const retained = captureIdentity(backend);
    const before = sqlDb(backend.store).all<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages ORDER BY id");
    expect(before).toHaveLength(2);
    const category = await client.call("categories.create", { name: "Guardado", color: "rose" });
    await client.call("categories.addThreads", { categoryId: category.id, threadIds: [...new Set(before.map((m) => m.thread_id))] });
    // the twin stored under a suffixed key, and where it is
    const suffixed = sqlDb(backend.store).get<{ mailbox: string }>("SELECT l.mailbox FROM messages m JOIN message_locations l ON l.message_id = m.id WHERE m.provider_msg_id LIKE '%#%'")!;
    const source = suffixed.mailbox;
    const uid = source === "X" ? inX.uid : inZ.uid;
    ctl.addMessage("A", { raw: raw({ subject: "Nuevo en A" }) });
    ctl.addMessage(source, { raw: raw({ subject: "Nuevo en el origen" }) });
    const original = ImapFlow.prototype.getMailboxLock;
    let locks = 0;
    const late = vi.spyOn(ImapFlow.prototype, "getMailboxLock").mockImplementation(function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
      if (String(args[0]) === "A" && ++locks === 2) ctl.moveMessages(source, [uid], "A");
      return original.apply(this, args);
    });
    try {
      await backend.syncAccount(account.id);
    } finally {
      late.mockRestore();
    }
    expect(locks).toBeGreaterThanOrEqual(2);
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).all<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages WHERE subject = 'Gemelos repartidos' ORDER BY id")).toEqual(before);
    expect(count(backend, "SELECT 1 FROM message_locations l JOIN messages m ON m.id = l.message_id WHERE m.subject = 'Gemelos repartidos' AND l.mailbox = 'A'")).toBe(0);
    expect(count(backend, "SELECT 1 FROM thread_categories WHERE category_id = ?", category.id)).toBe(new Set(before.map((m) => m.thread_id)).size);
    await expectRetained(backend, account.id, retained, retained.filter((m) => m.id === before[1]!.id).map((m) => m.id));
  });

  for (const window of ["inside", "outside"] as const) {
    it(`Codex R20: missing plain-key and late moved twins (${window} the window) both remain cached`, async () => {
      const { ImapFlow } = await import("imapflow");
      const { imap, backend, client, addAccount } = await setup();
      const ctl = imap.server.control;
      const old = new Date(Date.now() - 400 * 86_400_000);
      if (window === "outside") await client.call("settings.update", { syncWindowDays: 3650 });
      ctl.createMailbox("X");
      ctl.createMailbox("Z");
      const twin = raw({ subject: "Superviviente", ...(window === "outside" && { date: old }) }).replace(/^Message-ID: .*\r\n/m, "");
      const opts = window === "outside" ? { raw: twin, internaldate: old } : { raw: twin };
      const inX = ctl.addMessage("X", opts);
      const inZ = ctl.addMessage("Z", opts);
      const account = await addAccount(imap.port);
      await backend.syncAccount(account.id);
      const retained = captureIdentity(backend);
      const plain = sqlDb(backend.store).get<{ id: number; mailbox: string }>("SELECT m.id, l.mailbox FROM messages m JOIN message_locations l ON l.message_id = m.id WHERE m.provider_msg_id NOT LIKE '%#%'")!;
      const survivor = sqlDb(backend.store).get<{ id: number; thread_id: number; mailbox: string }>("SELECT m.id, m.thread_id, l.mailbox FROM messages m JOIN message_locations l ON l.message_id = m.id WHERE m.provider_msg_id LIKE '%#%'")!;
      const category = await client.call("categories.create", { name: "Guardado", color: "rose" });
      await client.call("categories.addThreads", { categoryId: category.id, threadIds: [survivor.thread_id] });
      // the plain-key one goes, in a pass that completes
      ctl.expungeMessages(plain.mailbox, [plain.mailbox === "X" ? inX.uid : inZ.uid]);
      await backend.syncAccount(account.id);
      await backend.syncAccount(account.id);
      expect(sqlDb(backend.store).all<{ id: number }>("SELECT id FROM messages").map((m) => m.id)).toEqual(retained.map((m) => m.id));
      // then the other moves, after its folder's sweep, into a folder seen for the first time
      if (window === "outside") await client.call("settings.update", { syncWindowDays: 30 });
      ctl.addMessage(survivor.mailbox, { raw: raw({ subject: "Nuevo en el origen" }) });
      ctl.createMailbox("A");
      const original = ImapFlow.prototype.getMailboxLock;
      let moved = false;
      const late = vi.spyOn(ImapFlow.prototype, "getMailboxLock").mockImplementation(function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
        if (String(args[0]) === "A" && !moved) {
          moved = true;
          ctl.moveMessages(survivor.mailbox, [survivor.mailbox === "X" ? inX.uid : inZ.uid], "A");
        }
        return original.apply(this, args);
      });
      try {
        await backend.syncAccount(account.id);
      } finally {
        late.mockRestore();
      }
      expect(moved).toBe(true);
      await backend.syncAccount(account.id);
      expect(sqlDb(backend.store).all<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages WHERE subject = 'Superviviente'")).toEqual(retained.map(({ id, thread_id }) => ({ id, thread_id })));
      expect(count(backend, "SELECT 1 FROM message_locations WHERE message_id = ? AND mailbox = 'A'", survivor.id)).toBe(0);
      expect(count(backend, "SELECT 1 FROM thread_categories WHERE category_id = ? AND thread_id = ?", category.id, survivor.thread_id)).toBe(1);
    await expectRetained(backend, account.id, retained, retained.map((m) => m.id));
    });
  }

  it("Codex R21: after a twin vanishes, identical arrivals elsewhere remain unbound", async () => {
    const { imap, backend, addAccount } = await setup();
    const ctl = imap.server.control;
    ctl.createMailbox("X");
    ctl.createMailbox("Z");
    ctl.createMailbox("A");
    ctl.createMailbox("B");
    const twin = raw({ subject: "Copias en dos carpetas" }).replace(/^Message-ID: .*\r\n/m, "");
    const inX = ctl.addMessage("X", { raw: twin });
    const inZ = ctl.addMessage("Z", { raw: twin });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const retained = captureIdentity(backend);
    const plain = sqlDb(backend.store).get<{ mailbox: string }>("SELECT l.mailbox FROM messages m JOIN message_locations l ON l.message_id = m.id WHERE m.provider_msg_id NOT LIKE '%#%'")!;
    ctl.expungeMessages(plain.mailbox, [plain.mailbox === "X" ? inX.uid : inZ.uid]);
    await backend.syncAccount(account.id);
    await backend.syncAccount(account.id);
    expect(count(backend, "SELECT 1 FROM messages")).toBe(2);
    ctl.addMessage("A", { raw: twin });
    ctl.addMessage("B", { raw: twin });
    await backend.syncAccount(account.id);
    await backend.syncAccount(account.id);
    expect(count(backend, "SELECT 1 FROM messages")).toBe(2);
    expect(count(backend, "SELECT DISTINCT message_id FROM message_locations WHERE mailbox IN ('A', 'B')")).toBe(0);
    await expectRetained(backend, account.id, retained, [retained[0]!.id]);
  });

  it("Codex R20: a late move of the 55th twin withholds binding and retains the exact target", async () => {
    const { ImapFlow } = await import("imapflow");
    const { imap, backend, addAccount } = await setup();
    const ctl = imap.server.control;
    ctl.createMailbox("A");
    ctl.createMailbox("Z");
    const twin = raw({ subject: "Muchos gemelos" }).replace(/^Message-ID: .*\r\n/m, "");
    const all = Array.from({ length: 55 }, () => ctl.addMessage("Z", { raw: twin }));
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const retained = captureIdentity(backend);
    const before = sqlDb(backend.store).all<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages ORDER BY id");
    expect(before).toHaveLength(55);
    const last = sqlDb(backend.store).get<{ id: number }>("SELECT message_id AS id FROM message_locations WHERE mailbox = 'Z' AND uid = ?", all.at(-1)!.uid)!.id;
    ctl.addMessage("A", { raw: raw({ subject: "Nuevo en A" }) });
    ctl.addMessage("Z", { raw: raw({ subject: "Nuevo en Z" }) });
    const original = ImapFlow.prototype.getMailboxLock;
    let locks = 0;
    const late = vi.spyOn(ImapFlow.prototype, "getMailboxLock").mockImplementation(function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
      if (String(args[0]) === "A" && ++locks === 2) ctl.moveMessages("Z", [all.at(-1)!.uid], "A");
      return original.apply(this, args);
    });
    try {
      await backend.syncAccount(account.id);
    } finally {
      late.mockRestore();
    }
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).all<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages WHERE subject = 'Muchos gemelos' ORDER BY id")).toEqual(before);
    expect(count(backend, "SELECT 1 FROM message_locations WHERE message_id = ? AND mailbox = 'A'", last)).toBe(0);
    await expectRetained(backend, account.id, retained, [last]);
  });

  it("Codex R3: a folder named __proto__ is a path like any other: its checkpoint is kept, and STATUS skips it when quiet", async () => {
    const { ImapFlow } = await import("imapflow");
    const { imap, backend, client, addAccount } = await setup();
    const ctl = imap.server.control;
    ctl.createMailbox("__proto__");
    ctl.addMessage("__proto__", { raw: raw({ subject: "Rara" }) });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    expect(await folderOf(client, account.id, "__proto__")).toEqual(["Rara"]);
    const config = JSON.parse(sqlDb(backend.store).get<{ provider_config: string }>("SELECT provider_config FROM accounts WHERE id = ?", account.id)!.provider_config) as { cursor: { mailboxes: Record<string, unknown> } };
    expect(Object.hasOwn(config.cursor.mailboxes, "__proto__")).toBe(true);
    const opened: string[] = [];
    const original = ImapFlow.prototype.getMailboxLock;
    const spy = vi.spyOn(ImapFlow.prototype, "getMailboxLock").mockImplementation(function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
      opened.push(String(args[0]));
      return original.apply(this, args);
    });
    try {
      await backend.syncAccount(account.id);
      expect(opened).not.toContain("__proto__");
    } finally {
      spy.mockRestore();
    }
  });

  it("a new folder’s old mail cannot acquire a cached target from its envelope", async () => {
    const { imap, backend, client, addAccount } = await setup();
    const ctl = imap.server.control;
    const old = new Date(Date.now() - 400 * 86_400_000);
    await client.call("settings.update", { syncWindowDays: 3650 });
    const m = ctl.addMessage("INBOX", { raw: raw({ subject: "Factura 2025", date: old }), internaldate: old });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const retained = captureIdentity(backend);
    await client.call("settings.update", { syncWindowDays: 30 });
    ctl.createMailbox("Facturas");
    ctl.copyMessages("INBOX", [m.uid], "Facturas");
    await backend.syncAccount(account.id);
    expect(await folderOf(client, account.id, "Facturas")).toEqual([]);
    expect(count(backend, "SELECT 1 FROM messages")).toBe(1);
    await expectRetained(backend, account.id, retained, []);
  });

  it("a folder STATUS says is unchanged isn't opened again; a flag change in it is seen (CONDSTORE)", async () => {
    const { ImapFlow } = await import("imapflow");
    const { imap, backend, client, addAccount } = await setup();
    const ctl = imap.server.control;
    ctl.createMailbox("Work");
    const m = ctl.addMessage("Work", { raw: raw({ subject: "Contrato" }) });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const retained = captureIdentity(backend);
    const opened: string[] = [];
    const original = ImapFlow.prototype.getMailboxLock;
    const spy = vi.spyOn(ImapFlow.prototype, "getMailboxLock").mockImplementation(function (this: InstanceType<typeof ImapFlow>, ...args: Parameters<typeof original>) {
      opened.push(String(args[0]));
      return original.apply(this, args);
    });
    try {
      await backend.syncAccount(account.id);
      expect(opened).not.toContain("Work");
      ctl.setFlags("Work", [m.uid], ["\\Seen"], "add");
      opened.length = 0;
      await backend.syncAccount(account.id);
      expect(opened).toContain("Work");
      expect((await client.call("counts.get", {})).folderUnread).toEqual({});
      // Codex R2: a UIDVALIDITY reset that keeps UIDNEXT, MESSAGES and the mod-sequence is still a reset
      const before = sqlDb(backend.store).get<{ uidvalidity: number }>("SELECT uidvalidity FROM message_locations WHERE mailbox = 'Work'")!.uidvalidity;
      ctl.resetUidValidity("Work");
      expect(ctl.getMailbox("Work").uidvalidity).toBeGreaterThan(before);
      opened.length = 0;
      await backend.syncAccount(account.id);
      expect(opened).toContain("Work");
      expect(count(backend, "SELECT 1 FROM message_locations WHERE mailbox = 'Work'")).toBe(0);
      expect(await folderOf(client, account.id, "Work")).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    await expectRetained(backend, account.id, retained, retained.map((m) => m.id));
  });
});

describe("IMAP identity and safety (review fixes)", () => {
  it("keeps two distinct messages that share a Message-ID in the same mailbox", async () => {
    const { imap, backend, addAccount } = await setup();
    imap.server.control.addMessage("INBOX", { raw: raw({ subject: "Copia 1", id: "dup@x" }) });
    imap.server.control.addMessage("INBOX", { raw: raw({ subject: "Copia 2", id: "dup@x" }) });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).all("SELECT subject FROM messages ORDER BY subject")).toEqual([{ subject: "Copia 1" }, { subject: "Copia 2" }]);
    await backend.syncAccount(account.id);
    expect(count(backend, "SELECT 1 FROM messages")).toBe(2);
  });

  it("archiving mail without a Message-ID doesn't wedge the next sync", async () => {
    const { imap, backend, client, addAccount } = await setup();
    imap.server.control.addMessage("INBOX", { raw: "From: x@y.z\r\nSubject: Sin ID\r\n\r\nhola\r\n" });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const [t] = (await client.call("threads.list", { view: "inbox" })).items;
    await client.call("threads.act", { threadIds: [t!.id], action: "archive" });
    await backend.runWorker();
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).get<{ status: string }>("SELECT json_extract(sync_state, '$.status') AS status FROM accounts")!.status).toBe("idle");
    expect(count(backend, "SELECT 1 FROM messages")).toBe(1);
    expect((await client.call("threads.list", { view: "archive" })).items).toHaveLength(1);
  });

  it("keeps old cached mail (outside the sync window) across a UIDVALIDITY reset", async () => {
    const { imap, backend, addAccount } = await setup();
    const old = new Date(Date.now() - 400 * 86_400_000);
    imap.server.control.addMessage("INBOX", { raw: raw({ subject: "Viejo", date: old }), internaldate: old });
    imap.server.control.addMessage("INBOX", { raw: raw({ subject: "Nuevo" }) });
    await backend.server.invoke("settings.update", { syncWindowDays: 3650 }, { clientId: "t", origin: "renderer" });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    expect(count(backend, "SELECT 1 FROM messages")).toBe(2);
    await backend.server.invoke("settings.update", { syncWindowDays: 30 }, { clientId: "t", origin: "renderer" });
    imap.server.control.resetUidValidity("INBOX", { uids: "renumber" });
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).all("SELECT subject FROM messages ORDER BY subject")).toEqual([{ subject: "Nuevo" }, { subject: "Viejo" }]);
  });

  it("re-identifies mail without a Message-ID after a UIDVALIDITY reset", async () => {
    const { imap, backend, addAccount } = await setup();
    const noId = (subject: string) => `From: x@y.z\r\nSubject: ${subject}\r\nDate: ${new Date().toUTCString()}\r\n\r\nhola\r\n`;
    imap.server.control.addMessage("INBOX", { raw: noId("sin id 1") });
    imap.server.control.addMessage("INBOX", { raw: noId("sin id 2") });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const before = sqlDb(backend.store).all("SELECT id FROM messages ORDER BY id");
    imap.server.control.resetUidValidity("INBOX", { uids: "renumber" });
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).all("SELECT id FROM messages ORDER BY id")).toEqual(before); // same rows, not re-imported
  });

  it("imports first-sync equal-envelope ID-less UIDs as separate targets", async () => {
    const { imap, backend, addAccount } = await setup();
    const date = new Date().toUTCString();
    const twin = (body: string) => `From: x@y.z\r\nSubject: Igual\r\nDate: ${date}\r\n\r\n${body}\r\n`;
    imap.server.control.addMessage("INBOX", { raw: twin("AAAA") });
    imap.server.control.addMessage("Archive", { raw: twin("BBBB") });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    expect(count(backend, "SELECT 1 FROM messages")).toBe(2);
    expect(count(backend, "SELECT 1 FROM message_locations GROUP BY message_id HAVING count(*) > 1")).toBe(0);
  });

  it("recognises cached mail stored under an older identity scheme after a reset", async () => {
    const { imap, backend, addAccount } = await setup();
    const old = new Date(Date.now() - 400 * 86_400_000);
    imap.server.control.addMessage("INBOX", { raw: `From: x@y.z\r\nSubject: Antiguo\r\nDate: ${old.toUTCString()}\r\n\r\nhola\r\n`, internaldate: old });
    await backend.server.invoke("settings.update", { syncWindowDays: 3650 }, { clientId: "t", origin: "renderer" });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    sqlDb(backend.store).run("UPDATE messages SET provider_msg_id = 'INBOX:1:1'"); // legacy location-based key
    await backend.server.invoke("settings.update", { syncWindowDays: 30 }, { clientId: "t", origin: "renderer" });
    imap.server.control.resetUidValidity("INBOX", { uids: "renumber" });
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).all("SELECT subject, body_state FROM messages")).toEqual([{ subject: "Antiguo", body_state: "full" }]);
  });

  it("ID-less twins retain cached bytes and withhold unproven bindings across a reset", async () => {
    const { imap, backend, client, addAccount } = await setup();
    const date = new Date().toUTCString();
    const twin = (body: string) => `From: x@y.z\r\nSubject: Gemelo\r\nDate: ${date}\r\n\r\n${body}\r\n`;
    imap.server.control.addMessage("INBOX", { raw: twin("AAAA") });
    imap.server.control.addMessage("INBOX", { raw: twin("BBBB") });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    expect(count(backend, "SELECT 1 FROM messages")).toBe(2);
    imap.server.control.resetUidValidity("INBOX", { uids: "renumber" });
    await backend.syncAccount(account.id);
    expect(count(backend, "SELECT 1 FROM messages")).toBe(2);
    expect(count(backend, "SELECT DISTINCT uid FROM message_locations")).toBe(0);
    // trashing the row whose cached body is AAAA must move the server message AAAA
    const a = sqlDb(backend.store).get<{ thread_id: number }>("SELECT thread_id FROM messages JOIN message_bodies ON message_id = id WHERE body_text LIKE 'AAAA%'")!.thread_id;
    await client.call("threads.act", { threadIds: [a], action: "trash" });
    await backend.runWorker();
    const trashed = imap.server.control.listMessages("Trash", { raw: true }) as { raw: Buffer }[];
    expect(trashed).toEqual([]);
    expect((await client.call("ops.list", {}))[0]).toMatchObject({ state: "queued", attempts: 0, lastErrorI18n: { key: "errors.imap.identityUnavailable" } });
  });

  it("never binds a different message to a cached row that had another Message-ID", async () => {
    const { imap, backend, addAccount } = await setup();
    const date = new Date();
    const a = imap.server.control.addMessage("INBOX", { raw: raw({ subject: "Igual", id: "a@x", from: "x@y.z", date, body: "AAAA" }) });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    imap.server.control.expungeMessages("INBOX", [a.uid]);
    imap.server.control.addMessage("INBOX", { raw: raw({ subject: "Igual", id: "b@x", from: "x@y.z", date, body: "BBBB" }) });
    imap.server.control.resetUidValidity("INBOX", { uids: "renumber" });
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).all("SELECT rfc_message_id, substr(body_text, 1, 4) AS b FROM messages LEFT JOIN message_bodies ON message_id = id")).toEqual([{ rfc_message_id: "a@x", b: "AAAA" }, { rfc_message_id: "b@x", b: "BBBB" }]);
  });

  it("doesn't merge unrelated messages that reuse a Message-ID across folders", async () => {
    const { imap, backend, addAccount } = await setup();
    imap.server.control.addMessage("INBOX", { raw: raw({ subject: "Factura", id: "same@x", from: "a@uno.com" }) });
    imap.server.control.addMessage("Archive", { raw: raw({ subject: "Otra cosa", id: "same@x", from: "b@dos.com" }) });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).all("SELECT subject FROM messages ORDER BY subject")).toEqual([{ subject: "Factura" }, { subject: "Otra cosa" }]);
  });

  it("an op queued before a UIDVALIDITY reset never touches the wrong message", async () => {
    const { imap, backend, client, addAccount } = await setup();
    const ctl = imap.server.control;
    for (const s of ["uno", "dos", "tres"]) ctl.addMessage("INBOX", { raw: raw({ subject: s }) });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const thread = sqlDb(backend.store).get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE subject = 'uno'")!.thread_id;
    await client.call("threads.act", { threadIds: [thread], action: "trash" });
    ctl.resetUidValidity("INBOX", { uids: "shuffle", seed: 3 }); // old UIDs now point at other messages
    await backend.runWorker();
    expect(ctl.listMessages("Trash")).toHaveLength(0); // refused: stale UIDVALIDITY
    const [op] = await client.call("ops.list", {});
    expect(op).toMatchObject({ state: "queued", lastErrorI18n: { key: "errors.imap.identityUnavailable" } });
    await backend.syncAccount(account.id); // remaps locations
    sqlDb(backend.store).run("UPDATE ops SET next_attempt_at = 0");
    await backend.runWorker();
    const trashed = ctl.listMessages("Trash", { raw: true }) as { raw: Buffer }[];
    expect(trashed).toHaveLength(0);
    expect((await backend.store.ops.get(op!.id))?.next_attempt_at).toBe(AWAITING_IDENTITY);
  });

  describe("queued actions across UIDVALIDITY reuse (A25/S12)", () => {
    const witness = (ctl: ImapKitServer["control"], path: string) => ({
      mailbox: path,
      uidvalidity: ctl.getMailbox(path).uidvalidity,
      messages: ctl.listMessages(path, { raw: true }).map((m) => ({ uid: m.uid, raw: m.raw!.toString(), flags: [...m.flags].sort() })),
    });
    const mutations = (server: ImapKitServer) => {
      const commands: { command: string; mailbox: string | null; line: string }[] = [];
      server.script.add({ on: "command", run: true, when: (context) => {
        if (/^(?:UID )?(?:COPY|MOVE|STORE|EXPUNGE)$/.test(context.command ?? "")) {
          if (commands.length >= 16) throw new Error("Unexpected unbounded queued mutations");
          commands.push({ command: context.command!, mailbox: context.mailbox, line: context.data.trim() });
        }
        return false;
      } });
      return commands;
    };
    const reopen = async (t: Awaited<ReturnType<typeof setup>>) => {
      await t.stop();
      const backend = new Backend({ dbPath: join(t.dir, "u.db"), version: "t", cipher: plaintextCipher, providers: createRegistry({ imap: { allowInsecure: true } }), autoSync: false });
      cleanups.push(() => backend.stop());
      const [c, s] = createMemoryTransportPair();
      backend.connect(s, { clientId: "queued-identity-reopen", origin: "renderer" });
      await backend.ready;
      return { backend, client: new RpcClient(c) };
    };

    it.each([
      { mode: "synced", action: "trash" },
      { mode: "stale dispatch", action: "trash" },
      { mode: "stale dispatch", action: "markRead" },
      { mode: "reopened", action: "trash" },
      { mode: "synced then reopened", action: "trash" },
      { mode: "interrupted reset", action: "trash" },
      { mode: "recreated mailbox", action: "trash" },
      { mode: "disappeared", action: "trash" },
      { mode: "reopened", action: "markRead" },
    ] as const)("keeps an old queued $action away from different mail: $mode", async ({ mode, action }) => {
      const t = await setup();
      const ctl = t.imap.server.control;
      ctl.createMailbox("Work");
      const epoch = Math.max(ctl.getMailbox("Work").uidvalidity, ctl.getMailbox("Archive").uidvalidity) + 1;
      ctl.resetUidValidity("Work", { uidvalidity: epoch });
      ctl.resetUidValidity("Archive", { uidvalidity: epoch });
      const date = new Date();
      const oldRaw = raw({ subject: "Same envelope", id: "old@x", body: "AAAA", date });
      const newRaw = raw({ subject: "Same envelope", id: "new@x", body: "BBBB", date });
      expect(Buffer.byteLength(oldRaw)).toBe(Buffer.byteLength(newRaw));
      const old = ctl.addMessage("Work", { raw: oldRaw });
      const otherRaw = raw({ subject: "Other folder", body: "Other UID one" });
      const other = ctl.addMessage("Archive", { raw: otherRaw });
      expect(other.uid).toBe(old.uid);
      expect(other.uidvalidity).toBe(old.uidvalidity);
      const account = await t.addAccount(t.imap.port);
      await t.backend.syncAccount(account.id);
      expect(witness(ctl, "Work")).toEqual({ mailbox: "Work", uidvalidity: old.uidvalidity, messages: [{ uid: old.uid, raw: oldRaw, flags: [] }] });
      const original = sqlDb(t.backend.store).get<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages WHERE rfc_message_id = 'old@x'")!;
      expect(await t.backend.store.providerStore(account.id).locations!.of([original.id])).toEqual([expect.objectContaining({ mailbox: "Work", uidvalidity: old.uidvalidity, uid: old.uid })]);
      await t.client.call("threads.act", { threadIds: [original.thread_id], action });
      let [queued] = await t.client.call("ops.list", {});
      expect(queued).toMatchObject({ kind: action, state: "queued", attempts: 0 });
      expect(JSON.parse((await t.backend.store.ops.get(queued!.id))!.target_json)).toEqual({ messageIds: [original.id] });
      const otherBefore = witness(ctl, "Archive");
      ctl.expungeMessages("Work", [old.uid]);
      if (mode === "recreated mailbox") {
        ctl.deleteMailbox("Work");
        ctl.createMailbox("Work");
      }
      if (mode !== "disappeared") ctl.addMessage("Work", { raw: newRaw });
      const reset = ctl.resetUidValidity("Work", { uids: "renumber" });
      expect(reset.uidvalidity).not.toBe(old.uidvalidity);
      const replacement = witness(ctl, "Work");
      expect(replacement.messages).toEqual(mode === "disappeared" ? [] : [{ uid: old.uid, raw: newRaw, flags: [] }]);
      const commands = mutations(t.imap.server);
      if (mode === "stale dispatch") {
        await t.backend.runWorker();
        [queued] = await t.client.call("ops.list", {});
        expect(queued).toMatchObject({ state: "queued", attempts: 0, lastErrorI18n: { key: "errors.imap.identityUnavailable" } });
        expect(commands).toEqual([]);
        expect(witness(ctl, "Work")).toEqual(replacement);
        expect(witness(ctl, "Archive")).toEqual(otherBefore);
      }
      // Drop both read attempts after reset journaling; this must stop before reconciliation.
      const interrupted = mode === "interrupted reset" ? t.imap.server.script.add({ on: "command", command: "UID SEARCH", when: (context) => context.mailbox === "Work", times: 2, drop: true, close: "reset" }) : null;
      let active = mode === "reopened" ? await reopen(t) : { backend: t.backend, client: t.client };
      expect(await active.client.call("ops.list", {})).toEqual([queued]);
      expect(JSON.parse((await active.backend.store.ops.get(queued!.id))!.target_json)).toEqual({ messageIds: [original.id] });
      await active.backend.syncAccount(account.id);
      if (interrupted) {
        expect(interrupted.hits).toBe(2);
        const config = JSON.parse(sqlDb(t.backend.store).get<{ provider_config: string }>("SELECT provider_config FROM accounts WHERE id = ?", account.id)!.provider_config) as { cursor: { resetPending: Record<string, number[]>; unlocated: number[] } };
        expect(config.cursor.resetPending.Work).toContain(original.id);
        expect(config.cursor.unlocated).toContain(original.id);
        expect(await t.backend.store.providerStore(account.id).locations!.of([original.id])).toEqual([]);
        expect((await t.client.call("threads.get", { threadId: original.thread_id })).messages[0]).toMatchObject({ id: original.id, bodyText: "AAAA\n" });
      }
      expect(await active.client.call("ops.list", {})).toEqual([queued]);
      if (mode === "interrupted reset" || mode === "synced then reopened") {
        const savedConfig = sqlDb(t.backend.store).get<{ provider_config: string }>("SELECT provider_config FROM accounts WHERE id = ?", account.id)!.provider_config;
        active = await reopen(t);
        expect(sqlDb(active.backend.store).get<{ provider_config: string }>("SELECT provider_config FROM accounts WHERE id = ?", account.id)!.provider_config).toEqual(savedConfig);
        expect(await active.client.call("ops.list", {})).toEqual([queued]);
        if (interrupted) {
          expect(await active.backend.store.providerStore(account.id).locations!.of([original.id])).toEqual([]);
          await active.backend.syncAccount(account.id);
        }
      }
      expect(await active.backend.store.providerStore(account.id).locations!.of([original.id])).toEqual([]);
      expect(sqlDb(active.backend.store).get("SELECT id FROM messages WHERE id = ?", original.id)).toEqual({ id: original.id });
      expect((await active.client.call("threads.get", { threadId: original.thread_id })).messages[0]).toMatchObject({ bodyText: "AAAA\n" });
      if (mode !== "disappeared") {
        const fresh = sqlDb(active.backend.store).get<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages WHERE rfc_message_id = 'new@x'")!;
        expect(fresh.id).not.toBe(original.id);
        expect(await active.backend.store.providerStore(account.id).locations!.of([fresh.id])).toEqual([expect.objectContaining({ mailbox: "Work", uidvalidity: reset.uidvalidity, uid: old.uid })]);
        expect((await active.client.call("threads.get", { threadId: fresh.thread_id })).messages[0]).toMatchObject({ id: fresh.id, rfcMessageId: "new@x", bodyText: "BBBB\n" });
      }
      expect(await active.backend.store.ops.get(queued!.id)).not.toBeNull();
      expect(await active.backend.runWorker()).toBe(mode === "stale dispatch" ? 0 : 1);
      expect(await active.backend.store.ops.get(queued!.id)).toMatchObject({ state: "queued", next_attempt_at: AWAITING_IDENTITY, target_json: JSON.stringify({ messageIds: [original.id] }) });
      await active.backend.runWorker();
      expect(commands).toEqual([]);
      expect(witness(ctl, "Work")).toEqual(replacement);
      expect(witness(ctl, "Archive")).toEqual(otherBefore);
      expect(witness(ctl, "Trash").messages).toEqual([]);
    });

    it.each(["current validity", "reset in place", "relocated across reset", "interrupted reset"] as const)("requires trusted current validity for queued genuine mail: %s", async (mode) => {
      const t = await setup();
      const ctl = t.imap.server.control;
      ctl.createMailbox("Work");
      const bytes = raw({ subject: "Genuine target", id: "genuine@x", body: "Exact genuine body" });
      const old = ctl.addMessage("Work", { raw: bytes });
      const other = ctl.addMessage("Archive", { raw: raw({ subject: "Other folder", body: "Other UID one" }) });
      expect(other.uid).toBe(old.uid);
      const account = await t.addAccount(t.imap.port);
      await t.backend.syncAccount(account.id);
      const original = sqlDb(t.backend.store).get<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages WHERE rfc_message_id = 'genuine@x'")!;
      await t.client.call("threads.act", { threadIds: [original.thread_id], action: "trash" });
      const [queued] = await t.client.call("ops.list", {});
      expect(queued).toMatchObject({ state: "queued", attempts: 0 });
      let path = "Work", uid = old.uid;
      if (mode === "relocated across reset") {
        const moved = ctl.moveMessages("Work", [old.uid], "Archive");
        path = "Archive";
        uid = moved.uids[0]!.targetUid;
        ctl.addMessage("Work", { raw: raw({ subject: "Different replacement", id: "replacement@x", body: "Leave this body alone" }) });
        ctl.resetUidValidity("Work", { uids: "renumber" });
      } else if (mode === "reset in place" || mode === "interrupted reset") {
        const reset = ctl.resetUidValidity("Work", { uids: "offset", offset: 100 });
        uid = reset.uids[0]!.newUid;
      }
      const interrupted = mode === "interrupted reset" ? t.imap.server.script.add({ on: "command", command: "UID SEARCH", when: (context) => context.mailbox === "Work", times: 2, drop: true, close: "reset" }) : null;
      await t.backend.syncAccount(account.id);
      const expected = { mailbox: path, uidvalidity: ctl.getMailbox(path).uidvalidity, uid };
      if (mode !== "current validity") {
        if (interrupted) expect(interrupted.hits).toBe(2);
        expect(await t.backend.store.providerStore(account.id).locations.of([original.id])).toEqual([]);
        const { backend, client } = await reopen(t);
        if (interrupted) await backend.syncAccount(account.id);
        const before = [witness(ctl, "Work"), witness(ctl, "Archive"), witness(ctl, "Trash")];
        const commands = mutations(t.imap.server);
        expect(ctl.getMessage(path, uid, { raw: true }).raw).toEqual(Buffer.from(bytes));
        await backend.runWorker();
        expect(await backend.store.ops.get(queued!.id)).toMatchObject({ state: "queued", attempts: 0, next_attempt_at: AWAITING_IDENTITY, target_json: JSON.stringify({ messageIds: [original.id] }) });
        expect((await client.call("threads.get", { threadId: original.thread_id })).messages[0]).toMatchObject({ id: original.id, bodyText: "Exact genuine body\n" });
        await backend.runWorker();
        expect(commands).toEqual([]);
        expect([witness(ctl, "Work"), witness(ctl, "Archive"), witness(ctl, "Trash")]).toEqual(before);
        return;
      }
      if (interrupted) {
        expect(interrupted.hits).toBe(2);
        expect(await t.backend.store.providerStore(account.id).locations!.of([original.id])).toEqual([]);
      } else expect(await t.backend.store.providerStore(account.id).locations!.of([original.id])).toEqual([expect.objectContaining(expected)]);
      expect((await t.client.call("threads.get", { threadId: original.thread_id })).messages[0]).toMatchObject({ id: original.id, bodyText: "Exact genuine body\n" });
      const { backend, client } = await reopen(t);
      expect(await client.call("ops.list", {})).toEqual([queued]);
      if (interrupted) await backend.syncAccount(account.id);
      expect(await backend.store.providerStore(account.id).locations!.of([original.id])).toEqual([expect.objectContaining(expected)]);
      const sourceBefore = witness(ctl, "Work"), otherBefore = witness(ctl, "Archive"), trashBefore = witness(ctl, "Trash");
      const commands = mutations(t.imap.server);
      await backend.runWorker();
      expect(await client.call("ops.list", {})).toEqual([expect.objectContaining({ id: queued!.id, state: "succeeded", attempts: 1, lastError: null })]);
      expect(commands).toEqual([{ command: "UID MOVE", mailbox: path, line: expect.stringMatching(new RegExp(` UID MOVE ${uid} Trash$`)) }]);
      const trash = witness(ctl, "Trash");
      expect(trash.uidvalidity).toBe(trashBefore.uidvalidity);
      expect(trash.messages).toEqual([{ uid: ctl.getMailbox("Trash").uidnext - 1, raw: bytes, flags: [] }]);
      expect(witness(ctl, "Work")).toEqual({ ...sourceBefore, messages: sourceBefore.messages.filter((m) => path !== "Work" || m.uid !== uid) });
      expect(witness(ctl, "Archive")).toEqual({ ...otherBefore, messages: otherBefore.messages.filter((m) => path !== "Archive" || m.uid !== uid) });
      expect(await backend.store.providerStore(account.id).locations!.of([original.id])).toEqual([expect.objectContaining({ mailbox: "Trash", uidvalidity: trash.uidvalidity, uid: trash.messages[0]!.uid })]);
      expect((await client.call("threads.get", { threadId: original.thread_id })).messages[0]).toMatchObject({ id: original.id, bodyText: "Exact genuine body\n" });
      await backend.runWorker();
      expect(commands).toHaveLength(1);
    });
  });

  it("refuses to log in over plaintext when the server doesn't offer STARTTLS", async () => {
    const imap = await startImap();
    const { createRegistry: strictRegistry } = await import("@terno/mail");
    const registry = strictRegistry(); // production: allowInsecure off
    await expect(
      registry.verifyImap(
        { imap: { host: "127.0.0.1", port: imap.port, secure: false, user: "testuser" }, smtp: { host: "127.0.0.1", port: 1, secure: false, user: "testuser" }, senderName: "x", appendToSent: true },
        "testpass",
      ),
    ).rejects.toThrow();
    expect(imap.server.control.sessions().filter((s: { state: string }) => s.state !== "Not Authenticated")).toEqual([]);
  });
});

describe("sending through SMTP", () => {
  it.each([
    { append: false, partial: true, fault: "rollback" }, { append: true, partial: true, fault: "rollback" },
    { append: false, partial: false, fault: "rollback" }, { append: true, partial: false, fault: "rollback" },
    { append: false, partial: true, fault: "normalizer" }, { append: true, partial: true, fault: "normalizer" },
    { append: false, partial: true, fault: "committed rejection" }, { append: true, partial: true, fault: "committed rejection" },
  ] as const)("proven SMTP acceptance fences public retry after reopen: %j", async ({ append, partial, fault }) => {
    const t = await setup({ smtp: { rejectRcpt: "nadie@example.com", tempFailRcpt: "luego@example.com" } });
    const account = await t.addAccount(t.imap.port);
    if (!append) {
      await t.backend.dropAccount(account.id);
      await t.backend.store.accounts.setProviderConfig(account.id, { ...(await t.backend.store.accounts.config<Record<string, unknown>>(account.id))!.config, appendToSent: false });
      await t.backend.signedIn(account.id);
    }
    let normalizations = 0;
    const create = nodemailer.createTransport.bind(nodemailer);
    const factory = fault === "normalizer" ? vi.spyOn(nodemailer, "createTransport").mockImplementation((...args: Parameters<typeof nodemailer.createTransport>) => {
      const transport = create(...args), send = transport.sendMail.bind(transport);
      transport.sendMail = (async (input: Parameters<typeof send>[0]) => {
        const result = await send(input); normalizations++;
        return Object.defineProperty(result, "rejected", { get() { throw new Error("Synthetic post-acceptance normalization failed"); } });
      }) as typeof transport.sendMail;
      return transport;
    }) : null;
    let opId = "", faults = 0;
    const db = sqlDb(t.backend.store);
    const inject = () => {
      if (faults || !opId || db.get<{ state: string }>("SELECT state FROM ops WHERE id=?", opId)?.state !== "succeeded") return;
      faults++; throw new Error("Synthetic native completion acknowledgement failed");
    };
    if (fault === "committed rejection") db.onCommit(inject); else db.onBeforeCommit(inject);
    try {
      ({ opId } = await t.client.call("compose.send", { accountId: account.id, to: [{ name: "", email: "ana@example.com" }, ...(partial ? [{ name: "", email: "nadie@example.com" }] : [])], cc: partial ? [{ name: "", email: "luego@example.com" }] : [], bcc: [{ name: "", email: "hidden@example.com" }], subject: "Proven acceptance", bodyText: "Original synthetic bytes" }));
      await t.backend.runWorker();
    } finally { factory?.mockRestore(); }
    expect(faults).toBe(1); expect(normalizations).toBe(fault === "normalizer" ? 1 : 0);
    expect(t.smtp.received).toHaveLength(1); expect(t.smtp.received[0]!.rcpt).toEqual(["ana@example.com", "hidden@example.com"]);
    expect(t.smtp.received[0]!.raw).not.toMatch(/^Bcc:/mi);
    const copies = t.imap.server.control.listMessages("Sent", { raw: true }) as { raw: Buffer }[];
    expect(copies).toHaveLength(append ? 1 : 0);
    if (append) {
      expect(copies[0]!.raw.toString()).toBe(t.smtp.received[0]!.raw);
      while (await t.backend.store.sendCopies.forgetSlice(opId)) { /* Store retirement is independent of public cleanup availability. */ }
    }
    await t.backend.dropAccount(account.id);
    await t.backend.store.accounts.setProviderConfig(account.id, { ...(await t.backend.store.accounts.config<Record<string, unknown>>(account.id))!.config, appendToSent: !append });
    await t.stop();
    const reopened = new Backend({ dbPath: join(t.dir, "u.db"), version: "t", cipher: plaintextCipher, providers: createRegistry({ imap: { allowInsecure: true } }), autoSync: false }); cleanups.push(() => reopened.stop()); await reopened.ready;
    const [c, server] = createMemoryTransportPair(); reopened.connect(server, { clientId: "acceptance", origin: "renderer" }); const rpc = new RpcClient(c); cleanups.push(() => rpc.close());
    const retried = await rpc.call("ops.resolveUnknown", { opId, resolution: "retry" }).then(() => true, () => false);
    await reopened.runWorker();
    expect(t.smtp.received).toHaveLength(1); expect(retried).toBe(false);
    const op = (await reopened.store.ops.get(opId))!;
    expect(JSON.parse(op.target_json).submissionAccepted).toBe(true);
    expect(op.state).toBe(fault === "committed rejection" ? "succeeded" : "unknown");
    if (op.state === "unknown") await expect(rpc.call("ops.resolveUnknown", { opId, resolution: "retry" })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("accepted for submission") });
    sqlDb(reopened.store).run("UPDATE ops SET state='queued', next_attempt_at=0 WHERE id=?", opId);
    await reopened.runWorker();
    expect(t.smtp.received).toHaveLength(1);
    expect((await reopened.store.ops.get(opId))?.state).toBe("unknown");
  });

  it("rechecks proven acceptance after yielding MIME preparation before creating an SMTP transport", async () => {
    const t = await setup(); const account = await t.addAccount(t.imap.port);
    await t.backend.dropAccount(account.id);
    await t.backend.store.accounts.setProviderConfig(account.id, { ...(await t.backend.store.accounts.config<Record<string, unknown>>(account.id))!.config, appendToSent: false });
    await t.backend.signedIn(account.id);
    let arrive = () => {}, release = () => {}, held = false;
    const reached = new Promise<void>((r) => { arrive = r; }), resumed = new Promise<void>((r) => { release = r; });
    vi.stubGlobal("scheduler", { yield: async () => { if (!held) { held = true; arrive(); await resumed; } } });
    const transport = vi.spyOn(nodemailer, "createTransport");
    const { opId } = await t.client.call("compose.send", { accountId: account.id, to: [{ name: "", email: "ana@example.com" }], subject: "Late proof", bodyText: "Synthetic" });
    const worker = t.backend.runWorker();
    try {
      await reached;
      const op = (await t.backend.store.ops.get(opId))!;
      sqlDb(t.backend.store).run("UPDATE ops SET target_json=? WHERE id=?", JSON.stringify({ ...JSON.parse(op.target_json), submissionAccepted: true }), opId);
    } finally { release(); await worker; vi.unstubAllGlobals(); }
    expect(transport).not.toHaveBeenCalled(); transport.mockRestore();
    expect(t.smtp.received).toHaveLength(0);
    expect((await t.backend.store.ops.get(opId))?.state).toBe("unknown");
  });

  it("receipt retirement between proof reads cannot open a stale legacy send's transport", async () => {
    const t = await setup(); const account = await t.addAccount(t.imap.port);
    // Queue directly so the worker cannot claim until the legacy receipt is seeded.
    const { opId } = await t.backend.store.compose.queueSend({ accountId: account.id, to: [{ name: "", email: "ana@example.com" }], cc: [], bcc: [], subject: "Legacy proof", bodyText: "Synthetic", recordReply: false, now: Date.now() });
    await t.backend.store.sendCopies.startWire(opId, 1); await t.backend.store.sendCopies.appendWire(opId, 0, "YQ=="); await t.backend.store.sendCopies.sealWire(opId);
    await t.backend.store.sendCopies.accepted(opId, null); await t.backend.store.sendCopies.record(opId, "saved");
    const op = (await t.backend.store.ops.get(opId))!, legacy = JSON.parse(op.target_json); delete legacy.submissionAccepted;
    sqlDb(t.backend.store).run("UPDATE ops SET target_json=? WHERE id=?", JSON.stringify(legacy), opId);
    const get = t.backend.store.sendCopies.get.bind(t.backend.store.sendCopies);
    let retired = false;
    const proof = vi.spyOn(t.backend.store.sendCopies, "get").mockImplementation(async (id) => {
      if (!retired && id === opId) { retired = true; while (await t.backend.store.sendCopies.forgetSlice(id)) { /* atomic transfer before deletion */ } }
      return get(id);
    });
    const transport = vi.spyOn(nodemailer, "createTransport");
    try { await t.backend.runWorker(); } finally { proof.mockRestore(); }
    expect(retired).toBe(true); expect(transport).not.toHaveBeenCalled(); transport.mockRestore();
    expect(t.smtp.received).toHaveLength(0);
    expect(JSON.parse((await t.backend.store.ops.get(opId))!.target_json).submissionAccepted).toBe(true);
    expect((await t.backend.store.ops.get(opId))?.state).toBe("unknown");
  });

  it("a temporary pre-DATA refusal remains safely retryable and later submits once", async () => {
    const refusal: { tempFailRcpt?: string } = { tempFailRcpt: "ana@example.com" };
    const t = await setup({ smtp: refusal }); const account = await t.addAccount(t.imap.port);
    const { opId } = await t.client.call("compose.send", { accountId: account.id, to: [{ name: "", email: "ana@example.com" }], subject: "Safe retry", bodyText: "Synthetic" });
    await t.backend.runWorker();
    const before = (await t.backend.store.ops.get(opId))!;
    expect(before.state).toBe("queued"); expect(JSON.parse(before.target_json).submissionAccepted).toBeUndefined();
    expect(t.smtp.received).toHaveLength(0);
    delete refusal.tempFailRcpt;
    sqlDb(t.backend.store).run("UPDATE ops SET next_attempt_at=0 WHERE id=?", opId);
    await t.backend.runWorker();
    expect(t.smtp.received).toHaveLength(1); expect(t.smtp.received[0]!.rcpt).toEqual(["ana@example.com"]);
    expect((await t.backend.store.ops.get(opId))?.state).toBe("succeeded");
    expect(JSON.parse((await t.backend.store.ops.get(opId))!.target_json).submissionAccepted).toBe(true);
  });

  it.each(["rejected", "lost acknowledgement", "lost before application"] as const)("durably repairs a %s Sent APPEND without a second SMTP submission", async (fault) => {
    const t = await setup({ smtp: { rejectRcpt: "nadie@example.com" } });
    const account = await t.addAccount(t.imap.port);
    const rule = t.imap.server.script.add(fault === "rejected"
      ? { on: "command", command: "APPEND", times: 1, send: "$TAG NO [OVERQUOTA] Synthetic quota\r\n" }
      : fault === "lost acknowledgement" ? { on: "response", command: "APPEND", untagged: false, times: 1, drop: true, close: "reset" }
      : { on: "command", command: "APPEND", times: 1, drop: true, close: "reset" });
    const { opId } = await t.client.call("compose.send", { accountId: account.id, to: [{ name: "", email: "ana@example.com" }, { name: "", email: "nadie@example.com" }], subject: "One submission", bodyText: "Original immutable bytes" });
    await t.backend.runWorker();
    expect(rule!.hits).toBe(1);
    expect(t.smtp.received).toHaveLength(1);
    const before = await t.backend.store.sendCopies.get(opId);
    expect(before).toMatchObject({ submission: "accepted", copy: fault === "rejected" ? "rejected" : "unknown", ready: true, mailbox: "Sent" });
    expect((await t.client.call("ops.list", {})).find((o) => o.id === opId)).toMatchObject({ state: "succeeded", partialRecipients: true, lastErrorI18n: { key: fault === "rejected" ? "errors.sentCopy.partialMissing" : "errors.sentCopy.partialUnknown", params: { recipients: "nadie@example.com" } } });
    const firstCopies = t.imap.server.control.listMessages("Sent", { raw: true }) as { uid: number; raw: Buffer }[];
    expect(firstCopies).toHaveLength(fault === "lost acknowledgement" ? 1 : 0);
    if (fault === "lost acknowledgement") expect(firstCopies[0]!.raw.toString()).toBe(t.smtp.received[0]!.raw);
    await t.stop();
    const reopened = new Backend({ dbPath: join(t.dir, "u.db"), version: "t", cipher: plaintextCipher, providers: createRegistry({ imap: { allowInsecure: true } }), autoSync: false });
    cleanups.push(() => reopened.stop());
    const [c, server] = createMemoryTransportPair(); reopened.connect(server, { clientId: "repair", origin: "renderer" }); const rpc = new RpcClient(c);
    expect(await reopened.store.sendCopies.get(opId)).toEqual(before);
    await rpc.call("ops.repairSentCopy", { opId });
    const after = await reopened.store.sendCopies.get(opId);
    expect(after).toMatchObject({ submission: "accepted", copy: "saved", mailbox: "Sent", uid: expect.any(Number), uidValidity: expect.any(String), chunks: 1 });
    expect(await reopened.store.sendCopies.readWire(opId, 0)).not.toBeNull();
    const copies = t.imap.server.control.listMessages("Sent", { raw: true }) as { uid: number; raw: Buffer }[];
    expect(copies).toHaveLength(1);
    expect(copies[0]!.raw.toString()).toBe(t.smtp.received[0]!.raw);
    if (fault === "lost acknowledgement") expect(copies[0]!.uid).toBe(firstCopies[0]!.uid);
    expect(t.smtp.received).toHaveLength(1);
    expect((await rpc.call("ops.list", {})).find((o) => o.id === opId)).toMatchObject({ state: "succeeded", lastErrorI18n: { key: "errors.smtp.notDeliveredTo", params: { recipients: "nadie@example.com" } } });
    await expect(rpc.call("ops.repairSentCopy", { opId })).rejects.toThrow();
    await reopened.runWorker();
    expect(t.smtp.received).toHaveLength(1);
  });

  it("a failed acceptance write falls back to atomic completion, without SMTP replay or an invented Sent copy", async () => {
    const t = await setup(); const account = await t.addAccount(t.imap.port);
    const failure = vi.spyOn(t.backend.store.sendCopies, "accepted").mockRejectedValueOnce(new Error("Synthetic write refused"));
    const { opId } = await t.client.call("compose.send", { accountId: account.id, to: [{ name: "", email: "ana@example.com" }], subject: "Once", bodyText: "Synthetic" });
    await t.backend.runWorker(); failure.mockRestore();
    expect(t.smtp.received).toHaveLength(1);
    expect(t.imap.server.control.listMessages("Sent")).toHaveLength(0);
    expect(await t.backend.store.sendCopies.get(opId)).toMatchObject({ submission: "accepted", copy: "pending", ready: true });
    await t.client.call("ops.repairSentCopy", { opId });
    expect(t.imap.server.control.listMessages("Sent")).toHaveLength(1);
    expect(t.smtp.received).toHaveLength(1);
  });

  it("wire cleanup failure cannot change a completed SMTP submission to unknown", async () => {
    const t = await setup(); const account = await t.addAccount(t.imap.port);
    const failure = vi.spyOn(t.backend.store.sendCopies, "pruneSavedSlice").mockRejectedValueOnce(new Error("Synthetic cleanup refused"));
    const { opId } = await t.client.call("compose.send", { accountId: account.id, to: [{ name: "", email: "ana@example.com" }], subject: "Once", bodyText: "Synthetic" });
    await t.backend.runWorker(); failure.mockRestore();
    expect((await t.backend.store.ops.get(opId))?.state).toBe("succeeded");
    expect(await t.backend.store.sendCopies.get(opId)).toMatchObject({ submission: "accepted", copy: "saved" });
    expect(t.smtp.received).toHaveLength(1);
    expect(t.imap.server.control.listMessages("Sent")).toHaveLength(1);
    await t.backend.runWorker(); expect(t.smtp.received).toHaveLength(1);
  });

  it("failed acceptance and completion writes retain acceptance in failure recording", async () => {
    const t = await setup(); const account = await t.addAccount(t.imap.port);
    const accept = vi.spyOn(t.backend.store.sendCopies, "accepted").mockRejectedValueOnce(new Error("Synthetic acceptance write refused"));
    const complete = vi.spyOn(t.backend.store.ops, "complete").mockRejectedValueOnce(new Error("Synthetic completion write refused"));
    const { opId } = await t.client.call("compose.send", { accountId: account.id, to: [{ name: "", email: "ana@example.com" }], subject: "Once", bodyText: "Synthetic" });
    await t.backend.runWorker(); accept.mockRestore(); complete.mockRestore();
    expect(t.smtp.received).toHaveLength(1); expect(t.imap.server.control.listMessages("Sent")).toHaveLength(0);
    await t.stop();
    const reopened = new Backend({ dbPath: join(t.dir, "u.db"), version: "t", cipher: plaintextCipher, providers: createRegistry({ imap: { allowInsecure: true } }), autoSync: false }); cleanups.push(() => reopened.stop());
    await reopened.ready;
    expect(await reopened.store.sendCopies.get(opId)).toMatchObject({ submission: "accepted", copy: "pending" });
    await expect(reopened.store.ops.resolveUnknown(opId, "retry", Date.now())).rejects.toThrow();
    await reopened.repairSentCopy(opId);
    expect(t.imap.server.control.listMessages("Sent")).toHaveLength(1); expect(t.smtp.received).toHaveLength(1);
  });

  it.each(["search refused", "duplicate identity", "different bytes"] as const)("failed reconciliation becomes unknown: %s", async (fault) => {
    const t = await setup(); const account = await t.addAccount(t.imap.port);
    t.imap.server.script.add({ on: "command", command: "APPEND", times: 1, send: "$TAG NO [OVERQUOTA] Synthetic quota\r\n" });
    const { opId } = await t.client.call("compose.send", { accountId: account.id, to: [{ name: "", email: "ana@example.com" }], subject: "Once", bodyText: "Synthetic" }); await t.backend.runWorker();
    if (fault === "search refused") t.imap.server.script.add({ on: "command", command: "UID SEARCH", times: 1, send: "$TAG NO [UNAVAILABLE] Synthetic search failure\r\n" });
    else {
      t.imap.server.control.addMessage("Sent", { raw: fault === "different bytes" ? t.smtp.received[0]!.raw.replace("Synthetic", "Different") : t.smtp.received[0]!.raw });
      if (fault === "duplicate identity") t.imap.server.control.addMessage("Sent", { raw: t.smtp.received[0]!.raw });
    }
    const copies = t.imap.server.control.listMessages("Sent").length;
    await expect(t.client.call("ops.repairSentCopy", { opId })).rejects.toThrow();
    expect(t.smtp.received).toHaveLength(1); expect(t.imap.server.control.listMessages("Sent")).toHaveLength(copies);
    await t.stop();
    const reopened = new Backend({ dbPath: join(t.dir, "u.db"), version: "t", cipher: plaintextCipher, providers: createRegistry({ imap: { allowInsecure: true } }), autoSync: false }); cleanups.push(() => reopened.stop()); await reopened.ready;
    expect(await reopened.store.sendCopies.get(opId)).toMatchObject({ submission: "accepted", copy: "unknown" });
  });

  it("partial SMTP submission records which recipients were rejected", async () => {
    const { imap, backend, client, addAccount } = await setup({ smtp: { rejectRcpt: "nadie@example.com" } });
    const account = await addAccount(imap.port);
    const { opId } = await client.call("compose.send", { accountId: account.id, to: [{ name: "", email: "ana@example.com" }, { name: "", email: "nadie@example.com" }], subject: "x", bodyText: "y" });
    await backend.runWorker();
    expect(sqlDb(backend.store).get("SELECT state FROM ops WHERE id = ?", opId)).toEqual({ state: "succeeded" });
    // kept as a catalog message: the renderer says it in the user's language
    expect((await client.call("ops.list", {})).find((o) => o.id === opId)).toMatchObject({
      lastError: "Mail server refused: nadie@example.com",
      lastErrorI18n: { key: "errors.smtp.notDeliveredTo", params: { recipients: "nadie@example.com" } },
      summary: "Send “x”",
      summaryI18n: { key: "backend.op.send", params: { subject: "x" } },
    });
  });

  it("a temporary 450 rejection is retried, not failed", async () => {
    const { imap, backend, client, addAccount } = await setup({ smtp: { tempFailRcpt: "luego@example.com" } });
    const account = await addAccount(imap.port);
    const { opId } = await client.call("compose.send", { accountId: account.id, to: [{ name: "", email: "luego@example.com" }], subject: "x", bodyText: "y" });
    await backend.runWorker();
    expect(sqlDb(backend.store).get("SELECT state FROM ops WHERE id = ?", opId)).toEqual({ state: "queued" });
  });

  it("sends a threaded reply, saves it to Sent, and adopts the server copy without duplicating", async () => {
    const { imap, smtp, backend, client, addAccount } = await setup();
    imap.server.control.addMessage("INBOX", { raw: raw({ subject: "Propuesta", id: "orig@example.com" }) });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const [t] = (await client.call("threads.list", { view: "inbox" })).items;
    const original = (await client.call("threads.get", { threadId: t!.id })).messages[0]!;
    await client.call("compose.send", {
      accountId: account.id,
      to: [{ name: "Ana", email: "ana@example.com" }],
      bcc: [{ name: "", email: "secreto@example.com" }],
      subject: "Re: Propuesta",
      bodyText: "¡Me encanta! Avancemos.",
      inReplyToMessageId: original.id,
    });
    await backend.runWorker();
    expect(smtp.received).toHaveLength(1);
    const sent = smtp.received[0]!;
    expect(sent.raw).toMatch(/In-Reply-To: <orig@example\.com>/);
    expect(sent.raw).toMatch(/References: <orig@example\.com>/);
    expect(sent.raw).not.toMatch(/^Bcc:/m);
    expect(sent.rcpt.sort()).toEqual(["ana@example.com", "secreto@example.com"]);
    expect(imap.server.control.listMessages("Sent")).toHaveLength(1);

    await backend.syncAccount(account.id);
    expect(count(backend, "SELECT 1 FROM messages WHERE is_sent = 1")).toBe(1);
    expect((await client.call("threads.get", { threadId: t!.id })).messages.map((m) => m.isSent)).toEqual([false, true]);
  });

  it("plan 16: a rich message goes out as multipart/alternative over SMTP, and the copy saved to Sent carries the same HTML", async () => {
    const { imap, smtp, backend, client, addAccount } = await setup();
    const account = await addAccount(imap.port);
    const html = '<!DOCTYPE html><html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head><body><div>Hola <b>Ana</b></div></body></html>';
    await client.call("compose.send", { accountId: account.id, to: [{ name: "Ana", email: "ana@example.com" }], subject: "Rico", bodyText: "Hola Ana", bodyHtml: html });
    await backend.runWorker();
    expect(smtp.received).toHaveLength(1);
    const sent = smtp.received[0]!.raw;
    expect(sent).toMatch(/^Content-Type: multipart\/alternative;/m);
    const { parseRaw } = await import("@terno/mail");
    const parsed = await parseRaw(sent);
    expect(parsed.html?.trim()).toBe(html);
    expect(parsed.text?.trim()).toBe("Hola Ana");
    const [copy] = imap.server.control.listMessages("Sent", { raw: true }) as { raw?: Buffer }[];
    const saved = await parseRaw(copy!.raw!);
    expect(saved.html?.trim()).toBe(html);
  });

  it("attachments arrive offline through IMAP and forward exact binary/empty bytes through SMTP and Sent APPEND", async () => {
    const { imap, smtp, backend, client, addAccount } = await setup();
    const { buildRaw, parseRaw } = await import("@terno/mail");
    const binary = new Uint8Array([0,255,128,13,10,46]);
    const source = await buildRaw({ from: { name: "Source", email: "source@test.com" }, to: [{ name: "Me", email: "me@test.com" }], cc: [], bcc: [], text: "files", subject: "Binary attachment source", messageId: "attachment-source@test.com", inReplyTo: null, references: [], providerThreadId: null,
      attachments: [{ assetId: crypto.randomUUID(), filename: "same.bin", mime: "application/octet-stream", size: 6, dataBase64: Buffer.from(binary).toString("base64") }, { assetId: crypto.randomUUID(), filename: "same.bin", mime: "text/plain", size: 0, dataBase64: "" }],
    });
    imap.server.control.addMessage("INBOX", { raw: source });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const thread = sqlDb(backend.store).get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE subject = 'Binary attachment source'")!.thread_id;
    const message = (await client.call("threads.get", { threadId: thread })).messages[0]!;
    expect(message.attachments).toHaveLength(2);
    const attachments = message.attachments.map((a) => ({ assetId: a.assetId!, filename: a.filename, mime: a.mime, size: a.size, contentId: a.contentId ?? null }));
    expect(await backend.store.attachments.read(account.id, attachments[0]!.assetId, 0)).toBe(Buffer.from(binary).toString("base64"));
    const draft = (await client.call("drafts.save", { accountId: account.id, to: [{ name: "", email: "forward@test.com" }], subject: "Fwd: bytes", bodyText: "forwarded", attachments }))!;
    await client.call("compose.send", { accountId: account.id, to: [{ name: "", email: "forward@test.com" }], subject: "Fwd: bytes", bodyText: "forwarded", attachments, draftId: draft.id, draftGeneration: draft.generation, draftRevision: draft.revision });
    await backend.runWorker();
    expect(smtp.received).toHaveLength(1);
    const transmitted = await parseRaw(smtp.received[0]!.raw);
    expect(transmitted.attachments.map((a) => [...a.bytes!])).toEqual([[...binary], []]);
    const copies = imap.server.control.listMessages("Sent", { raw: true }) as { raw: Buffer }[];
    expect(copies).toHaveLength(1);
    expect((await parseRaw(copies[0]!.raw)).attachments.map((a) => [...a.bytes!])).toEqual([[...binary], []]);
  });

  it("a rejected recipient fails permanently (no retries)", async () => {
    const { imap, backend, client, addAccount } = await setup({ smtp: { rejectRcpt: "nadie@example.com" } });
    const account = await addAccount(imap.port);
    const { opId } = await client.call("compose.send", { accountId: account.id, to: [{ name: "", email: "nadie@example.com" }], subject: "x", bodyText: "y" });
    await backend.runWorker();
    expect(sqlDb(backend.store).get("SELECT state FROM ops WHERE id = ?", opId)).toEqual({ state: "failed" });
  });

  it("a connection lost after DATA is reported as unknown and never resent", async () => {
    const { imap, backend, client, addAccount } = await setup({ smtp: { dropDuringData: true } });
    const account = await addAccount(imap.port);
    const { opId } = await client.call("compose.send", { accountId: account.id, to: [{ name: "", email: "ana@example.com" }], subject: "x", bodyText: "y" });
    await backend.runWorker();
    expect(sqlDb(backend.store).get("SELECT state FROM ops WHERE id = ?", opId)).toEqual({ state: "unknown" });
  });
});

it.each([false, true])("preserves the queued Sent-copy choice when configuration changes before SMTP (requested=%s)", async (requested) => {
  const t = await setup(); const account = await t.addAccount(t.imap.port);
  const config = (await t.backend.store.accounts.config<Record<string, unknown>>(account.id))!;
  await t.backend.store.accounts.setProviderConfig(account.id, { ...config, appendToSent: requested });
  const queued = await t.backend.store.compose.queueSend({ accountId: account.id, to: [{ name: "", email: "recipient@example.com" }], cc: [], bcc: [], subject: "Captured choice", bodyText: "Synthetic", recordReply: false, now: Date.now() });
  await t.backend.store.accounts.setProviderConfig(account.id, { ...config, appendToSent: !requested });
  await t.backend.runWorker();
  expect(t.smtp.received).toHaveLength(1);
  expect(t.imap.server.control.listMessages("Sent")).toHaveLength(requested ? 1 : 0);
  expect((await t.backend.store.ops.get(queued.opId))?.state).toBe("succeeded");
});
