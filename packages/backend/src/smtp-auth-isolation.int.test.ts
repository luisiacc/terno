import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createRegistry, parseRaw } from "@terno/mail";
import imapkit from "imapkit";
import { SMTPServer } from "smtp-server";
import { afterEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { readCopyWire } from "./sent-copy";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  const results = await Promise.allSettled(cleanups.splice(0).reverse().map((close) => close()));
  const errors = results.filter((r) => r.status === "rejected").map((r) => r.reason);
  if (errors.length) throw new AggregateError(errors, "SMTP isolation fixture cleanup failed");
});

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Fixture shutdown timed out")), 4000);
    })]);
  } finally { clearTimeout(timer); }
}

function raw(subject: string) {
  return Buffer.from([
    "From: Synthetic sender <sender@example.test>", "To: Receiver <receiver@example.test>",
    `Subject: ${subject}`, `Message-ID: <${subject}@isolation.test>`,
    "Date: Thu, 29 Oct 2026 12:00:00 +0000", "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8", "", `Exact ${subject} body.`, ".Dot line", "",
  ].join("\r\n"));
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "terno-smtp-isolation-"));
  const imap = imapkit({
    plugins: ["IDLE", "MOVE", "UIDPLUS", "SPECIAL-USE", "ENABLE", "CONDSTORE"],
    storage: { INBOX: {}, "": { separator: "/", folders: { Sent: { "special-use": "\\Sent" }, Archive: { "special-use": "\\Archive" } } } },
  });
  const imapCommands: string[] = [];
  imap.script.add({ on: "command", run: true, when: (context) => {
    if (imapCommands.length >= 2000) throw new Error("Unbounded IMAP commands");
    imapCommands.push(context.command ?? "");
    return false;
  } });
  const smtpCommands: string[] = [];
  const auths: { generation: string; refused: boolean }[] = [];
  const received: { raw: Buffer; recipients: string[] }[] = [];
  let refuse = false, password = "testpass";
  let holdNext = false;
  let release = () => {};
  const noop = () => {};
  const smtp = new SMTPServer({
    disabledCommands: ["STARTTLS"], allowInsecureAuth: true, closeTimeout: 250,
    logger: { trace: noop, info: noop, warn: noop, error: noop, fatal: noop,
      debug(entry: { tnx?: string; command?: string }) {
        if (entry.tnx !== "command") return;
        if (smtpCommands.length >= 200) throw new Error("Unbounded SMTP commands");
        smtpCommands.push(entry.command ?? "");
      },
    },
    onAuth(auth, _session, callback) {
      const refused = refuse || auth.username !== "testuser" || auth.password !== password;
      auths.push({ generation: auth.password === "testpass" ? "initial" : "replacement", refused });
      const answer = () => callback(refused ? Object.assign(new Error("Synthetic AUTH refused"), { responseCode: 535 }) : null, refused ? undefined : { user: "testuser" });
      if (holdNext) { holdNext = false; release = answer; }
      else answer();
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 64 * 1024) stream.destroy(new Error("Fixture mail exceeds limit"));
        else chunks.push(chunk);
      });
      stream.on("error", callback);
      stream.on("end", () => {
        received.push({ raw: Buffer.concat(chunks), recipients: session.envelope.rcptTo.map((r) => r.address) });
        callback();
      });
    },
  });
  const sessions: { backend: Backend; client: RpcClient; stop(): Promise<void> }[] = [];
  let imapStarted = false, smtpStarted = false;
  cleanups.push(async () => {
    release();
    const errors: unknown[] = [];
    const attempt = async (close: () => Promise<unknown>) => { try { await bounded(close()); } catch (error) { errors.push(error); } };
    for (const session of sessions.toReversed()) await attempt(() => session.stop());
    if (smtpStarted) await attempt(async () => {
      await new Promise<void>((resolve) => smtp.close(resolve));
      await expect.poll(() => smtp.connections.size).toBe(0);
    });
    if (imapStarted) await attempt(async () => { await imap.stop(); expect(imap.control.sessions()).toEqual([]); });
    rmSync(dir, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, "Fixture resources did not close");
  });
  const imapPort = await imap.start(0, "127.0.0.1");
  imapStarted = true;
  await new Promise<void>((resolve, reject) => {
    smtp.once("error", reject);
    smtp.listen(0, "127.0.0.1", resolve);
  });
  smtpStarted = true;
  const smtpPort = (smtp.server.address() as { port: number }).port;
  function open() {
    const backend = new Backend({ dbPath: join(dir, "mail.db"), version: "test", cipher: plaintextCipher,
      providers: createRegistry({ imap: { allowInsecure: true } }), autoSync: false, iconTransport: null });
    const [c, s] = createMemoryTransportPair();
    const disconnect = backend.connect(s, { clientId: "isolation", origin: "renderer" });
    const client = new RpcClient(c);
    let stopped = false;
    const session = { backend, client, async stop() {
      if (stopped) return;
      client.close(); disconnect();
      await backend.stop();
      stopped = true;
    } };
    sessions.push(session);
    return session;
  }
  let session = open();
  const state = async (id: number) => (await session.client.call("app.bootstrap", {})).accounts.find((a) => a.id === id)?.syncState;
  const ops = () => session.client.call("ops.list", {});
  const send = (subject: string, accountId: number, bodyText = `Exact ${subject} send.\r\n.Dot line`) => session.client.call("compose.send", {
    accountId, to: [{ name: "Synthetic recipient", email: "recipient@example.test" }], subject, bodyText,
  });
  const add = async () => {
    const account = await session.client.call("accounts.addImap", {
      email: "receiver@example.test", displayName: "Receiver", password: "testpass",
      imap: { host: "127.0.0.1", port: imapPort, secure: false, user: "testuser" },
      smtp: { host: "127.0.0.1", port: smtpPort, secure: false, user: "testuser" },
    });
    await session.backend.syncAccount(account.id);
    await expect.poll(() => state(account.id)).toMatchObject({ status: "idle", authRequired: false });
    return account;
  };
  const reopen = async () => { await session.stop(); session = open(); await session.backend.ready; };
  return { imap, imapCommands, smtpCommands, auths, received, state, ops, send, add, reopen,
    get backend() { return session.backend; }, get client() { return session.client; },
    refuse() { refuse = true; },
    replacePassword() { refuse = false; password = "replacement-pass"; imap.control.updateUser("testuser", { password }); },
    holdRefusal() { refuse = true; holdNext = true; }, release() { const answer = release; release = noop; answer(); },
  };
}

async function parked(t: Awaited<ReturnType<typeof setup>>, ids: string[]) {
  const ops = await t.ops();
  for (const id of ids) expect(ops.find((op) => op.id === id)).toMatchObject({ state: "queued", attempts: 0, awaitingAuth: true });
}

async function sentExactly(t: Awaited<ReturnType<typeof setup>>, subjects: string[]) {
  expect(t.received).toHaveLength(subjects.length);
  const remote = t.imap.control.listMessages("Sent", { raw: true });
  expect(remote).toHaveLength(subjects.length);
  for (const [i, subject] of subjects.entries()) {
    const wire = t.received[i]!;
    const parsed = await parseRaw(wire.raw);
    expect(parsed.subject).toBe(subject);
    expect(parsed.text).toBe(`Exact ${subject} send.\n.Dot line\n`);
    expect(wire.recipients).toEqual(["recipient@example.test"]);
    const copies = remote.filter((m) => m.raw?.includes(Buffer.from(`Message-ID: <${parsed.rfcMessageId}>`)));
    expect(copies).toHaveLength(1);
    expect(copies[0]?.raw).toEqual(wire.raw);
  }
}

describe("S21: real SMTP authentication is isolated from receiving", () => {
  it("matched healthy SMTP submits once and preserves exact DATA in Sent", async () => {
    const t = await setup();
    const account = await t.add();
    expect(t.auths).toEqual([{ generation: "initial", refused: false }]);
    const { opId } = await t.send("healthy", account.id);
    await t.backend.runWorker();
    expect(await t.ops()).toEqual([expect.objectContaining({ id: opId, state: "succeeded", attempts: 1 })]);
    expect(t.smtpCommands.filter((c) => ["AUTH", "MAIL", "RCPT", "DATA"].includes(c))).toEqual(["AUTH", "AUTH", "MAIL", "RCPT", "DATA"]);
    expect(t.imapCommands).toContain("APPEND");
    await sentExactly(t, ["healthy"]);
    await t.backend.syncAccount(account.id);
    await t.backend.runWorker();
    expect(t.received).toHaveLength(1);
    await expect.poll(() => t.state(account.id)).toMatchObject({ status: "idle", authRequired: false, authScope: null });
  });

  it("LF input preserves identical SMTP DATA and Sent bytes", async () => {
    const t = await setup();
    const account = await t.add();
    const { opId } = await t.send("lf-wire", account.id, "Exact lf-wire send.\n.Dot line");
    await t.backend.runWorker();
    expect((await t.ops()).find((op) => op.id === opId)).toMatchObject({ state: "succeeded", attempts: 1 });
    expect(t.received).toHaveLength(1);
    const [copy] = t.imap.control.listMessages("Sent", { raw: true });
    expect(t.received[0]!.raw.toString()).toContain("Exact lf-wire send.\r\n.Dot line");
    expect(copy?.raw).toEqual(t.received[0]!.raw);
  });

  it("535 parks only sends while IDLE, body reads, flags and foreground receiving work across SQL reopen", async () => {
    const t = await setup();
    const account = await t.add();
    t.refuse();
    const first = await t.send("first-waiting", account.id);
    await t.backend.runWorker();
    await parked(t, [first.opId]);
    await expect.poll(() => t.state(account.id)).toMatchObject({ status: "idle", authRequired: true, authScope: "send" });
    expect(t.auths).toEqual([{ generation: "initial", refused: false }, { generation: "initial", refused: true }]);
    expect(t.smtpCommands.filter((c) => ["MAIL", "RCPT", "DATA"].includes(c))).toEqual([]);
    const prepared = Buffer.from(await readCopyWire(t.backend.store, first.opId, async () => {}, () => {}));
    await expect.poll(() => t.imapCommands.includes("IDLE")).toBe(true);
    const incoming = raw("after-refusal");
    const added = t.imap.control.addMessage("INBOX", { raw: incoming });
    // No explicit sync: this new body must arrive via the live watch.
    await expect.poll(async () => (await t.client.call("threads.list", { view: "inbox" })).items.map((thread) => thread.subject)).toContain("after-refusal");
    const [thread] = (await t.client.call("threads.list", { view: "inbox" })).items;
    const message = (await t.client.call("threads.get", { threadId: thread!.id })).messages[0]!;
    expect(message).toMatchObject({ bodyState: "full", bodyText: "Exact after-refusal body.\n.Dot line\n", isRead: false });
    expect(t.imap.control.getMessage("INBOX", added.uid).raw).toEqual(incoming);
    const second = await t.send("second-waiting", account.id);
    const commandStart = t.imapCommands.length;
    await t.client.call("threads.act", { threadIds: [thread!.id], action: "markRead" });
    await t.backend.runWorker();
    expect(t.imapCommands.slice(commandStart)).toContain("UID STORE");
    expect(t.imap.control.getMessage("INBOX", added.uid).flags).toContain("\\Seen");
    expect((await t.client.call("threads.get", { threadId: thread!.id })).messages[0]?.isRead).toBe(true);
    expect((await t.ops()).find((op) => op.kind === "markRead")).toMatchObject({ state: "succeeded" });
    await parked(t, [first.opId, second.opId]);
    for (let i = 0; i < 3; i++) { await t.backend.syncAccount(account.id); await t.backend.runWorker(); }
    expect(t.auths).toHaveLength(2);
    expect(t.received).toEqual([]);
    await expect.poll(() => t.state(account.id)).toMatchObject({ status: "idle", authRequired: true, authScope: "send", lastError: null });

    await t.reopen();
    await parked(t, [first.opId, second.opId]);
    expect(Buffer.from(await readCopyWire(t.backend.store, first.opId, async () => {}, () => {}))).toEqual(prepared);
    expect(await t.state(account.id)).toMatchObject({ authRequired: true, authScope: "send" });
    // autoSync:false does not start accounts on reopen: establish receiving before the public retry.
    await t.backend.syncAccount(account.id);
    const foreground = raw("foreground-after-reopen");
    const fresh = t.imap.control.addMessage("INBOX", { raw: foreground });
    const before = t.imapCommands.length;
    await t.client.call("sync.now", { accountId: account.id, reason: "user" });
    await expect.poll(async () => (await t.client.call("threads.list", { view: "inbox" })).items.map((thread) => thread.subject)).toContain("foreground-after-reopen");
    expect(t.imapCommands.length).toBeGreaterThan(before);
    await t.backend.syncAccount(account.id);
    const freshThread = (await t.client.call("threads.list", { view: "inbox" })).items.find((row) => row.subject === "foreground-after-reopen")!;
    expect((await t.client.call("threads.get", { threadId: freshThread.id })).messages[0]).toMatchObject({ bodyState: "full", bodyText: "Exact foreground-after-reopen body.\n.Dot line\n" });
    expect(t.imap.control.getMessage("INBOX", fresh.uid).raw).toEqual(foreground);
    await t.backend.runWorker();
    await parked(t, [first.opId, second.opId]);
    expect(t.auths).toHaveLength(2);
    await expect.poll(() => t.state(account.id)).toMatchObject({ status: "idle", authRequired: true, authScope: "send" });

    t.replacePassword();
    await t.client.call("accounts.reconnect", { id: account.id, password: "replacement-pass" });
    await t.backend.runWorker();
    for (const id of [first.opId, second.opId]) expect((await t.ops()).find((op) => op.id === id)).toMatchObject({ state: "succeeded", attempts: 1 });
    expect(t.received[0]?.raw).toEqual(prepared);
    await sentExactly(t, ["first-waiting", "second-waiting"]);
    expect(t.auths.map((a) => a.generation)).toEqual(["initial", "initial", "replacement", "replacement", "replacement"]);
    await t.backend.syncAccount(account.id);
    await t.backend.runWorker();
    await sentExactly(t, ["first-waiting", "second-waiting"]);
    await expect.poll(() => t.state(account.id)).toMatchObject({ status: "idle", authRequired: false, authScope: null });
  });

  it("a refused SMTP reconnect check preserves the old credential, scope and parked send", async () => {
    const t = await setup();
    const account = await t.add();
    t.refuse();
    const { opId } = await t.send("check-refusal", account.id);
    await t.backend.runWorker();
    await parked(t, [opId]);
    const secret = await t.backend.store.secrets.get(`account:${account.id}:password`);
    expect(secret).toBeInstanceOf(Uint8Array);
    const before = t.imapCommands.length;
    await expect(t.client.call("accounts.reconnect", { id: account.id, password: "testpass" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(t.imapCommands.slice(before)).toContain("LOGIN");
    expect(t.imapCommands.slice(before)).toContain("LOGOUT");
    expect(t.auths).toHaveLength(3);
    expect(t.auths.at(-1)?.refused).toBe(true);
    expect(await t.backend.store.secrets.get(`account:${account.id}:password`)).toEqual(secret);
    await t.backend.syncAccount(account.id);
    await t.backend.runWorker();
    await parked(t, [opId]);
    await expect.poll(() => t.state(account.id)).toMatchObject({ status: "idle", authRequired: true, authScope: "send" });
    expect(t.smtpCommands.filter((c) => ["MAIL", "RCPT", "DATA"].includes(c))).toEqual([]);
    expect(t.received).toEqual([]);
  });

  it("a fresh IMAP login refusal is receive-wide and holds non-send operations too", async () => {
    const t = await setup();
    t.imap.control.addMessage("INBOX", { raw: raw("read-refusal") });
    const account = await t.add();
    const [thread] = (await t.client.call("threads.list", { view: "inbox" })).items;
    await t.reopen();
    t.imap.control.updateUser("testuser", { password: "different-imap-password" });
    const before = t.imapCommands.length;
    await t.backend.syncAccount(account.id);
    expect(t.imapCommands.slice(before)).toContain("LOGIN");
    expect(await t.state(account.id)).toMatchObject({ status: "error", authRequired: true, authScope: null });
    await t.client.call("threads.act", { threadIds: [thread!.id], action: "markRead" });
    const { opId } = await t.send("read-auth-holds-send", account.id);
    const commands = t.imapCommands.length;
    await t.backend.runWorker();
    expect((await t.ops()).filter((op) => op.kind === "markRead")).toHaveLength(1);
    await parked(t, (await t.ops()).map((op) => op.id));
    expect((await t.ops()).find((op) => op.id === opId)).toBeDefined();
    expect(t.imapCommands).toHaveLength(commands);
    expect(t.auths).toHaveLength(1);
    expect(t.received).toEqual([]);
  });

  it.each(["replacement", "removal"] as const)("a late old SMTP 535 after %s cannot poison or revive the account", async (change) => {
    const t = await setup();
    const account = await t.add();
    t.holdRefusal();
    const { opId } = await t.send("late-refusal", account.id);
    const worker = t.backend.runWorker();
    await expect.poll(() => t.auths.length).toBe(2);
    expect((await t.ops()).find((op) => op.id === opId)).toMatchObject({ state: "running" });
    if (change === "replacement") {
      t.replacePassword();
      await t.client.call("accounts.reconnect", { id: account.id, password: "replacement-pass" });
      expect(await t.state(account.id)).toMatchObject({ authRequired: false, authScope: null });
    } else {
      await t.client.call("accounts.remove", { id: account.id });
      expect(await t.state(account.id)).toBeUndefined();
    }
    t.release();
    await worker;
    await t.backend.runWorker();
    if (change === "replacement") {
      expect(await t.state(account.id)).toMatchObject({ authRequired: false, authScope: null });
      expect((await t.ops()).find((op) => op.id === opId)).toMatchObject({ state: "succeeded", attempts: 1 });
      expect(t.auths).toEqual([
        { generation: "initial", refused: false }, { generation: "initial", refused: true },
        { generation: "replacement", refused: false }, { generation: "replacement", refused: false },
      ]);
      await sentExactly(t, ["late-refusal"]);
      t.imap.control.addMessage("INBOX", { raw: raw("new-generation") });
      await t.backend.syncAccount(account.id);
      expect((await t.client.call("threads.list", { view: "inbox" })).items.map((thread) => thread.subject)).toContain("new-generation");
      await expect.poll(() => t.state(account.id)).toMatchObject({ status: "idle", authRequired: false, authScope: null });
    } else {
      expect(await t.state(account.id)).toBeUndefined();
      expect(await t.ops()).toEqual([]);
      expect(t.auths).toHaveLength(2);
      expect(t.received).toEqual([]);
      expect(t.imap.control.listMessages("Sent")).toEqual([]);
    }
    await t.backend.runWorker();
    expect(t.received).toHaveLength(change === "replacement" ? 1 : 0);
  });
});
