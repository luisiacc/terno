/**
 * Real imapflow ↔ in-process ImapKit (strict RFC server) and nodemailer ↔
 * in-process smtp-server, driven through the real Backend.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createRegistry } from "@terno/mail";
import imapkit from "imapkit";
import { SMTPServer } from "smtp-server";
import { afterEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { sqlDb } from "@terno/db";

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
  for (const c of cleanups.splice(0).reverse()) await c();
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
  cleanups.push(async () => {
    await backend.stop();
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
  return { imap, smtp, backend, client, addAccount };
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
    const { imap, backend, client, addAccount } = await setup({ imap: { plugins: ["IDLE", "SPECIAL-USE", "ENABLE", "CONDSTORE"] } });
    const ctl = imap.server.control;
    const targetRaw = raw({ subject: "Keep target", body: "Exact target body" });
    const otherRaw = raw({ subject: "Keep unrelated", body: "Exact unrelated body" });
    const target = ctl.addMessage("INBOX", { raw: targetRaw });
    const other = ctl.addMessage("INBOX", { raw: otherRaw });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const thread = (await client.call("threads.list", { view: "inbox" })).items.find((t) => t.subject === "Keep target")!;
    expect(thread).toBeDefined();
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
    await client.call("threads.act", { threadIds: [thread.id], action: "archive" });
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
    ctl.addMessage("All", { raw: targetRaw });
    const otherRaw = raw({ subject: "All Mail unrelated", body: "Exact unrelated body" });
    const other = ctl.addMessage("INBOX", { raw: otherRaw });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const thread = (await client.call("threads.list", { view: "inbox" })).items.find((t) => t.subject === "All Mail target")!;
    const message = (await client.call("threads.get", { threadId: thread.id })).messages[0]!;
    const locations = backend.store.providerStore(account.id).locations!;
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
    ctl.addMessage("All", { raw: targetRaw });
    const otherRaw = raw({ subject: "All Mail unrelated", body: "Exact unrelated body" });
    const other = ctl.addMessage("INBOX", { raw: otherRaw });
    const account = await addAccount(imap.port);
    await backend.syncAccount(account.id);
    const thread = (await client.call("threads.list", { view: "inbox" })).items.find((t) => t.subject === "All Mail target")!;
    const message = (await client.call("threads.get", { threadId: thread.id })).messages[0]!;
    const locations = backend.store.providerStore(account.id).locations!;
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
      { subject: "C", is_read: 0, is_starred: 0, in_inbox: 0 },
      { subject: "D", is_read: 0, is_starred: 0, in_inbox: 1 },
    ]);
    expect((await client.call("counts.get", {})).inboxUnread).toBe(1);
  });

  it("recovers from a UIDVALIDITY reset without duplicating mail", async () => {
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
    expect(after).toHaveLength(3);
    expect(after[0]!.uidvalidity).toBeGreaterThan(before[0]!.uidvalidity);
    expect(after.every((l) => l.uid > 100)).toBe(true);
    // ops still target the right message after the reset
    const thread = sqlDb(backend.store).get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE subject = 'dos'")!.thread_id;
    await backend.server.invoke("threads.act", { threadIds: [thread], action: "markRead" }, { clientId: "t", origin: "renderer" });
    await backend.runWorker();
    const dos = ctl.listMessages("INBOX").find((m: { uid: number }) => m.uid === after.find((_, i) => i === 1)!.uid) as { flags: string[] } | undefined;
    expect(dos?.flags ?? ctl.listMessages("INBOX").flatMap((m: { flags: string[] }) => m.flags)).toContain("\\Seen");
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

  it("keeps distinct ID-less messages with identical envelopes in different folders", async () => {
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

  it("ID-less twins in one mailbox stay bound to their own server copies across a reset", async () => {
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
    expect(count(backend, "SELECT DISTINCT uid FROM message_locations")).toBe(2);
    // trashing the row whose cached body is AAAA must move the server message AAAA
    const a = sqlDb(backend.store).get<{ thread_id: number }>("SELECT thread_id FROM messages JOIN message_bodies ON message_id = id WHERE body_text LIKE 'AAAA%'")!.thread_id;
    await client.call("threads.act", { threadIds: [a], action: "trash" });
    await backend.runWorker();
    const trashed = imap.server.control.listMessages("Trash", { raw: true }) as { raw: Buffer }[];
    expect(trashed.map((m) => m.raw.toString())).toEqual([expect.stringContaining("AAAA")]);
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
    expect(sqlDb(backend.store).all("SELECT rfc_message_id, substr(body_text, 1, 4) AS b FROM messages LEFT JOIN message_bodies ON message_id = id")).toEqual([{ rfc_message_id: "b@x", b: "BBBB" }]);
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
    expect(op).toMatchObject({ state: "queued", lastError: expect.stringContaining("UIDVALIDITY") });
    await backend.syncAccount(account.id); // remaps locations
    sqlDb(backend.store).run("UPDATE ops SET next_attempt_at = 0");
    await backend.runWorker();
    const trashed = ctl.listMessages("Trash", { raw: true }) as { raw: Buffer }[];
    expect(trashed).toHaveLength(1);
    expect(trashed[0]!.raw.toString()).toContain("Subject: uno");
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
  it("partial delivery succeeds but records which recipients were rejected", async () => {
    const { imap, backend, client, addAccount } = await setup({ smtp: { rejectRcpt: "nadie@example.com" } });
    const account = await addAccount(imap.port);
    const { opId } = await client.call("compose.send", { accountId: account.id, to: [{ name: "", email: "ana@example.com" }, { name: "", email: "nadie@example.com" }], subject: "x", bodyText: "y" });
    await backend.runWorker();
    expect(sqlDb(backend.store).get("SELECT state FROM ops WHERE id = ?", opId)).toEqual({ state: "succeeded" });
    // kept as a catalog message: the renderer says it in the user's language
    expect((await client.call("ops.list", {})).find((o) => o.id === opId)).toMatchObject({
      lastError: "Not delivered to: nadie@example.com",
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
