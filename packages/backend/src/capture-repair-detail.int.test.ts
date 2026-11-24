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

async function setup(provider: Partial<MailProvider>) {
  const dir = mkdtempSync(join(tmpdir(), "terno-repair-detail-"));
  const providers = {
    create: () => ({ async verify() {}, async sync() {}, async close() {}, ...provider }) as unknown as MailProvider,
    async verifyImap() {}, async connectGmail() { throw new Error("Unexpected OAuth"); },
  } as unknown as ProviderRegistry;
  const backend = new Backend({ dbPath: join(dir, "mail.db"), providers, cipher: plaintextCipher, version: "test", autoSync: false, instantSearch: false, iconTransport: null, repairDetailMs: 300 });
  await backend.ready;
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "repairs", origin: "renderer" });
  const client = new RpcClient(c);
  cleanup.push(async () => { client.close(); await backend.stop(); rmSync(dir, { recursive: true, force: true }); });
  const { account } = await backend.store.accounts.create({ kind: "gmail", email: "me@example.test", displayName: "Me", color: "brown", providerConfig: {}, now: 1 });
  return { backend, client, account, list: () => client.call("captureRepairs.list", { accountId: account.id }) };
}
const block = (t: Awaited<ReturnType<typeof setup>>, ids: string[]) => Promise.all(ids.map((id) => t.backend.store.captureRepairs.block(t.account.id, { kind: "gmail", providerId: id }, "mime-headers", 0)));
const id = (r: { locator: { kind: string } }) => (r.locator as unknown as { providerId: string }).providerId;

it("reads each Gmail repair's message once, keeps it, and shows the page whatever the reads say", async () => {
  const describe = vi.fn<NonNullable<MailProvider["describe"]>>(async (pid) => {
    if (pid === "failing") throw new Error("synthetic network failure");
    return pid === "known" ? { subject: "Quarterly report", from: "Ana", date: 5 } : undefined;
  });
  const t = await setup({ describe });
  await block(t, ["known", "unreadable", "failing"]);
  expect((await t.list()).items.map((r) => [id(r), r.detail])).toEqual([["failing", undefined], ["known", { subject: "Quarterly report", from: "Ana", date: 5 }], ["unreadable", undefined]]);
  expect(describe).toHaveBeenCalledTimes(3);
  describe.mockClear();
  await t.list();
  expect(describe.mock.calls.map(([pid]) => pid).sort()).toEqual(["failing", "unreadable"]);
});

it("returns the page at the deadline when a read never answers, and a late answer writes nothing", async () => {
  let answer!: (d: { subject: string }) => void;
  const t = await setup({ describe: () => new Promise((resolve) => { answer = resolve; }) });
  await block(t, ["slow"]);
  const started = Date.now();
  expect((await t.list()).items.map((r) => r.detail)).toEqual([undefined]);
  expect(Date.now() - started).toBeLessThan(5000);
  answer({ subject: "Late" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect((await t.backend.store.captureRepairs.list(t.account.id)).items[0]!.detail).toBeUndefined();
});

it("keeps nothing read under other credentials, and shows a row as another window left it", async () => {
  const t = await setup({});
  await block(t, ["a-retried", "b-renewed"]);
  const core = t.backend as unknown as { credentials: Map<number, number> };
  const provider = await (t.backend as unknown as { provider(id: number): Promise<MailProvider> }).provider(t.account.id);
  provider.describe = async (pid) => {
    if (pid === "b-renewed") core.credentials.set(t.account.id, (core.credentials.get(t.account.id) ?? 0) + 1);
    else {
      const row = (await t.backend.store.captureRepairs.list(t.account.id)).items.find((r) => id(r) === "a-retried")!;
      await t.backend.store.captureRepairs.retry(t.account.id, row.key, row.revision);
    }
    return { subject: `Subject of ${pid}` };
  };
  const page = await t.list();
  expect(page.items.map((r) => [id(r), r.state, r.revision, r.detail])).toEqual([["a-retried", "pending", 1, undefined], ["b-renewed", "blocked", 0, undefined]]);
});

it("reads for one opening at a time: a second window's opening just lists", async () => {
  let release!: () => void;
  const describe = vi.fn<NonNullable<MailProvider["describe"]>>(() => new Promise((resolve) => { release = () => resolve({ subject: "Once" }); }));
  const t = await setup({ describe });
  await block(t, ["one"]);
  const first = t.list();
  await vi.waitFor(() => expect(describe).toHaveBeenCalledTimes(1));
  expect((await t.list()).items[0]!.detail).toBeUndefined();
  release();
  expect((await first).items[0]!.detail).toEqual({ subject: "Once" });
  expect(describe).toHaveBeenCalledTimes(1);
});

it("a search hit the parser refuses becomes a repair, never the end of the other hits", async () => {
  const t = await setup({
    async fetchHits(_hits, sink) {
      await sink.blockCapture!({ kind: "gmail", providerId: "hit" }, "mime-addresses", 0);
    },
  });
  await t.backend.fetchHitsForAccount(t.account.id, [{ id: "hit", date: 1 }], new AbortController().signal, () => {});
  expect((await t.backend.store.captureRepairs.list(t.account.id)).items.map((r) => [id(r), r.reason])).toEqual([["hit", "mime-addresses"]]);
});
