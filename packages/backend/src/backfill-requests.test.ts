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
