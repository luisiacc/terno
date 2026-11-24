/** Plan 267: opening the repairs list says which Gmail messages they are, read once from Gmail and kept. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import type { MailProvider, ProviderRegistry } from "@terno/mail";
import { afterEach, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanup.splice(0).reverse()) await c(); });

async function setup(describe: MailProvider["describe"]) {
  const dir = mkdtempSync(join(tmpdir(), "terno-repair-detail-"));
  const providers = {
    create: () => ({ describe, async verify() {}, async sync() {}, async close() {} }) as unknown as MailProvider,
    async verifyImap() {}, async connectGmail() { throw new Error("Unexpected OAuth"); },
  } as unknown as ProviderRegistry;
  const backend = new Backend({ dbPath: join(dir, "mail.db"), providers, cipher: plaintextCipher, version: "test", autoSync: false, instantSearch: false, iconTransport: null });
  await backend.ready;
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "repairs", origin: "renderer" });
  const client = new RpcClient(c);
  cleanup.push(async () => { client.close(); await backend.stop(); rmSync(dir, { recursive: true, force: true }); });
  const { account } = await backend.store.accounts.create({ kind: "gmail", email: "me@example.test", displayName: "Me", color: "brown", providerConfig: {}, now: 1 });
  for (const id of ["known", "unreadable", "failing"]) await backend.store.captureRepairs.block(account.id, { kind: "gmail", providerId: id }, "mime-headers", 0);
  return { backend, client, account };
}

it("reads each Gmail repair's message once, keeps it, and shows the page whatever the reads say", async () => {
  const describe = vi.fn<NonNullable<MailProvider["describe"]>>(async (id) => {
    if (id === "failing") throw new Error("synthetic network failure");
    return id === "known" ? { subject: "Quarterly report", from: "Ana", date: 5 } : undefined;
  });
  const t = await setup(describe);
  const first = await t.client.call("captureRepairs.list", { accountId: t.account.id });
  expect(first.items.map((r) => [r.locator.kind === "gmail" && r.locator.providerId, r.detail])).toEqual([
    ["failing", undefined], ["known", { subject: "Quarterly report", from: "Ana", date: 5 }], ["unreadable", undefined],
  ]);
  expect(describe).toHaveBeenCalledTimes(3);
  // kept: the next opening asks Gmail only about the two it couldn't name
  describe.mockClear();
  const second = await t.client.call("captureRepairs.list", { accountId: t.account.id });
  expect(second.items.find((r) => r.detail)?.detail).toEqual({ subject: "Quarterly report", from: "Ana", date: 5 });
  expect(describe.mock.calls.map(([id]) => id).sort()).toEqual(["failing", "unreadable"]);
});
