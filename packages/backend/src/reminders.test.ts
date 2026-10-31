import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient, RpcError, type RemindersSnapshot } from "@terno/core/rpc";
import { REMINDERS_MAX, type MailNotice } from "@terno/core";
import { NOTIFIED_KEY, Reminders } from "./reminders";
import { createAccount, ingestMessages, sqlDb, type IncomingMessage } from "@terno/db";
import { demoRegistry } from "@terno/mail";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const NOW = Date.UTC(2026, 9, 31, 12);
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
    providerMsgId: `r${n}`,
    providerThreadId: null,
    rfcMessageId: `r${n}@x`,
    inReplyTo: null,
    references: [],
    from: { name: "Ana", email: "ana@friends.com" },
    to: [{ name: "Me", email: "me@example.com" }],
    cc: [],
    bcc: [],
    subject: `Lunch ${n}`,
    date: NOW - HOUR,
    snippet: "",
    bodyText: "Lunch on Friday?",
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

/** A backend on a clock the test moves (its timers faked), with two conversations and the reminders events it sent. */
async function setup() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const clock = { now: NOW };
  const dir = mkdtempSync(join(tmpdir(), "terno-rem-"));
  const backend = new Backend({ dbPath: join(dir, "terno.db"), version: "test", cipher: plaintextCipher, providers: demoRegistry, now: () => clock.now, autoSync: false });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "renderer", origin: "renderer" });
  const client = new RpcClient(c);
  cleanups.push(async () => {
    await backend.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  const db = sqlDb(backend.store);
  const account = createAccount(db, { kind: "imap", email: "me@example.com", displayName: "Me", color: "indigo" }).id;
  const [a, b] = [...ingestMessages(db, [incoming(account, { rfcMessageId: "a@x" }), incoming(account, { rfcMessageId: "b@x" })]).touchedThreads];
  const events: RemindersSnapshot[] = [];
  client.on("reminders", (e) => events.push(e));
  const advance = async (ms: number) => {
    clock.now += ms;
    vi.advanceTimersByTime(ms);
    await settle();
  };
  return { backend, client, db, account, a: a!, b: b!, events, clock, advance };
}

describe("reminders (plan 87)", () => {
  it("comes due at its time: one timer, an event then, nothing before", async () => {
    const { backend, client, a, events, advance } = await setup();
    const { rows, replaced } = await client.call("reminders.set", { threadIds: [a], dueAt: NOW + HOUR, kind: "always" });
    expect(rows).toEqual([{ threadId: a, dueAt: NOW + HOUR, kind: "always", setAt: NOW }]);
    expect(replaced).toEqual([]);
    await settle();
    expect(events.at(-1)).toEqual({ reminders: [{ threadId: a, dueAt: NOW + HOUR, kind: "always", setAt: NOW, due: false }] });
    expect(backend.reminders.nextAt).toBe(NOW + HOUR);
    const before = events.length;
    await advance(HOUR - 1);
    expect(events).toHaveLength(before);
    await advance(1);
    expect(events.at(-1)!.reminders[0]).toMatchObject({ threadId: a, due: true });
    // due: nothing left to wait for
    expect(backend.reminders.nextAt).toBeNull();
    expect((await client.call("reminders.threads", { dueOnly: true })).items.map((t) => t.id)).toEqual([a]);
  });

  it("no reminders, no timer; a cleared one stops its timer", async () => {
    const { backend, client, a } = await setup();
    backend.refreshReminders();
    await settle();
    expect(backend.reminders.nextAt).toBeNull();
    await client.call("reminders.set", { threadIds: [a], dueAt: NOW + HOUR, kind: "always" });
    await settle();
    expect(backend.reminders.nextAt).toBe(NOW + HOUR);
    expect((await client.call("reminders.clear", { threadIds: [a] })).cleared).toHaveLength(1);
    await settle();
    expect(backend.reminders.nextAt).toBeNull();
    expect((await client.call("reminders.list", {})).reminders).toEqual([]);
  });

  it("opening clears only a due reminder; Undo of a set puts back what it replaced", async () => {
    const { client, a, b } = await setup();
    await client.call("reminders.set", { threadIds: [a], dueAt: NOW - 1, kind: "always" });
    const set = await client.call("reminders.set", { threadIds: [a, b], dueAt: NOW + HOUR, kind: "noReply" });
    expect(set.replaced).toEqual([{ threadId: a, dueAt: NOW - 1, kind: "always", setAt: NOW }]);
    expect((await client.call("reminders.clear", { threadIds: [a, b], dueOnly: true })).cleared).toEqual([]);
    await client.call("reminders.restore", { drop: set.rows, put: set.replaced });
    expect((await client.call("reminders.list", {})).reminders).toEqual([{ threadId: a, dueAt: NOW - 1, kind: "always", setAt: NOW, due: true }]);
    expect((await client.call("reminders.clear", { threadIds: [a], dueOnly: true })).cleared).toHaveLength(1);
  });

  it("an answer ends a noReply reminder (and the windows hear of it); your own mail doesn't", async () => {
    const { backend, client, db, account, a, b, events } = await setup();
    await client.call("reminders.set", { threadIds: [a, b], dueAt: NOW + 24 * HOUR, kind: "noReply" });
    const later = (over: Partial<IncomingMessage>) => incoming(account, { date: NOW + 60_000, ...over });
    const mine = ingestMessages(db, [later({ references: ["a@x"], from: { name: "Me", email: "me@example.com" }, isSent: true })]);
    backend.notifyChanged(mine.touchedThreads);
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(events.at(-1)!.reminders.map((r) => r.threadId).sort()).toEqual([a, b].sort());
    const theirs = ingestMessages(db, [later({ references: ["b@x"] })]);
    backend.notifyChanged(theirs.touchedThreads);
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(events.at(-1)!.reminders.map((r) => r.threadId)).toEqual([a]);
    expect((await client.call("reminders.list", {})).reminders.map((r) => r.threadId)).toEqual([a]);
  });

  it("archiving ends a due reminder, never a pending one; its Undo brings both back", async () => {
    const { client, a, b } = await setup();
    await client.call("reminders.set", { threadIds: [a], dueAt: NOW - 1, kind: "always" });
    await client.call("reminders.set", { threadIds: [b], dueAt: NOW + HOUR, kind: "always" });
    const r = await client.call("threads.act", { threadIds: [a, b], action: "archive" });
    expect((await client.call("reminders.list", {})).reminders.map((x) => x.threadId)).toEqual([b]);
    await client.call("threads.undo", { undoId: r.undoId! });
    expect((await client.call("reminders.list", {})).reminders.map((x) => [x.threadId, x.due])).toEqual([[a, true], [b, false]].sort((x, y) => (x[0] as number) - (y[0] as number)));
    // starring a due one doesn't end it
    await client.call("threads.act", { threadIds: [a], action: "star" });
    expect((await client.call("reminders.list", {})).reminders.map((x) => x.threadId)).toContain(a);
  });

  it("a due reminder of an archived conversation stays an Inbox top; one in Trash or Spam doesn't; an account narrows them", async () => {
    const { client, account, a, b } = await setup();
    await client.call("reminders.set", { threadIds: [a, b], dueAt: NOW + HOUR, kind: "always" });
    await client.call("threads.act", { threadIds: [a], action: "archive" });
    await client.call("threads.act", { threadIds: [b], action: "trash" });
    expect((await client.call("reminders.threads", { dueOnly: false })).items.map((t) => t.id)).toEqual([a]);
    expect((await client.call("reminders.threads", { dueOnly: true })).items).toEqual([]);
    await client.call("reminders.set", { threadIds: [a], dueAt: NOW, kind: "always" });
    expect((await client.call("reminders.threads", { dueOnly: true, accountId: account })).items.map((t) => t.id)).toEqual([a]);
    expect((await client.call("reminders.threads", { dueOnly: true, accountId: account + 1 })).items).toEqual([]);
  });

  it("refuses past the cap, all of the batch; replacing one still works", async () => {
    const { client, db, account, a, b } = await setup();
    const many = [...ingestMessages(db, Array.from({ length: REMINDERS_MAX - 1 }, () => incoming(account))).touchedThreads];
    await client.call("reminders.set", { threadIds: [a, ...many], dueAt: NOW + HOUR, kind: "always" });
    const err = await client.call("reminders.set", { threadIds: [a, b], dueAt: NOW + 2 * HOUR, kind: "always" }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).code).toBe("BAD_REQUEST");
    expect((err as RpcError).message).toMatch(/up to 1,000 reminders/);
    // nothing of the refused batch was set
    const list = (await client.call("reminders.list", {})).reminders;
    expect(list).toHaveLength(REMINDERS_MAX);
    expect(list.find((r) => r.threadId === a)!.dueAt).toBe(NOW + HOUR);
    await client.call("reminders.set", { threadIds: [a], dueAt: NOW + 3 * HOUR, kind: "noReply" });
  });

  it("a wake looks at once, even without sync; stop leaves no timer", async () => {
    const { backend, client, a, events, clock } = await setup();
    await client.call("reminders.set", { threadIds: [a], dueAt: NOW + HOUR, kind: "always" });
    await settle();
    // the machine slept through it: the clock moved, the timer didn't
    clock.now += 2 * HOUR;
    backend.networkChanged(true, "wake");
    await settle();
    expect(events.at(-1)!.reminders[0]).toMatchObject({ due: true });
    await client.call("reminders.set", { threadIds: [a], dueAt: clock.now + HOUR, kind: "always" });
    await settle();
    expect(backend.reminders.nextAt).toBe(clock.now + HOUR);
    await backend.stop();
    expect(backend.reminders.nextAt).toBeNull();
  });

  it("Undo of a set never overwrites a reminder set since (another window); Undo of a clear neither", async () => {
    const { client, a } = await setup();
    await client.call("reminders.set", { threadIds: [a], dueAt: NOW + HOUR, kind: "always" });
    const second = await client.call("reminders.set", { threadIds: [a], dueAt: NOW + 2 * HOUR, kind: "always" });
    // meanwhile, elsewhere: a third
    await client.call("reminders.set", { threadIds: [a], dueAt: NOW + 3 * HOUR, kind: "noReply" });
    await client.call("reminders.restore", { drop: second.rows, put: second.replaced });
    expect((await client.call("reminders.list", {})).reminders.map((r) => [r.dueAt, r.kind])).toEqual([[NOW + 3 * HOUR, "noReply"]]);
    const { cleared } = await client.call("reminders.clear", { threadIds: [a] });
    await client.call("reminders.set", { threadIds: [a], dueAt: NOW + 4 * HOUR, kind: "always" });
    await client.call("reminders.restore", { drop: [], put: cleared });
    expect((await client.call("reminders.list", {})).reminders.map((r) => r.dueAt)).toEqual([NOW + 4 * HOUR]);
  });

  it("an open ends exactly the reminder it saw: one set meanwhile stays", async () => {
    const { client, a } = await setup();
    const seen = (await client.call("reminders.set", { threadIds: [a], dueAt: NOW - 1, kind: "always" })).rows;
    await client.call("reminders.set", { threadIds: [a], dueAt: NOW - 2, kind: "always" });
    expect((await client.call("reminders.clear", { threadIds: [a], dueOnly: true, exact: seen })).cleared).toEqual([]);
    expect((await client.call("reminders.list", {})).reminders.map((r) => r.dueAt)).toEqual([NOW - 2]);
  });

  it("an archive's Undo refused at the cap takes nothing back and stays for a retry", async () => {
    const { client, db, account, a } = await setup();
    await client.call("reminders.set", { threadIds: [a], dueAt: NOW - 1, kind: "always" });
    const r = await client.call("threads.act", { threadIds: [a], action: "archive" });
    const many = [...ingestMessages(db, Array.from({ length: REMINDERS_MAX }, () => incoming(account))).touchedThreads];
    await client.call("reminders.set", { threadIds: many, dueAt: NOW + HOUR, kind: "always" });
    const err = await client.call("threads.undo", { undoId: r.undoId! }).then(() => null, (e: unknown) => e);
    expect((err as RpcError).code).toBe("BAD_REQUEST");
    expect(db.get<{ in_inbox: number }>("SELECT in_inbox FROM threads WHERE id = ?", a)!.in_inbox).toBe(0);
    await client.call("reminders.clear", { threadIds: [many[0]!] });
    await client.call("threads.undo", { undoId: r.undoId! });
    expect(db.get<{ in_inbox: number }>("SELECT in_inbox FROM threads WHERE id = ?", a)!.in_inbox).toBe(1);
    expect((await client.call("reminders.list", {})).reminders.find((x) => x.threadId === a)).toMatchObject({ due: true });
  });

  it("a change with no reminded thread in it (an account removed, a merge's survivor) still looks again", async () => {
    const { backend, client, db, a, events } = await setup();
    await client.call("reminders.set", { threadIds: [a], dueAt: NOW - 1, kind: "always" });
    await settle();
    db.run("DELETE FROM threads WHERE id = ?", a);
    backend.notifyChanged([]);
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(events.at(-1)).toEqual({ reminders: [] });
  });

  it("filing a due one into a category hidden from the Inbox ends it; the filing's Undo brings it back", async () => {
    const { client, a, b } = await setup();
    const hidden = await client.call("categories.create", { name: "Quiet", color: "slate" });
    const shown = await client.call("categories.create", { name: "Work", color: "indigo", showInInbox: true });
    await client.call("reminders.set", { threadIds: [a, b], dueAt: NOW - 1, kind: "always" });
    await client.call("categories.addThreads", { categoryId: shown.id, threadIds: [b], source: "picker" });
    const moved = await client.call("categories.moveThreads", { to: hidden.id, threadIds: [a], source: "picker" });
    expect((await client.call("reminders.list", {})).reminders.map((r) => r.threadId)).toEqual([b]);
    await client.call("categorize.undo", { batchId: moved.batchId });
    expect((await client.call("reminders.list", {})).reminders.map((r) => r.threadId).sort()).toEqual([a, b].sort());
  });

  it("coming due says so once (a notification), not again after a restart; off or private, as the settings say", async () => {
    const { backend, client, a, b, advance, clock } = await setup();
    const notices: MailNotice[] = [];
    client.on("notify", (n) => notices.push(n));
    await client.call("reminders.set", { threadIds: [a], dueAt: NOW + HOUR, kind: "always" });
    await advance(HOUR);
    expect(notices).toEqual([expect.objectContaining({ kind: "reminder", count: 1, threadId: a, senders: ["Ana"] })]);
    // another look (a wake) says nothing new
    backend.networkChanged(true, "wake");
    await settle();
    expect(notices).toHaveLength(1);
    // private: who and what stay in the backend
    await client.call("settings.update", { notificationPreview: false });
    await client.call("reminders.set", { threadIds: [b], dueAt: clock.now + HOUR, kind: "always" });
    await advance(HOUR);
    expect(notices[1]).toMatchObject({ kind: "reminder", count: 1, senders: [], subject: "" });
    // off: nothing
    await client.call("settings.update", { notifications: false });
    await client.call("reminders.set", { threadIds: [a], dueAt: clock.now + HOUR, kind: "always" });
    await advance(HOUR);
    expect(notices).toHaveLength(2);
  });

  it("a restart doesn't say again what it said; one that came due while closed is said once, if within a day", async () => {
    const { backend, client, a, b, advance, clock } = await setup();
    await client.call("reminders.set", { threadIds: [a], dueAt: NOW + HOUR, kind: "always" });
    await advance(HOUR);
    expect(await backend.store.settings.get(NOTIFIED_KEY, 0)).toBe(NOW + HOUR);
    await client.call("reminders.set", { threadIds: [b], dueAt: clock.now + HOUR, kind: "always" });
    // a fresh backend (a restart) on the same store, after b's time: says b, not a
    const said: MailNotice[] = [];
    const fresh = new Reminders({ store: backend.store, now: () => clock.now + 2 * HOUR, emit: () => {}, notify: (n) => said.push(n), runBudgeted: async (items, work) => void (await work([...items])), log: () => {} });
    await fresh.refresh();
    fresh.stop();
    expect(said).toEqual([expect.objectContaining({ threadId: b })]);
    // days later, nothing left to say
    const later = new Reminders({ store: backend.store, now: () => clock.now + 5 * 24 * HOUR, emit: () => {}, notify: (n) => said.push(n), runBudgeted: async (items, work) => void (await work([...items])), log: () => {} });
    await later.refresh();
    later.stop();
    expect(said).toHaveLength(1);
  });
});
