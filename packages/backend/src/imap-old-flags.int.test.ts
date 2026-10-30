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
    const store = t.backend.store.providerStore(t.account.id);
    const original = store.providerIds.bind(store);
    const captured = deferred<void>(), release = deferred<void>();
    // reconcileMessages has already captured location flags when it awaits provider IDs.
    vi.spyOn(store, "providerIds").mockImplementationOnce(async (ids) => {
      const result = await original(ids);
      captured.resolve();
      await bounded(release.promise, "release old reconciliation");
      return result;
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
    // Location/raw witnesses still run when the intentionally unmarked ACK spec is red.
    expect((await durable.backend.store.providerStore(t.account.id).locations!.of([t.message.id]))[0]).toMatchObject({ uid: t.target.uid, uidvalidity: t.target.uidvalidity });
    expect(t.ctl.getMessage(t.path, t.target.uid).flags.sort()).toEqual(FLAGS);
    expect(t.ctl.getMessage(t.path, t.target.uid).raw).toEqual(Buffer.from(t.targetRaw));
    expect(t.ctl.getMessage(t.path, t.other.uid).raw).toEqual(Buffer.from(t.otherRaw));
    if (!acknowledged) await witness(durable, t, FLAGS);
  });

});
