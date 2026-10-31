import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { sqlDb } from "@terno/db";
import { createRegistry } from "@terno/mail";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { bounded } from "./test/imap-idle-fixture";
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
  if (errors.length) throw new AggregateError(errors, "Resume fixture cleanup failed");
});
function raw(index: number, date = START - DAY) {
  return [`From: Synthetic <sender@example.test>`, "To: Test <test@example.test>", `Subject: cached-${index}`,
    `Message-ID: <cached-${index}@resume.example.test>`, `Date: ${new Date(date).toUTCString()}`,
    "Content-Type: text/plain; charset=utf-8", "", `Exact body ${index}`, ""].join("\r\n");
}
async function setup(condstore: boolean, idle: boolean, path: string, count = 1) {
  const w = await flagsFixture(condstore, idle);
  cleanups.push(() => w.stop());
  const ctl = w.server.control;
  const targets = Array.from({ length: count }, (_, i) => ctl.addMessage(path, { raw: raw(i), internaldate: new Date(START - DAY) }));
  const neverRaw = raw(-1, START - 200 * DAY);
  const never = ctl.addMessage(path, { raw: neverRaw, internaldate: new Date(START - 200 * DAY) });
  const dir = mkdtempSync(join(tmpdir(), "terno-resume-flags-"));
  cleanups.push(async () => { rmSync(dir, { recursive: true, force: true }); });
  let now = START;
  let resets = 0;
  const backend = new Backend({ dbPath: join(dir, "test.db"), version: "test", cipher: plaintextCipher,
    providers: createRegistry({ imap: { allowInsecure: true, timeouts: {
      connectMs: 3000, socketMs: 30_000, heartbeatMs: 3_600_000, quietMs: 0,
    } } }), autoSync: true, syncIntervalMs: 3_600_000, instantSearch: false,
    onNetworkReset: () => { resets++; },
    now: () => now, connectivity: { settleMs: 0, random: () => 0 },
  });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "resume-flags", origin: "renderer" });
  const client = new RpcClient(c);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    await bounded(backend.stop(), "backend stop", 15_000);
    client.close(); stopped = true;
  };
  cleanups.push(stop);
  await bounded(backend.start(), "start backend");
  await client.call("settings.update", { syncWindowDays: 30 });
  const account = await client.call("accounts.addImap", {
    email: "test@example.test", displayName: "Synthetic", verify: false,
    imap: { host: "127.0.0.1", port: w.port, secure: false, user: "testuser" },
    smtp: { host: "127.0.0.1", port: 1, secure: false, user: "testuser" }, password: "testpass",
  });
  // Manual setup only: the measured recovery below must be scheduled by the host event.
  await bounded(backend.syncAccount(account.id), "initial cache", 60_000);
  // Body hydration is intentionally bounded to 500 per pass.
  for (let i = 1; i < Math.ceil(count / 500); i++) await bounded(backend.syncAccount(account.id), "hydrate fixture", 60_000);
  const rows = () => sqlDb(backend.store).all<{ id: number; provider_msg_id: string; body_text: string; is_read: number; is_starred: number }>(
    "SELECT m.id, m.provider_msg_id, b.body_text, m.is_read, m.is_starred FROM messages m LEFT JOIN message_bodies b ON b.message_id=m.id ORDER BY m.id");
  const original = rows();
  expect(original).toHaveLength(count);
  expect(original.every((row) => row.body_text?.startsWith("Exact body"))).toBe(true);
  const locations = await backend.store.providerStore(account.id).locations.of(original.map((row) => row.id));
  function cursor() {
    return JSON.parse(sqlDb(backend.store).get<{ provider_config: string }>("SELECT provider_config FROM accounts WHERE id=?", account.id)!.provider_config).cursor as { pass: number };
  }
  const automatic: Promise<unknown>[] = [];
  const invoked: number[] = [];
  const sync = backend.syncAccount.bind(backend);
  vi.spyOn(backend, "syncAccount").mockImplementation((...args) => {
    const result = sync(...args); invoked.push(args[0]); automatic.push(result); return result;
  });
  async function offline() {
    backend.networkChanged(false, "offline");
    await expect.poll(async () => (await client.call("app.bootstrap", {})).accounts[0]?.syncState.status).toBe("offline");
  }
  await offline();
  async function signal(reason: "wake" | "network" | "online", pause = true) {
    if (pause) await offline();
    const before = automatic.length;
    backend.networkChanged(true, reason);
    await expect.poll(() => automatic.length, { timeout: 30_000 }).toBeGreaterThan(before);
    await bounded(Promise.all(automatic.slice(before)), "automatic pass finishes", 30_000);
  }
  w.resetCapture();
  return { w, ctl, backend, client, account, resetCount: () => resets, automaticCount: () => automatic.length, invoked, automatic, targets, never, neverRaw, original, locations, rows, cursor, signal, stop,
    age() { now += 60 * DAY; },
    change() { ctl.setFlags(path, targets.map((target) => target.uid), FLAGS, "set"); },
    async witness() {
      expect(rows()).toEqual(original.map((row) => ({ ...row, is_read: 1, is_starred: 1 })));
      expect(await backend.store.providerStore(account.id).locations.of(original.map((row) => row.id))).toEqual(
        locations.map((location) => ({ ...location, flags: expect.any(String) })));
      const currentLocations = await backend.store.providerStore(account.id).locations.of(original.map((row) => row.id));
      expect(currentLocations.every((location) => JSON.stringify((JSON.parse(location.flags) as string[]).sort()) === JSON.stringify(FLAGS))).toBe(true);
      for (let i = 0; i < targets.length; i++) {
        const remote = ctl.getMessage(path, targets[i]!.uid);
        expect(remote.raw).toEqual(Buffer.from(raw(i)));
        expect(remote.flags.sort()).toEqual(FLAGS);
      }
      expect(ctl.getMessage(path, never.uid).raw).toEqual(Buffer.from(neverRaw));
    },
  };
}
function traffic(t: Awaited<ReturnType<typeof setup>>, start: number, max = 60) {
  const commands = t.w.commands.slice(start);
  expect(t.w.overflow).toBe(false);
  expect(commands.length).toBeLessThan(max);
  expect(commands.filter((c) => /BODY(?:\.PEEK)?\[|ENVELOPE|BODYSTRUCTURE/.test(c.data))).toEqual([]);
  expect(commands.filter((c) => /STORE|MOVE|COPY|EXPUNGE|APPEND/.test(c.command))).toEqual([]);
  return commands;
}

describe("W06 A26/S14: supported host signals reconcile cached old flags automatically", () => {
  it.each([true, false].flatMap((condstore) => [true, false].flatMap((idle) => ["INBOX", "Projects"].map((path) => ({ condstore, idle, path })))))
  ("wake: $path MODSEQ=$condstore IDLE=$idle", async ({ condstore, idle, path }) => {
    const t = await setup(condstore, idle, path);
    t.age(); t.change();
    const start = t.w.commands.length;
    // An ordinary custom folder has no push listener: without a host event it stays stale.
    if (path === "Projects") expect(t.rows()).toEqual(t.original);
    let swept = false;
    for (let i = 0; i < 4 && !swept; i++) {
      await t.signal("wake");
      swept = path === "INBOX" || condstore || t.cursor().pass % 4 === 0;
      expect(t.rows()[0]).toMatchObject({ is_read: swept ? 1 : 0, is_starred: swept ? 1 : 0 });
    }
    expect(swept).toBe(true);
    await t.witness(); traffic(t, start, 180);
    expect(t.w.responses.some((s) => /HIGHESTMODSEQ/.test(s))).toBe(condstore);
    if (idle) await expect.poll(() => t.w.commands.some((c) => c.command === "IDLE")).toBe(true);
    else expect(t.w.commands.some((c) => c.command === "IDLE")).toBe(false);
    await t.stop();
    expect(t.ctl.sessions()).toEqual([]);
  });

  it.each(["network", "online"] as const)("%s transition schedules a custom-folder pass without manual sync", async (reason) => {
    const t = await setup(true, false, "Projects");
    if (reason === "online") {
      t.backend.networkChanged(false, "offline");
      await expect.poll(async () => (await t.client.call("app.bootstrap", {})).accounts[0]?.syncState.status).toBe("offline");
    }
    t.age(); t.change(); const start = t.w.commands.length;
    await t.signal(reason); await t.witness(); traffic(t, start);
  });

  it("an online unwatched folder stays stale without a host event, then wake schedules recovery", async () => {
    const t = await setup(true, false, "Projects");
    await t.signal("online");
    t.age(); t.change(); const start = t.w.commands.length;
    const before = t.automaticCount();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(t.automaticCount()).toBe(before);
    expect(t.rows()).toEqual(t.original);
    expect(t.w.commands.slice(start).filter((c) => /UID FETCH|UID SEARCH|STATUS/.test(c.command))).toEqual([]);
    await t.signal("wake", false);
    await t.witness(); traffic(t, start);
  });

  it("SEARCH refusal on automatic wake retains locators and a later wake recovers", async () => {
    const t = await setup(true, false, "Projects");
    t.age(); t.change();
    const refused = t.w.server.script.add({ on: "command", command: "UID SEARCH", mailbox: "Projects", match: / ALL\s*$/i,
      times: 1, send: "$TAG NO Synthetic enumeration refusal\r\n" });
    const start = t.w.commands.length;
    await t.signal("wake");
    expect(refused.hits).toBe(1);
    expect(t.rows()).toEqual(t.original);
    expect(await t.backend.store.providerStore(t.account.id).locations.of(t.original.map((row) => row.id))).toEqual(t.locations);
    await t.signal("wake"); await t.witness(); traffic(t, start, 120);
  });

  it("removal untracks an account before a later admitted wake", async () => {
    const t = await setup(true, false, "Projects");
    t.ctl.addUser("sibling", { password: "testpass" });
    const sibling = await t.client.call("accounts.addImap", {
      email: "sibling@example.test", displayName: "Sibling", verify: false,
      imap: { host: "127.0.0.1", port: t.w.port, secure: false, user: "sibling" },
      smtp: { host: "127.0.0.1", port: 1, secure: false, user: "sibling" }, password: "testpass",
    });
    await bounded(t.backend.syncAccount(sibling.id), "track sibling");
    await t.client.call("accounts.remove", { id: t.account.id });
    t.age(); t.change(); const start = t.w.commands.length;
    const before = t.invoked.length;
    t.backend.networkChanged(true, "wake");
    await expect.poll(() => t.invoked.slice(before)).toContain(sibling.id);
    await bounded(Promise.all(t.automatic.slice(before)), "surviving account wake pass");
    expect(t.invoked.slice(before)).not.toContain(t.account.id);
    expect((await t.client.call("app.bootstrap", {})).accounts.map((account) => account.id)).toEqual([sibling.id]);
    expect(t.w.commands.slice(start).filter((c) => c.command === "LOGIN" && /testuser/.test(c.data))).toEqual([]);
    expect(t.ctl.sessions().every((session) => session.user === "sibling")).toBe(true);
    await t.stop();
    expect(t.ctl.sessions()).toEqual([]);
  });

  it("a stopped backend admits no new wake work", async () => {
    const t = await setup(true, false, "Projects");
    await t.stop(); t.age(); t.change();
    const start = t.w.commands.length;
    t.backend.networkChanged(true, "wake");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(t.w.commands.slice(start)).toEqual([]);
    expect(t.ctl.sessions()).toEqual([]);
  });

  it("2,001 actually cached old messages use three flag FETCH batches and no raw backfill", async () => {
    const t = await setup(true, false, "Projects", 2001);
    t.age(); t.change(); const start = t.w.commands.length;
    await t.signal("wake"); await t.witness();
    const commands = traffic(t, start);
    const fetched = commands.filter((c) => c.mailbox === "Projects" && c.command === "UID FETCH");
    expect(fetched).toHaveLength(3);
    const uids: number[] = [];
    const sizes: number[] = [];
    for (const command of fetched) {
      const before = uids.length;
      const match = /UID FETCH ([\d,:]+) \(([^)]+)\)/.exec(command.data);
      expect(match).not.toBeNull();
      expect(match![2]!.split(" ").sort()).toEqual(["FLAGS", "MODSEQ", "UID"]);
      for (const range of match![1]!.split(",")) {
        const [first, last = first] = range.split(":").map(Number) as [number, number?];
        for (let uid = first; uid <= last!; uid++) uids.push(uid);
      }
      sizes.push(uids.length - before);
    }
    expect(sizes).toEqual([1000, 1000, 1]);
    expect(uids).toEqual(t.targets.map((target) => target.uid));
  }, 120_000);
});
