import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient, type PinsSnapshot, type RpcError } from "@terno/core/rpc";
import { PINS_MAX, REMINDERS_MAX } from "@terno/core";
import { createAccount, ingestMessages, sqlDb, type IncomingMessage } from "@terno/db";
import { demoRegistry } from "@terno/mail";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const NOW = Date.UTC(2026, 10, 10, 12);
const HOUR = 3_600_000;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const c of cleanups.splice(0).reverse()) await c();
});

const turn = () => new Promise((r) => setImmediate(r));
async function settle() {
  for (let i = 0; i < 5; i++) await turn();
}

let n = 0;
function incoming(accountId: number, over: Partial<IncomingMessage> = {}): IncomingMessage {
  n++;
  return {
    accountId,
    providerMsgId: `p${n}`,
    providerThreadId: null,
    rfcMessageId: `p${n}@x`,
    inReplyTo: null,
    references: [],
    from: { name: "Ana", email: "ana@friends.com" },
    to: [{ name: "Me", email: "me@example.com" }],
    cc: [],
    bcc: [],
    subject: `Trip ${n}`,
    date: NOW - HOUR,
    snippet: "",
    bodyText: "The tickets",
    bodyHtml: null,
    bodyState: "full",
    listId: null,
    isRead: false,
    isStarred: false,
    inInbox: true,
    isSent: false,
    isDraft: false,
    isTrash: false,
    isSpam: false,
    hasAttachments: false,
    size: 100,
    ...over,
  };
}

/** A backend on a clock that stands still unless the test moves it, three conversations, and the pins events it sent. */
async function setup() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const clock = { now: NOW };
  const dir = mkdtempSync(join(tmpdir(), "terno-pins-"));
  const backend = new Backend({ dbPath: join(dir, "terno.db"), version: "test", cipher: plaintextCipher, providers: demoRegistry, now: () => clock.now, autoSync: false });
  await backend.store.ready;
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "renderer", origin: "renderer" });
  const client = new RpcClient(c);
  cleanups.push(async () => {
    await backend.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  const db = sqlDb(backend.store);
  const account = createAccount(db, { kind: "imap", email: "me@example.com", displayName: "Me", color: "indigo" }).id;
  const [a, b, c3] = [...ingestMessages(db, [incoming(account, { rfcMessageId: "a@x" }), incoming(account, { rfcMessageId: "b@x" }), incoming(account, { rfcMessageId: "c@x" })]).touchedThreads];
  const events: PinsSnapshot[] = [];
  client.on("pins", (e) => events.push(e));
  return { backend, client, db, account, a: a!, b: b!, c: c3!, events, clock };
}

const pinnedIds = async (client: RpcClient) => (await client.call("pins.list", {})).pins.map((p) => p.threadId).sort((x, y) => x - y);
const inInbox = (db: ReturnType<typeof sqlDb>, id: number) => db.get<{ in_inbox: number }>("SELECT in_inbox FROM threads WHERE id = ?", id)!.in_inbox;

describe("pins (plan 177)", () => {
  it("pins, unpins and puts back exactly; every change reaches the windows", async () => {
    const { client, a, b, events } = await setup();
    const { added } = await client.call("pins.add", { threadIds: [a, b, a] });
    expect(added.map((p) => p.threadId).sort()).toEqual([a, b].sort());
    expect(events.at(-1)!.pins.map((p) => p.threadId).sort()).toEqual([a, b].sort());
    // pinned again: it keeps its pin
    expect((await client.call("pins.add", { threadIds: [a] })).added).toEqual([]);
    const { removed } = await client.call("pins.remove", { threadIds: [a] });
    expect(removed.map((p) => p.threadId)).toEqual([a]);
    expect(events.at(-1)!.pins.map((p) => p.threadId)).toEqual([b]);
    // Undo of the unpin, then of the first pin
    await client.call("pins.restore", { drop: [], put: removed });
    expect(await pinnedIds(client)).toEqual([a, b].sort((x, y) => x - y));
    await client.call("pins.restore", { drop: added, put: [] });
    expect(await pinnedIds(client)).toEqual([]);
  });

  it("a pin made again in the same millisecond is a new pin: the old one's Undo leaves it", async () => {
    // the clock stands still: every call sees NOW
    const { client, a } = await setup();
    const first = (await client.call("pins.add", { threadIds: [a] })).added;
    await client.call("pins.remove", { threadIds: [a] });
    const again = (await client.call("pins.add", { threadIds: [a] })).added;
    expect(again[0]!.pinnedAt).toBeGreaterThan(first[0]!.pinnedAt);
    await client.call("pins.restore", { drop: first, put: [] });
    expect(await pinnedIds(client)).toEqual([a]);
  });

  it("refuses past the cap, all of the batch", async () => {
    const { client, db, account, a, b } = await setup();
    const many = [...ingestMessages(db, Array.from({ length: PINS_MAX - 1 }, () => incoming(account))).touchedThreads];
    await client.call("pins.add", { threadIds: many });
    const err = await client.call("pins.add", { threadIds: [a, b] }).then(() => null, (e: unknown) => e as RpcError);
    expect(err?.code).toBe("BAD_REQUEST");
    expect((await client.call("pins.list", {})).pins).toHaveLength(PINS_MAX - 1);
    expect((await client.call("pins.add", { threadIds: [a] })).added).toHaveLength(1);
  });

  it("the top's rows: newest pin first, wherever they live but Trash and Spam, narrowed to an account", async () => {
    const { client, account, a, b, c, clock } = await setup();
    await client.call("pins.add", { threadIds: [a] });
    clock.now += 1000;
    await client.call("pins.add", { threadIds: [b] });
    clock.now += 1000;
    await client.call("pins.add", { threadIds: [c] });
    expect((await client.call("pins.threads", {})).items.map((t) => t.id)).toEqual([c, b, a]);
    // pinned from Archive, it still shows; in Trash it doesn't (and comes back with it)
    await client.call("pins.remove", { threadIds: [b] });
    await client.call("threads.act", { threadIds: [b], action: "archive" });
    await client.call("pins.add", { threadIds: [b] });
    await client.call("threads.act", { threadIds: [c], action: "spam" });
    expect((await client.call("pins.threads", { accountId: account })).items.map((t) => t.id)).toEqual([b, a]);
    expect((await client.call("pins.threads", { accountId: account + 1 })).items).toEqual([]);
  });

  it("archiving, trashing or marking as spam ends a pin; starring doesn't; the Undo brings it back", async () => {
    const { client, db, a, b, c } = await setup();
    await client.call("pins.add", { threadIds: [a, b, c] });
    await client.call("threads.act", { threadIds: [a], action: "star" });
    expect(await pinnedIds(client)).toContain(a);
    const r = await client.call("threads.act", { threadIds: [a, b], action: "archive" });
    await client.call("threads.act", { threadIds: [c], action: "trash" });
    expect(await pinnedIds(client)).toEqual([]);
    await client.call("threads.undo", { undoId: r.undoId! });
    expect(await pinnedIds(client)).toEqual([a, b].sort((x, y) => x - y));
    expect(inInbox(db, a)).toBe(1);
  });

  it("an archive's Undo refused at the pins' cap takes nothing back and stays for a retry", async () => {
    const { client, db, account, a } = await setup();
    await client.call("pins.add", { threadIds: [a] });
    const r = await client.call("threads.act", { threadIds: [a], action: "archive" });
    const many = [...ingestMessages(db, Array.from({ length: PINS_MAX }, () => incoming(account))).touchedThreads];
    await client.call("pins.add", { threadIds: many });
    const err = await client.call("threads.undo", { undoId: r.undoId! }).then(() => null, (e: unknown) => e as RpcError);
    expect(err?.code).toBe("BAD_REQUEST");
    expect(inInbox(db, a)).toBe(0);
    await client.call("pins.remove", { threadIds: [many[0]!] });
    await client.call("threads.undo", { undoId: r.undoId! });
    expect(inInbox(db, a)).toBe(1);
    expect(await pinnedIds(client)).toContain(a);
  });

  it("refused by the reminders' cap, an Undo puts no pin back either", async () => {
    const { client, db, account, a } = await setup();
    await client.call("pins.add", { threadIds: [a] });
    await client.call("reminders.set", { threadIds: [a], dueAt: NOW - 1, kind: "always" });
    const r = await client.call("threads.act", { threadIds: [a], action: "archive" });
    expect(await pinnedIds(client)).toEqual([]);
    const many = [...ingestMessages(db, Array.from({ length: REMINDERS_MAX }, () => incoming(account))).touchedThreads];
    await client.call("reminders.set", { threadIds: many, dueAt: NOW + HOUR, kind: "always" });
    const err = await client.call("threads.undo", { undoId: r.undoId! }).then(() => null, (e: unknown) => e as RpcError);
    expect(err?.code).toBe("BAD_REQUEST");
    expect(await pinnedIds(client)).toEqual([]);
    expect(inInbox(db, a)).toBe(0);
    await client.call("reminders.clear", { threadIds: [many[0]!] });
    await client.call("threads.undo", { undoId: r.undoId! });
    expect(await pinnedIds(client)).toEqual([a]);
    expect(inInbox(db, a)).toBe(1);
  });

  it("filing into a category hidden from the Inbox ends a pin, its Undo brings it back; a category the Inbox shows keeps it", async () => {
    const { client, a, b } = await setup();
    const hidden = await client.call("categories.create", { name: "Quiet", color: "slate" });
    const shown = await client.call("categories.create", { name: "Work", color: "indigo", showInInbox: true });
    await client.call("pins.add", { threadIds: [a, b] });
    await client.call("categories.addThreads", { categoryId: shown.id, threadIds: [b], source: "picker" });
    const moved = await client.call("categories.moveThreads", { to: hidden.id, threadIds: [a], source: "picker" });
    expect(await pinnedIds(client)).toEqual([b]);
    await client.call("categorize.undo", { batchId: moved.batchId });
    expect(await pinnedIds(client)).toEqual([a, b].sort((x, y) => x - y));
  });

  it("filing into a hidden category ends only the pins of conversations the Inbox showed: an archived or already hidden one keeps its pin (Codex review)", async () => {
    const { client, a, b, c } = await setup();
    const hidden = await client.call("categories.create", { name: "Quiet", color: "slate" });
    const hidden2 = await client.call("categories.create", { name: "Later", color: "slate" });
    await client.call("pins.remove", { threadIds: [a, b, c] });
    // a archived, then pinned from Archive; b already in a hidden category; c in the Inbox
    await client.call("threads.act", { threadIds: [a], action: "archive" });
    await client.call("categories.addThreads", { categoryId: hidden2.id, threadIds: [b], source: "picker" });
    await client.call("pins.add", { threadIds: [a, b, c] });
    await client.call("categories.addThreads", { categoryId: hidden.id, threadIds: [a, b, c], source: "picker" });
    expect(await pinnedIds(client)).toEqual([a, b].sort((x, y) => x - y));
    // a move into one does the same
    await client.call("pins.add", { threadIds: [c] });
    await client.call("categories.moveThreads", { to: hidden2.id, threadIds: [a, c], source: "picker" });
    expect(await pinnedIds(client)).toEqual([a, b, c].sort((x, y) => x - y));
  });

  it("a conversation that goes takes its pin, and the windows hear of it without a thread named", async () => {
    const { backend, client, db, a, events } = await setup();
    await client.call("pins.add", { threadIds: [a] });
    await settle();
    db.run("DELETE FROM threads WHERE id = ?", a);
    backend.notifyChanged([]);
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(events.at(-1)).toEqual({ pins: [] });
  });

  it("nothing pinned, no look after mail changes", async () => {
    const { backend, events } = await setup();
    await settle();
    const before = events.length;
    backend.notifyChanged([]);
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(events.length).toBe(before);
  });
});
