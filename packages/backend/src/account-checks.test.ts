/**
 * Plan 211 §2: the check of mail already here is the backend's, per account, with no offer. Its bookkeeping first, with a
 * store in memory; then the real backend with scripted providers: a first sync's end, a pass that ends offline, an account's
 * switches, and the upgrade from the offers' answers.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Account, AccountPrefs } from "@terno/core";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createAccount, sqlDb } from "@terno/db";
import type { MailProvider, ProviderRegistry, SyncSink } from "@terno/mail";
import type { IncomingMessage } from "@terno/store";
import { msg } from "@terno/store/conformance";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountChecks, DATED_CHECKED_KEY, FOLLOWUPS_CHECKED_KEY, type AccountChecksHost } from "./account-checks";
import { Backend, plaintextCipher } from "./backend";
import { readSettings } from "./settings";

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 17, 12).getTime();
const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe("the checks' bookkeeping", () => {
  /** a host over a settings map and a few accounts, each `synced` and `allowed` as the test says */
  function fake(accounts: { id: number; synced?: boolean; allowed?: boolean }[]) {
    const kept = new Map<string, unknown>();
    const checks: { accountId: number; since: number | null }[] = [];
    const clock = { now: NOW };
    const state = { active: true, fail: false, refuse: false };
    const host: AccountChecksHost = {
      key: "k",
      store: {
        settings: {
          get: async <T,>(key: string, fallback: T) => (kept.has(key) ? (structuredClone(kept.get(key)) as T) : fallback),
          set: async (key: string, value: unknown) => void kept.set(key, structuredClone(value)),
          update: async () => {
            throw new Error("unused");
          },
        },
        accounts: {
          list: async () => accounts.map((a) => ({ id: a.id, syncState: { lastSyncAt: a.synced === false ? null : NOW - DAY } }) as Account),
        } as unknown as AccountChecksHost["store"]["accounts"],
      },
      now: () => clock.now,
      active: async () => state.active,
      allowed: (id) => accounts.find((a) => a.id === id)?.allowed !== false,
      check: async (accountId, since) => {
        if (state.fail) throw new Error("the store failed");
        if (state.refuse) return false;
        checks.push({ accountId, since });
        return true;
      },
      log: () => {},
    };
    return { checks: new AccountChecks(host), host, kept, made: checks, clock, state, accounts };
  }

  it("each synced account it may read, once; one not synced, not allowed or while inactive waits for a later moment", async () => {
    const t = fake([{ id: 1 }, { id: 2, synced: false }, { id: 3, allowed: false }]);
    // before the worker starts (the upgrade may not have run), nothing
    await t.checks.reconcile();
    await t.checks.synced(1);
    expect(t.made).toEqual([]);
    t.state.active = false;
    await t.checks.start();
    expect(t.made).toEqual([]);
    t.state.active = true;
    await t.checks.reconcile();
    expect(t.made).toEqual([{ accountId: 1, since: null }]);
    expect(t.kept.get("k")).toEqual({ 1: { at: NOW } });
    await t.checks.reconcile();
    await t.checks.synced(1);
    expect(t.made).toHaveLength(1);
    t.accounts[1]!.synced = true;
    t.accounts[2]!.allowed = true;
    await t.checks.reconcile([2]);
    expect(t.made.map((c) => c.accountId)).toEqual([1, 2]);
  });

  it("the queue first, then the record: a check that fails isn't recorded, and is made again", async () => {
    const t = fake([{ id: 1 }]);
    t.state.fail = true;
    await t.checks.start();
    expect(t.kept.has("k")).toBe(false);
    t.state.fail = false;
    await t.checks.synced(1);
    expect(t.made).toEqual([{ accountId: 1, since: null }]);
  });

  it("Codex code review 2: a check that couldn't (off meanwhile) isn't recorded, and is made in full later", async () => {
    const t = fake([{ id: 1 }]);
    t.state.refuse = true;
    await t.checks.start();
    expect(t.kept.has("k")).toBe(false);
    t.state.refuse = false;
    await t.checks.synced(1);
    expect(t.made).toEqual([{ accountId: 1, since: null }]);
  });

  it("withdrawn after the check: owed from then, once readable again; the first moment kept until a check covers it (Codex code review 4)", async () => {
    const t = fake([{ id: 1 }]);
    // never checked: nothing's owed but the whole window
    await t.checks.withdrawn(1);
    await t.checks.start();
    expect(t.made).toEqual([{ accountId: 1, since: null }]);
    t.clock.now = NOW + 3_600_000;
    await t.checks.withdrawn(1);
    t.accounts[0]!.allowed = false;
    // off again later, before any check: the gap still starts at the first
    t.clock.now = NOW + 3 * 3_600_000;
    await t.checks.withdrawn(1);
    await t.checks.synced(1);
    expect(t.made).toHaveLength(1);
    t.accounts[0]!.allowed = true;
    t.clock.now = NOW + 5 * 3_600_000;
    // a pass's end finds it too (a lookup: it's owed)
    await t.checks.synced(1);
    expect(t.made[1]).toEqual({ accountId: 1, since: NOW + 3_600_000 });
    expect(t.kept.get("k")).toEqual({ 1: { at: NOW + 5 * 3_600_000 } });
    await t.checks.reconcile([1]);
    expect(t.made).toHaveLength(2);
  });

  it("an account removed is forgotten: its id may come back as another's", async () => {
    const t = fake([{ id: 1 }]);
    await t.checks.start();
    await t.checks.forget(1);
    expect(t.kept.get("k")).toEqual({});
    await t.checks.synced(1);
    expect(t.made).toHaveLength(2);
  });
});

describe("in the backend (scripted providers)", () => {
  interface Script {
    /** the first pass's mail (a first sync: not live) */
    first: IncomingMessage[];
    /** the next pass's mail, as live or not */
    next: { mail: IncomingMessage[]; live: boolean } | null;
    /** the first pass ends with the host offline */
    offline?: boolean;
    passes: number;
  }

  async function setup(o: { dir?: string; accounts?: { email: string; prefs?: AccountPrefs }[]; before?: (backend: Backend) => Promise<void> } = {}) {
    const scripts = new Map<string, Script>();
    const clock = { now: NOW };
    let backend!: Backend;
    const registry: ProviderRegistry = {
      create(ctx) {
        const s = scripts.get(ctx.account.email)!;
        const p: MailProvider = {
          async verify() {},
          async sync(sink: SyncSink) {
            s.passes++;
            if (s.passes === 1) {
              await sink.ingest(s.first.splice(0), { live: false });
              if (s.offline) backend.networkChanged(false, "offline");
            } else if (s.next) {
              const { mail, live } = s.next;
              s.next = null;
              await sink.ingest(mail, { live });
            }
          },
          async execute() {},
          async close() {},
        } as MailProvider;
        return p;
      },
      async verifyImap() {},
      async connectGmail() {
        throw new Error("not in tests");
      },
    };
    const dir = o.dir ?? mkdtempSync(join(tmpdir(), "terno-checks-"));
    backend = new Backend({ dbPath: join(dir, "t.db"), version: "t", cipher: plaintextCipher, providers: registry, autoSync: true, syncIntervalMs: 3_600_000, connectivity: { delays: [3_600_000], settleMs: 30, offlineRetryMs: 3_600_000 }, demoAi: true, now: () => clock.now });
    await backend.store.ready;
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId: "r", origin: "renderer" });
    const client = new RpcClient(c);
    await client.call("settings.update", { ai: { provider: "fake", model: "demo" } });
    const ids: number[] = [];
    for (const a of o.accounts ?? [{ email: "a@example.com" }]) {
      const existing = (await backend.store.accounts.list()).find((x) => x.email === a.email);
      ids.push(existing?.id ?? createAccount(sqlDb(backend.store), { kind: "imap", email: a.email, displayName: a.email, color: "brown", providerConfig: a.prefs ?? {} }).id);
      scripts.set(a.email, { first: [], next: null, passes: 0 });
    }
    await o.before?.(backend);
    // what each check queued: the ids it was handed and what it took
    const datedQueued: number[][] = [];
    const sentQueued: number[][] = [];
    const dq = backend.store.dated.marks.queueScan.bind(backend.store.dated.marks);
    const fq = backend.store.followups.marks.queueScan.bind(backend.store.followups.marks);
    vi.spyOn(backend.store.dated.marks, "queueScan").mockImplementation(async (msgIds, now) => (datedQueued.push([...msgIds]), dq(msgIds, now)));
    vi.spyOn(backend.store.followups.marks, "queueScan").mockImplementation(async (msgIds, now) => (sentQueued.push([...msgIds]), fq(msgIds, now)));
    cleanups.push(async () => {
      await backend.stop();
      if (!o.dir) rmSync(dir, { recursive: true, force: true });
    });
    const received = (accountId: number, key: string, daysAgo: number) => msg({ accountId, providerMsgId: key, subject: key, from: { name: "Power Co", email: "billing@power.test" }, to: [{ name: "Me", email: "me@example.com" }], date: clock.now - daysAgo * DAY, bodyText: "Your bill is due on November 30." });
    const sent = (accountId: number, key: string, daysAgo: number) => msg({ accountId, providerMsgId: key, subject: key, from: { name: "Me", email: (sqlDb(backend.store).get<{ email: string }>("SELECT email FROM accounts WHERE id = ?", accountId))!.email }, to: [{ name: "Tom", email: "tom@acme.test" }], isSent: true, inInbox: false, date: clock.now - daysAgo * DAY, bodyText: "I'll send the contract tomorrow." });
    const id = (key: string) => sqlDb(backend.store).get<{ id: number }>("SELECT id FROM messages WHERE provider_msg_id = ?", key)!.id;
    const state = (accountId: number) => JSON.parse(sqlDb(backend.store).get<{ s: string }>("SELECT sync_state s FROM accounts WHERE id = ?", accountId)!.s) as { status: string; lastSyncAt: number | null };
    const checked = async (key: string) => Object.keys(await backend.store.settings.get<Record<string, unknown>>(key, {})).map(Number);
    return { backend, client, clock, ids, scripts: (email: string) => scripts.get(email)!, datedQueued, sentQueued, received, sent, id, state, checked, dir };
  }

  it("on by default: a first sync's end checks the account once, its window only (14 days received, 30 sent); another pass doesn't", async () => {
    const t = await setup();
    const [a] = t.ids;
    const script = t.scripts("a@example.com");
    script.first.push(t.received(a!, "bill-5d", 5), t.received(a!, "bill-20d", 20), t.sent(a!, "sent-10d", 10), t.sent(a!, "sent-40d", 40));
    await t.backend.start();
    await expect.poll(() => t.datedQueued.length).toBe(1);
    await expect.poll(() => t.sentQueued.length).toBe(1);
    expect(t.datedQueued[0]).toEqual([t.id("bill-5d")]);
    expect(t.sentQueued[0]).toEqual([t.id("sent-10d")]);
    expect(await t.checked(DATED_CHECKED_KEY)).toEqual([a]);
    expect(await t.checked(FOLLOWUPS_CHECKED_KEY)).toEqual([a]);
    // a second pass, with older mail coming in (not live): no check again
    script.next = { mail: [t.received(a!, "bill-3d", 3)], live: false };
    await t.backend.syncAccount(a!);
    expect(script.passes).toBe(2);
    await new Promise((r) => setTimeout(r, 50));
    expect(t.datedQueued).toHaveLength(1);
    expect(t.sentQueued).toHaveLength(1);
  });

  it("revision 9: a first sync that ends offline is checked all the same", async () => {
    const t = await setup();
    const [a] = t.ids;
    const script = t.scripts("a@example.com");
    script.first.push(t.received(a!, "bill-2d", 2));
    script.offline = true;
    await t.backend.start();
    await expect.poll(() => t.state(a!).status).toBe("offline");
    expect(t.state(a!).lastSyncAt).not.toBeNull();
    await expect.poll(() => t.datedQueued.length).toBe(1);
    expect(t.datedQueued).toEqual([[t.id("bill-2d")]]);
  });

  it("an account with AI off is never checked; turned on, its whole window is", async () => {
    const t = await setup({ accounts: [{ email: "a@example.com", prefs: { ai: false, aiOffAt: NOW - 30 * DAY } }, { email: "b@example.com" }] });
    const [a, b] = t.ids;
    t.scripts("a@example.com").first.push(t.received(a!, "a-bill-5d", 5), t.received(a!, "a-bill-1d", 1));
    t.scripts("b@example.com").first.push(t.received(b!, "b-bill-2d", 2));
    await t.backend.start();
    await expect.poll(() => t.state(a!).lastSyncAt !== null && t.state(b!).lastSyncAt !== null).toBe(true);
    await expect.poll(() => t.datedQueued.length).toBe(1);
    expect(t.datedQueued).toEqual([[t.id("b-bill-2d")]]);
    expect(await t.checked(DATED_CHECKED_KEY)).toEqual([b]);
    await t.client.call("accounts.update", { id: a!, ai: true });
    // never checked: the whole window, not since it went off
    await expect.poll(() => t.datedQueued.length).toBe(2);
    expect(t.datedQueued[1]).toEqual([t.id("a-bill-1d"), t.id("a-bill-5d")]);
    await expect.poll(async () => (await t.checked(DATED_CHECKED_KEY)).sort()).toEqual([a, b].sort());
    await expect.poll(async () => (await t.checked(FOLLOWUPS_CHECKED_KEY)).sort()).toEqual([a, b].sort());
  });

  it("revisions 7 and 8: checked, turned off and back on, it's checked again from when it went off, still in the window", async () => {
    const t = await setup();
    const [a] = t.ids;
    const script = t.scripts("a@example.com");
    script.first.push(t.received(a!, "before", 5));
    await t.backend.start();
    await expect.poll(() => t.datedQueued.length).toBe(1);
    t.clock.now = NOW + 3_600_000;
    await t.client.call("accounts.update", { id: a!, ai: false });
    // while it's off: live mail isn't marked, and older mail comes in too
    t.clock.now = NOW + 3 * 3_600_000;
    script.next = { mail: [t.received(a!, "while-off", 1 / 24), t.received(a!, "older", 6)], live: true };
    await t.backend.syncAccount(a!);
    expect(await t.backend.store.dated.marks.page(null, 10)).not.toContainEqual(expect.objectContaining({ messageId: t.id("while-off") }));
    t.clock.now = NOW + 4 * 3_600_000;
    await t.client.call("accounts.update", { id: a!, ai: true });
    await expect.poll(() => t.datedQueued.length).toBe(2);
    // only what came since it went off: "older" and "before" were the first check's, or read while it was on
    expect(t.datedQueued[1]).toEqual([t.id("while-off")]);
    // What matters' own switch, the same
    t.clock.now = NOW + 5 * 3_600_000;
    await t.client.call("accounts.update", { id: a!, feed: false });
    await t.client.call("accounts.update", { id: a!, feed: true });
    await expect.poll(() => t.datedQueued.length).toBe(3);
    expect(t.datedQueued[2]).toEqual([]);
  });

  it("Codex code review 4: switches off and on in turn before any check: the gap starts where it first went off", async () => {
    const t = await setup();
    const [a] = t.ids;
    const script = t.scripts("a@example.com");
    script.first.push(t.received(a!, "before", 5));
    await t.backend.start();
    await expect.poll(() => t.datedQueued.length).toBe(1);
    const at = (hours: number) => void (t.clock.now = NOW + hours * 3_600_000);
    at(1);
    await t.client.call("accounts.update", { id: a!, ai: false });
    at(1.5);
    script.next = { mail: [t.received(a!, "while-off", 0)], live: true };
    await t.backend.syncAccount(a!);
    // AI off, What matters off, AI on, AI off again (its moment written anew), What matters on, AI on
    for (const [h, patch] of [[2, { feed: false }], [3, { ai: true }], [4, { ai: false }], [5, { feed: true }], [6, { ai: true }]] as const) {
      at(h);
      await t.client.call("accounts.update", { id: a!, ...patch });
    }
    await expect.poll(() => t.datedQueued.length).toBe(2);
    expect(t.datedQueued[1]).toEqual([t.id("while-off")]);
  });

  it("Codex code review 3: the upgrade failing keeps the checks closed: nothing declined is read", async () => {
    const t = await setup({
      before: async (backend) => {
        const get = backend.store.settings.get.bind(backend.store.settings);
        vi.spyOn(backend.store.settings, "get").mockImplementation(async (key, fallback) => {
          if (key === "checks:version") throw new Error("the store failed");
          return get(key, fallback);
        });
      },
    });
    const [a] = t.ids;
    t.scripts("a@example.com").first.push(t.received(a!, "bill-2d", 2));
    await t.backend.start();
    await expect.poll(() => t.state(a!).lastSyncAt).not.toBeNull();
    await t.client.call("settings.update", { dated: { enabled: true } });
    await new Promise((r) => setTimeout(r, 50));
    expect(t.datedQueued).toEqual([]);
    expect(t.sentQueued).toEqual([]);
  });

  it("What matters turned off isn't checked; turned on, synced accounts are", async () => {
    const t = await setup({ before: async (backend) => void (await backend.server.invoke("settings.update", { dated: { enabled: false } }, { clientId: "setup", origin: "dev" })) });
    const [a] = t.ids;
    t.scripts("a@example.com").first.push(t.received(a!, "bill-2d", 2));
    await t.backend.start();
    await expect.poll(() => t.sentQueued.length).toBe(1);
    expect(t.datedQueued).toEqual([]);
    await t.client.call("settings.update", { dated: { enabled: true } });
    await expect.poll(() => t.datedQueued.length).toBe(1);
    expect(t.datedQueued).toEqual([[t.id("bill-2d")]]);
  });

  it("revision 10: an install that answered the offers counts the accounts it had as checked; one added after the upgrade is checked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terno-checks-upgrade-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    // the install before plan 211: answered both offers, with one account
    const first = await setup({
      dir,
      before: async (backend) => {
        const app = await backend.store.settings.get<Record<string, unknown>>("app", {});
        await backend.store.settings.set("app", { ...app, dated: { enabled: true, enabledAt: NOW - 30 * DAY, scanAnswered: true, offerDismissed: false }, followups: { enabled: true, enabledAt: NOW - 30 * DAY, nudgeAfterDays: 5, scanAnswered: true } });
      },
    });
    const [a] = first.ids;
    first.scripts("a@example.com").first.push(first.received(a!, "a-bill-2d", 2), first.sent(a!, "a-sent-2d", 2));
    await first.backend.start();
    await expect.poll(() => first.state(a!).lastSyncAt).not.toBeNull();
    expect(await first.checked(DATED_CHECKED_KEY)).toEqual([a]);
    expect(await first.checked(FOLLOWUPS_CHECKED_KEY)).toEqual([a]);
    // the answers went with the offers
    expect((await readSettings(first.backend.store)).dated).toEqual({ enabled: true, enabledAt: NOW - 30 * DAY });
    await new Promise((r) => setTimeout(r, 50));
    expect(first.datedQueued).toEqual([]);
    expect(first.sentQueued).toEqual([]);
    // an account added, then a restart: the upgrade isn't made again, and only the new account is checked
    const b = createAccount(sqlDb(first.backend.store), { kind: "imap", email: "b@example.com", displayName: "B", color: "brown", providerConfig: {} }).id;
    await first.backend.stop();
    const again = await setup({ dir, accounts: [{ email: "a@example.com" }, { email: "b@example.com" }] });
    again.scripts("b@example.com").first.push(again.received(b, "b-bill-2d", 2));
    await again.backend.start();
    await expect.poll(() => again.datedQueued.length).toBe(1);
    expect(again.datedQueued).toEqual([[again.id("b-bill-2d")]]);
    expect((await again.checked(DATED_CHECKED_KEY)).sort()).toEqual([a, b].sort());
  });

  it("Codex code review, round 2: an account off at the upgrade owes what came since it went off, not what was declined", async () => {
    const t = await setup({
      accounts: [{ email: "a@example.com", prefs: { ai: false, aiOffAt: NOW - 2 * DAY } }],
      before: async (backend) => {
        const app = await backend.store.settings.get<Record<string, unknown>>("app", {});
        await backend.store.settings.set("app", { ...app, dated: { enabled: true, enabledAt: NOW - 30 * DAY, scanAnswered: true, offerDismissed: false } });
      },
    });
    const [a] = t.ids;
    t.scripts("a@example.com").first.push(t.received(a!, "declined", 5), t.received(a!, "while-off", 1));
    await t.backend.start();
    await expect.poll(() => t.state(a!).lastSyncAt).not.toBeNull();
    await t.client.call("accounts.update", { id: a!, ai: true });
    await expect.poll(() => t.datedQueued.length).toBe(1);
    expect(t.datedQueued[0]).toEqual([t.id("while-off")]);
  });

  it("revision 10: an install that never answered checks each of its accounts", async () => {
    const t = await setup({
      before: async (backend) => {
        const app = await backend.store.settings.get<Record<string, unknown>>("app", {});
        await backend.store.settings.set("app", { ...app, dated: { enabled: true, enabledAt: NOW - 30 * DAY, scanAnswered: false, offerDismissed: false } });
      },
    });
    const [a] = t.ids;
    t.scripts("a@example.com").first.push(t.received(a!, "bill-2d", 2));
    await t.backend.start();
    await expect.poll(() => t.datedQueued.length).toBe(1);
    expect(t.datedQueued).toEqual([[t.id("bill-2d")]]);
  });
});
