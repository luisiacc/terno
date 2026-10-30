import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createRegistry } from "@terno/mail";
import { ImapFlow } from "imapflow";
import type { SessionInfo } from "imapkit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { bounded, deferred, idleFixture, rawIdleMail } from "./test/imap-idle-fixture";

type Wire = Awaited<ReturnType<typeof idleFixture>>;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanups.splice(0).reverse()) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "IDLE fixture cleanup failed");
});

async function wire(idle = true, script: Parameters<typeof idleFixture>[1] = []) {
  const w = await idleFixture(idle, script);
  cleanups.push(() => w.stop());
  return w;
}

let accountSeq = 0;
async function account(w: Wire, heartbeatMs = 400) {
  const user = `idle-backend-${++accountSeq}`;
  w.server.control.addUser(user, { password: "testpass" });
  const owned = new Set<number>();
  const opening = (event: { type: string; session: SessionInfo }) => {
    if (event.type === "open") owned.add(event.session.session);
  };
  w.server.on("session", opening);
  const dir = mkdtempSync(join(tmpdir(), "terno-idle-foreground-"));
  const backend = new Backend({
    dbPath: join(dir, "test.db"), version: "test", cipher: plaintextCipher, instantSearch: false,
    providers: createRegistry({ imap: { allowInsecure: true, timeouts: {
      connectMs: 2000, socketMs: 3000, quietMs: 0, heartbeatMs,
      reconnectMs: 40, reconnectMaxMs: 160,
    } } }),
    autoSync: true, syncIntervalMs: 3_600_000, connectivity: { settleMs: 0 },
  });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "idle-test", origin: "renderer" });
  const client = new RpcClient(c);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    w.server.off("session", opening);
    for (const session of w.server.control.sessions()) if (session.user === user) owned.add(session.session);
    await bounded(backend.stop(), "backend stop");
    await w.wait(() => [...owned].every((id) => w.closed.has(id)) && !w.server.control.sessions().some((s) => s.user === user)
      ? true : undefined, "all owned command/pending/IDLE/fallback sockets close");
    client.close();
    stopped = true;
  };
  cleanups.push(async () => { await stop(); rmSync(dir, { recursive: true, force: true }); });
  await bounded(backend.start(), "backend start");
  const added = await bounded(client.call("accounts.addImap", {
    email: "synthetic@example.test", displayName: "Synthetic",
    imap: { host: "127.0.0.1", port: w.port, secure: false, user },
    smtp: { host: "127.0.0.1", port: 1, secure: false, user: "testuser" },
    password: "testpass", verify: false,
  }), "add account");
  await bounded(backend.syncAccount(added.id), "initial sync");
  const provider = (await backend.provider(added.id))!;
  w.server.off("session", opening);
  return { backend, client, account: added, provider, stop };
}

async function listener(w: Wire, after = 0) {
  return w.wait(() => w.idles.slice(after).find((id) => w.active.has(id)), "server-positive IDLE");
}

async function detail(t: Awaited<ReturnType<typeof account>>, subject: string) {
  const threads = await t.client.call("threads.list", { view: "all", accountId: t.account.id });
  const thread = threads.items.find((item) => item.subject === subject);
  expect(thread).toBeDefined();
  return t.client.call("threads.get", { threadId: thread!.id });
}

async function act(t: Awaited<ReturnType<typeof account>>, threadId: number, action: "markRead" | "star" | "trash") {
  await bounded(t.client.call("threads.act", { threadIds: [threadId], action }), action);
  await bounded(t.backend.runWorker(), "worker");
  await expect.poll(async () => (await t.client.call("ops.list", {})).find((op) => op.kind === action)?.state,
    { timeout: 3000 }).toBe("succeeded");
}

function budget(w: Wire, start: number, sessions = 2) {
  expect(w.overflow).toBe(false);
  expect(w.server.sessionCounter).toBeLessThanOrEqual(5);
  expect(w.commands.length - start).toBeLessThan(120);
  expect(new Set(w.commands.slice(start).map((cmd) => cmd.session)).size).toBeLessThanOrEqual(sessions);
}

async function unrelated(w: Wire) {
  const c = new ImapFlow({ host: "127.0.0.1", port: w.port, secure: false, doSTARTTLS: false,
    auth: { user: "testuser", pass: "testpass" }, logger: false, disableAutoIdle: true,
    connectionTimeout: 2000, socketTimeout: 5000 });
  c.on("error", () => {});
  let id: number | undefined;
  cleanups.push(async () => {
    c.close();
    if (id !== undefined) await w.wait(() => w.closed.has(id!) ? true : undefined, "unrelated socket close");
  });
  const before = new Set(w.server.control.sessions().map((s) => s.session));
  await bounded(c.connect(), "unrelated connect");
  id = w.server.control.sessions().find((s) => !before.has(s.session))!.session;
  return { c, id };
}

describe("W06 A29: installed IMAP transport foreground/IDLE ownership", () => {
  it.each([true, false])("body/read/flag/move complete with IDLE capability=%s (matched control)", async (idle) => {
    const w = await wire(idle);
    const untouchedRaw = rawIdleMail("unrelated", "Unrelated exact bytes");
    const other = w.server.control.addMessage("INBOX", { raw: untouchedRaw, flags: ["\\Flagged", "\\Deleted"] });
    const t = await account(w);
    const owner = idle ? await listener(w) : await w.wait(() => w.commands.find((c) => c.command === "NOOP")?.session, "fallback NOOP");
    const start = w.commands.length;
    const sourceRaw = rawIdleMail("foreground");
    const target = w.server.control.addMessage("Projects", { raw: sourceRaw });
    // Projects is deliberately outside INBOX push scope: this call must download the uncached source.
    await bounded(t.backend.syncAccount(t.account.id), "foreground body sync");
    const d = await detail(t, "foreground");
    const message = d.messages[0]!;
    expect(message).toMatchObject({ bodyState: "full", bodyText: "Exact foreground body\n", isRead: false, isStarred: false });
    const sourceFetch = w.commands.slice(start).filter((c) => c.command === "UID FETCH" && /BODY\.PEEK\[\]/i.test(c.data));
    expect(sourceFetch.length).toBeGreaterThan(0);
    expect(sourceFetch.every((c) => c.session !== owner)).toBe(true);
    const originalLocation = await t.backend.store.providerStore(t.account.id).locations!.of([message.id]);
    expect(originalLocation).toEqual([expect.objectContaining({ mailbox: "Projects", uidvalidity: target.uidvalidity, uid: target.uid })]);
    await act(t, d.thread.id, "markRead");
    expect(w.server.control.getMessage("Projects", target.uid).flags.sort()).toEqual(["\\Seen"]);
    await act(t, d.thread.id, "star");
    expect(w.server.control.getMessage("Projects", target.uid).flags.sort()).toEqual(["\\Flagged", "\\Seen"]);
    await act(t, d.thread.id, "trash");
    expect(w.server.control.listMessages("Projects")).toEqual([]);
    const moved = w.server.control.listMessages("Trash", { raw: true });
    expect(moved).toHaveLength(1);
    expect(moved[0]!.raw).toEqual(Buffer.from(sourceRaw));
    expect(moved[0]!.flags.sort()).toEqual(["\\Flagged", "\\Seen"]);
    expect(await t.backend.store.providerStore(t.account.id).locations!.of([message.id])).toEqual([
      expect.objectContaining({ mailbox: "Trash", uidvalidity: w.server.control.getMailbox("Trash").uidvalidity, uid: moved[0]!.uid }),
    ]);
    expect((await t.client.call("threads.get", { threadId: d.thread.id })).messages[0]).toMatchObject({
      id: message.id, bodyText: message.bodyText, isRead: true, isStarred: true,
    });
    expect((await t.client.call("threads.get", { threadId: d.thread.id })).thread.inTrash).toBe(true);
    const mutations = w.commands.slice(start).filter((c) => /^(UID STORE|UID MOVE|UID COPY|EXPUNGE|UID EXPUNGE)$/.test(c.command));
    expect(mutations.map((c) => c.command)).toEqual(["UID STORE", "UID STORE", "UID MOVE"]);
    expect(mutations.every((c) => c.session !== owner)).toBe(true);
    expect(w.commands.slice(start).filter((c) => c.session === owner)).toEqual([]);
    if (idle) expect(w.active.has(owner)).toBe(true);
    else expect(w.commands.some((c) => c.command === "IDLE")).toBe(false);
    const kept = w.server.control.getMessage("INBOX", other.uid);
    expect(kept.raw).toEqual(Buffer.from(untouchedRaw));
    expect(kept.flags.sort()).toEqual(["\\Deleted", "\\Flagged"]);
    expect(w.server.control.getMailbox("INBOX").uidvalidity).toBe(other.uidvalidity);
    budget(w, start, 1);
  });

  it("receives exact INBOX arrivals while the listener stays IDLE", async () => {
    const w = await wire();
    const t = await account(w);
    const owner = await listener(w);
    const start = w.commands.length;
    const raw = rawIdleMail("push-arrival", "Arrival bytes");
    const remote = w.server.control.addMessage("INBOX", { raw });
    await expect.poll(async () => (await t.client.call("threads.list", { view: "inbox" })).items.map((x) => x.subject)).toContain("push-arrival");
    await bounded(t.backend.syncAccount(t.account.id), "join push sync");
    const d = await detail(t, "push-arrival");
    expect(d.messages[0]!.bodyText).toBe("Arrival bytes\n");
    await act(t, d.thread.id, "markRead");
    expect(w.server.control.getMessage("INBOX", remote.uid).raw).toEqual(Buffer.from(raw));
    expect(w.server.control.getMessage("INBOX", remote.uid).flags).toEqual(["\\Seen"]);
    expect(w.active.has(owner)).toBe(true);
    expect(w.commands.slice(start).filter((c) => c.session === owner)).toEqual([]);
    budget(w, start, 1);
  });

  it("reconnects only the BYE'd listener and restores a second push before the scheduled tick", async () => {
    const w = await wire();
    const t = await account(w);
    const owner = await listener(w);
    const observer = await unrelated(w);
    const previous = w.idles.length;
    const start = w.commands.length;
    expect(w.server.control.disconnect(owner, { text: "A29 server BYE" })).toBe(1);
    expect(w.byes).toContain(owner);
    const next = await listener(w, previous);
    expect(next).not.toBe(owner);
    await w.wait(() => w.closed.has(owner) ? true : undefined, "BYE socket close");
    await bounded(t.backend.syncAccount(t.account.id), "join reconnect catch-up");
    const raw = rawIdleMail("after-bye", "Restored push bytes");
    w.server.control.addMessage("INBOX", { raw });
    await expect.poll(async () => (await t.client.call("threads.list", { view: "inbox" })).items.map((x) => x.subject)).toContain("after-bye");
    await bounded(t.backend.syncAccount(t.account.id), "join restored push");
    expect((await detail(t, "after-bye")).messages[0]!.bodyText).toBe("Restored push bytes\n");
    await bounded(observer.c.noop(), "unrelated session survives BYE");
    expect(w.closed.has(observer.id)).toBe(false);
    expect(w.idles.slice(previous)).toEqual([next]);
    budget(w, start, 3);
  });

  it.each(["before", "after"] as const)("does not lose a real arrival %s DONE completion", async (phase) => {
    const w = await wire();
    const t = await account(w);
    const owner = await listener(w);
    const previous = w.idles.length;
    const start = w.commands.length;
    const raw = rawIdleMail(`done-${phase}`, `DONE ${phase} bytes`);
    const held = deferred<string>();
    const arrivalsBefore = w.arrivals.filter((id) => id === owner).length;
    const deliver = w.server.script.add({ on: "input", session: owner, match: /^DONE\r?\n?$/i,
      run: true, times: 1, when() {
        if (phase === "before") w.server.control.addMessage("INBOX", { raw });
        return true;
      } });
    const handle = w.server.script.add({ on: "response", command: "IDLE", session: owner, untagged: false,
      times: 1, drop: true, when(ctx) { held.resolve(ctx.tag!); return true; } });
    let tag: string | undefined;
    try {
      t.provider.heartbeat!();
      tag = await bounded(held.promise, "DONE tagged completion held");
      expect(w.commands.slice(start).filter((c) => c.session === owner).map((c) => c.command)).toEqual(["DONE"]);
      if (phase === "before") expect(w.arrivals.filter((id) => id === owner)).toHaveLength(arrivalsBefore + 1);
      w.server.control.inject(owner, `${tag} OK IDLE terminated\r\n`);
      tag = undefined;
      if (phase === "after") w.server.control.addMessage("INBOX", { raw });
      await w.wait(() => w.completions.slice().find((c) => c.session === owner && c.command === "NOOP") ? true : undefined, "heartbeat NOOP");
      await listener(w, previous);
      await expect.poll(async () => (await t.client.call("threads.list", { view: "inbox" })).items.map((x) => x.subject)).toContain(`done-${phase}`);
      await bounded(t.backend.syncAccount(t.account.id), "join DONE push sync");
      const d = await detail(t, `done-${phase}`);
      expect(d.messages[0]!.bodyText).toBe(`DONE ${phase} bytes\n`);
      expect(w.server.control.listMessages("INBOX", { raw: true }).map((m) => m.raw)).toEqual([Buffer.from(raw)]);
      expect(w.active.has(owner)).toBe(true);
      expect(w.closed.has(owner)).toBe(false);
      budget(w, start);
    } finally {
      handle.remove();
      deliver.remove();
      if (tag && !w.closed.has(owner) && !w.active.has(owner)) w.server.control.inject(owner, `${tag} OK released\r\n`);
    }
  });

  it("a tagged IDLE refusal falls back on the next heartbeat without blocking foreground work", async () => {
    const w = await wire(true, [{ on: "command", command: "IDLE", times: 1, send: "$TAG BAD IDLE unavailable\r\n" }]);
    const t = await account(w);
    const owner = await w.wait(() => w.commands.find((c) => c.command === "IDLE")?.session, "refused IDLE command");
    // A NOOP queued after the refusal also joins its processing before fallback is requested.
    t.provider.heartbeat!();
    await w.wait(() => w.completions.find((c) => c.session === owner && c.command === "NOOP") ? true : undefined, "refused IDLE heartbeat");
    await w.wait(() => w.commands.filter((c) => c.session === owner && c.command === "NOOP").length >= 2 ? true : undefined,
      "installed fallback NOOP after heartbeat");
    const start = w.commands.length;
    w.server.control.addMessage("Projects", { raw: rawIdleMail("refusal-control") });
    await bounded(t.backend.syncAccount(t.account.id), "foreground with refused IDLE");
    const d = await detail(t, "refusal-control");
    await act(t, d.thread.id, "markRead");
    expect(d.messages[0]!.bodyText).toBe("Exact foreground body\n");
    expect(w.commands.filter((c) => c.command === "IDLE")).toHaveLength(1);
    expect(w.closed.has(owner)).toBe(false);
    expect(w.server.control.listMessages("Projects")[0]!.flags).toEqual(["\\Seen"]);
    budget(w, start);
  });

  it.each(["absent", "refused"])("joins the %s-IDLE listener even with a heartbeat response held", async (mode) => {
    const w = await wire(mode !== "absent", mode === "refused"
      ? [{ on: "command", command: "IDLE", times: 1, send: "$TAG BAD IDLE unavailable\r\n" }] : []);
    const t = await account(w);
    const owner = await w.wait(() => w.commands.find((c) => c.command === (mode === "absent" ? "NOOP" : "IDLE"))?.session,
      "fallback listener session");
    if (mode === "refused") t.provider.heartbeat!();
    await w.wait(() => w.completions.filter((c) => c.session === owner && c.command === "NOOP").length >= (mode === "absent" ? 1 : 2)
      ? true : undefined, "join fallback startup");
    const held = deferred<void>();
    const handle = w.server.script.add({ on: "response", command: "NOOP", session: owner, untagged: false, times: 1,
      drop: true, when() { held.resolve(); return true; } });
    try {
      t.provider.heartbeat!();
      await bounded(held.promise, "fallback heartbeat held");
      await t.stop();
      expect(w.closed.has(owner)).toBe(true);
    } finally {
      handle.remove();
      await w.wait(() => w.closed.has(owner) ? true : undefined, "fallback socket closes before fixture teardown", 3500);
    }
  });

  it.each(["IDLE", "NOOP"])("heartbeat timeout during %s closes only the listener; foreground and replacement push work", async (command) => {
    const w = await wire();
    const heartbeatMs = 9001;
    const t = await account(w, heartbeatMs);
    const owner = await listener(w);
    const observer = await unrelated(w);
    const previous = w.idles.length;
    const start = w.commands.length;
    const held = deferred<void>();
    const deadline = deferred<() => void>();
    const originalTimeout = globalThis.setTimeout;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    // Release only the heartbeat's real deadline after the wire assertions; other deadlines keep running.
    const clock = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, ms, ...args) => {
      const timer = originalTimeout(callback, ms, ...args);
      if (ms === heartbeatMs) {
        deadlineTimer = timer;
        deadline.resolve(() => { clearTimeout(timer); callback(...args); });
      }
      return timer;
    });
    const handle = w.server.script.add({ on: "response", command, session: owner, untagged: false, times: 1,
      drop: true, when() { held.resolve(); return true; } });
    try {
      t.provider.heartbeat!();
      await bounded(held.promise, `${command} blocked`);
      const expire = await bounded(deadline.promise, "heartbeat deadline armed");
      w.server.control.addMessage("Projects", { raw: rawIdleMail(`timeout-${command}`) });
      await bounded(t.backend.syncAccount(t.account.id), "foreground while probe blocked");
      const d = await detail(t, `timeout-${command}`);
      await act(t, d.thread.id, "star");
      expect(w.closed.has(owner)).toBe(false);
      expect(w.server.control.sessions().some((s) => s.session === owner)).toBe(true);
      expect(w.commands.slice(start).some((c) => c.command === "UID FETCH" && /BODY\.PEEK\[\]/i.test(c.data) && c.session !== owner)).toBe(true);
      expect(w.server.control.listMessages("Projects")[0]!.flags).toEqual(["\\Flagged"]);
      expect(w.commands.slice(start).filter((c) => c.command === "UID STORE").map((c) => c.session)).toEqual([
        w.commands.slice(start).find((c) => c.command === "UID FETCH")!.session,
      ]);
      expect(handle.hits).toBe(1);
      expire();
      await w.wait(() => w.closed.has(owner) ? true : undefined, "timed-out listener closes");
      const next = await listener(w, previous);
      expect(next).not.toBe(owner);
      await bounded(t.backend.syncAccount(t.account.id), "drain reconnect catch-up before push probe");
      await bounded(observer.c.noop(), "unrelated session survives timeout");
      expect(w.closed.has(observer.id)).toBe(false);
      w.server.control.addMessage("INBOX", { raw: rawIdleMail(`timeout-push-${command}`) });
      await expect.poll(async () => (await t.client.call("threads.list", { view: "inbox" })).items.map((x) => x.subject)).toContain(`timeout-push-${command}`);
      expect(w.idles.slice(previous)).toEqual([next]);
      budget(w, start, 4);
    } finally { clock.mockRestore(); clearTimeout(deadlineTimer); handle.remove(); }
  });

  it("offline cancellation force-closes a listener awaiting DONE; unrelated and fresh accounts stay healthy", async () => {
    const w = await wire();
    const t = await account(w);
    const owner = await listener(w);
    const observer = await unrelated(w);
    const previous = w.idles.length;
    const start = w.commands.length;
    const handle = w.server.script.add({ on: "input", session: owner, match: /^DONE\r?\n?$/i, drop: true });
    try {
      t.backend.networkChanged(false, "offline");
      await w.wait(() => w.commands.slice(start).some((c) => c.session === owner && c.command === "DONE") ? true : undefined, "stop requested DONE");
      await w.wait(() => w.closed.has(owner) ? true : undefined, "stop joins listener socket", 3500);
      await bounded(observer.c.noop(), "unrelated session survives owned stop");
      expect(w.closed.has(observer.id)).toBe(false);
      expect(w.commands.slice(start).filter((c) => c.session === owner).map((c) => c.command)).toEqual(["DONE"]);
      expect(w.idles.length).toBe(previous);
      await t.stop();
      const fresh = await account(w);
      const freshOwner = await listener(w, previous);
      expect(freshOwner).not.toBe(owner);
      w.server.control.addMessage("Projects", { raw: rawIdleMail("fresh-account", "Fresh exact body") });
      await bounded(fresh.backend.syncAccount(fresh.account.id), "fresh foreground sync");
      const d = await detail(fresh, "fresh-account");
      await act(fresh, d.thread.id, "markRead");
      expect(d.messages[0]!.bodyText).toBe("Fresh exact body\n");
      expect(w.active.has(freshOwner)).toBe(true);
      await fresh.stop();
      await w.wait(() => w.closed.has(freshOwner) ? true : undefined, "fresh listener close");
      await bounded(observer.c.noop(), "unrelated session survives both backends");
      budget(w, start, 4);
    } finally { handle.remove(); }
  });
});
