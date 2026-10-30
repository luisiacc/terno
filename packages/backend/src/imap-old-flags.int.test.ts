import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { sqlDb } from "@terno/db";
import { createRegistry } from "@terno/mail";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { bounded, deferred } from "./test/imap-idle-fixture";
import { flagsFixture } from "./test/imap-flags-fixture";

const DAY = 86_400_000;
const START = Date.UTC(2026, 0, 20, 12);
const FLAGS = ["\\Flagged", "\\Seen"];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanups.splice(0).reverse()) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  vi.restoreAllMocks();
  if (errors.length) throw new AggregateError(errors, "Old flag fixture cleanup failed");
});

function raw(subject: string, date = START - DAY) {
  return [`From: Synthetic <sender@example.test>`, "To: Test <test@example.test>", `Subject: ${subject}`,
    `Message-ID: <${subject}@flags.example.test>`, `Date: ${new Date(date).toUTCString()}`,
    "Content-Type: text/plain; charset=utf-8", "", `Exact ${subject} body`, ""].join("\r\n");
}

async function setup(condstore = true, path = "Projects", initial: string[] = []) {
  const w = await flagsFixture(condstore);
  cleanups.push(() => w.stop());
  const ctl = w.server.control;
  const targetRaw = raw("cached");
  const target = ctl.addMessage(path, { raw: targetRaw, internaldate: new Date(START - DAY), flags: initial });
  const otherRaw = raw("unrelated");
  const other = ctl.addMessage(path, { raw: otherRaw, internaldate: new Date(START - DAY), flags: ["\\Deleted"] });
  const neverRaw = raw("never-downloaded", START - 200 * DAY);
  const never = ctl.addMessage(path, { raw: neverRaw, internaldate: new Date(START - 200 * DAY), flags: ["\\Seen"] });
  const dir = mkdtempSync(join(tmpdir(), "terno-old-flags-"));
  cleanups.push(async () => { rmSync(dir, { recursive: true, force: true }); });
  let now = START;
  async function open() {
    const backend = new Backend({ dbPath: join(dir, "test.db"), version: "test", cipher: plaintextCipher,
      providers: createRegistry({ imap: { allowInsecure: true, timeouts: { connectMs: 2000, socketMs: 3000 } } }),
      autoSync: false, instantSearch: false, now: () => now, connectivity: { settleMs: 0 },
    });
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId: "old-flags", origin: "renderer" });
    const client = new RpcClient(c);
    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      await bounded(backend.stop(), "backend stop");
      client.close();
      stopped = true;
    };
    cleanups.push(stop);
    await backend.ready;
    return { backend, client, stop };
  }
  const t = await open();
  await t.client.call("settings.update", { syncWindowDays: 30 });
  const account = await t.client.call("accounts.addImap", {
    email: "test@example.test", displayName: "Synthetic", verify: false,
    imap: { host: "127.0.0.1", port: w.port, secure: false, user: "testuser" },
    smtp: { host: "127.0.0.1", port: 1, secure: false, user: "testuser" }, password: "testpass",
  });
  await bounded(t.backend.syncAccount(account.id), "initial sync");
  const d = await detail(t);
  expect(d.messages).toHaveLength(1);
  const message = d.messages[0]!;
  expect(message).toMatchObject({ bodyState: "full", bodyText: "Exact cached body\n", isRead: initial.includes("\\Seen"), isStarred: initial.includes("\\Flagged") });
  expect(await t.backend.store.providerStore(account.id).locations!.of([message.id])).toEqual([
    expect.objectContaining({ mailbox: path, uid: target.uid, uidvalidity: target.uidvalidity }),
  ]);
  expect(sqlDb(t.backend.store).all("SELECT subject FROM messages ORDER BY subject")).toEqual([{ subject: "cached" }, { subject: "unrelated" }]);
  expect(sqlDb(t.backend.store).all("SELECT body_state FROM messages")).toEqual([{ body_state: "full" }, { body_state: "full" }]);
  expect(ctl.getMessage(path, target.uid).raw).toEqual(Buffer.from(targetRaw));
  expect(w.responses.filter((s) => /\* CAPABILITY /.test(s)).some((s) => /\bCONDSTORE\b/.test(s))).toBe(condstore);
  expect(w.responses.some((s) => /HIGHESTMODSEQ/.test(s))).toBe(condstore);
  return { ...t, w, ctl, path, account, message, thread: d.thread, target, targetRaw, other, otherRaw, never, neverRaw,
    open, providerId: sqlDb(t.backend.store).get<{ provider_msg_id: string }>("SELECT provider_msg_id FROM messages WHERE id = ?", message.id)!.provider_msg_id,
    advance() { now += 60 * DAY; }, now: () => now };
}

type Session = { backend: Backend; client: RpcClient };
async function detail(t: Session) {
  const items = (await t.client.call("threads.list", { view: "all" })).items;
  const thread = items.find((item) => item.subject === "cached");
  expect(thread).toBeDefined();
  return t.client.call("threads.get", { threadId: thread!.id });
}
function cursor(t: Session, account: number) {
  return JSON.parse(sqlDb(t.backend.store).get<{ provider_config: string }>("SELECT provider_config FROM accounts WHERE id = ?", account)!.provider_config).cursor as {
    pass: number; fullCheck?: boolean; mailboxes: Record<string, { uidvalidity: number; uidnext: number; messages?: number; modseq?: string }>;
  };
}
async function witness(t: Session, source: Awaited<ReturnType<typeof setup>>, flags: string[], uid = source.target.uid, epoch = source.target.uidvalidity) {
  const d = await detail(t);
  expect(d.thread).toMatchObject({ id: source.thread.id, unread: !flags.includes("\\Seen"), starred: flags.includes("\\Flagged") });
  expect(d.messages[0]).toMatchObject({ id: source.message.id, bodyState: "full", bodyText: source.message.bodyText,
    isRead: flags.includes("\\Seen"), isStarred: flags.includes("\\Flagged") });
  expect(sqlDb(t.backend.store).get("SELECT provider_msg_id FROM messages WHERE id = ?", source.message.id)).toEqual({ provider_msg_id: source.providerId });
  const locs = await t.backend.store.providerStore(source.account.id).locations!.of([source.message.id]);
  expect(locs).toHaveLength(1);
  expect(locs[0]).toMatchObject({ mailbox: source.path, uid, uidvalidity: epoch });
  expect((JSON.parse(locs[0]!.flags) as string[]).sort()).toEqual([...flags].sort());
  expect(source.ctl.getMessage(source.path, uid).flags.sort()).toEqual([...flags].sort());
  expect(source.ctl.getMessage(source.path, uid).raw).toEqual(Buffer.from(source.targetRaw));
  expect(source.ctl.getMessage(source.path, source.other.uid).raw).toEqual(Buffer.from(source.otherRaw));
  expect(source.ctl.getMessage(source.path, source.other.uid).flags).toEqual(["\\Deleted"]);
  expect(source.ctl.getMessage(source.path, source.never.uid).raw).toEqual(Buffer.from(source.neverRaw));
  expect(sqlDb(t.backend.store).all("SELECT subject FROM messages ORDER BY subject")).toEqual([{ subject: "cached" }, { subject: "unrelated" }]);
  const counts = await t.client.call("counts.get", {});
  if (source.path === "Projects") expect(counts.folderUnread?.[`${source.account.id}:Projects`] ?? 0).toBe(flags.includes("\\Seen") ? 1 : 2);
}
function traffic(w: Awaited<ReturnType<typeof flagsFixture>>, start: number) {
  const commands = w.commands.slice(start);
  expect(w.overflow).toBe(false);
  expect(commands.length).toBeLessThan(35);
  expect(commands.filter((c) => /BODY(?:\.PEEK)?\[|ENVELOPE|BODYSTRUCTURE/.test(c.data))).toEqual([]);
  expect(commands.filter((c) => /STORE|MOVE|COPY|EXPUNGE|APPEND/.test(c.command))).toEqual([]);
  return commands;
}
async function pass(t: Session, source: Awaited<ReturnType<typeof setup>>) {
  const before = cursor(t, source.account.id).pass;
  const start = source.w.commands.length;
  await bounded(t.backend.syncAccount(source.account.id), "explicit flag sync");
  expect(cursor(t, source.account.id).pass).toBe(before + 1);
  return traffic(source.w, start);
}

describe("W06 A26/S14: cached flags beyond the download window", () => {
  it.each([true, false].flatMap((condstore) => ["INBOX", "Projects"].flatMap((path) => [false, true].map((read) => ({ condstore, path, read })))))
  ("catches up after reopen: $path CONDSTORE=$condstore initially seen/flagged=$read", async ({ condstore, path, read }) => {
    const initial = read ? FLAGS : [];
    const next = read ? [] : FLAGS;
    const t = await setup(condstore, path, initial);
    if (!condstore && path === "Projects") {
      while (cursor(t, t.account.id).pass % 4 !== 0) await pass(t, t);
    }
    const before = cursor(t, t.account.id);
    expect(before.fullCheck).toBeUndefined();
    await t.stop();
    expect(t.ctl.sessions()).toEqual([]);
    t.advance();
    expect(t.message.date).toBeLessThan(t.now() - 30 * DAY);
    const status = t.ctl.getMailbox(path);
    t.ctl.setFlags(path, [t.target.uid], next, "set");
    expect(t.ctl.getMailbox(path)).toMatchObject({ uidnext: status.uidnext, uidvalidity: status.uidvalidity, messages: status.messages });
    const r = await t.open();
    expect(cursor(r, t.account.id)).toEqual(before);
    const old = (await detail(r)).messages[0]!;
    expect(old).toMatchObject({ id: t.message.id, bodyText: t.message.bodyText, isRead: read, isStarred: read });
    let swept = false;
    for (let i = 0; i < 4 && !swept; i++) {
      const commands = await pass(r, t);
      const current = cursor(r, t.account.id);
      swept = path === "INBOX" || condstore || current.pass % 4 === 0;
      expect(commands.some((c) => c.mailbox === path && c.command === "UID FETCH")).toBe(swept);
      if (path === "Projects") {
        const request = commands.find((c) => c.command === "STATUS" && /Projects/.test(c.data));
        expect(request).toBeDefined();
        expect(/HIGHESTMODSEQ/.test(request!.data)).toBe(condstore);
        if (!swept) expect(current.mailboxes[path]).toEqual(before.mailboxes[path]);
      }
      expect((await detail(r)).messages[0]).toMatchObject({ isRead: swept ? !read : read, isStarred: swept ? !read : read });
    }
    expect(swept).toBe(true);
    await witness(r, t, next);
    await r.stop();
    const durable = await t.open();
    await witness(durable, t, next);
    expect(cursor(durable, t.account.id).mailboxes[path]!.modseq !== undefined).toBe(condstore);
  });

  it("skips a matched CONDSTORE STATUS and catches flags on a retained provider", async () => {
    const t = await setup();
    t.advance();
    const commands = await pass(t, t);
    expect(commands.some((c) => c.command === "STATUS" && /Projects/.test(c.data))).toBe(true);
    expect(commands.some((c) => c.mailbox === "Projects" && c.command === "UID FETCH")).toBe(false);
    t.ctl.setFlags(t.path, [t.target.uid], FLAGS, "set");
    await pass(t, t);
    await witness(t, t, FLAGS);
  });

  it.each(["INBOX", "Projects"].flatMap((path) => ["NO", "BAD"].map((status) => ({ path, status }))))
  ("preserves cached old bytes when $path UID SEARCH ALL returns $status", async ({ path, status }) => {
    const t = await setup(true, path);
    await t.stop();
    t.advance();
    t.ctl.setFlags(t.path, [t.target.uid], FLAGS, "set");
    const r = await t.open();
    const before = cursor(r, t.account.id).mailboxes[path];
    const refusal = t.w.server.script.add({ on: "command", command: "UID SEARCH", mailbox: path, match: / ALL\s*$/i,
      times: 1, send: `$TAG ${status} Synthetic enumeration refusal\r\n` });
    await bounded(r.backend.syncAccount(t.account.id), "refused sync");
    expect(refusal.hits).toBe(1);
    expect((await detail(r)).messages[0]).toMatchObject({ id: t.message.id, bodyText: t.message.bodyText, isRead: false });
    expect(await r.backend.store.providerStore(t.account.id).locations!.of([t.message.id])).toEqual([
      expect.objectContaining({ mailbox: t.path, uid: t.target.uid, uidvalidity: t.target.uidvalidity }),
    ]);
    expect(cursor(r, t.account.id).mailboxes[path]).toMatchObject({ uidvalidity: before!.uidvalidity, uidnext: before!.uidnext });
    if (path === "INBOX") expect(cursor(r, t.account.id).mailboxes[path]).toEqual(before);
    else expect(cursor(r, t.account.id).mailboxes[path]!.modseq).toBeUndefined();
    await r.stop();
    const durable = await t.open();
    expect((await detail(durable)).messages[0]).toMatchObject({ id: t.message.id, bodyText: t.message.bodyText, isRead: false });
    await pass(durable, t);
    await witness(durable, t, FLAGS);
  });

  it("a successful empty SEARCH still reconciles genuinely expunged cached mail", async () => {
    const t = await setup(true, "INBOX");
    await t.stop();
    t.advance();
    t.ctl.expungeMessages("INBOX", [t.target.uid, t.other.uid, t.never.uid]);
    const r = await t.open();
    await pass(r, t);
    // The first pass also visits the quiet custom folder on modulo four if needed.
    if (sqlDb(r.backend.store).get("SELECT id FROM messages LIMIT 1")) await pass(r, t);
    expect(t.w.responses.some((s) => /^\* SEARCH\s*\r?\n?$/.test(s))).toBe(true);
    expect(sqlDb(r.backend.store).all("SELECT id FROM messages")).toEqual([]);
    expect(await r.backend.store.providerStore(t.account.id).locations!.of([t.message.id])).toEqual([]);
    await r.stop();
    const durable = await t.open();
    expect(sqlDb(durable.backend.store).all("SELECT id FROM messages")).toEqual([]);
  });

  it("STATUS refusal forces a real check instead of masquerading as absent MODSEQ", async () => {
    const t = await setup();
    t.advance();
    t.ctl.setFlags(t.path, [t.target.uid], FLAGS, "set");
    const refusal = t.w.server.script.add({ on: "command", command: "STATUS", match: /Projects/, times: 1,
      send: "$TAG NO Synthetic STATUS refusal\r\n" });
    const commands = await pass(t, t);
    expect(refusal.hits).toBe(1);
    expect(commands.some((c) => c.mailbox === t.path && c.command === "UID FETCH")).toBe(true);
    expect(cursor(t, t.account.id).mailboxes.Projects!.modseq).toBe(String(t.ctl.getMailbox(t.path).highestModseq));
    await witness(t, t, FLAGS);
  });

  it("a custom-folder checkpoint does not acknowledge flags changed after its sweep", async () => {
    const t = await setup();
    t.advance();
    if ((cursor(t, t.account.id).pass + 2) % 4 === 0) await pass(t, t);
    // Force a sweep now; change a second flag only after its old snapshot has been consumed.
    t.ctl.setFlags(t.path, [t.target.uid], ["\\Seen"], "set");
    const snapshot = t.ctl.getMailbox(t.path).highestModseq;
    let changed = false;
    t.w.server.script.add({ on: "command", command: "UID SEARCH", mailbox: t.path, run: true, when(ctx) {
      if (!changed && / UID \d+:\*/i.test(ctx.data)) {
        changed = true;
        t.ctl.setFlags(t.path, [t.target.uid], FLAGS, "set");
      }
      return false;
    } });
    await pass(t, t);
    expect(changed).toBe(true);
    expect((await detail(t)).messages[0]).toMatchObject({ isRead: true, isStarred: false });
    expect(cursor(t, t.account.id).mailboxes.Projects!.modseq).toBe(String(snapshot));
    expect(t.ctl.getMailbox(t.path).highestModseq).toBeGreaterThan(snapshot!);
    expect((cursor(t, t.account.id).pass + 1) % 4).not.toBe(0);
    await pass(t, t);
    await witness(t, t, FLAGS);
    await t.stop();
    const durable = await t.open();
    await witness(durable, t, FLAGS);
  });

  it.each([true, false])("reidentifies the same cached old bytes in a new epoch with CONDSTORE=%s", async (condstore) => {
    const t = await setup(condstore);
    await t.stop();
    t.advance();
    const epoch = t.ctl.resetUidValidity(t.path, { uids: "keep" });
    t.ctl.setFlags(t.path, [t.target.uid], FLAGS, "set");
    const r = await t.open();
    const start = t.w.commands.length;
    await bounded(r.backend.syncAccount(t.account.id), "reset sync");
    expect(epoch.uidvalidity).not.toBe(t.target.uidvalidity);
    await witness(r, t, FLAGS, t.target.uid, epoch.uidvalidity);
    const commands = t.w.commands.slice(start);
    expect(commands.filter((c) => /BODY(?:\.PEEK)?\[\](?:<|\s|\))/.test(c.data))).toEqual([]);
    expect(commands.length).toBeLessThan(35);
    expect(t.w.overflow).toBe(false);
    await r.stop();
    const durable = await t.open();
    await witness(durable, t, FLAGS, t.target.uid, epoch.uidvalidity);
  });

  it("a reused old UID in a replacement epoch cannot borrow the cached identity/body", async () => {
    const t = await setup();
    await t.stop();
    t.advance();
    t.ctl.deleteMailbox(t.path);
    t.ctl.createMailbox(t.path);
    const epoch = t.ctl.resetUidValidity(t.path, { uidvalidity: t.target.uidvalidity + 10 });
    const replacementRaw = raw("replacement", t.now());
    const replacement = t.ctl.addMessage(t.path, { raw: replacementRaw, flags: FLAGS, internaldate: new Date(t.now()) });
    expect(replacement.uid).toBe(t.target.uid);
    const r = await t.open();
    await bounded(r.backend.syncAccount(t.account.id), "replacement sync");
    const rows = sqlDb(r.backend.store).all<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).not.toBe(t.message.id);
    expect((await r.client.call("threads.get", { threadId: rows[0]!.thread_id })).messages[0]).toMatchObject({ bodyText: "Exact replacement body\n", isRead: true, isStarred: true });
    expect(await r.backend.store.providerStore(t.account.id).locations!.of([rows[0]!.id])).toEqual([
      expect.objectContaining({ mailbox: t.path, uid: replacement.uid, uidvalidity: epoch.uidvalidity }),
    ]);
    expect(t.ctl.getMessage(t.path, replacement.uid).raw).toEqual(Buffer.from(replacementRaw));
    await r.stop();
    const durable = await t.open();
    expect(sqlDb(durable.backend.store).all("SELECT id, thread_id FROM messages")).toEqual(rows);
  });

  it.each([false, true])("a captured old observation preserves newer local star intent, acknowledged=%s", async (acknowledged) => {
    const t = await setup(true, "INBOX");
    t.advance();
    t.ctl.setFlags(t.path, [t.target.uid], ["\\Seen"], "set");
    const original = t.backend.store.sync.updateFlags.bind(t.backend.store.sync);
    const captured = deferred<void>(), release = deferred<void>();
    // Identity is now captured first. Gate the derived old payload immediately before its transaction.
    vi.spyOn(t.backend.store.sync, "updateFlags").mockImplementationOnce(async (...args) => {
      expect(args[1].find((update) => update.messageId === t.message.id)?.flags).toMatchObject({ isRead: true, isStarred: false });
      captured.resolve();
      await bounded(release.promise, "release old reconciliation");
      return original(...args);
    });
    const running = t.backend.syncAccount(t.account.id);
    try {
      await bounded(captured.promise, "old flags captured");
      await t.client.call("threads.act", { threadIds: [t.thread.id], action: "star" });
      if (acknowledged) {
        expect(await t.backend.runWorker()).toBe(1);
        expect((await t.backend.store.debug.snapshot()).ops[0]).toMatchObject({ kind: "star", state: "succeeded" });
        expect(t.ctl.getMessage(t.path, t.target.uid).flags.sort()).toEqual(FLAGS);
      }
    } finally { release.resolve(); await bounded(running, "old reconciliation finishes"); }
    expect.soft((await detail(t)).messages[0]).toMatchObject({ id: t.message.id, bodyText: t.message.bodyText, isStarred: true });
    if (!acknowledged) expect(await t.backend.runWorker()).toBe(1);
    await pass(t, t);
    expect.soft((await detail(t)).messages[0]).toMatchObject({ isRead: true, isStarred: true });
    await t.stop();
    const durable = await t.open();
    expect.soft((await detail(durable)).messages[0]).toMatchObject({ id: t.message.id, bodyText: t.message.bodyText, isRead: true, isStarred: true });
    // Location/raw witnesses remain independent of the effective-flag oracle.
    expect((await durable.backend.store.providerStore(t.account.id).locations!.of([t.message.id]))[0]).toMatchObject({ uid: t.target.uid, uidvalidity: t.target.uidvalidity });
    expect(t.ctl.getMessage(t.path, t.target.uid).flags.sort()).toEqual(FLAGS);
    expect(t.ctl.getMessage(t.path, t.target.uid).raw).toEqual(Buffer.from(t.targetRaw));
    expect(t.ctl.getMessage(t.path, t.other.uid).raw).toEqual(Buffer.from(t.otherRaw));
    if (!acknowledged) await witness(durable, t, FLAGS);
  });

  it("confirms unchanged ACK cache rows, then accepts a genuine external reversal after reopen", async () => {
    const t = await setup(true, "INBOX");
    t.advance();
    await t.client.call("threads.act", { threadIds: [t.thread.id], action: "star" });
    expect(await t.backend.runWorker()).toBe(1);
    const pending = () => t.backend.store.providerStore(t.account.id).pendingFlagSnapshots({ limit: 50 });
    expect((await pending()).items).toEqual([{ id: t.message.id, providerMsgId: t.providerId }]);
    await pass(t, t);
    expect((await pending()).items).toEqual([]);
    await witness(t, t, ["\\Flagged"]);
    await t.stop();
    const durable = await t.open();
    t.ctl.setFlags(t.path, [t.target.uid], ["\\Seen"], "set");
    for (let i = 0; i < 4; i++) await pass(durable, t);
    await witness(durable, t, ["\\Seen"]);
  });

  it.each(["UID", "FLAGS"] as const)("incomplete sweep %s evidence cannot retire acknowledged intent", async (missing) => {
    const t = await setup(true, "INBOX");
    t.advance();
    await t.client.call("threads.act", { threadIds: [t.thread.id], action: "star" });
    expect(await t.backend.runWorker()).toBe(1);
    const ctl = t.w.server.script.add({ on: "command", command: "UID FETCH", mailbox: t.path, times: 1,
      match: /\(UID FLAGS(?: MODSEQ)?\)/i,
      send: missing === "UID" ? "$TAG OK Synthetic omitted UID\r\n" : `* 1 FETCH (UID ${t.target.uid})\r\n$TAG OK Synthetic omitted FLAGS\r\n` });
    await bounded(t.backend.syncAccount(t.account.id), "incomplete final evidence");
    expect(ctl.hits).toBe(1);
    expect((await detail(t)).messages[0]).toMatchObject({ isStarred: true, bodyText: t.message.bodyText });
    expect((await t.backend.store.providerStore(t.account.id).pendingFlagSnapshots({ limit: 50 })).items).toHaveLength(1);
    await pass(t, t);
    expect((await t.backend.store.providerStore(t.account.id).pendingFlagSnapshots({ limit: 50 })).items).toEqual([]);
  });

  it("a failed location in a multi-location pass retains intent until complete evidence", async () => {
    const t = await setup(true, "INBOX");
    t.ctl.copyMessages("INBOX", [t.target.uid], "Projects");
    await bounded(t.backend.syncAccount(t.account.id), "discover second location");
    const locations = await t.backend.store.providerStore(t.account.id).locations.of([t.message.id]);
    expect(locations).toHaveLength(2);
    t.advance();
    await t.client.call("threads.act", { threadIds: [t.thread.id], action: "star" });
    expect(await t.backend.runWorker()).toBe(1);
    for (const location of locations) t.ctl.setFlags(location.mailbox, [location.uid], [], "set");
    const refusal = t.w.server.script.add({ on: "command", command: "UID SEARCH", mailbox: "Projects", match: / ALL\s*$/i, times: 1, send: "$TAG NO Synthetic partial location\r\n" });
    await bounded(t.backend.syncAccount(t.account.id), "partial multi-location pass");
    expect(refusal.hits).toBe(1);
    expect((await detail(t)).messages[0]).toMatchObject({ isStarred: true, bodyText: t.message.bodyText });
    expect((await t.backend.store.providerStore(t.account.id).pendingFlagSnapshots({ limit: 50 })).items).toHaveLength(1);
    await pass(t, t);
    expect((await detail(t)).messages[0]).toMatchObject({ isStarred: false, bodyText: t.message.bodyText });
    expect((await t.backend.store.providerStore(t.account.id).pendingFlagSnapshots({ limit: 50 })).items).toEqual([]);
    expect(await t.backend.store.providerStore(t.account.id).locations.of([t.message.id])).toHaveLength(2);
    await t.stop();
    const durable = await t.open();
    expect((await detail(durable)).messages[0]).toMatchObject({ id: t.message.id, isStarred: false, bodyText: t.message.bodyText });
  });

  it("a newer queued and acknowledged inverse fences the same captured observation", async () => {
    const t = await setup(true, "INBOX");
    t.advance();
    await t.client.call("threads.act", { threadIds: [t.thread.id], action: "star" });
    expect(await t.backend.runWorker()).toBe(1);
    const original = t.backend.store.sync.updateFlags.bind(t.backend.store.sync);
    const captured = deferred<void>(), release = deferred<void>();
    vi.spyOn(t.backend.store.sync, "updateFlags").mockImplementationOnce(async (...args) => {
      captured.resolve(); await bounded(release.promise, "release old star snapshot"); return original(...args);
    });
    const running = t.backend.syncAccount(t.account.id);
    try {
      await bounded(captured.promise, "old star snapshot captured");
      await t.client.call("threads.act", { threadIds: [t.thread.id], action: "unstar" });
      expect(await t.backend.runWorker()).toBe(1);
      expect(t.ctl.getMessage(t.path, t.target.uid).flags).toEqual([]);
    } finally { release.resolve(); await bounded(running, "old star snapshot finishes"); }
    expect((await detail(t)).messages[0]).toMatchObject({ isStarred: false, bodyText: t.message.bodyText });
    await pass(t, t);
    await witness(t, t, []);
    await t.stop(); const durable = await t.open(); await witness(durable, t, []);
  });

  it("drains three finite pages once, retaining a superseded first target and a new tail", async () => {
    const t = await setup(true, "INBOX");
    for (let i = 0; i < 123; i++) t.ctl.addMessage("INBOX", { raw: raw(`page-${i}`), internaldate: new Date(START - DAY) });
    await bounded(t.backend.syncAccount(t.account.id), "page fixture discovery");
    const messages = (await t.backend.store.debug.snapshot()).messages.filter((message) => message.subject !== "unrelated");
    expect(messages).toHaveLength(124);
    const tail = messages[messages.length - 1]!;
    const targets = messages.slice(0, -1);
    await t.backend.store.threads.act({ threadIds: targets.map((message) => message.threadId), action: "star", signal: null, now: t.now() });
    expect(await t.backend.runWorker()).toBe(1);
    t.advance();
    const original = t.backend.store.sync.updateFlags.bind(t.backend.store.sync);
    const visited: number[] = [];
    let edited = false;
    vi.spyOn(t.backend.store.sync, "updateFlags").mockImplementation(async (...args) => {
      const confirmed = args[1].filter((update) => update.expectedImapLocations);
      visited.push(...confirmed.map((update) => update.messageId));
      if (confirmed.length && !edited) {
        edited = true;
        for (const action of ["unstar", "star"] as const) {
          await t.backend.store.threads.act({ threadIds: [targets[0]!.threadId], action, signal: null, now: t.now() });
          expect(await t.backend.runWorker()).toBe(1);
        }
        await t.backend.store.threads.act({ threadIds: [tail.threadId], action: "star", signal: null, now: t.now() });
        expect(await t.backend.runWorker()).toBe(1);
      }
      return original(...args);
    });
    const start = t.w.commands.length;
    await bounded(t.backend.syncAccount(t.account.id), "finite three-page sync");
    expect(edited).toBe(true);
    expect(visited).toEqual(targets.map((message) => message.id));
    const pending = await t.backend.store.providerStore(t.account.id).pendingFlagSnapshots({ limit: 50 });
    expect(pending.items.map((item) => item.id)).toEqual([targets[0]!.id, tail.id]);
    expect(t.w.commands.slice(start).filter((command) => command.command === "UID SEARCH" && / ALL\s*$/i.test(command.data) && command.mailbox === "INBOX")).toHaveLength(1);
    expect(t.w.commands.slice(start).filter((command) => /BODY(?:\.PEEK)?\[|ENVELOPE|BODYSTRUCTURE/.test(command.data))).toEqual([]);
    await bounded(t.backend.syncAccount(t.account.id), "finish retained targets");
    expect((await t.backend.store.providerStore(t.account.id).pendingFlagSnapshots({ limit: 50 })).items).toEqual([]);
    expect((await t.backend.store.debug.snapshot()).messages.filter((message) => message.isStarred)).toHaveLength(124);
    expect(t.ctl.getMessage(t.path, t.target.uid).raw).toEqual(Buffer.from(t.targetRaw));
    expect((await t.backend.store.providerStore(t.account.id).locations.of([t.message.id]))[0]).toMatchObject({ uid: t.target.uid, uidvalidity: t.target.uidvalidity });
  });

  it("an omitted reset remapping UID cannot certify a surviving location's contradictory flags", async () => {
    const t = await setup(true, "INBOX");
    t.ctl.copyMessages("INBOX", [t.target.uid], "Projects");
    await bounded(t.backend.syncAccount(t.account.id), "discover reset copy");
    expect(await t.backend.store.providerStore(t.account.id).locations.of([t.message.id])).toHaveLength(2);
    t.advance();
    await t.client.call("threads.act", { threadIds: [t.thread.id], action: "star" });
    expect(await t.backend.runWorker()).toBe(1);
    t.ctl.setFlags("INBOX", [t.target.uid], [], "set");
    const epoch = t.ctl.resetUidValidity("Projects", { uids: "keep" });
    const omitted = t.w.server.script.add({ on: "command", command: "UID FETCH", mailbox: "Projects", match: /ENVELOPE/, times: 1, send: "$TAG OK Synthetic omitted remap UID\r\n" });
    await bounded(t.backend.syncAccount(t.account.id), "partial reset remapping");
    expect(omitted.hits).toBe(1);
    expect((await detail(t)).messages[0]).toMatchObject({ id: t.message.id, isStarred: true, bodyText: t.message.bodyText });
    expect((await t.backend.store.providerStore(t.account.id).pendingFlagSnapshots({ limit: 50 })).items).toHaveLength(1);
    await bounded(t.backend.syncAccount(t.account.id), "complete reset remapping");
    expect(await t.backend.store.providerStore(t.account.id).locations.of([t.message.id])).toEqual(expect.arrayContaining([
      expect.objectContaining({ mailbox: "Projects", uidvalidity: epoch.uidvalidity }),
      expect.objectContaining({ mailbox: "INBOX", uidvalidity: t.target.uidvalidity }),
    ]));
    expect((await detail(t)).messages[0]).toMatchObject({ id: t.message.id, isStarred: true, bodyText: t.message.bodyText });
    await t.stop(); const durable = await t.open();
    expect((await detail(durable)).messages[0]).toMatchObject({ id: t.message.id, isStarred: true, bodyText: t.message.bodyText });
  });

  it("a MOVE after destination coverage verifies synthetic COPYUID flags before confirming independent intent", async () => {
    const t = await setup(true, "INBOX");
    t.advance();
    for (const action of ["star", "markRead"] as const) await t.client.call("threads.act", { threadIds: [t.thread.id], action });
    expect(await t.backend.runWorker()).toBe(2);
    const original = t.backend.store.sync.updateFlags.bind(t.backend.store.sync);
    const captured = deferred<void>(), release = deferred<void>();
    vi.spyOn(t.backend.store.sync, "updateFlags").mockImplementationOnce(async (...args) => {
      captured.resolve(); await bounded(release.promise, "release pre-MOVE observation"); return original(...args);
    });
    const running = t.backend.syncAccount(t.account.id);
    try {
      await bounded(captured.promise, "mailbox coverage complete before MOVE");
      await t.client.call("threads.act", { threadIds: [t.thread.id], action: "archive" });
      expect(await t.backend.runWorker()).toBe(1);
      expect(await t.backend.store.providerStore(t.account.id).locations.of([t.message.id])).toEqual([
        expect.objectContaining({ mailbox: "Archive", flags: "[]" }),
      ]);
    } finally { release.resolve(); await bounded(running, "post-MOVE reconciliation"); }
    expect((await detail(t)).messages[0]).toMatchObject({ id: t.message.id, isRead: true, isStarred: true, bodyText: t.message.bodyText });
    expect(t.ctl.listMessages("Archive")[0]!.flags.sort()).toEqual(FLAGS);
    const moved = t.ctl.listMessages("Archive")[0]!;
    expect(t.ctl.getMessage("Archive", moved.uid).raw).toEqual(Buffer.from(t.targetRaw));
    expect(sqlDb(t.backend.store).get("SELECT in_inbox FROM messages WHERE id=?", t.message.id)).toEqual({ in_inbox: 0 });
    await bounded(t.backend.syncAccount(t.account.id), "confirm moved intent");
    expect((await t.backend.store.providerStore(t.account.id).pendingFlagSnapshots({ limit: 50 })).items).toEqual([]);
    await t.stop(); const durable = await t.open();
    expect((await detail(durable)).messages[0]).toMatchObject({ id: t.message.id, isRead: true, isStarred: true, bodyText: t.message.bodyText });
  });

  it("a provider reset after swept FLAGS discards that generation before final delivery", async () => {
    const t = await setup(true, "INBOX");
    t.advance();
    await t.client.call("threads.act", { threadIds: [t.thread.id], action: "star" });
    expect(await t.backend.runWorker()).toBe(1);
    const store = t.backend.store.providerStore(t.account.id);
    const readLocations = store.locations.of.bind(store.locations);
    const captured = deferred<void>(), release = deferred<void>();
    vi.spyOn(store.locations, "of").mockImplementationOnce(async (ids) => {
      const result = await readLocations(ids);
      captured.resolve(); await bounded(release.promise, "release retired generation"); return result;
    });
    const updates = t.backend.store.sync.updateFlags.bind(t.backend.store.sync);
    const confirmed: boolean[] = [];
    vi.spyOn(t.backend.store.sync, "updateFlags").mockImplementation(async (...args) => {
      for (const update of args[1]) if (update.messageId === t.message.id && update.expectedImapLocations) confirmed.push(update.flags.isStarred!);
      return updates(...args);
    });
    const running = t.backend.syncAccount(t.account.id);
    try {
      await bounded(captured.promise, "swept FLAGS before reset");
      (await t.backend.provider(t.account.id))!.reset!();
      t.ctl.setFlags(t.path, [t.target.uid], [], "set");
    } finally { release.resolve(); await bounded(running, "fresh generation retry"); }
    expect(confirmed).toEqual([false]);
    expect((await t.backend.store.providerStore(t.account.id).pendingFlagSnapshots({ limit: 50 })).items).toEqual([]);
    await witness(t, t, []);
  });

});
