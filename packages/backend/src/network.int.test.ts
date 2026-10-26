/**
 * Plan 20 end to end: the real Backend, real imapflow ↔ in-process ImapKit and nodemailer ↔
 * smtp-server, with a TCP proxy in between that breaks the way networks break (test/net-proxy.ts).
 * A "VPN switch" is the proxy black-holing every open connection while new ones go through.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createImapProvider, createRegistry, type ImapTimeouts, type ProviderContext } from "@terno/mail";
import { sqlDb } from "@terno/db";
import imapkit from "imapkit";
import { SMTPServer } from "smtp-server";
import { afterEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { startNetProxy } from "./test/net-proxy";

const STORAGE = {
  INBOX: {},
  "": { separator: "/", folders: { Sent: { "special-use": "\\Sent" }, Archive: { "special-use": "\\Archive" }, Junk: { "special-use": "\\Junk" }, Trash: { "special-use": "\\Trash" } } },
};

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

let seq = 0;
const raw = (subject: string) =>
  [`From: Ana <ana@example.com>`, `To: Luis <luis@test.local>`, `Subject: ${subject}`, `Message-ID: <n${++seq}-${Date.now()}@test.local>`, `Date: ${new Date().toUTCString()}`, "Content-Type: text/plain; charset=utf-8", "", "hola", ""].join("\r\n");

async function startImap() {
  const server = imapkit({ plugins: ["IDLE", "MOVE", "UIDPLUS", "SPECIAL-USE", "ENABLE", "CONDSTORE"], storage: structuredClone(STORAGE) });
  const port = await server.start(0, "127.0.0.1");
  cleanups.push(() => server.stop());
  return { server, port };
}

/** smtp-server that keeps what it receives; `hold` delays the answer to DATA, `afterData` runs once the message is in */
async function startSmtp(o: { holdMs?: number; afterData?: () => void } = {}) {
  const received: string[] = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS"],
    logger: false,
    onAuth: (_a, _s, cb) => cb(null, { user: "t" }),
    onData(stream, _session, cb) {
      let data = "";
      stream.on("data", (c) => (data += c));
      stream.on("end", () => {
        received.push(data);
        o.afterData?.();
        setTimeout(() => cb(), o.holdMs ?? 0);
      });
    },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return { received, port: (server.server.address() as { port: number }).port };
}

const FAST: Partial<ImapTimeouts> = { connectMs: 3000, socketMs: 2000, heartbeatMs: 1000, quietMs: 500, reconnectMs: 100, reconnectMaxMs: 1000, smtpSocketMs: 1500 };

async function setup(o: { syncIntervalMs?: number; timeouts?: Partial<ImapTimeouts>; smtp?: Parameters<typeof startSmtp>[0]; delays?: number[] } = {}) {
  const imap = await startImap();
  const proxy = await startNetProxy(imap.port);
  cleanups.push(() => proxy.close());
  const smtp = await startSmtp(o.smtp);
  const smtpProxy = await startNetProxy(smtp.port);
  cleanups.push(() => smtpProxy.close());
  const dir = mkdtempSync(join(tmpdir(), "terno-net-"));
  const backend = new Backend({
    dbPath: join(dir, "t.db"),
    version: "t",
    cipher: plaintextCipher,
    providers: createRegistry({ imap: { allowInsecure: true, timeouts: { ...FAST, ...o.timeouts } } }),
    // a real host: retries, the worker and network events run on their own (the poll as the test says)
    autoSync: true,
    syncIntervalMs: o.syncIntervalMs ?? 3_600_000,
    connectivity: { delays: o.delays ?? [300, 600, 1200], settleMs: 100 },
  });
  cleanups.push(async () => {
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  await backend.start();
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "r", origin: "renderer" });
  const client = new RpcClient(c);
  const account = await client.call("accounts.addImap", {
    email: "luis@test.local",
    displayName: "Luis",
    imap: { host: "127.0.0.1", port: proxy.port, secure: false, user: "testuser" },
    smtp: { host: "127.0.0.1", port: smtpProxy.port, secure: false, user: "testuser" },
    password: "testpass",
  });
  const db = () => sqlDb(backend.store);
  const state = () => JSON.parse(db().get<{ s: string }>("SELECT sync_state s FROM accounts WHERE id = ?", account.id)!.s) as { status: string; connection?: { state: string; retryAt: number | null } | null };
  const subjects = async () => (await client.call("threads.list", { view: "inbox" })).items.map((t) => t.subject);
  // the first sync done and IDLE listening
  await expect.poll(() => state().status, { timeout: 10_000 }).toBe("idle");
  await new Promise((r) => setTimeout(r, 400));
  return { imap, proxy, smtp, smtpProxy, backend, client, account, db, state, subjects };
}

describe("plan 20: mail comes back after the network changes", () => {
  it("a VPN switch with the event: new mail within seconds (and without the event, not in that window)", async () => {
    const t = await setup();
    // the switch: every open socket goes silent, no error anywhere
    t.proxy.blackholeExisting();
    t.imap.server.control.addMessage("INBOX", { raw: raw("after the switch, unannounced") });
    await new Promise((r) => setTimeout(r, 3000));
    // IDLE is deaf and nothing else looks: the control
    expect(await t.subjects()).not.toContain("after the switch, unannounced");

    t.proxy.blackholeExisting();
    const started = Date.now();
    t.imap.server.control.addMessage("INBOX", { raw: raw("after the switch") });
    t.backend.networkChanged(true, "network");
    await expect.poll(t.subjects, { timeout: 3000, interval: 50 }).toContain("after the switch");
    const took = Date.now() - started;
    console.log(`plan 20: VPN switch → event → new mail listed in ${took} ms`);
    expect(took).toBeLessThan(3000);
    // and push works again afterwards (a new message arrives without any event or poll)
    const pushed = Date.now();
    t.imap.server.control.addMessage("INBOX", { raw: raw("pushed after the switch") });
    await expect.poll(t.subjects, { timeout: 5000, interval: 50 }).toContain("pushed after the switch");
    console.log(`plan 20: push after the reconnect: ${Date.now() - pushed} ms`);
  });

  it("without any event the heartbeat and the command session's timeout recover within their bound", async () => {
    const t = await setup({ syncIntervalMs: 1500 });
    t.proxy.blackholeExisting();
    const started = Date.now();
    t.imap.server.control.addMessage("INBOX", { raw: raw("found by the heartbeat") });
    // bound: a tick (1.5 s) + the command session's stall timeout (2 s) + a reconnect
    await expect.poll(t.subjects, { timeout: 8000, interval: 50 }).toContain("found by the heartbeat");
    console.log(`plan 20: black hole, no event → new mail listed in ${Date.now() - started} ms (tick 1.5 s, socket 2 s, heartbeat 1 s)`);
    // push was restored by the heartbeat: the next message arrives between ticks
    await new Promise((r) => setTimeout(r, 1600));
    const before = t.proxy.accepted;
    expect(before).toBeGreaterThanOrEqual(3);
  });

  it("server down: quiet first retry, then offline with a retry time; back up, it syncs on its own", async () => {
    const t = await setup();
    await t.proxy.refuse();
    t.proxy.resetAll();
    void t.backend.syncAccount(t.account.id);
    // the first failure is a blip (no offline flash), the second is shown, with when it tries again
    await expect.poll(() => t.state().connection?.state ?? null, { timeout: 5000, interval: 20 }).toBe("offline");
    expect(t.state()).toMatchObject({ status: "offline" });
    expect(t.state().connection!.retryAt).toBeGreaterThan(Date.now() - 50);
    await t.proxy.pass();
    t.imap.server.control.addMessage("INBOX", { raw: raw("while it was down") });
    await expect.poll(() => t.state().status, { timeout: 5000, interval: 20 }).toBe("idle");
    expect(t.state().connection).toBeNull();
    expect(await t.subjects()).toContain("while it was down");
  });

  it("an archive made while the server is unreachable waits for the network (never failed), then runs after the change", async () => {
    const t = await setup();
    t.imap.server.control.addMessage("INBOX", { raw: raw("archive me offline") });
    await t.backend.syncAccount(t.account.id);
    const [thread] = (await t.client.call("threads.list", { view: "inbox" })).items.filter((x) => x.subject === "archive me offline");
    await t.proxy.refuse();
    t.proxy.resetAll();
    (await t.backend.provider(t.account.id))!.reset!();
    await t.client.call("threads.act", { threadIds: [thread!.id], action: "archive" });
    const op = () => t.db().get<{ state: string; next_attempt_at: number; attempts: number }>("SELECT state, next_attempt_at, attempts FROM ops WHERE kind = 'archive'")!;
    // parked for the network: queued, no timer
    await expect.poll(() => op().next_attempt_at, { timeout: 8000, interval: 20 }).toBeGreaterThan(Date.now() + 1e15);
    expect(op().state).toBe("queued");
    await t.proxy.pass();
    t.backend.networkChanged(true, "network");
    await expect.poll(() => op().state, { timeout: 5000, interval: 20 }).toBe("succeeded");
    expect(t.imap.server.control.listMessages("Archive").length).toBe(1);
  });

  it("offline, the worker claims nothing (no attempt spent); online, the queued action runs", async () => {
    const t = await setup();
    t.imap.server.control.addMessage("INBOX", { raw: raw("star me") });
    await t.backend.syncAccount(t.account.id);
    const [thread] = (await t.client.call("threads.list", { view: "inbox" })).items.filter((x) => x.subject === "star me");
    // the network really is down while the host says so (a pass that worked would prove the host wrong)
    await t.proxy.refuse();
    t.proxy.resetAll();
    t.backend.networkChanged(false, "offline");
    await expect.poll(() => t.state().connection?.state ?? null).toBe("offline");
    await t.client.call("threads.act", { threadIds: [thread!.id], action: "star" });
    const op = () => t.db().get<{ state: string; attempts: number }>("SELECT state, attempts FROM ops WHERE kind = 'star'")!;
    await new Promise((r) => setTimeout(r, 500));
    expect(op()).toEqual({ state: "queued", attempts: 0 });
    await t.proxy.pass();
    t.backend.networkChanged(true, "online");
    await expect.poll(() => op().state, { timeout: 5000 }).toBe("succeeded");
    await expect.poll(() => t.state().connection ?? null, { timeout: 5000 }).toBeNull();
  });

  it("a probe that works while the host says offline proves it wrong: back online, push and the worker resume", async () => {
    const t = await setup();
    t.backend.networkChanged(false, "offline");
    await expect.poll(() => t.state().connection?.state ?? null).toBe("offline");
    // the user asks (or the 5-minute probe fires); the server answers
    await t.client.call("sync.now", { accountId: t.account.id });
    await expect.poll(() => t.backend.connectivity.online, { timeout: 5000 }).toBe(true);
    await expect.poll(() => t.state().connection ?? null, { timeout: 5000 }).toBeNull();
    t.imap.server.control.addMessage("INBOX", { raw: raw("pushed once online again") });
    await expect.poll(t.subjects, { timeout: 5000 }).toContain("pushed once online again");
  });
});

describe("plan 20: sends across a network change are never duplicated", () => {
  it("a change while the server is answering DATA: delivered once, the op succeeded", async () => {
    let t!: Awaited<ReturnType<typeof setup>>;
    t = await setup({ smtp: { holdMs: 800, afterData: () => t.backend.networkChanged(true, "network") } });
    const { opId } = await t.client.call("compose.send", { accountId: t.account.id, to: [{ name: "", email: "ana@example.com" }], subject: "once", bodyText: "y" });
    await expect.poll(() => t.db().get<{ state: string }>("SELECT state FROM ops WHERE id = ?", opId)!.state, { timeout: 8000 }).toBe("succeeded");
    await new Promise((r) => setTimeout(r, 500));
    expect(t.smtp.received.filter((m) => m.includes("Subject: once"))).toHaveLength(1);
  });

  it("the answer to DATA lost in a black hole: unknown, and still unknown (not resent) after the network comes back", async () => {
    let t!: Awaited<ReturnType<typeof setup>>;
    t = await setup({ smtp: { afterData: () => t.smtpProxy.blackholeExisting() } });
    const { opId } = await t.client.call("compose.send", { accountId: t.account.id, to: [{ name: "", email: "ana@example.com" }], subject: "maybe", bodyText: "y" });
    const opState = () => t.db().get<{ state: string }>("SELECT state FROM ops WHERE id = ?", opId)!.state;
    await expect.poll(opState, { timeout: 8000 }).toBe("unknown");
    t.backend.networkChanged(true, "network");
    await new Promise((r) => setTimeout(r, 1500));
    await t.backend.runWorker();
    expect(opState()).toBe("unknown");
    expect(t.smtp.received.filter((m) => m.includes("Subject: maybe"))).toHaveLength(1);
  });

  it("a send that never reached the server (refused) waits for the network and goes once it's back", async () => {
    const t = await setup();
    await t.smtpProxy.refuse();
    const { opId } = await t.client.call("compose.send", { accountId: t.account.id, to: [{ name: "", email: "ana@example.com" }], subject: "later", bodyText: "y" });
    const op = () => t.db().get<{ state: string; next_attempt_at: number }>("SELECT state, next_attempt_at FROM ops WHERE id = ?", opId)!;
    await expect.poll(() => op().next_attempt_at, { timeout: 8000 }).toBeGreaterThan(Date.now() + 1e15);
    await t.smtpProxy.pass();
    t.backend.networkChanged(true, "network");
    await expect.poll(() => op().state, { timeout: 8000 }).toBe("succeeded");
    expect(t.smtp.received.filter((m) => m.includes("Subject: later"))).toHaveLength(1);
  });
});

describe("plan 20: the IMAP provider's own connections", () => {
  function provider(port: number, o: { secretDelayMs?: number; timeouts?: Partial<ImapTimeouts> } = {}) {
    const ctx = {
      account: { id: 1, email: "luis@test.local", kind: "imap" },
      config: { imap: { host: "127.0.0.1", port, secure: false, user: "testuser" }, smtp: { host: "127.0.0.1", port: 1, secure: false, user: "t" }, senderName: "", appendToSent: false },
      getSecret: async () => {
        if (o.secretDelayMs) await new Promise((r) => setTimeout(r, o.secretDelayMs));
        return "testpass";
      },
      store: { locations: { of: async () => [] } },
    } as unknown as ProviderContext;
    return createImapProvider(ctx, { allowInsecure: true, timeouts: { ...FAST, ...o.timeouts } });
  }

  it("the IDLE reconnect loop never multiplies while the server refuses (one attempt at a time, backing off)", async () => {
    let attempts = 0;
    const server = createTcpServer((s) => {
      attempts++;
      s.destroy();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    const p = provider((server.address() as { port: number }).port, { timeouts: { reconnectMs: 50, reconnectMaxMs: 400 } });
    const stop = p.watch!(() => {});
    await new Promise((r) => setTimeout(r, 4000));
    stop();
    // 50, 100, 200, 400, 400 … ms (±20 %): about 12 in 4 s; the old double scheduling made thousands
    expect(attempts).toBeGreaterThan(5);
    expect(attempts).toBeLessThan(20);
  });

  it("plan 25: a refused password isn't knocked with every minute: one login, none more; a network change tries once", async () => {
    const imap = await startImap();
    const proxy = await startNetProxy(imap.port);
    cleanups.push(() => proxy.close());
    // the password was changed on the server
    imap.server.control.updateUser("testuser", { password: "changed" });
    const p = provider(proxy.port, { timeouts: { reconnectMs: 50, reconnectMaxMs: 200 } });
    const stop = p.watch!(() => {});
    cleanups.push(() => stop());
    await expect.poll(() => proxy.accepted).toBe(1);
    // with the old loop: 50, 100, 200, 200 … ms, a dozen logins in this window
    await new Promise((r) => setTimeout(r, 1500));
    expect(proxy.accepted).toBe(1);
    p.reset?.();
    await expect.poll(() => proxy.accepted).toBe(2);
    await new Promise((r) => setTimeout(r, 800));
    expect(proxy.accepted).toBe(2);
    // and a sync says it's a sign-in to redo
    await expect(p.sync({} as never)).rejects.toBeInstanceOf((await import("@terno/mail")).ProviderAuthError);
  });

  /** an op on a message the provider has no location for: it connects, discovers folders and does nothing else */
  const markRead = (p: ReturnType<typeof provider>) => p.execute({ id: "x", kind: "markRead", target: { messageIds: [1] }, payload: null });

  async function behindProxy() {
    const imap = await startImap();
    const proxy = await startNetProxy(imap.port);
    cleanups.push(() => proxy.close());
    return proxy;
  }

  it("two callers asking for a session together share one connection, and later calls reuse it", async () => {
    const proxy = await behindProxy();
    const p = provider(proxy.port);
    cleanups.push(() => p.close());
    await Promise.all([markRead(p), markRead(p), markRead(p)]);
    await markRead(p);
    expect(proxy.accepted).toBe(1);
  });

  it("a reset while the password is being read never connects on the old network (the call still succeeds)", async () => {
    const proxy = await behindProxy();
    const p = provider(proxy.port, { secretDelayMs: 300 });
    cleanups.push(() => p.close());
    const run = markRead(p);
    await new Promise((r) => setTimeout(r, 100));
    p.reset!();
    await run;
    // the first attempt gave up before connecting; the retry made the only connection
    expect(proxy.accepted).toBe(1);
  });

  it("a reset while connecting abandons that session; the next one is kept and reused", async () => {
    const proxy = await behindProxy();
    const p = provider(proxy.port);
    cleanups.push(() => p.close());
    const run = markRead(p);
    await expect.poll(() => proxy.accepted, { interval: 1 }).toBe(1);
    p.reset!();
    await run;
    expect(proxy.accepted).toBe(2);
    await markRead(p);
    expect(proxy.accepted).toBe(2);
  });

  it("Codex review: a reset while IDLE is still connecting abandons that session at once; push works right after", async () => {
    const imap = await startImap();
    const proxy = await startNetProxy(imap.port);
    cleanups.push(() => proxy.close());
    // the old network: connections open, nothing ever answers (the greeting never comes)
    await proxy.blackholeAll();
    const p = provider(proxy.port, { timeouts: { connectMs: 10_000 } });
    let changes = 0;
    const stop = p.watch!(() => void changes++);
    cleanups.push(stop);
    await expect.poll(() => proxy.accepted).toBe(1);
    await new Promise((r) => setTimeout(r, 200));
    await proxy.pass();
    const started = Date.now();
    p.reset!();
    // the stuck attempt's socket is gone and a new session listens
    await expect.poll(() => proxy.accepted, { timeout: 2000 }).toBe(2);
    await expect.poll(() => proxy.open, { timeout: 2000 }).toBe(1);
    await new Promise((r) => setTimeout(r, 300));
    imap.server.control.addMessage("INBOX", { raw: raw("pushed after a reset mid-connect") });
    await expect.poll(() => changes, { timeout: 2000 }).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("Codex review: stopping push while it is still connecting closes that socket at once", async () => {
    const imap = await startImap();
    const proxy = await startNetProxy(imap.port);
    cleanups.push(() => proxy.close());
    await proxy.blackholeAll();
    const p = provider(proxy.port, { timeouts: { connectMs: 10_000 } });
    const stop = p.watch!(() => {});
    await expect.poll(() => proxy.open).toBe(1);
    stop();
    await expect.poll(() => proxy.open, { timeout: 1000 }).toBe(0);
  });

  it("a reset closes the cached session at once (no LOGOUT on a dead socket) and the next call opens a new one", async () => {
    const proxy = await behindProxy();
    const p = provider(proxy.port);
    cleanups.push(() => p.close());
    await markRead(p);
    proxy.blackholeExisting();
    const started = Date.now();
    p.reset!();
    await markRead(p);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(proxy.accepted).toBe(2);
  });
});
