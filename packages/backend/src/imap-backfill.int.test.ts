import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { sqlDb } from "@terno/db";
import { createRegistry } from "@terno/mail";
import { afterEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { bounded } from "./test/imap-idle-fixture";
import { flagsFixture } from "./test/imap-flags-fixture";

// Plan 101: widening an IMAP account's window downloads its older mail, in every folder it reads, as old mail.
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 1, 12);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

const raw = (subject: string, date: number) => [`From: Synthetic <sender@example.test>`, "To: Test <test@example.test>", `Subject: ${subject}`,
  `Message-ID: <${subject}@backfill.example.test>`, `Date: ${new Date(date).toUTCString()}`, "Content-Type: text/plain; charset=utf-8", "", `${subject} body`, ""].join("\r\n");

async function setup(o: { firstWindow?: number; searchMs?: number; roles?: boolean; extra?: (add: (path: string, subject: string, age: number, flags?: string[]) => { uid: number }) => void; before?: (backend: Backend) => void } = {}) {
  const w = await flagsFixture(false);
  cleanups.push(() => w.stop());
  const ctl = w.server.control;
  const add = (path: string, subject: string, age: number, flags = ["\\Seen"]) => ctl.addMessage(path, { raw: raw(subject, NOW - age * DAY), internaldate: new Date(NOW - age * DAY), flags });
  add("INBOX", "recent", 2);
  add("Projects", "recent-project", 3);
  for (let i = 0; i < 6; i++) add("INBOX", `older-${i}`, 60 + i * 30);
  add("Projects", "older-project", 100);
  add("INBOX", "ancient", 900);
  if (o.roles) for (const [path, use] of [["Junk", "\\Junk"], ["Trash", "\\Trash"]] as const) {
    ctl.createMailbox(path);
    ctl.setSpecialUse(path, [use]);
  }
  o.extra?.(add);
  const dir = mkdtempSync(join(tmpdir(), "terno-backfill-"));
  const notices: unknown[] = [];
  const backend = new Backend({ dbPath: join(dir, "t.db"), version: "t", cipher: plaintextCipher, instantSearch: false, autoSync: false, now: () => NOW,
    providers: createRegistry({ imap: { allowInsecure: true, timeouts: { connectMs: 2000, socketMs: 3000, ...(o.searchMs ? { searchMs: o.searchMs } : {}) } } }),
    attention: { badge() {}, notify: (n) => void notices.push(n) } });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "backfill", origin: "renderer" });
  const client = new RpcClient(c);
  cleanups.push(async () => { await bounded(backend.stop(), "stop"); client.close(); rmSync(dir, { recursive: true, force: true }); });
  await backend.ready;
  await client.call("settings.update", { syncWindowDays: o.firstWindow ?? 30 });
  o.before?.(backend);
  const account = await client.call("accounts.addImap", { email: "test@example.test", displayName: "Synthetic", verify: false,
    imap: { host: "127.0.0.1", port: w.port, secure: false, user: "testuser" }, smtp: { host: "127.0.0.1", port: 1, secure: false, user: "testuser" }, password: "testpass" });
  await bounded(backend.syncAccount(account.id), "first sync");
  const subjects = () => sqlDb(backend.store).all<{ subject: string }>("SELECT subject FROM messages ORDER BY subject").map((r) => r.subject);
  const cursor = () => JSON.parse(sqlDb(backend.store).get<{ c: string }>("SELECT provider_config c FROM accounts WHERE id = ?", account.id)!.c).cursor;
  return { backend, client, account, subjects, cursor, notices, w, ctl };
}

it("a wider window takes in the older mail of every folder it reads, without notices or moving its place", async () => {
  const t = await setup();
  expect(t.subjects()).toEqual(["recent", "recent-project"]);
  const uidnext = Object.fromEntries(Object.entries(t.cursor().mailboxes as Record<string, { uidnext: number }>).map(([p, m]) => [p, m.uidnext]));
  const noticesBefore = t.notices.length;
  // a year: the six older ones and the project's, not the one from 900 days ago
  await t.client.call("accounts.update", { id: t.account.id, syncWindowDays: 365 });
  await expect.poll(async () => (await t.backend.store.accounts.get(t.account.id))?.backfillSince, { timeout: 10_000 }).toBeNull();
  expect(t.subjects()).toEqual(["older-0", "older-1", "older-2", "older-3", "older-4", "older-5", "older-project", "recent", "recent-project"]);
  expect(t.notices.length).toBe(noticesBefore);
  const after = t.cursor();
  for (const [path, next] of Object.entries(uidnext)) expect(after.mailboxes[path].uidnext).toBe(next);
  expect(after.backfill).toBeUndefined();
});

it("a narrower window asks for nothing; widening back asks again", async () => {
  const t = await setup();
  await t.client.call("accounts.update", { id: t.account.id, syncWindowDays: 14 });
  expect((await t.backend.store.accounts.get(t.account.id))?.backfillSince).toBeNull();
  await t.client.call("accounts.update", { id: t.account.id, syncWindowDays: 30 });
  expect((await t.backend.store.accounts.get(t.account.id))?.backfillSince).not.toBeNull();
});

it("a storage removal cancels a pending backfill (what is removed isn't fetched back)", async () => {
  const t = await setup();
  await t.backend.store.accounts.update(t.account.id, { backfill: { merge: { since: NOW - 365 * DAY, until: NOW - 30 * DAY } } });
  expect((await t.backend.store.accounts.get(t.account.id))?.backfillSince).toBe(NOW - 365 * DAY);
  await t.backend.cancelBackfills();
  expect((await t.backend.store.accounts.get(t.account.id))?.backfillSince).toBeNull();
});

const done = (t: Awaited<ReturnType<typeof setup>>) => expect.poll(async () => (await t.backend.store.accounts.get(t.account.id))?.backfillSince, { timeout: 10_000 }).toBeNull();

it("a folder whose backfill search is refused isn't marked done: a later pass reads it (Codex review)", async () => {
  const t = await setup();
  // the backfill's SEARCH (SINCE … BEFORE …) in Projects is refused once
  let refused = 0;
  t.w.server.script.add({ on: "command", command: "UID SEARCH", when: (ctx: { data: string; mailbox: string | null }) => /BEFORE/i.test(ctx.data) && ctx.mailbox === "Projects" && refused++ === 0, send: "$TAG NO Search refused\r\n" } as never);
  await t.client.call("accounts.update", { id: t.account.id, syncWindowDays: 365 });
  // the pass that started ends with Projects to retry: the request stays, its older mail isn't here yet
  await expect.poll(() => refused, { timeout: 10_000 }).toBe(1);
  await expect.poll(() => t.subjects().includes("older-5"), { timeout: 10_000 }).toBe(true);
  expect((await t.backend.store.accounts.get(t.account.id))?.backfillSince).not.toBeNull();
  expect(t.subjects()).not.toContain("older-project");
  // the next regular pass reads it and finishes
  await bounded(t.backend.syncAccount(t.account.id), "next pass");
  await done(t);
  expect(t.subjects()).toContain("older-project");
});

it("an older message in two folders arrives from both, as a first sync reads it, and nothing stays held (Codex review)", async () => {
  const t = await setup({ extra: (add) => { add("INBOX", "twin", 120); add("Projects", "twin", 120); } });
  await t.client.call("accounts.update", { id: t.account.id, syncWindowDays: 365 });
  await done(t);
  // a copy in each folder, each at its place (IMAP copies are separate messages, as in a first sync)
  const twins = sqlDb(t.backend.store).all<{ id: number }>("SELECT id FROM messages WHERE subject = 'twin'");
  const places = (await t.backend.store.providerStore(t.account.id).locations.of(twins.map((m) => m.id))).map((l) => l.mailbox).sort();
  expect(places).toEqual(["INBOX", "Projects"]);
  expect(sqlDb(t.backend.store).all("SELECT 1 FROM imap_identity_holds")).toEqual([]);
  expect(t.cursor().backfill).toBeUndefined();
});

it("a stored older message whose flags changed on the server shows the change after the backfill reads it (Codex review)", async () => {
  // a 60-day first window takes the 40-day-old message; narrowed to 30, then widened to a year
  let starred = 0;
  const t = await setup({ firstWindow: 60, extra: (add) => { starred = add("INBOX", "forty", 40).uid; } });
  await t.client.call("accounts.update", { id: t.account.id, syncWindowDays: 30 });
  const id = sqlDb(t.backend.store).get<{ id: number }>("SELECT id FROM messages WHERE subject = 'forty'")!.id;
  expect(sqlDb(t.backend.store).get<{ s: number }>("SELECT is_starred s FROM messages WHERE id = ?", id)!.s).toBe(0);
  // starred on the server after the pass's sweep, as the backfill's SEARCH arrives: only the backfill sees it
  let changed = false;
  t.w.server.script.add({ on: "command", command: "UID SEARCH", run: true, when: (ctx: { data: string; mailbox: string | null }) => {
    if (!changed && /BEFORE/i.test(ctx.data) && ctx.mailbox === "INBOX") { changed = true; t.ctl.setFlags("INBOX", [starred], ["\\Flagged"], "add"); }
    return false;
  } } as never);
  await t.client.call("accounts.update", { id: t.account.id, syncWindowDays: 365 });
  await done(t);
  expect(changed).toBe(true);
  expect(sqlDb(t.backend.store).get<{ s: number }>("SELECT is_starred s FROM messages WHERE id = ?", id)!.s).toBe(1);
  // and the next pass's sweep agrees (nothing was swallowed)
  await bounded(t.backend.syncAccount(t.account.id), "next pass");
  expect(sqlDb(t.backend.store).get<{ s: number }>("SELECT is_starred s FROM messages WHERE id = ?", id)!.s).toBe(1);
});

it("plan 103: an IMAP first read says how many folders it has read", async () => {
  const { vi } = await import("vitest");
  const writes: unknown[] = [];
  const t = await setup({ before: (backend) => {
    const server = (backend as unknown as { server: { emit: (name: string, payload: unknown) => void } }).server;
    const emit = server.emit.bind(server);
    vi.spyOn(server, "emit").mockImplementation((name, payload) => { if (name === "syncProgress" && (payload as { progress: unknown }).progress) writes.push((payload as { progress: unknown }).progress); emit(name, payload); });
  } });
  expect(writes[0]).toEqual({ done: 0, total: 2, unit: "folders" });
  // done: nothing left to show (absent or null: a state that never stored progress stays sparse, afd95dac)
  expect((await t.backend.store.accounts.get(t.account.id))?.syncState.progress ?? null).toBeNull();
});

// Plan 141: older mail, on a click, from a real IMAP server: every folder but Junk and Trash, old mail kept by later passes.
describe("Ask's server search", () => {
  const criteria = (terms: string[], extra: object = {}) => ({ queries: [{ terms, ...extra }], before: NOW - 30 * DAY, limit: 50, signal: new AbortController().signal });

  it("finds a match in any selectable folder, never Junk or Trash, and reads no body", async () => {
    const t = await setup({ roles: true, extra: (add) => {
      add("Projects", "lease-in-a-folder", 400);
      add("INBOX", "lease-in-the-inbox", 300);
      add("Junk", "lease-in-junk", 300);
      add("Trash", "lease-in-trash", 300);
    } });
    const provider = (await t.backend.provider(t.account.id))!;
    const r = await provider.search!(criteria(["lease"]));
    expect(r.partial).toBe(false);
    expect(r.hits.map((h) => h.place!.mailbox)).toEqual(["INBOX", "Projects"]);
    // a whole term, and nothing stored yet
    expect(t.subjects()).toEqual(["recent", "recent-project"]);
    // one that's outside the window but a word that isn't there
    expect((await provider.search!(criteria(["nothing-like-this"]))).hits).toEqual([]);
    // what's in the window is the local search's
    expect((await provider.search!(criteria(["recent"]))).hits).toEqual([]);
  });

  it("each term must hold; a group needs one; a repeat of the same message under two folders collapses", async () => {
    const t = await setup({ extra: (add) => {
      add("INBOX", "alpha-beta", 300);
      add("INBOX", "alpha-only", 300);
      add("INBOX", "twice", 300);
      add("Projects", "twice", 300);
    } });
    const provider = (await t.backend.provider(t.account.id))!;
    expect((await provider.search!(criteria(["alpha", "beta"]))).hits).toHaveLength(1);
    expect((await provider.search!(criteria([], { anyOf: [["beta", "only"]] }))).hits).toHaveLength(2);
    expect((await provider.search!(criteria(["twice"]))).hits).toHaveLength(1);
  });

  it("a server that stops answering holds the account only until the deadline, and what was found so far stands", async () => {
    const t = await setup({ searchMs: 800, extra: (add) => { add("INBOX", "slowword-a", 300); add("Projects", "slowword-b", 300); } });
    // the second folder's search never gets a tagged answer
    t.w.server.script.add({ on: "command", command: "UID SEARCH", when: (ctx: { mailbox: string | null }) => ctx.mailbox === "Projects", send: "* OK still looking\r\n" } as never);
    const provider = (await t.backend.provider(t.account.id))!;
    const started = Date.now();
    const r = await provider.search!(criteria(["slowword"]));
    expect(Date.now() - started).toBeLessThan(2500);
    expect(r.partial).toBe(true);
    expect(r.hits).toHaveLength(1);
    // the account's next pass works: the session that was closed isn't kept
    await bounded(t.backend.syncAccount(t.account.id), "a pass after the deadline");
  });

  it("fetching stores them as old mail with no notices; a later pass of the provider keeps them", async () => {
    const t = await setup({ extra: (add) => void add("INBOX", "lease-old", 300) });
    const noticesBefore = t.notices.length;
    const provider = (await t.backend.provider(t.account.id))!;
    const { hits } = await provider.search!(criteria(["lease"]));
    const ids: number[] = [];
    await t.backend.fetchHitsForAccount(t.account.id, hits, new AbortController().signal, (inserted) => ids.push(...inserted));
    expect(ids).toHaveLength(1);
    expect(t.subjects()).toContain("lease-old");
    expect(t.notices.length).toBe(noticesBefore);
    await bounded(t.backend.syncAccount(t.account.id), "second sync");
    await bounded(t.backend.syncAccount(t.account.id), "third sync");
    expect(t.subjects()).toContain("lease-old");
    // found again, it's already here
    expect((await provider.search!(criteria(["lease"]))).hits).toEqual([]);
  });
});
