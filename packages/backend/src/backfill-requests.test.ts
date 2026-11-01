import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountPrefs } from "@terno/core";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createAccount, sqlDb } from "@terno/db";
import type { MailProvider, ProviderRegistry } from "@terno/mail";
import { afterEach, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";

// Plan 101 (Codex review 1, 11): what records a backfill request, by each account's effective window.
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 1);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

async function setup() {
  const registry: ProviderRegistry = { create: () => ({ async verify() {}, async sync() {}, async execute() {}, async close() {} }) as MailProvider, async verifyImap() {}, async connectGmail() { throw new Error("unused"); } };
  const dir = mkdtempSync(join(tmpdir(), "terno-backfill-req-"));
  let now = NOW;
  const backend = new Backend({ dbPath: join(dir, "t.db"), version: "t", cipher: plaintextCipher, providers: registry, autoSync: false, now: () => now });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "r", origin: "renderer" });
  const client = new RpcClient(c);
  cleanups.push(async () => { await backend.stop(); rmSync(dir, { recursive: true, force: true }); });
  await backend.ready;
  const make = (email: string, prefs: AccountPrefs = {}) => createAccount(sqlDb(backend.store), { kind: "imap", email, displayName: email, color: "indigo", providerConfig: prefs }).id;
  const request = async (id: number) => (await backend.store.accounts.config<AccountPrefs>(id))?.config.backfill ?? null;
  return { backend, client, make, request, tick: (ms: number) => { now += ms; } };
}

it("a wider General window asks only the accounts that follow it, for the exact span", async () => {
  const t = await setup();
  await t.client.call("settings.update", { syncWindowDays: 180 });
  const follows = t.make("a@example.com"), own = t.make("b@example.com", { syncWindowDays: 30 });
  await t.client.call("settings.update", { syncWindowDays: 181 });
  // 180 → 181 days fills exactly that day (no "more than a day" threshold)
  expect(await t.request(follows)).toEqual({ since: NOW - 181 * DAY, until: NOW - 180 * DAY });
  expect(await t.request(own)).toBeNull();
  // narrower: nothing new
  await t.client.call("settings.update", { syncWindowDays: 90 });
  expect(await t.request(follows)).toEqual({ since: NOW - 181 * DAY, until: NOW - 180 * DAY });
});

it("an override removed for a wider General is a widening; widenings merge into one span", async () => {
  const t = await setup();
  await t.client.call("settings.update", { syncWindowDays: 365 });
  const id = t.make("a@example.com", { syncWindowDays: 30 });
  await t.client.call("accounts.update", { id, syncWindowDays: null });
  expect(await t.request(id)).toEqual({ since: NOW - 365 * DAY, until: NOW - 30 * DAY });
  // a day later, an even wider override: one span, from the widest start to the first request's end
  t.tick(DAY);
  await t.client.call("accounts.update", { id, syncWindowDays: 730 });
  expect(await t.request(id)).toEqual({ since: NOW + DAY - 730 * DAY, until: NOW - 30 * DAY });
  // the renderer sees it as a date to show
  expect((await t.backend.store.accounts.get(id))?.backfillSince).toBe(NOW + DAY - 730 * DAY);
});

it("a request done while a wider one was recorded keeps the wider one; two widenings at once keep their union (Codex review)", async () => {
  const t = await setup();
  const id = t.make("a@example.com");
  const first = { since: NOW - 365 * DAY, until: NOW - 180 * DAY };
  await t.backend.store.accounts.update(id, { backfill: { merge: first } });
  // a wider window recorded while the first span was downloading
  await t.backend.store.accounts.update(id, { backfill: { merge: { since: NOW - 730 * DAY, until: NOW - 365 * DAY } } });
  // the first span's completion clears nothing: it isn't the request any more
  await t.backend.store.accounts.update(id, { backfill: { clearIf: first } });
  expect(await t.request(id)).toEqual({ since: NOW - 730 * DAY, until: NOW - 180 * DAY });
  // two widenings at once (an account's and General's): neither span is lost
  const other = t.make("b@example.com");
  await Promise.all([t.backend.widenWindow(other, 30, 90), t.backend.widenWindow(other, 180, 365)]);
  expect(await t.request(other)).toEqual({ since: NOW - 365 * DAY, until: NOW - 30 * DAY });
});

it("accounts.update answers with the account as it is now, its request included (Codex review)", async () => {
  const t = await setup();
  const id = t.make("a@example.com", { syncWindowDays: 30 });
  const reply = await t.client.call("accounts.update", { id, syncWindowDays: 365 });
  expect(reply.backfillSince).toBe(NOW - 365 * DAY);
});

it("plan 102: a first sync paused between chunks stays a first sync, and its next chunk starts on its own", async () => {
  let passes = 0;
  const registry: ProviderRegistry = {
    create: () => ({ async verify() {}, async sync(sink) { passes++; if (passes === 1) sink.again?.(); }, async execute() {}, async close() {} }) as MailProvider,
    async verifyImap() {}, async connectGmail() { throw new Error("unused"); },
  };
  const dir = mkdtempSync(join(tmpdir(), "terno-first-chunks-"));
  const backend = new Backend({ dbPath: join(dir, "t.db"), version: "t", cipher: plaintextCipher, providers: registry, autoSync: false });
  cleanups.push(async () => { await backend.stop(); rmSync(dir, { recursive: true, force: true }); });
  await backend.ready;
  const id = createAccount(sqlDb(backend.store), { kind: "gmail", email: "a@example.com", displayName: "A", color: "indigo", providerConfig: {} }).id;
  await backend.syncAccount(id);
  // between chunks: still "Downloading your mail" (syncing, never synced)
  expect((await backend.store.accounts.get(id))?.syncState).toMatchObject({ status: "syncing", lastSyncAt: null });
  // the next chunk starts a second later by itself, and finishes the first sync
  await expect.poll(async () => (await backend.store.accounts.get(id))?.syncState.lastSyncAt, { timeout: 5000 }).not.toBeNull();
  expect(passes).toBe(2);
  expect((await backend.store.accounts.get(id))?.syncState.status).toBe("idle");
});

async function chunked(sync: (sink: import("@terno/mail").SyncSink, pass: number, backend: Backend) => Promise<void>) {
  let passes = 0;
  let self!: Backend;
  const registry: ProviderRegistry = {
    create: () => ({ async verify() {}, async sync(sink) { passes++; await sync(sink, passes, self); }, async execute() {}, async close() {} }) as MailProvider,
    async verifyImap() {}, async connectGmail() { throw new Error("unused"); },
  };
  const dir = mkdtempSync(join(tmpdir(), "terno-first-chunks-"));
  // autoSync on (never started: no poll runs) so the host's network word counts
  self = new Backend({ dbPath: join(dir, "t.db"), version: "t", cipher: plaintextCipher, providers: registry, autoSync: true, syncIntervalMs: 3_600_000 });
  cleanups.push(async () => { await self.stop(); rmSync(dir, { recursive: true, force: true }); });
  await self.ready;
  const id = createAccount(sqlDb(self.store), { kind: "gmail", email: "a@example.com", displayName: "A", color: "indigo", providerConfig: {} }).id;
  return { backend: self, id, passes: () => passes };
}

it("plan 102 (Codex review): a chunk that ends as the host goes offline keeps the first sync a first sync", async () => {
  const t = await chunked(async (sink, pass, backend) => { if (pass === 1) { sink.again?.(); backend.networkChanged(false, "offline"); } });
  await t.backend.syncAccount(t.id);
  await expect.poll(async () => (await t.backend.store.accounts.get(t.id))?.syncState.status).toBe("offline");
  expect((await t.backend.store.accounts.get(t.id))?.syncState.lastSyncAt).toBeNull();
});

it("plan 102 (Codex review): after a failed first chunk, the retry's new mail is announced (the account is primed)", async () => {
  const { ProviderError } = await import("@terno/mail");
  const t = await chunked(async (_sink, pass) => { if (pass === 1) throw new ProviderError("synthetic: the connection dropped", true); });
  await t.backend.syncAccount(t.id).catch(() => {});
  const attention = (t.backend as unknown as { attention: { primedAccounts: Set<number> } }).attention;
  expect(attention.primedAccounts.has(t.id)).toBe(true);
});

it("plan 103: a first sync's progress is kept between chunks and cleared when it's done", async () => {
  const t = await chunked(async (sink, pass) => {
    sink.progress?.({ done: 10, total: 100, unit: "messages" });
    sink.progress?.({ done: 20, total: 100, unit: "messages" });
    if (pass === 1) sink.again?.();
  });
  await t.backend.syncAccount(t.id);
  // the chunk's latest, not the first one written (writes are throttled)
  expect((await t.backend.store.accounts.get(t.id))?.syncState.progress).toEqual({ done: 20, total: 100, unit: "messages" });
  await expect.poll(async () => (await t.backend.store.accounts.get(t.id))?.syncState.lastSyncAt, { timeout: 5000 }).not.toBeNull();
  expect((await t.backend.store.accounts.get(t.id))?.syncState.progress).toBeNull();
});

it("plan 103 (Codex review): finishing is written at once, never held back by the throttle", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const t = await chunked(async (sink) => {
    sink.progress?.({ done: 90, total: 100, unit: "messages" });
    // a moment later (inside the throttle's window) the download ends and the flags are read again, for a while
    sink.progress?.({ finishing: true, unit: "messages", done: 100, total: 100 });
    await gate;
  });
  // live progress is its own event (only the sync card listens)
  const heard: unknown[] = [];
  const server = (t.backend as unknown as { server: { emit: (name: string, payload: unknown) => void } }).server;
  const emit = server.emit.bind(server);
  server.emit = (name, payload) => { if (name === "syncProgress") heard.push(payload); emit(name, payload); };
  const pass = t.backend.syncAccount(t.id);
  await expect.poll(() => heard.some((p) => (p as { progress: { finishing?: boolean } | null }).progress?.finishing === true)).toBe(true);
  release();
  await pass;
});

it("plan 103 (Codex review): a pass that leaves its backfill still pending keeps the progress shown", async () => {
  const t = await chunked(async (sink) => { sink.progress?.({ done: 3, total: 7, unit: "folders" }); });
  const now = Date.now();
  await t.backend.store.accounts.update(t.id, { backfill: { merge: { since: now - 365 * DAY, until: now - 180 * DAY } } });
  await t.backend.syncAccount(t.id);
  // neither done nor asking for another pass (a folder to retry later): the card keeps where it was
  expect((await t.backend.store.accounts.get(t.id))?.syncState.progress).toEqual({ done: 3, total: 7, unit: "folders" });
});

it("plan 103: live progress never sends the accounts event (the reader and the composer would re-render every 2 s)", async () => {
  const count = async (reports: number) => {
    const t = await chunked(async (sink) => { for (let i = 0; i < reports; i++) { sink.progress?.({ done: i, total: reports, unit: "messages" }); await new Promise((r) => setTimeout(r, reports > 1 ? 25 : 0)); } });
    let accounts = 0;
    const server = (t.backend as unknown as { server: { emit: (name: string, payload: unknown) => void } }).server;
    const emit = server.emit.bind(server);
    server.emit = (name, payload) => { if (name === "accounts") accounts++; emit(name, payload); };
    await t.backend.syncAccount(t.id);
    return accounts;
  };
  // a pass reporting 120 times over 3 s sends as many accounts events as one reporting once
  expect(await count(120)).toBe(await count(1));
});
