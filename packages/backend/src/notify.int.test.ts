/**
 * Plan 38 through the real Backend (node:sqlite): a scripted provider hands
 * passes of mail to the sync sink, and a fake host records the badge.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** Each sync pass takes the next scripted batch. */
function scripted(passes: { messages: (accountId: number) => IncomingMessage[] }[]): ProviderRegistry {
  return {
    create(ctx) {
      return {
        async verify() {},
        async sync(sink) {
          const next = passes.shift();
          if (next) await sink.ingest(next.messages(ctx.account.id));
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

function setup(passes: Parameters<typeof scripted>[0], dir = mkdtempSync(join(tmpdir(), "terno-notify-")), keep = false) {
  const badges: number[] = [];
  const backend = new Backend({ dbPath: join(dir, "terno.db"), version: "test", cipher: plaintextCipher, providers: scripted(passes), autoSync: false, attention: { badge: (c) => badges.push(c) } });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "renderer", origin: "renderer" });
  const client = new RpcClient(c);
  cleanups.push(async () => {
    await backend.stop().catch(() => {});
    if (!keep) rmSync(dir, { recursive: true, force: true });
  });
  return { backend, client, badges, dir };
}

describe("the Dock badge through the backend (plan 38)", () => {
  it("follows the Inbox's unread count: a read lowers it, turning it off clears it", async () => {
    const t = setup([{ messages: (a) => [mail(a), mail(a)] }]);
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

  it("a restarted backend puts the badge back at start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terno-notify-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const first = setup([{ messages: (a) => [mail(a), mail(a)] }], dir, true);
    const accountId = createAccount(sqlDb(first.backend.store), { kind: "imap", email: ME, displayName: "Me", color: "indigo" }).id;
    await first.backend.start();
    await first.backend.syncAccount(accountId);
    await expect.poll(() => first.badges.at(-1)).toBe(2);
    await first.backend.stop();
    const second = setup([], dir, true);
    await second.backend.start();
    await expect.poll(() => second.badges[0]).toBe(2);
  });
});
