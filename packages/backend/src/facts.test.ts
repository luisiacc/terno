/**
 * Plan 17's backfill runner: it runs at start, in slices sized by the time
 * they take, announces the lists at most once a second and at the end, stops
 * between slices (a quit loses nothing; the next start resumes), wakes on a
 * change, and gives up for the session after three failures in a row.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { seedDataset, sqlDb } from "@terno/db";
import { demoRegistry } from "@terno/mail";
import { generateDataset } from "@terno/mock-data";
import type { MailStore } from "@terno/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { FactsBackfill, type FactsHost } from "./facts";

const NOW = Date.UTC(2026, 9, 22, 12);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function backendAt(dir: string) {
  const backend = new Backend({ dbPath: join(dir, "terno.db"), version: "test", cipher: plaintextCipher, providers: demoRegistry, now: () => NOW, autoSync: false });
  cleanups.push(() => backend.stop().catch(() => {}));
  return backend;
}

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "terno-facts-"));
  cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A mailbox whose facts are as right after the migration: a backfill to do. */
async function pendingMailbox(dir: string) {
  const backend = backendAt(dir);
  seedDataset(sqlDb(backend.store), generateDataset({ threads: 400, accounts: 2, seed: 7, now: NOW }), { now: NOW });
  const expected = (await backend.store.debug.snapshot()).threads.map((t) => [t.id, t.person, t.waitingSince]);
  await backend.store.debug.resetFacts();
  return { backend, expected };
}

const factsOf = async (store: MailStore) => (await store.debug.snapshot()).threads.map((t) => [t.id, t.person, t.waitingSince]);

describe("the facts backfill (plan 17)", () => {
  it("runs at start, in slices, until every thread's facts are back; the waiting count then becomes known", async () => {
    const { backend, expected } = await pendingMailbox(tempDir());
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId: "renderer", origin: "renderer" });
    const client = new RpcClient(c);
    expect((await client.call("counts.get", {})).inboxWaiting).toBeNull();
    const backfill = vi.spyOn(backend.store.facts, "backfill");
    await backend.start();
    await backend.facts.idle();
    expect(await factsOf(backend.store)).toEqual(expected);
    expect(backfill.mock.calls.length).toBeGreaterThan(3);
    // the first slice is a probe; later ones grow with what slices took
    expect(Math.max(...backfill.mock.calls.map(([o]) => o.limit))).toBeGreaterThan(backfill.mock.calls[0]![0].limit);
    expect((await client.call("counts.get", {})).inboxWaiting).toEqual(expect.any(Number));
    const boot = await client.call("app.bootstrap", {});
    expect(boot.filters).toEqual(["unread", "people", "waiting", "attachments", "starred"]);
  });

  it("stopping waits for the slice in flight and loses nothing; the next start finishes", async () => {
    const dir = tempDir();
    const { backend, expected } = await pendingMailbox(dir);
    let slices = 0;
    const real = backend.store.facts.backfill.bind(backend.store.facts);
    vi.spyOn(backend.store.facts, "backfill").mockImplementation(async (o) => {
      slices++;
      return real({ limit: 5 });
    });
    void backend.start();
    await vi.waitFor(() => expect(slices).toBeGreaterThan(3));
    await backend.stop();
    const done = slices;
    // a fresh backend on the same file: the store's progress says where to go on
    const again = backendAt(dir);
    expect(await again.store.facts.idle()).toBe(false);
    await again.start();
    await again.facts.idle();
    expect(await factsOf(again.store)).toEqual(expected);
    expect(slices).toBe(done);
  });

  it("wakes on a change, sleeps when nothing is pending, announces at most once a second and at the end", async () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      let t = 0;
      vi.spyOn(performance, "now").mockImplementation(() => t);
      let pending = 30;
      const notify = vi.fn();
      const store = {
        isOpen: true,
        facts: {
          idle: async () => pending === 0,
          backfill: async () => {
            t += 100;
            pending = Math.max(0, pending - 1);
            return { phase: "threads" as const, processed: 1, more: pending > 0 };
          },
        },
      } as unknown as MailStore;
      const host: FactsHost = { store, platform: { yield: async () => {} }, notifyChanged: notify, log: () => {} };
      const runner = new FactsBackfill(host);
      runner.wake();
      await runner.idle();
      expect(pending).toBe(0);
      // 30 slices of 100 ms: about one announcement a second, and one at the end
      expect(notify.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(notify.mock.calls.length).toBeLessThanOrEqual(4);
      notify.mockClear();
      runner.wake();
      await runner.idle();
      expect(notify).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up for the session after three failures in a row, each reported", async () => {
    const backfill = vi.fn(async () => {
      throw new Error("disk I/O error");
    });
    const store = { isOpen: true, facts: { idle: async () => false, backfill } } as unknown as MailStore;
    const log = vi.fn();
    const runner = new FactsBackfill({ store, platform: { yield: async () => {} }, notifyChanged: () => {}, log });
    for (let i = 0; i < 5; i++) {
      runner.wake();
      await runner.idle();
    }
    expect(backfill).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledTimes(3);
  });
});
