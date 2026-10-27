/**
 * Plan 41 through the real Backend (node:sqlite): a scripted provider hands
 * passes of mail to the sync sink, live or not, and a fake host records the
 * badge and the notices. Timing (gather, gap) is unit-tested in attention.test.ts.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MailNotice } from "@terno/core";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createAccount, sqlDb, type IncomingMessage } from "@terno/db";
import type { ProviderRegistry } from "@terno/mail";
import { afterEach, describe, expect, it } from "vitest";
import { GATHER_MS } from "./attention";
import { Backend, plaintextCipher } from "./backend";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const ME = "me@example.com";

/** Each sync pass takes the next scripted batch: messages and whether the provider calls them live. */
function scripted(passes: { messages: (accountId: number) => IncomingMessage[]; live: boolean }[]): ProviderRegistry {
  return {
    create(ctx) {
      return {
        async verify() {},
        async sync(sink) {
          const next = passes.shift();
          if (next) await sink.ingest(next.messages(ctx.account.id), { live: next.live });
        },
        async execute() {},
        async close() {},
      };
    },
    async verifyImap() {},
    async connectGmail() {
      throw new Error("not in tests");
    },
  };
}

let n = 0;
function mail(accountId: number, over: Partial<IncomingMessage> = {}): IncomingMessage {
  n++;
  return {
    accountId, providerMsgId: `p${n}`, providerThreadId: null, rfcMessageId: `m${n}@x`, inReplyTo: null, references: [],
    from: { name: "Carlos Ruiz", email: "carlos@acme.com" }, to: [{ name: "Me", email: ME }], cc: [], bcc: [],
    subject: `Subject ${n}`, date: Date.now() - 60_000, snippet: `Snippet ${n}`, bodyText: "hola", bodyHtml: null, bodyState: "full", listId: null,
    isRead: false, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 10,
    ...over,
  };
}

/** you wrote to Carlos once: he is someone you have written to */
const wroteToCarlos = (a: number) => [mail(a, { from: { name: "Me", email: ME }, to: [{ name: "Carlos", email: "carlos@acme.com" }], isSent: true, inInbox: false, isRead: true, date: Date.now() - 86_400_000 * 3 })];

function setup(passes: Parameters<typeof scripted>[0], dir = mkdtempSync(join(tmpdir(), "terno-notify-")), keep = false) {
  const badges: number[] = [];
  const notices: MailNotice[] = [];
  const backend = new Backend({
    dbPath: join(dir, "terno.db"),
    version: "test",
    cipher: plaintextCipher,
    providers: scripted(passes),
    autoSync: false,
    attention: { badge: (c) => badges.push(c), notify: (x) => notices.push(x) },
  });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "renderer", origin: "renderer" });
  const client = new RpcClient(c);
  const pageNotices: MailNotice[] = [];
  client.on("notify", (x) => pageNotices.push(x));
  cleanups.push(async () => {
    await backend.stop().catch(() => {});
    if (!keep) rmSync(dir, { recursive: true, force: true });
  });
  return { backend, client, badges, notices, pageNotices, dir };
}

const settle = () => new Promise((r) => setTimeout(r, GATHER_MS + 300));

describe("notifications through the backend (plan 41)", () => {
  it("the first pass notifies nothing (even live mail); the next pass's important mail notifies once; what isn't important or isn't news stays quiet", async () => {
    const t = setup([
      { messages: (a) => [...wroteToCarlos(a), mail(a)], live: true },
      {
        live: true,
        messages: (a) => [
          mail(a, { subject: "Presupuesto", snippet: "Te mando el presupuesto." }),
          mail(a, { isRead: true, subject: "read on the phone" }),
          mail(a, { isSpam: true, inInbox: false, subject: "spam" }),
          mail(a, { from: { name: "Me", email: ME }, to: [{ name: "Carlos", email: "carlos@acme.com" }], isSent: true, inInbox: true, subject: "my own" }),
          mail(a, { from: { name: "Boletín", email: "boletin@xataka.com" }, listId: "boletin.xataka.com", subject: "list" }),
          mail(a, { from: { name: "Stranger", email: "someone@else.example" }, subject: "cold" }),
          mail(a, { subject: "receipt to archive" }),
        ],
      },
    ]);
    const accountId = createAccount(sqlDb(t.backend.store), { kind: "imap", email: ME, displayName: "Me", color: "indigo" }).id;
    await t.backend.store.filters.save({ name: "receipts", enabled: true, source: "manual", rule: { match: "all", conditions: [{ field: "subject", op: "contains", value: "receipt" }], actions: [{ type: "archive" }] } }, Date.now());
    await t.backend.start();
    await t.backend.syncAccount(accountId);
    await settle();
    expect(t.notices).toEqual([]);

    await t.backend.syncAccount(accountId);
    await settle();
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]).toMatchObject({ count: 1, senders: ["Carlos Ruiz"], subject: "Presupuesto", snippet: "Te mando el presupuesto." });
    // desktop: the host shows it; nothing goes to the page
    expect(t.pageNotices).toEqual([]);
  });

  it("mail a primed account inserts without the provider calling it live (a resync, a reset) notifies nothing", async () => {
    const t = setup([
      { messages: (a) => wroteToCarlos(a), live: false },
      { messages: (a) => [mail(a)], live: false },
    ]);
    const accountId = createAccount(sqlDb(t.backend.store), { kind: "imap", email: ME, displayName: "Me", color: "indigo" }).id;
    await t.backend.start();
    await t.backend.syncAccount(accountId);
    await t.backend.syncAccount(accountId);
    await settle();
    expect(t.notices).toEqual([]);
  });

  it("a restarted backend's first pass is quiet (no catch-up at launch); its badge comes back at start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terno-notify-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const first = setup([{ messages: (a) => [...wroteToCarlos(a), mail(a), mail(a)], live: false }], dir, true);
    const accountId = createAccount(sqlDb(first.backend.store), { kind: "imap", email: ME, displayName: "Me", color: "indigo" }).id;
    await first.backend.start();
    await first.backend.syncAccount(accountId);
    await expect.poll(() => first.badges.at(-1)).toBe(2);
    await first.backend.stop();

    const second = setup([{ messages: (a) => [mail(a)], live: true }], dir, true);
    await second.backend.start();
    await expect.poll(() => second.badges[0]).toBe(2);
    await second.backend.syncAccount(accountId);
    await settle();
    expect(second.notices).toEqual([]);
    await expect.poll(() => second.badges.at(-1)).toBe(3);
  });

  it("the badge follows the Inbox's unread count: a read lowers it, turning it off clears it", async () => {
    const t = setup([{ messages: (a) => [mail(a), mail(a)], live: false }]);
    const accountId = createAccount(sqlDb(t.backend.store), { kind: "imap", email: ME, displayName: "Me", color: "indigo" }).id;
    await t.backend.start();
    expect(t.badges).toEqual([0]);
    await t.backend.syncAccount(accountId);
    await expect.poll(() => t.badges.at(-1)).toBe(2);
    const inbox = await t.client.call("threads.list", { view: "inbox" });
    await t.client.call("threads.act", { threadIds: [inbox.items[0]!.id], action: "markRead" });
    await expect.poll(() => t.badges.at(-1)).toBe(1);
    await t.client.call("settings.update", { dockBadge: false });
    expect(t.badges.at(-1)).toBe(0);
    await t.client.call("settings.update", { dockBadge: true });
    expect(t.badges.at(-1)).toBe(1);
  });

  it("without a host (the web) the notice goes to the page; preview off, it carries nothing but the count", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terno-notify-"));
    const pageNotices: MailNotice[] = [];
    const passes = [
      { messages: (a: number) => wroteToCarlos(a), live: false },
      { messages: (a: number) => [mail(a, { subject: "Secreto" })], live: true },
    ];
    const backend = new Backend({ dbPath: join(dir, "terno.db"), version: "test", cipher: plaintextCipher, providers: scripted(passes), autoSync: false });
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId: "renderer", origin: "renderer" });
    const client = new RpcClient(c);
    client.on("notify", (x) => pageNotices.push(x));
    cleanups.push(async () => {
      await backend.stop().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    });
    const accountId = createAccount(sqlDb(backend.store), { kind: "imap", email: ME, displayName: "Me", color: "indigo" }).id;
    await client.call("settings.update", { notificationPreview: false });
    await backend.start();
    await backend.syncAccount(accountId);
    await backend.syncAccount(accountId);
    await settle();
    expect(pageNotices).toHaveLength(1);
    expect(pageNotices[0]).toMatchObject({ count: 1, senders: [], subject: "", snippet: "" });
    expect(JSON.stringify(pageNotices[0])).not.toMatch(/Carlos|Secreto/);
  });

  it("notifications off: a live pass reads nothing", async () => {
    const t = setup([
      { messages: (a) => wroteToCarlos(a), live: false },
      { messages: (a) => [mail(a)], live: true },
    ]);
    const accountId = createAccount(sqlDb(t.backend.store), { kind: "imap", email: ME, displayName: "Me", color: "indigo" }).id;
    await t.client.call("settings.update", { notifications: false });
    await t.backend.start();
    let reads = 0;
    const arrivals = t.backend.store.sync.arrivals.bind(t.backend.store.sync);
    t.backend.store.sync.arrivals = async (ids) => (reads++, arrivals(ids));
    await t.backend.syncAccount(accountId);
    await t.backend.syncAccount(accountId);
    await settle();
    expect(reads).toBe(0);
    expect(t.notices).toEqual([]);
  });
});
