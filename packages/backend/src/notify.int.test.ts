/**
 * Plan 41 through the real Backend (node:sqlite): a scripted provider hands
 * passes of mail to the sync sink, live or not, and a fake host records the
 * badge and the notices. Timing (gather, gap) is unit-tested in attention.test.ts.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAi, promptText, type AiOptions, type Completion, type CompletionRequest, type ProviderConfig } from "@terno/ai";
import { dayKeyOf, type MailNotice } from "@terno/core";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createAccount, sqlDb, type IncomingMessage } from "@terno/db";
import type { ProviderRegistry } from "@terno/mail";
import { afterEach, describe, expect, it } from "vitest";
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

async function setup(passes: Parameters<typeof scripted>[0], dir = mkdtempSync(join(tmpdir(), "terno-notify-")), keep = false, ai?: { answer(req: CompletionRequest): Promise<Completion> }) {
  const badges: number[] = [];
  const notices: MailNotice[] = [];
  // plan 273: a scripted model, for What matters
  const aiFactory = ai && ((config: ProviderConfig, options: AiOptions) => createAi(config, { ...options, transport: { complete: (req) => ai.answer(req) } }));
  const backend = new Backend({
    dbPath: join(dir, "terno.db"),
    version: "test",
    cipher: plaintextCipher,
    providers: scripted(passes),
    autoSync: false,
    attention: { badge: (c) => badges.push(c), notify: (x) => notices.push(x) },
    ...(aiFactory && { demoAi: true, aiFactory }),
  });
  noGather(backend);
  await backend.store.ready;
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

type Looking = { timers: unknown; screening: Promise<void>; timer: unknown; flushing: Promise<void> | null };
/** attention.test proves how long the gather is; here it's over at once, and a test waits for the look itself */
function noGather(backend: Backend) {
  (backend.attention as unknown as Looking).timers = { setTimeout: (fn: () => void) => setTimeout(fn, 0), clearTimeout, now: Date.now };
}
const settle = async (backend: Backend) => {
  const attention = backend.attention as unknown as Looking;
  await attention.screening;
  await expect.poll(() => attention.timer === null && attention.flushing === null, { interval: 5 }).toBe(true);
};

describe("notifications through the backend (plan 41)", () => {
  it("the first pass notifies nothing (even live mail); the next pass's important mail notifies once; what isn't important or isn't news stays quiet", async () => {
    const t = await setup([
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
    const accountId = createAccount(sqlDb(t.backend.store), { kind: "imap", email: ME, displayName: "Me", color: "brown" }).id;
    await t.backend.store.filters.save({ name: "receipts", enabled: true, source: "manual", rule: { match: "all", conditions: [{ field: "subject", op: "contains", value: "receipt" }], actions: [{ type: "archive" }] } }, Date.now());
    await t.backend.start();
    await t.backend.syncAccount(accountId);
    await settle(t.backend);
    expect(t.notices).toEqual([]);

    await t.backend.syncAccount(accountId);
    await settle(t.backend);
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]).toMatchObject({ count: 1, senders: ["Carlos Ruiz"], subject: "Presupuesto", snippet: "Te mando el presupuesto." });
    // desktop: the host shows it; nothing goes to the page
    expect(t.pageNotices).toEqual([]);
  });

  it("mail a primed account inserts without the provider calling it live (a resync, a reset) notifies nothing", async () => {
    const t = await setup([
      { messages: (a) => wroteToCarlos(a), live: false },
      { messages: (a) => [mail(a)], live: false },
    ]);
    const accountId = createAccount(sqlDb(t.backend.store), { kind: "imap", email: ME, displayName: "Me", color: "brown" }).id;
    await t.backend.start();
    await t.backend.syncAccount(accountId);
    await t.backend.syncAccount(accountId);
    await settle(t.backend);
    expect(t.notices).toEqual([]);
  });

  it("a restarted backend's first pass is quiet (no catch-up at launch); its badge comes back at start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terno-notify-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const first = await setup([{ messages: (a) => [...wroteToCarlos(a), mail(a), mail(a)], live: false }], dir, true);
    const accountId = createAccount(sqlDb(first.backend.store), { kind: "imap", email: ME, displayName: "Me", color: "brown" }).id;
    await first.backend.start();
    await first.backend.syncAccount(accountId);
    await expect.poll(() => first.badges.at(-1)).toBe(2);
    await first.backend.stop();

    const second = await setup([{ messages: (a) => [mail(a)], live: true }], dir, true);
    await second.backend.start();
    await expect.poll(() => second.badges[0]).toBe(2);
    await second.backend.syncAccount(accountId);
    await settle(second.backend);
    expect(second.notices).toEqual([]);
    await expect.poll(() => second.badges.at(-1)).toBe(3);
  });

  it("the badge follows the Inbox's unread count: a read lowers it, turning it off clears it", async () => {
    const t = await setup([{ messages: (a) => [mail(a), mail(a)], live: false }]);
    const accountId = createAccount(sqlDb(t.backend.store), { kind: "imap", email: ME, displayName: "Me", color: "brown" }).id;
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
    noGather(backend);
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId: "renderer", origin: "renderer" });
    const client = new RpcClient(c);
    client.on("notify", (x) => pageNotices.push(x));
    cleanups.push(async () => {
      await backend.stop().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    });
    await backend.store.ready;
    const accountId = createAccount(sqlDb(backend.store), { kind: "imap", email: ME, displayName: "Me", color: "brown" }).id;
    await client.call("settings.update", { notificationPreview: false });
    await backend.start();
    await backend.syncAccount(accountId);
    await backend.syncAccount(accountId);
    await settle(backend);
    expect(pageNotices).toHaveLength(1);
    expect(pageNotices[0]).toMatchObject({ count: 1, senders: [], subject: "", snippet: "" });
    expect(JSON.stringify(pageNotices[0])).not.toMatch(/Carlos|Secreto/);
  });

  it("notifications off: a live pass reads nothing", async () => {
    const t = await setup([
      { messages: (a) => wroteToCarlos(a), live: false },
      { messages: (a) => [mail(a)], live: true },
    ]);
    const accountId = createAccount(sqlDb(t.backend.store), { kind: "imap", email: ME, displayName: "Me", color: "brown" }).id;
    await t.client.call("settings.update", { notifications: false });
    await t.backend.start();
    let reads = 0;
    const arrivals = t.backend.store.sync.arrivals.bind(t.backend.store.sync);
    t.backend.store.sync.arrivals = async (ids) => (reads++, arrivals(ids));
    await t.backend.syncAccount(accountId);
    await t.backend.syncAccount(accountId);
    await settle(t.backend);
    expect(reads).toBe(0);
    expect(t.notices).toEqual([]);
  });
});

describe("plan 273: with What matters first, notifications follow it", () => {
  const ASK = "¿Me mandas el presupuesto antes del viernes?";
  it("Gmail's Important job alert says nothing, a person waiting on you is said, a bill due today once the reader finds it; the Inbox first, plan 41's rule", async () => {
    const today = new Date();
    const dueWords = today.toLocaleDateString("en-US", { month: "long", day: "numeric" });
    const billText = `Your electricity bill of $54.20 is due on ${dueWords}.`;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const ai = {
      answer: async (req: CompletionRequest): Promise<Completion> => {
        const prompt = promptText(req.messages[0]!.content);
        const items = (list: object[]): Completion => ({ text: JSON.stringify({ items: list, settled: [], moved: [], replaced: [] }), stop: "end" });
        // Carlos asks something (a reading that found nothing asked takes his conversation out of Waiting on you)
        if (prompt.includes(ASK)) return items([{ kind: "ask", text: "Send Carlos the budget", quote: ASK, due: null, time: null }]);
        if (!prompt.includes("electricity")) return items([]);
        await held;
        return items([{ kind: "pay", text: "Pay the electricity bill", quote: `due on ${dueWords}`, due: dayKeyOf(today.getTime()), time: null }]);
      },
    };
    // the reported mail: Gmail Important, in Updates, bulk, no List-Id
    const alert = (a: number, subject: string) => mail(a, { from: { name: "LinkedIn Job Alerts", email: "jobalerts-noreply@linkedin.com" }, subject, gmailLabels: ["IMPORTANT", "CATEGORY_UPDATES", "INBOX"], bulk: true, date: Date.now() });
    const t = await setup(
      [
        { messages: (a) => wroteToCarlos(a), live: true },
        {
          live: true,
          messages: (a) => [
            alert(a, "Pasito is hiring a Fullstack Engineer"),
            mail(a, { subject: "Presupuesto", bodyText: ASK, snippet: ASK, date: Date.now() }),
            mail(a, { from: { name: "Power Co", email: "billing@power.test" }, subject: "Your bill", bodyText: billText, snippet: billText, date: Date.now() }),
          ],
        },
        { messages: (a) => [alert(a, "Acme is hiring")], live: true },
      ],
      undefined,
      false,
      ai,
    );
    const accountId = createAccount(sqlDb(t.backend.store), { kind: "gmail", email: ME, displayName: "Me", color: "brown" }).id;
    await t.client.call("settings.update", { ai: { provider: "fake", model: "demo" } });
    await t.client.call("settings.update", { firstScreen: "whatMatters" });
    await t.backend.start();
    await t.backend.syncAccount(accountId);
    await settle(t.backend);
    expect((await t.client.call("counts.get", {})).today).not.toBeUndefined();

    await t.backend.syncAccount(accountId);
    await settle(t.backend);
    // Carlos waits on you; the alert isn't What matters'; the bill is still being read
    expect(t.notices.map((x) => x.subject)).toEqual(["Presupuesto"]);
    release();
    await expect.poll(() => t.notices.map((x) => x.subject), { timeout: 10_000 }).toEqual(["Presupuesto", "Your bill"]);
    expect(t.notices[1]).toMatchObject({ count: 1, senders: ["Power Co"] });

    // the Inbox first: plan 41's rule says Gmail's Important alert
    await t.client.call("settings.update", { firstScreen: "inbox" });
    await t.backend.syncAccount(accountId);
    await settle(t.backend);
    expect(t.notices.map((x) => x.subject)).toEqual(["Presupuesto", "Your bill", "Acme is hiring"]);
  });
});

