/**
 * Plan 281 through the real backend: who has something open with you, everyone you've written to, the search and one
 * person's page. The items are What matters' own (its rules are its tests'); here, whom each is given to and what's left out.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { demoRegistry } from "@terno/mail";
import type { IncomingMessage } from "@terno/store";
import { msg, threadOf } from "@terno/store/conformance";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { personOf } from "./people";

const NOW = new Date(2026, 10, 5, 9).getTime();
const DAY = 86_400_000;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup(o: { provider?: "fake" | "none"; followups?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "terno-people-"));
  const clock = { now: NOW };
  const backend = new Backend({ dbPath: join(dir, "a.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false, demoAi: true, now: () => clock.now });
  await backend.store.ready;
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "r", origin: "renderer" });
  const client = new RpcClient(c);
  const { account } = await backend.store.accounts.create({ kind: "gmail", email: "me@terno.test", displayName: "Me", color: "brown", now: 0 });
  if (o.provider !== "none") await client.call("settings.update", { ai: { provider: "fake", model: "demo" } });
  if (o.followups) await client.call("settings.update", { followups: { enabled: true } });
  cleanups.push(async () => {
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const raw = (backend.store as unknown as { db: { run(sql: string, ...a: unknown[]): unknown } }).db;
  let seq = 0;
  const me = { name: "Me", email: account.email };
  /** a conversation from someone, waiting on your answer (or not) */
  const from = async (name: string, email: string, o: { waiting?: boolean; over?: Partial<IncomingMessage> } = {}) => {
    const id = `m-${seq++}`;
    const m = msg({ accountId: account.id, date: NOW - DAY + seq, from: { name, email }, to: [me], subject: `From ${name} ${seq}`, providerMsgId: id, ...o.over });
    await backend.store.sync.ingest([m], { applyFilters: false, now: NOW, classifier: null });
    const thread = await threadOf(backend.store, id);
    const waiting = o.waiting ?? true;
    raw.run("UPDATE threads SET waiting_since = ?, has_sent = ? WHERE id = ?", waiting ? NOW - DAY + seq : null, waiting ? 1 : 0, thread);
    return thread;
  };
  /** mail you sent them (the index's "written to") */
  const to = async (name: string, email: string) => {
    const id = `s-${seq++}`;
    await backend.store.sync.ingest([msg({ accountId: account.id, date: NOW - 2 * DAY + seq, from: me, to: [{ name, email }], subject: `To ${name}`, providerMsgId: id, isSent: true, isRead: true })], { applyFilters: false, now: NOW, classifier: null });
    return threadOf(backend.store, id);
  };
  /** a reply owed to you on this conversation */
  const owed = (thread: number, name: string, email: string) =>
    raw.run(
      "INSERT INTO followups (thread_id, message_id, item, kind, text, person_name, person_email, sent_at, due_at, state, created_at) VALUES (?, (SELECT id FROM messages WHERE thread_id = ? LIMIT 1), 0, 'awaiting', 'the contract', ?, ?, ?, ?, 'open', ?)",
      thread,
      thread,
      name,
      email,
      NOW - 3 * DAY,
      NOW + DAY,
      NOW - 3 * DAY,
    );
  return { backend, client, raw, account, clock, from, to, owed };
}

describe("who has something open with you", () => {
  it("nothing at all while What matters isn't offered", async () => {
    const { client, from } = await setup({ provider: "none" });
    await from("Ana", "ana@people.test");
    expect(await client.call("people.list", {})).toMatchObject({ open: [], everyone: [] });
    expect(await client.call("people.person", { email: "ana@people.test" })).toBeNull();
    expect((await client.call("people.search", { query: "an" })).hits).toEqual([]);
  });

  it("conversations waiting on you, by who wrote, one person however their address is spelled", async () => {
    const { client, from } = await setup();
    const a1 = await from("Ana B", "ana.b@gmail.com");
    const a2 = await from("Ana B", "anab+work@googlemail.com");
    const bob = await from("Bob", "bob@people.test");
    const { open } = await client.call("people.list", {});
    const ana = open.find((p) => p.key === "anab@gmail.com")!;
    expect(ana.items.map((i) => (i.kind === "today" ? i.item.thread.id : 0)).sort()).toEqual([a1, a2].sort());
    expect(open.find((p) => p.key === "bob@people.test")!.items).toHaveLength(1);
    expect(open.flatMap((p) => p.items).map((i) => (i.kind === "today" ? i.item.thread.id : 0))).toContain(bob);
  });

  it("replies owed to you join with follow-ups on, never from Trash, Spam or with follow-ups off", async () => {
    const { client, raw, from, owed } = await setup({ followups: true });
    const t = await from("Cara", "cara@people.test", { waiting: false });
    owed(t, "Cara", "cara@people.test");
    const binned = await from("Dan", "dan@people.test", { waiting: false });
    owed(binned, "Dan", "dan@people.test");
    raw.run("UPDATE threads SET in_trash = 1, in_inbox = 0 WHERE id = ?", binned);
    const { open } = await client.call("people.list", {});
    expect(open.map((p) => p.key)).toEqual(["cara@people.test"]);
    expect(open[0]!.items[0]).toMatchObject({ kind: "awaiting", row: { text: "the contract" }, thread: { id: t } });
    await client.call("settings.update", { followups: { enabled: false } });
    expect((await client.call("people.list", {})).open).toEqual([]);
  });

  it("a conversation moved to Trash leaves at once (any mail change reads the grouping again)", async () => {
    const { backend, client, raw, from } = await setup();
    const t = await from("Ana", "ana@people.test");
    expect((await client.call("people.list", {})).open).toHaveLength(1);
    raw.run("UPDATE threads SET in_trash = 1, in_inbox = 0 WHERE id = ?", t);
    backend.today.touched();
    expect((await client.call("people.list", {})).open).toEqual([]);
  });

  it("Open is longest waiting first (owner, after the QA panel); one with only what's put off with Later is last, not counted", async () => {
    const { backend, client, raw, account, from } = await setup({ followups: true });
    const soon = await from("Bea", "bea@people.test");
    const long = await from("Carl", "carl@people.test");
    // Carl has waited a week, Bea a day: Carl first, whatever What matters' own order
    raw.run("UPDATE threads SET waiting_since = ? WHERE id = ?", NOW - 7 * DAY, long);
    raw.run("UPDATE threads SET waiting_since = ? WHERE id = ?", NOW - DAY, soon);
    // Ana: only a promise put off with Later
    const m = msg({ accountId: account.id, from: { name: "Me", email: account.email }, to: [{ name: "Ana", email: "ana@people.test" }], isSent: true, inInbox: true, date: NOW - DAY, providerMsgId: "p-1", subject: "The deck" });
    const r = await backend.store.sync.ingest([m], { applyFilters: false, now: NOW, classifier: null, liveSent: { wanted: true } });
    const thread = await threadOf(backend.store, "p-1");
    await backend.store.followups.finish({ messageId: r.inserted[0]!, threadId: thread, fromScan: false, now: NOW, kept: [], model: "m", provider: "p", promptVersion: 1, clearGeneration: backend.store.followups.clearGeneration(), rows: [{ kind: "promise", item: 0, text: "send the deck", quote: "I'll send it", personName: "Ana", personEmail: "ana@people.test", dueAt: NOW - 1000, dated: false }] });
    const row = (await backend.store.followups.ofThread(thread))[0]!;
    await client.call("followups.act", { id: row.id, revision: row.revision, action: "later", dueAt: NOW + 3 * DAY });
    backend.today.changed();
    const { open } = await client.call("people.list", {});
    expect(open.map((p) => [p.key, p.since])).toEqual([
      ["carl@people.test", NOW - 7 * DAY],
      ["bea@people.test", NOW - DAY],
      ["ana@people.test", null],
    ]);
  });

  it("the owner's renewal (2026-11-26): what What matters keeps under Coming up isn't open yet, its person last, under Later, not counted", async () => {
    const { backend, client, raw, clock, from, to } = await setup();
    const bea = await from("Bea", "bea@people.test");
    raw.run("UPDATE threads SET waiting_since = ? WHERE id = ?", NOW - DAY, bea);
    // Gonzalo, whom you write to, mailed a week ago: renew the registered agent by Jan 12, its time to act a week before
    await to("Gonzalo", "gonzalo@people.test");
    const renewal = await from("Gonzalo", "gonzalo@people.test", { waiting: false });
    const due = new Date(2027, 0, 12, 23, 59).getTime();
    raw.run(
      "INSERT INTO dated_items (thread_id, message_id, item, kind, text, quote, sender_key, due_day, due_at, act_at, arrived_at, state, created_at) VALUES (?, (SELECT id FROM messages WHERE thread_id = ? LIMIT 1), 0, 'renew', 'Renew the registered agent', 'antes del 13/01/2027', 'gonzalo@people.test', '2027-01-12', ?, ?, ?, 'open', ?)",
      renewal,
      renewal,
      due,
      new Date(2027, 0, 5, 9).getTime(),
      NOW - 7 * DAY,
      NOW,
    );
    backend.today.changed();
    // What matters keeps it under Coming up, so People has it as not yet: Gonzalo last, his search hit counting nothing open
    const placed = async () => (await client.call("today.list", { held: [] })).sections.find((x) => x.items.some((i) => i.thread.id === renewal))?.kind;
    expect(await placed()).toBe("comingUp");
    const { open } = await client.call("people.list", {});
    expect(open.map((p) => [p.key, p.since])).toEqual([
      ["bea@people.test", NOW - DAY],
      ["gonzalo@people.test", null],
    ]);
    const item = open[1]!.items[0]!;
    const shows = item.kind === "today" ? item.item.why.ahead! : 0;
    expect(item.kind === "today" && [item.item.why.kind, item.item.why.back]).toEqual(["dated", undefined]);
    expect(shows).toBeGreaterThan(NOW);
    expect(shows).toBeLessThan(due);
    expect(await client.call("people.ready", {})).toEqual({ index: "ready" });
    expect((await client.call("people.search", { query: "gonz" })).hits.map((h) => [h.key, h.open])).toEqual([["gonzalo@people.test", 0]]);
    // its time to act comes: in What matters and People alike, open now, since that moment (never since the mail)
    clock.now = shows + 3_600_000;
    backend.today.changed();
    expect(await placed()).not.toBe("comingUp");
    // (Bea's conversation is long past waiting on you by January)
    const later = await client.call("people.list", {});
    expect(later.open.map((p) => [p.key, p.since])).toEqual([["gonzalo@people.test", shows]]);
    expect((await client.call("people.search", { query: "gonz" })).hits.map((h) => [h.key, h.open])).toEqual([["gonzalo@people.test", 1]]);
  });

  it("a person's items: what's open now, longest waiting first, then what's put off", async () => {
    const { client, raw, from } = await setup();
    const newer = await from("Ana", "ana@people.test");
    const older = await from("Ana", "ana@people.test");
    raw.run("UPDATE threads SET waiting_since = ? WHERE id = ?", NOW - 5 * DAY, older);
    raw.run("UPDATE threads SET waiting_since = ? WHERE id = ?", NOW - 2 * DAY, newer);
    const page = (await client.call("people.person", { email: "ana@people.test" }))!;
    expect(page.items.map((i) => (i.kind === "today" ? i.item.thread.id : 0))).toEqual([older, newer]);
  });

  it("the grouping is read again after What matters changes, not before", async () => {
    const { backend, client, from } = await setup();
    await from("Ana", "ana@people.test");
    expect((await client.call("people.list", {})).open).toHaveLength(1);
    await from("Bob", "bob@people.test");
    // kept: nothing said What matters changed
    expect((await client.call("people.list", {})).open).toHaveLength(1);
    backend.today.changed();
    expect((await client.call("people.list", {})).open).toHaveLength(2);
  });
});

describe("everyone and the search", () => {
  it("everyone you've written to (the open ones too, at their places), never yourself; the search finds anyone by name or domain", async () => {
    const { backend, client, from, to } = await setup();
    await to("Marco", "marco@greenway.studio");
    await to("Ana", "ana@people.test");
    await to("Me again", "me+notes@terno.test");
    // an alias you send from (the index learns it from your sent mail): never a person here
    await backend.store.sync.ingest([msg({ accountId: 1, date: NOW - 3 * DAY, from: { name: "Me", email: "alias@other.test" }, to: [{ name: "Marco", email: "marco@greenway.studio" }], subject: "From my alias", providerMsgId: "alias-1", isSent: true, isRead: true })], { applyFilters: false, now: NOW, classifier: null });
    await backend.store.sync.ingest([msg({ accountId: 1, date: NOW - 3 * DAY, from: { name: "Ana", email: "ana@people.test" }, to: [{ name: "Me", email: "alias+x@other.test" }], subject: "To my alias", providerMsgId: "alias-2" })], { applyFilters: false, now: NOW, classifier: null });
    await from("Ana", "ana@people.test");
    await from("Priya", "priya@greenway.studio", { waiting: false });
    expect(await client.call("people.ready", {})).toEqual({ index: "ready" });
    const list = await client.call("people.list", {});
    expect(list.index).toBe("ready");
    expect(list.open.map((p) => p.key)).toEqual(["ana@people.test"]);
    expect(list.everyone!.map((p) => p.email).sort()).toEqual(["ana@people.test", "marco@greenway.studio"]);
    // Everyone isn't sent again while it's the version the renderer holds
    const again = await client.call("people.list", { known: list.everyoneVersion });
    expect(again.everyone).toBeUndefined();
    expect(again.open.map((p) => p.key)).toEqual(["ana@people.test"]);
    // and you never get a page of your own
    expect(await client.call("people.person", { email: "me+notes@terno.test" })).toBeNull();
    const found = await client.call("people.search", { query: "greenway" });
    expect(found.hits.map((h) => h.email).sort()).toEqual(["marco@greenway.studio", "priya@greenway.studio"]);
    const anaHit = (await client.call("people.search", { query: "ana" })).hits[0]!;
    expect(anaHit.key).toBe("ana@people.test");
    expect(anaHit.open).toBeGreaterThan(0);
    expect((await client.call("people.search", { query: "me" })).hits.map((h) => h.email)).not.toContain("me+notes@terno.test");
    expect((await client.call("people.search", { query: "alias" })).hits.map((h) => h.email)).toEqual([]);
  });
});

describe("only people (owner, after the QA panel)", () => {
  it("a no-reply or a service's receipts, mail marked as spam, one you said isn't a person: never in the search, Everyone or Open", async () => {
    const { backend, client, from, to } = await setup();
    await from("Figma", "no-reply@figma.com", { waiting: false });
    await from("Stripe", "receipts@stripe.com", { waiting: false });
    // a role address you've written to is someone's (plan 278's rule)
    await to("Acme support", "support@acme.test");
    await to("Spammy", "deals@spammy.test");
    await to("Rita", "rita@people.test");
    await from("Rita", "rita@people.test");
    await client.call("people.ready", {});
    const hits = async (query: string) => (await client.call("people.search", { query })).hits.map((h) => h.email);
    expect(await hits("figma")).toEqual([]);
    expect(await hits("stripe")).toEqual([]);
    expect(await hits("support")).toEqual(["support@acme.test"]);
    expect(await hits("spammy")).toEqual(["deals@spammy.test"]);
    // mail from them marked as spam: they're out
    (backend.autocomplete as unknown as { contacts: { markSpam(e: string[]): void } }).contacts.markSpam(["deals@spammy.test"]);
    expect(await hits("spammy")).toEqual([]);
    expect((await client.call("people.list", {})).everyone!.map((p) => p.email)).not.toContain("deals@spammy.test");
    // you said Rita isn't a person: out of Open, Everyone and the search; said she is again, back
    expect((await client.call("people.list", {})).open.map((p) => p.key)).toEqual(["rita@people.test"]);
    await client.call("people.setRule", { email: "rita@people.test", name: "Rita", person: false });
    const without = await client.call("people.list", {});
    expect(without.open).toEqual([]);
    expect(without.everyone!.map((p) => p.email)).not.toContain("rita@people.test");
    expect(await hits("rita")).toEqual([]);
    await client.call("people.setRule", { email: "receipts@stripe.com", name: "Stripe", person: true });
    expect(await hits("stripe")).toEqual(["receipts@stripe.com"]);
  });

  it("Everyone is sent again when a rule changes, though the renderer holds the index's version (Codex review)", async () => {
    const { client, to } = await setup();
    await to("Rita", "rita@people.test");
    await client.call("people.ready", {});
    const first = await client.call("people.list", {});
    expect(first.everyone!.map((p) => p.email)).toContain("rita@people.test");
    await client.call("people.setRule", { email: "rita@people.test", name: "Rita", person: false });
    const without = await client.call("people.list", { known: first.everyoneVersion });
    expect(without.everyone?.map((p) => p.email)).not.toContain("rita@people.test");
    await client.call("people.removeRule", { email: "rita@people.test" });
    const back = await client.call("people.list", { known: without.everyoneVersion });
    expect(back.everyone?.map((p) => p.email)).toContain("rita@people.test");
  });

  it("a role address is a person once you've written to it under any tag, as the facts judge it (Codex review)", async () => {
    const { client, from, to } = await setup();
    await to("Acme support", "support+ticket-12@acme.test");
    await from("Acme support", "support@acme.test");
    await client.call("people.ready", {});
    expect((await client.call("people.list", {})).open.map((p) => p.email)).toEqual(["support@acme.test"]);
  });
});

describe("one person", () => {
  it("their page marks which conversations they wrote in (a group email they were only on, not)", async () => {
    const { client, from } = await setup();
    const theirs = await from("Ana", "ana@people.test", { waiting: false });
    const group = await from("Björn", "bjorn@people.test", { waiting: false, over: { to: [{ name: "Me", email: "me@terno.test" }, { name: "Ana", email: "ana@people.test" }] } });
    const page = (await client.call("people.person", { email: "ana@people.test" }))!;
    expect(page.conversations.map((t) => t.id).sort()).toEqual([theirs, group].sort());
    expect(page.wrote).toEqual([theirs]);
  });

  it("a tagged address's own mail is theirs (Codex review)", async () => {
    const { client, from } = await setup();
    const theirs = await from("Ana", "ana+work@people.test", { waiting: false });
    expect((await client.call("people.person", { email: "ana+work@people.test" }))!.wrote).toEqual([theirs]);
  });

  it("a promise put off with Later stays on their page, saying when it's back", async () => {
    const { backend, client, account } = await setup({ followups: true });
    const m = msg({ accountId: account.id, from: { name: "Me", email: account.email }, to: [{ name: "Ana", email: "ana@people.test" }], isSent: true, inInbox: true, date: NOW - DAY, providerMsgId: "p-1", subject: "The deck" });
    const r = await backend.store.sync.ingest([m], { applyFilters: false, now: NOW, classifier: null, liveSent: { wanted: true } });
    const thread = await threadOf(backend.store, "p-1");
    await backend.store.followups.finish({ messageId: r.inserted[0]!, threadId: thread, fromScan: false, now: NOW, kept: [], model: "m", provider: "p", promptVersion: 1, clearGeneration: backend.store.followups.clearGeneration(), rows: [{ kind: "promise", item: 0, text: "send the deck", quote: "I'll send it", personName: "Ana", personEmail: "ana@people.test", dueAt: NOW - 1000, dated: false }] });
    backend.today.changed();
    const before = (await client.call("people.person", { email: "ana@people.test" }))!;
    expect(before.items.map((i) => i.kind === "today" && i.item.why.kind)).toEqual(["promise"]);
    const row = (await backend.store.followups.ofThread(thread))[0]!;
    await client.call("followups.act", { id: row.id, revision: row.revision, action: "later", dueAt: NOW + 3 * DAY });
    const after = (await client.call("people.person", { email: "ana@people.test" }))!;
    expect(after.items).toHaveLength(1);
    expect(after.items[0]!.kind === "today" && after.items[0]!.item.why.back).toBe(NOW + 3 * DAY);
  });

  it("the card's Last time: the newest conversation other than the one open, its summary of that one; the page reads none", async () => {
    const { backend, client, from } = await setup();
    const older = await from("Ana", "ana@people.test", { waiting: false });
    const newer = await from("Ana", "ana@people.test", { waiting: false });
    const read = vi.spyOn(backend.today, "summaryLine").mockResolvedValue({ summary: "Agreed on two milestones." });
    const card = (await client.call("people.person", { email: "ana@people.test", conversations: 2, except: newer }))!;
    expect(card).toMatchObject({ lastBetween: older, lastSummary: "Agreed on two milestones.", lastSummaryOf: older });
    expect(read).toHaveBeenCalledWith(older);
    read.mockClear();
    const page = (await client.call("people.person", { email: "ana@people.test" }))!;
    expect(page.lastSummaryOf).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it("the card's Last time says whether you wrote it: never you for someone else's email they were on", async () => {
    const { client, from, to } = await setup();
    const open = await from("Ana", "ana@people.test", { waiting: false });
    // Björn wrote last, Ana on it: not you
    await from("Björn", "bjorn@people.test", { waiting: false, over: { to: [{ name: "Ana", email: "ana@people.test" }], date: NOW - 3 * DAY } });
    // (nor is it the last time you and Ana wrote each other: the card shows none, rather than Björn's, r06)
    const before = (await client.call("people.person", { email: "ana@people.test", conversations: 2, except: open }))!;
    expect(before.lastFromMe).toBeUndefined();
    expect(before.lastBetween).toBeUndefined();
    // you wrote her since
    const sent = await to("Ana", "ana@people.test");
    const card = (await client.call("people.person", { email: "ana@people.test", conversations: 3, except: open }))!;
    expect(card.lastBetween).toBe(sent);
    expect(card.lastFromMe).toBe(true);
  });

  it("each address's Last email is its page's: its newest conversation, never one in Trash", async () => {
    const { client, raw, from } = await setup();
    const older = await from("Ana", "ana@people.test", { waiting: false });
    const binned = await from("Ana", "ana@people.test", { waiting: false });
    raw.run("UPDATE threads SET in_trash = 1, in_inbox = 0 WHERE id = ?", binned);
    const page = (await client.call("people.person", { email: "ana@people.test" }))!;
    expect(page.conversations[0]!.id).toBe(older);
    const { last } = await client.call("people.lastEmails", { emails: ["ana@people.test", "nobody@people.test"] });
    expect(last).toEqual({ "ana@people.test": page.conversations[0]!.lastDate, "nobody@people.test": 0 });
  });

  it("their open items and recent conversations, never Spam or Trash, with whether there are more", async () => {
    const { client, raw, from } = await setup();
    const open = await from("Ana", "ana@people.test");
    const binned = await from("Ana", "ana@people.test", { waiting: false });
    raw.run("UPDATE threads SET in_trash = 1, in_inbox = 0 WHERE id = ?", binned);
    for (let i = 0; i < 3; i++) await from("Ana", "ana@people.test", { waiting: false });
    const page = (await client.call("people.person", { email: "ana@people.test", conversations: 2 }))!;
    expect(page.items).toHaveLength(1);
    expect(page.conversations).toHaveLength(2);
    expect(page.conversations.map((t) => t.id)).not.toContain(binned);
    expect(page.more).toBe(true);
    const all = (await client.call("people.person", { email: "ana@people.test" }))!;
    expect(all.conversations.map((t) => t.id)).toContain(open);
    expect(all.conversations.map((t) => t.id)).not.toContain(binned);
    expect(all.more).toBe(false);
  });
});

describe("whom an item is between you and", () => {
  const thread = { id: 1, fromName: "Gary", fromEmail: "gary@utility.test" } as never;
  it("a promise's person, a waiting conversation's sender, a person's request; a bill from a stranger is nobody's", () => {
    expect(personOf({ id: "p:1", thread, why: { kind: "promise", personEmail: "tom@x.test", personName: "Tom" } } as never, () => false)).toEqual({ email: "tom@x.test", name: "Tom" });
    expect(personOf({ id: "w:1", thread, why: { kind: "waiting" } } as never, () => false)).toEqual({ email: "gary@utility.test", name: "Gary" });
    const dated = (kind: string) => ({ id: "d:1", thread, why: { kind: "dated", item: { kind } }, from: { name: "Margaret", email: "m@insure.test" } }) as never;
    expect(personOf(dated("ask"), () => false)).toEqual({ name: "Margaret", email: "m@insure.test" });
    expect(personOf(dated("pay"), () => false)).toBeNull();
    expect(personOf(dated("pay"), (e) => e === "m@insure.test")).toEqual({ name: "Margaret", email: "m@insure.test" });
    expect(personOf({ id: "r:1", thread, why: { kind: "reminder" } } as never, () => true)).toBeNull();
  });
});
