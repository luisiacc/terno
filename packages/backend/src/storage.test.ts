/**
 * Plan 69 on the backend: the storage report, and removing this device's copy of old conversations in units
 * bounded by messages, with progress, without a word to the provider, and without a sync pass that overlapped it
 * putting any of it back.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { sqlDb } from "@terno/db";
import { createDemoProvider, type ProviderRegistry } from "@terno/mail";
import type { IncomingMessage } from "@terno/store";
import { ingest, msg, threadOf, withAccounts } from "@terno/store/conformance";
import { afterEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { Evictions } from "./storage";

const NOW = Date.UTC(2026, 9, 29, 12);
const DAY = 86_400_000;
const OLD = NOW - 500 * DAY;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A provider whose sync ingests `serve` once `gate` opens: a pass that fetched mail before a removal ended. */
function gatedRegistry() {
  const state = { serve: [] as IncomingMessage[], gate: Promise.resolve(), passes: 0 };
  const registry: ProviderRegistry = {
    kind: "demo",
    create: (ctx) => ({
      ...createDemoProvider(ctx, 0),
      async sync(sink) {
        state.passes++;
        await state.gate;
        if (state.serve.length) await sink.ingest(state.serve);
      },
    }),
    async verifyImap() {},
    async connectGmail() {
      throw new Error("not here");
    },
  };
  return { registry, state };
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "terno-storage-"));
  const { registry, state } = gatedRegistry();
  // a tiny slice budget: a few dozen messages already take several units
  const backend = new Backend({ dbPath: join(dir, "terno.db"), version: "test", cipher: plaintextCipher, providers: registry, now: () => NOW, autoSync: false, sliceBudgetMs: 1 });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: `renderer-${Math.random()}`, origin: "renderer" });
  cleanups.push(async () => {
    await backend.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  const [acct] = await withAccounts(backend.store, 1);
  const client = new RpcClient(c);
  return { backend, client, db: sqlDb(backend.store), acct: acct!, state };
}

describe("storage.report", () => {
  it("tallies every view and what each age would remove, with what the file takes", async () => {
    const { backend, client, acct } = await setup();
    await ingest(backend.store, [
      msg({ accountId: acct, providerMsgId: "spam-old", inInbox: false, isSpam: true, date: OLD, size: 1000 }),
      msg({ accountId: acct, providerMsgId: "spam-month", inInbox: false, isSpam: true, date: NOW - 60 * DAY, size: 10 }),
      msg({ accountId: acct, providerMsgId: "starred", inInbox: false, isSpam: true, isStarred: true, date: OLD, size: 7 }),
      msg({ accountId: acct, providerMsgId: "inbox", date: OLD, size: 3 }),
    ]);
    const r = await client.call("storage.report", {});
    const spam = r.buckets.find((b) => b.bucket === "spam")!;
    expect(spam).toMatchObject({ threads: 3, messages: 3, bytes: 1017 });
    // older than a month: both unstarred; older than three months: only the old one
    expect(spam.removable.map((a) => a.threads)).toEqual([2, 1, 1, 1, 0]);
    expect(r.buckets.find((b) => b.bucket === "inbox")).toMatchObject({ threads: 1, bytes: 3 });
    expect(r.disk).toEqual({ bytes: expect.any(Number), free: expect.any(Number) });
    expect(r.disk!.bytes).toBeGreaterThan(0);
    expect(r).toMatchObject({ compactPending: false, at: NOW });
  });
});

describe("storage.remove", () => {
  it("removes the chosen views' old conversations in units bounded by messages, with progress, and tells the provider nothing", async () => {
    const { backend, client, db, acct } = await setup();
    // one conversation of 60 messages (several units at this budget), 30 small ones, and what must stay
    const root = msg({ accountId: acct, providerMsgId: "big0", rfcMessageId: "big0@t", inInbox: false, isTrash: true, date: OLD });
    await ingest(backend.store, [
      root,
      ...Array.from({ length: 59 }, (_, i) => msg({ accountId: acct, providerMsgId: `big${i + 1}`, rfcMessageId: `big${i + 1}@t`, inReplyTo: "big0@t", references: ["big0@t"], subject: root.subject, inInbox: false, isTrash: true, date: OLD + i })),
      ...Array.from({ length: 30 }, (_, i) => msg({ accountId: acct, providerMsgId: `t${i}`, inInbox: false, isTrash: true, date: OLD })),
      msg({ accountId: acct, providerMsgId: "starred", inInbox: false, isTrash: true, isStarred: true, date: OLD }),
      msg({ accountId: acct, providerMsgId: "young", inInbox: false, isTrash: true, date: NOW - DAY }),
      msg({ accountId: acct, providerMsgId: "archived", inInbox: false, date: OLD }),
    ]);
    const kept = await Promise.all(["starred", "young", "archived"].map((id) => threadOf(backend.store, id)));
    const progress: { done: number; total: number }[] = [];
    client.on("bulkProgress", (p) => p.jobId === "job-1" && progress.push(p));
    const changed: number[] = [];
    client.on("changed", (e) => changed.push(...e.threadIds));
    const ops = db.get<{ c: number }>("SELECT count(*) AS c FROM ops")!.c;

    const r = await client.call("storage.remove", { buckets: ["trash"], olderThanDays: 365, jobId: "job-1" });
    expect(r).toEqual({ threads: 31, messages: 90, compact: "done" });
    expect(db.get<{ c: number }>("SELECT count(*) AS c FROM messages")!.c).toBe(3);
    for (const t of kept) expect(await backend.store.threads.get(t)).not.toBeNull();
    // nothing for the server: this device's copy only
    expect(db.get<{ c: number }>("SELECT count(*) AS c FROM ops")!.c).toBe(ops);
    expect(progress[0]).toEqual({ jobId: "job-1", done: 0, total: 90 });
    expect(progress.at(-1)).toEqual({ jobId: "job-1", done: 90, total: 90 });
    expect(progress.length).toBeGreaterThan(2);
    expect(changed.length).toBeGreaterThan(0);
    // the freed pages left the file
    expect(db.get<{ freelist_count: number }>("PRAGMA freelist_count")!.freelist_count).toBe(0);
    const report = await client.call("storage.report", {});
    expect(report.buckets.find((b) => b.bucket === "trash")).toMatchObject({ threads: 2 });
  });

  it("runs one at a time and refuses a bad age", async () => {
    const { backend, client, acct } = await setup();
    await ingest(backend.store, Array.from({ length: 40 }, (_, i) => msg({ accountId: acct, providerMsgId: `s${i}`, inInbox: false, isSpam: true, date: OLD })));
    const first = client.call("storage.remove", { buckets: ["spam"], olderThanDays: 30 });
    await expect(client.call("storage.remove", { buckets: ["spam"], olderThanDays: 30 })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(first).resolves.toMatchObject({ threads: 40 });
    await expect(client.call("storage.remove", { buckets: ["spam"], olderThanDays: 31 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // nothing left that old: nothing to compact either
    await expect(client.call("storage.remove", { buckets: ["spam"], olderThanDays: 30 })).resolves.toEqual({ threads: 0, messages: 0, compact: "none" });
  });

  it("a sync pass that fetched removed mail before the removal ended doesn't put it back; a later pass may (Codex R1)", async () => {
    const { backend, client, acct, state } = await setup();
    const old = msg({ accountId: acct, providerMsgId: "fetched", inInbox: false, isSpam: true, date: OLD });
    await ingest(backend.store, [old]);
    // a pass starts, and has the message in hand before the removal runs
    let open!: () => void;
    state.gate = new Promise<void>((resolve) => (open = resolve));
    state.serve = [old];
    const pass = backend.syncAccount(acct);
    await expect.poll(() => state.passes).toBe(1);
    await client.call("storage.remove", { buckets: ["spam"], olderThanDays: 365 });
    open();
    await pass;
    await expect(threadOf(backend.store, "fetched")).rejects.toThrow();
    // that pass overlapped the removal: the list stays until one that started after it
    expect(backend.evictions.size).toBe(1);
    // the server still has it and the next pass brings it (moved in another app, say): that's the user's mail
    state.gate = Promise.resolve();
    await backend.syncAccount(acct);
    expect(await threadOf(backend.store, "fetched")).toBeGreaterThan(0);
    expect(backend.evictions.size).toBe(0);
  });
});

describe("Evictions", () => {
  it("drops what a removal took only from passes that overlapped it, and forgets it after the next full pass", () => {
    const e = new Evictions();
    const m = (id: string) => msg({ accountId: 1, providerMsgId: id });
    const before = e.pass();
    e.begin();
    const during = e.pass();
    e.record([{ accountId: 1, providerMsgIds: ["a"] }]);
    e.end();
    expect(e.admit(1, before, [m("a"), m("b")]).map((x) => x.providerMsgId)).toEqual(["b"]);
    expect(e.admit(1, during, [m("a")])).toEqual([]);
    expect(e.admit(2, during, [m("a")])).toHaveLength(1);
    // an overlapping pass finishing keeps the list; a later one clears it
    e.passDone(1, during);
    expect(e.size).toBe(1);
    const after = e.pass();
    expect(e.admit(1, after, [m("a")])).toHaveLength(1);
    e.passDone(1, after);
    expect(e.size).toBe(0);
  });
});
