import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createRegistry, ProviderError } from "@terno/mail";
import { parseRaw } from "../../mail/src/mime";
import { afterEach, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { bounded } from "./test/imap-idle-fixture";
import { flagsFixture } from "./test/imap-flags-fixture";

const cleanups: (() => Promise<void>)[] = [];
const now = Date.UTC(2026, 9, 30, 12);
afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanups.splice(0).reverse()) { try { await close(); } catch (error) { errors.push(error); } }
  vi.restoreAllMocks();
  if (errors.length) throw new AggregateError(errors, "IMAP repair cleanup failed");
});
function raw(id: string, depth = 0, files = 1) {
  const headers = [`From: Synthetic <sender@example.test>`, "To: Test <test@example.test>", `Subject: ${id}`, `Message-ID: <${id}@repair.example.test>`, `Date: ${new Date(now - 1000).toUTCString()}`, "MIME-Version: 1.0"];
  const parts = Array.from({ length: files }, (_, i) => ["--b", "Content-Type: application/octet-stream", `Content-Disposition: attachment; filename="${i}.bin"`, "Content-Transfer-Encoding: base64", "", "AP+ADQo="].join("\r\n"));
  const inner = ['Content-Type: multipart/mixed; boundary="b"', "", "--b", "Content-Type: text/plain", "", `Exact ${id} body`, ...parts, "--b--", ""].join("\r\n");
  let body = inner;
  for (let i = 0; i < depth; i++) body = [`Content-Type: multipart/mixed; boundary="d${i}"`, "", `--d${i}`, body, `--d${i}--`, ""].join("\r\n");
  return Buffer.from(`${headers.join("\r\n")}\r\n${body}`);
}

it("direct parseRaw accepts the Gmail 1001-file poison but refuses its own default nesting boundary", async () => {
  const accepted = await parseRaw(raw("parts", 0, 1001));
  expect(accepted.text).toBe("Exact parts body");
  expect(accepted.attachments).toHaveLength(1001);
  for (const a of accepted.attachments) expect([...a.bytes!]).toEqual([0, 255, 128, 13, 10]);
  const nested = await parseRaw(raw("nested", 254));
  expect(nested.text).toBe("Exact nested body");
  expect([...nested.attachments[0]!.bytes!]).toEqual([0, 255, 128, 13, 10]);
  await expect(parseRaw(raw("poison", 257))).rejects.toMatchObject({ code: "EMAXNESTINGDEPTH" });
});

async function mailbox() {
  // Any accidental HTTP path must fail before constructing Backend; only native loopback IMAP is used.
  const unexpected: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => { unexpected.push("Unexpected HTTP during IMAP test"); throw new Error(unexpected.at(-1)); });
  const w = await flagsFixture(true);
  cleanups.push(() => w.stop());
  const dir = mkdtempSync(join(tmpdir(), "terno-imap-repair-"));
  cleanups.push(async () => { rmSync(dir, { recursive: true, force: true }); });
  const failures: unknown[] = [];
  async function open() {
    const providers = createRegistry({ imap: { allowInsecure: true, timeouts: { connectMs: 2000, socketMs: 3000 } } });
    const create = providers.create.bind(providers);
    providers.create = (ctx) => {
      const provider = create(ctx), sync = provider.sync.bind(provider);
      provider.sync = async (sink) => { try { return await sync(sink); } catch (error) { failures.push(error); throw error; } };
      return provider;
    };
    const backend = new Backend({ dbPath: join(dir, "synthetic.db"), cipher: plaintextCipher, providers, version: "test", now: () => now, autoSync: false, instantSearch: false, iconTransport: null });
    const [local, remote] = createMemoryTransportPair();
    backend.connect(remote, { clientId: "imap-repair", origin: "renderer" });
    const rpc = new RpcClient(local);
    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      const sessions = new Set(w.server.control.sessions().map((s) => s.session));
      let done!: () => void;
      const closed = new Promise<void>((resolve) => { done = resolve; });
      const onSession = (event: { type: string; session: { session: number } }) => {
        if (event.type === "close") { sessions.delete(event.session.session); if (!sessions.size) done(); }
      };
      w.server.on("session", onSession);
      try {
        if (!sessions.size) done();
        await bounded(backend.stop(), "backend stop"); await bounded(closed, "owned protocol sessions close");
        rpc.close(); stopped = true;
      } finally { w.server.off("session", onSession); }
    };
    cleanups.push(stop);
    await backend.ready;
    return { backend, rpc, stop };
  }
  let session = await open();
  const account = await session.rpc.call("accounts.addImap", { email: "test@example.test", displayName: "Synthetic", verify: false,
    imap: { host: "127.0.0.1", port: w.port, secure: false, user: "testuser" }, smtp: { host: "127.0.0.1", port: 1, secure: false, user: "testuser" }, password: "testpass" });
  const runs: Promise<void>[] = [];
  cleanups.push(async () => { await Promise.allSettled(runs); expect(unexpected).toEqual([]); expect(w.overflow).toBe(false); });
  const rows = async () => (await session.backend.store.debug.snapshot()).messages;
  const cursor = async () => (await session.backend.store.accounts.config<{ cursor?: { pass: number; mailboxes: Record<string, { uidnext: number; uidvalidity: number }> } }>(account.id))!.config.cursor!;
  const pending = () => session.backend.store.providerStore(account.id).pendingBodies(50);
  const snapshot = async () => Promise.all((await rows()).map(async (row) => {
    const thread = await session.rpc.call("threads.get", { threadId: row.threadId });
    const attachments = await session.backend.store.attachments.current(account.id, { id: row.id });
    return { row, message: thread.messages.find((m) => m.id === row.id), attachments,
      bytes: await Promise.all(attachments.map((a) => session.backend.store.attachments.read(account.id, a.assetId!, 0))) };
  }));
  return { account, w, failures, rows, cursor, pending, snapshot,
    get backend() { return session.backend; },
    add(id: string, depth = 0, files = 1) { const source = raw(id, depth, files); const identity = w.server.control.addMessage("Projects", { raw: source, internaldate: new Date(now - 1000) }); return { source, ...identity }; },
    sync() { const run = session.backend.syncAccount(account.id); runs.push(run); return bounded(run, "sync completes"); },
    async reopen() { await session.stop(); expect(w.server.control.sessions()).toEqual([]); session = await open(); },
    async locators() { return session.backend.store.providerStore(account.id).locations.of((await rows()).map((m) => m.id)); },
    async sourceUnchanged(uid: number, source: Buffer) { expect(w.server.control.getMessage("Projects", uid).raw).toEqual(source); },
  };
}

it("retains exact IMAP pending identities past the header checkpoint but must let a later valid body progress", async () => {
  const t = await mailbox(); const cached = t.add("cached"); await t.sync(); const before = await t.snapshot();
  expect(before[0]!.bytes).toEqual(["AP+ADQo="]); expect(await t.pending()).toEqual([]);
  const poison = t.add("poison", 257), good = t.add("later");
  await t.sync();
  expect(t.failures).toHaveLength(1); expect(t.failures[0]).toBeInstanceOf(ProviderError);
  expect(t.w.commands.filter((c) => c.mailbox === "Projects" && /BODY\.PEEK\[\]</.test(c.data))).toHaveLength(3);
  expect(t.failures[0]).toMatchObject({ retryable: true, message: expect.stringContaining("Maximum MIME nesting depth of 256") });
  const rows = await t.rows(), p = rows.find((m) => m.subject === "poison")!, g = rows.find((m) => m.subject === "later")!;
  expect(rows).toHaveLength(3);
  const checkpoint = await t.cursor(), locators = await t.locators();
  expect(checkpoint.mailboxes.Projects).toMatchObject({ uidnext: good.uid + 1, uidvalidity: poison.uidvalidity });
  expect(locators.find((l) => l.message_id === p.id)).toMatchObject({ mailbox: "Projects", uid: poison.uid, uidvalidity: poison.uidvalidity });
  expect(locators.find((l) => l.message_id === g.id)).toMatchObject({ mailbox: "Projects", uid: good.uid, uidvalidity: good.uidvalidity });
  expect(await t.pending()).toContainEqual({ id: p.id, mailbox: "Projects", uid: poison.uid, uidvalidity: poison.uidvalidity });
  expect((await t.snapshot()).find((m) => m.row.id === p.id)?.message).toMatchObject({ bodyState: "none", bodyText: null, bodyHtml: null });
  expect((await t.snapshot()).filter((m) => m.row.id === before[0]!.row.id)).toEqual(before);
  expect.soft((await t.snapshot()).find((m) => m.row.id === g.id)?.message).toMatchObject({ bodyState: "full", bodyText: "Exact later body" });
  const retained = await t.snapshot(), pending = await t.pending();
  await t.reopen();
  expect(await t.snapshot()).toEqual(retained); expect(await t.pending()).toEqual(pending); expect(await t.locators()).toEqual(locators); expect(await t.cursor()).toEqual(checkpoint);
  await t.sync();
  expect(t.failures).toHaveLength(2); expect(t.failures[1]).toMatchObject({ retryable: true, message: expect.stringContaining("Maximum MIME nesting depth of 256") });
  expect(await t.pending()).toContainEqual({ id: p.id, mailbox: "Projects", uid: poison.uid, uidvalidity: poison.uidvalidity });
  expect.soft((await t.snapshot()).find((m) => m.row.id === g.id)?.message).toMatchObject({ bodyState: "full", bodyText: "Exact later body" });
  expect((await t.snapshot()).filter((m) => m.row.id === before[0]!.row.id)).toEqual(before);
  await t.sourceUnchanged(cached.uid, cached.source); await t.sourceUnchanged(poison.uid, poison.source); await t.sourceUnchanged(good.uid, good.source);
});

it("keeps body debt after an actual temporary FETCH refusal and repairs the same source after reopen", async () => {
  const t = await mailbox(); t.add("cached"); await t.sync(); const cached = await t.snapshot();
  const target = t.add("temporary", 254), later = t.add("neighbor");
  const refusal = t.w.server.script.add({ on: "command", command: "UID FETCH", mailbox: "Projects", match: /BODY\.PEEK\[\]</, times: 1, send: "$TAG NO [UNAVAILABLE] Temporary body unavailable\r\n" });
  await t.sync();
  expect(refusal.hits).toBe(1); expect(t.failures).toHaveLength(1); expect(t.failures[0]).toBeInstanceOf(ProviderError);
  // The current mapper treats tagged NO as nonretryable; that is not deterministic MIME poison.
  expect(t.failures[0]).toMatchObject({ retryable: false, message: "IMAP: Command failed" });
  const before = await t.snapshot(), rows = await t.rows(), p = rows.find((m) => m.subject === "temporary")!, g = rows.find((m) => m.subject === "neighbor")!;
  expect(rows).toHaveLength(3); expect(before.filter((m) => m.row.id === cached[0]!.row.id)).toEqual(cached);
  const checkpoint = await t.cursor(), pending = await t.pending(), locators = await t.locators();
  expect(checkpoint.mailboxes.Projects).toMatchObject({ uidnext: later.uid + 1, uidvalidity: target.uidvalidity });
  expect(pending.map((m) => m.id).sort()).toEqual([p.id, g.id].sort());
  for (const m of before.filter((m) => m.row.id !== cached[0]!.row.id)) expect(m.message).toMatchObject({ bodyState: "none", bodyText: null });
  await t.reopen(); expect(await t.snapshot()).toEqual(before); expect(await t.pending()).toEqual(pending); expect(await t.locators()).toEqual(locators); expect(await t.cursor()).toEqual(checkpoint);
  await t.sync(); expect(t.failures).toHaveLength(1); expect(await t.pending()).toEqual([]);
  expect((await t.backend.store.accounts.get(t.account.id))!.syncState.status).toBe("idle");
  const repaired = await t.snapshot();
  expect(repaired.find((m) => m.row.id === p.id)?.message).toMatchObject({ bodyState: "full", bodyText: "Exact temporary body" });
  expect(repaired.find((m) => m.row.id === g.id)?.message).toMatchObject({ bodyState: "full", bodyText: "Exact neighbor body" });
  expect(repaired.find((m) => m.row.id === p.id)?.bytes).toEqual(["AP+ADQo="]);
  expect(repaired.find((m) => m.row.id === g.id)?.bytes).toEqual(["AP+ADQo="]);
  expect(repaired.filter((m) => m.row.id === cached[0]!.row.id)).toEqual(cached); expect(await t.locators()).toEqual(locators);
  await t.sourceUnchanged(target.uid, target.source); await t.sourceUnchanged(later.uid, later.source);
  expect(t.w.commands.filter((c) => /STORE|COPY|MOVE|EXPUNGE|APPEND/.test(c.command))).toEqual([]);
});
