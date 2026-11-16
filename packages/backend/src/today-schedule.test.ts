/**
 * Plan 210 (iteration 4, the owner's "Change…"): an item's day and time, the user's, through the real backend (RPC,
 * settings, the dated reader, SQLite) with a scripted model and clock. What the store guarantees (all or none, exact
 * snapshots, a proposal under the move's guards) has its rows in the conformance suite; here, what the act decides, what
 * the feed and Earlier show, and a later mail's move kept for the user.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAi, promptText, type AiOptions, type Completion, type CompletionRequest, type ProviderConfig } from "@terno/ai";
import type { DatedRow, FollowupRow } from "@terno/core";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { demoRegistry } from "@terno/mail";
import { msg, threadOf } from "@terno/store/conformance";
import type { IncomingMessage } from "@terno/store";
import { afterEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { scheduleChanges } from "./today-schedule";

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
// Tuesday 10 November 2026, noon
const NOW = at(2026, 11, 10, 12);
const DAY = 86_400_000;
const me = { name: "Me", email: "me@terno.test" };
const jess = { name: "Jess Moreno", email: "jess@sponsor.test" };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

type Item = { kind: string; text: string; quote: string; due: string | null; time: string | null };
type Moved = { label: string; due: string; time: string | null; evidence: string; text?: string | null; textEvidence?: string | null };
const reply = (items: Item[] = [], moved: Moved[] = []): Completion => ({ text: JSON.stringify({ items, settled: [], moved: moved.map((m) => ({ text: null, textEvidence: null, ...m })), replaced: [] }), stop: "end" });
const script: Item = { kind: "respond", text: "Send Jess the sponsor script", quote: "send the script by Friday", due: "2026-11-13", time: null };

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "terno-change-"));
  const model = { answer: (_r: CompletionRequest): Completion => reply() };
  const clock = { now: NOW };
  const factory = (config: ProviderConfig, options: AiOptions) => createAi(config, { ...options, transport: { complete: async (req) => model.answer(req) } });
  const backend = new Backend({ dbPath: join(dir, "c.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false, demoAi: true, aiFactory: factory, now: () => clock.now });
  await backend.store.ready;
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "r", origin: "renderer" });
  const client = new RpcClient(c);
  const { account } = await backend.store.accounts.create({ kind: "gmail", email: me.email, displayName: "Me", color: "brown", now: 0 });
  await client.call("settings.update", { ai: { provider: "fake", model: "demo" } });
  await client.call("settings.update", { dated: { enabled: true } });
  await client.call("settings.update", { followups: { enabled: true } });
  clock.now += 120_000;
  cleanups.push(async () => {
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const raw = (backend.store as unknown as { db: { run(sql: string, ...a: unknown[]): unknown } }).db;
  let seq = 0;
  const receive = async (over: Partial<IncomingMessage> = {}) => {
    const id = `c-${seq++}`;
    const m = msg({ accountId: account.id, from: jess, to: [me], isSent: false, inInbox: true, isRead: false, date: clock.now - 60_000 + seq, subject: "Script", bodyText: "Can you send the script by Friday?", providerMsgId: id, providerThreadId: "jess", ...over });
    await backend.ingestSliced([m], true, undefined, undefined, undefined, undefined, undefined, true);
    return threadOf(backend.store, id);
  };
  const read = async () => {
    backend.dated.wake();
    await expect.poll(() => backend.store.dated.marks.count()).toBe(0);
  };
  const list = (history = false) => client.call("today.list", { held: [], ...(history ? { history: { through: null } } : {}) });
  /** the rows' ids under each section, a day's by its day */
  const placed = async () => (await list()).sections.flatMap((x) => x.items.map((i) => [i.id, x.day ? `day:${x.day}` : x.kind]));
  /** Jess's script, read, and the item */
  const scripted = async () => {
    model.answer = (req) => (promptText(req.messages[0]!.content).includes("at the latest") ? reply([], [{ label: "o1", due: "2026-11-20", time: null, evidence: "Friday the 20th at the latest" }]) : reply([script]));
    const thread = await receive();
    await read();
    return { thread, row: (await backend.store.dated.ofThread(thread))[0]! };
  };
  return { backend, client, model, clock, raw, receive, read, list, placed, scripted };
}

describe("what a change writes (scheduleChanges)", () => {
  const row = (over: Partial<DatedRow> = {}): DatedRow => ({ id: 1, threadId: 1, messageId: 1, item: 0, kind: "pay", text: "Pay the bill", quote: "due Friday", senderKey: "a@b.mx", dueDay: "2026-11-13", dueAt: at(2026, 11, 13, 9), timed: false, dated: true, actAt: at(2026, 11, 6, 9), deferredUntil: null, arrivedAt: NOW - DAY, state: "open", closedReason: null, closedAt: null, fromScan: false, revision: 3, model: null, provider: null, createdAt: NOW - DAY, ...over });
  const promise = (over: Partial<FollowupRow> = {}): FollowupRow => ({ id: 7, threadId: 1, messageId: 2, rfcMessageId: null, item: 0, kind: "promise", text: "send the script", quote: null, personName: "Jess", personEmail: jess.email, sentAt: NOW - DAY, dueAt: at(2026, 11, 11, 9), dated: true, deferredUntil: null, state: "open", inboxState: "none", closedReason: null, closedAt: null, notifiedAt: null, fromScan: false, revision: 1, model: null, provider: null, createdAt: NOW - DAY, ...over });
  const seen = { source: "dated" as const, id: 1, revision: 3 };

  it("a day and time: the dated item at its kind's lead from the new day, a promise at that moment, each open member with it", () => {
    const twin = row({ id: 2, kind: "event", revision: 8, sameAs: "dated:1" });
    const closed = row({ id: 3, state: "done", sameAs: "dated:1" });
    const asked = row({ id: 4, kind: "ask", sameAs: "dated:1" });
    const c = scheduleChanges(seen, row(), { dated: [row(), twin, closed, asked], promises: [promise({ sameAs: "dated:1" })] }, { day: "2026-11-24", time: "16:00" }, NOW);
    expect(c.at).toBe(NOW);
    // the bill shows a week before its day, the event within the seven days; each at its own revision; the day asked before
    // and the mail's clock were the mail's words about its day, so the user's day has neither (iteration 4, merge)
    expect(c.dated).toEqual([
      { id: 1, revision: 3, to: { dueDay: "2026-11-24", dueAt: at(2026, 11, 24, 16), timed: true, actAt: at(2026, 11, 17, 9), before: null, wall: null } },
      { id: 2, revision: 8, to: { dueDay: "2026-11-24", dueAt: at(2026, 11, 24, 16), timed: true, actAt: at(2026, 11, 21, 9), before: null, wall: null } },
    ]);
    expect(c.promises).toEqual([{ id: 7, revision: 1, to: { dueAt: at(2026, 11, 24, 16), timed: true, state: "open", before: null } }]);
    // a day alone: its 9:00, untimed (today, a day not over yet, is fine; a promise past its 9:00 keeps its state)
    const today = scheduleChanges({ source: "promise", id: 7, revision: 1 }, promise({ state: "due" }), { dated: [], promises: [promise({ state: "due" })] }, { day: "2026-11-10", time: null }, NOW);
    expect(today.promises).toEqual([{ id: 7, revision: 1, to: { dueAt: at(2026, 11, 10, 9), timed: false, state: "due", before: null } }]);
  });

  it("refuses what it can't do, saying why: changed since, a moment past, a year away, an ask's", () => {
    const members = { dated: [row()], promises: [] };
    expect(() => scheduleChanges({ ...seen, revision: 2 }, row(), members, { day: "2026-11-24", time: null }, NOW)).toThrow(expect.objectContaining({ code: "STALE" }));
    expect(() => scheduleChanges(seen, row({ state: "done" }), members, { day: "2026-11-24", time: null }, NOW)).toThrow(expect.objectContaining({ code: "STALE" }));
    expect(() => scheduleChanges(seen, row(), members, { day: "2026-11-10", time: "11:00" }, NOW)).toThrow(expect.objectContaining({ code: "BAD_REQUEST" }));
    expect(() => scheduleChanges(seen, row(), members, { day: "2026-11-09", time: null }, NOW)).toThrow(expect.objectContaining({ code: "BAD_REQUEST" }));
    expect(() => scheduleChanges(seen, row(), members, { day: "2027-12-01", time: null }, NOW)).toThrow(expect.objectContaining({ code: "BAD_REQUEST" }));
    expect(() => scheduleChanges(seen, row({ kind: "ask" }), members, { day: "2026-11-24", time: null }, NOW)).toThrow(expect.objectContaining({ code: "BAD_REQUEST" }));
    // no proposal to take (taken or gone since)
    expect(() => scheduleChanges(seen, row(), members, { accept: true }, NOW)).toThrow(expect.objectContaining({ code: "STALE" }));
  });

  it("taking a proposal: the named item gets the mail's day, moment and words exactly (its day asked before and clock too); the others its day", () => {
    const wall = { day: "2026-11-20", time: "16:00", zone: "America/Chicago", place: "Austin" };
    const proposal = { dueDay: "2026-11-20", dueAt: at(2026, 11, 20, 17), timed: true, actAt: at(2026, 11, 13, 9), text: "Pay the bill by 5 PM", before: "2026-11-21", wall, by: "Power Co", messageId: 9, at: NOW };
    const named = row({ proposal, changedAt: NOW - DAY });
    const c = scheduleChanges(seen, named, { dated: [named], promises: [promise({ sameAs: "dated:1" })] }, { accept: true }, NOW);
    expect(c.dated).toEqual([{ id: 1, revision: 3, to: { dueDay: "2026-11-20", dueAt: at(2026, 11, 20, 17), timed: true, actAt: at(2026, 11, 13, 9), text: "Pay the bill by 5 PM", before: "2026-11-21", wall } }]);
    expect(c.promises).toEqual([{ id: 7, revision: 1, to: { dueAt: at(2026, 11, 20, 17), timed: true, state: "open", before: null } }]);
    // a promise's own proposal: its day asked before with it
    const own = promise({ proposal: { dueDay: "2026-11-20", dueAt: at(2026, 11, 20, 9), timed: false, before: "2026-11-21", by: "Jess", messageId: 9, at: NOW }, changedAt: NOW - DAY });
    expect(scheduleChanges({ source: "promise", id: 7, revision: 1 }, own, { dated: [], promises: [own] }, { accept: true }, NOW).promises).toEqual([{ id: 7, revision: 1, to: { dueAt: at(2026, 11, 20, 9), timed: false, state: "open", before: "2026-11-21" } }]);
  });
});

describe("Change… through the backend", () => {
  it("moves the row to the user's day and time, says Changed in Earlier while it's open, clears Later; Undo puts all of it back", async () => {
    const { backend, client, placed, list, scripted } = await setup();
    const { row } = await scripted();
    expect(await placed()).toEqual([[`dated:${row.id}`, "today"]]);
    const later = await client.call("dated.act", { id: row.id, revision: row.revision, action: "later", until: at(2026, 11, 11, 9) });
    expect(later.row).toMatchObject({ deferredUntil: at(2026, 11, 11, 9) });
    const { undoId } = await client.call("today.schedule", { item: { source: "dated", id: row.id, revision: later.row!.revision }, to: { day: "2026-11-24", time: "16:00" } });
    expect(await backend.store.dated.get(row.id)).toMatchObject({ dueDay: "2026-11-24", dueAt: at(2026, 11, 24, 16), timed: true, deferredUntil: null, changedAt: NOW + 120_000, changedFrom: { dueDay: "2026-11-13", timed: false } });
    // a person's request, shown from its arrival: still Waiting on you, now "by Tue 24 4:00 PM"
    expect(await placed()).toEqual([[`dated:${row.id}`, "today"]]);
    expect((await list()).sections[0]!.items[0]!.why).toMatchObject({ dueAt: at(2026, 11, 24, 16), item: { dueDay: "2026-11-24", timed: true } });
    const history = (await list(true)).history!;
    expect(history.items).toEqual([expect.objectContaining({ id: `change:dated:${row.id}`, item: { source: "dated", id: row.id }, outcome: "changed", kind: "respond", text: "Send Jess the sponsor script", key: { at: NOW + 120_000, src: 2, id: row.id } })]);
    // its Undo: the day, the Later and no Changed line
    await client.call("today.scheduleUndo", { undoId });
    expect(await backend.store.dated.get(row.id)).toMatchObject({ dueDay: "2026-11-13", deferredUntil: at(2026, 11, 11, 9), changedAt: null, changedFrom: null });
    expect((await list(true)).history!.items).toEqual([]);
  });

  it("a stale revision changes nothing and says so; an Undo after something else changed it restores nothing and says so", async () => {
    const { backend, client, scripted } = await setup();
    const { row } = await scripted();
    await expect(client.call("today.schedule", { item: { source: "dated", id: row.id, revision: row.revision + 1 }, to: { day: "2026-11-24", time: null } })).rejects.toMatchObject({ code: "STALE" });
    expect(await backend.store.dated.get(row.id)).toMatchObject({ dueDay: "2026-11-13", changedAt: null, revision: row.revision });
    const { undoId } = await client.call("today.schedule", { item: { source: "dated", id: row.id, revision: row.revision }, to: { day: "2026-11-24", time: null } });
    await client.call("dated.act", { id: row.id, revision: row.revision + 1, action: "later", until: at(2026, 11, 20, 9) });
    await expect(client.call("today.scheduleUndo", { undoId })).rejects.toMatchObject({ code: "STALE" });
    expect(await backend.store.dated.get(row.id)).toMatchObject({ dueDay: "2026-11-24", changedAt: NOW + 120_000 });
  });

  it("Jess's later 'Friday the 20th' is a proposal on the day the user chose; Use takes it, and its Undo brings the proposal back", async () => {
    const { backend, client, receive, read, placed, scripted } = await setup();
    const { row } = await scripted();
    await client.call("today.schedule", { item: { source: "dated", id: row.id, revision: row.revision }, to: { day: "2026-11-16", time: null } });
    const mine = (await backend.store.dated.get(row.id))!;
    await receive({ subject: "Re: Script", bodyText: "No stress. Friday the 20th at the latest is fine." });
    await read();
    const proposed = (await backend.store.dated.get(row.id))!;
    expect(proposed).toMatchObject({ dueDay: "2026-11-16", revision: mine.revision + 1, proposal: { dueDay: "2026-11-20", timed: false, by: "Jess Moreno" } });
    // the row keeps the user's Monday
    expect(await placed()).toEqual([[`dated:${row.id}`, "today"]]);
    expect((await client.call("today.list", { held: [] })).sections[0]!.items[0]!.why.item).toMatchObject({ id: row.id, dueDay: "2026-11-16" });
    // Use
    const { undoId } = await client.call("today.schedule", { item: { source: "dated", id: row.id, revision: proposed.revision }, to: { accept: true } });
    expect(await backend.store.dated.get(row.id)).toMatchObject({ dueDay: "2026-11-20", proposal: null, changedAt: NOW + 120_000 });
    await client.call("today.scheduleUndo", { undoId });
    expect(await backend.store.dated.get(row.id)).toEqual({ ...proposed, revision: proposed.revision + 2 });
    // taken, it's still the user's: their next move is a proposal again
  });

  it("an item it's the same thing as changes with it, all or none; a promise of yours too, its broken day gone and a mail's move kept", async () => {
    const { backend, client, clock, raw, receive, read, scripted, model } = await setup();
    const { thread, row } = await scripted();
    // the same thing read twice (the matcher's link), and your promise to Jess on the conversation
    const other = await receive({ providerThreadId: "jess-2", subject: "Script again", bodyText: "Again: can you send the script by Friday?" });
    await read();
    const [twin] = await backend.store.dated.ofThread(other);
    await backend.store.today.link({ same: [{ item: { source: "dated", id: twin!.id }, sameAs: `dated:${row.id}` }], details: [] });
    const { undoId } = await client.call("today.schedule", { item: { source: "dated", id: twin!.id, revision: (await backend.store.dated.get(twin!.id))!.revision }, to: { day: "2026-11-18", time: "10:30" } });
    for (const id of [row.id, twin!.id]) expect(await backend.store.dated.get(id)).toMatchObject({ dueDay: "2026-11-18", dueAt: at(2026, 11, 18, 10, 30), timed: true, changedAt: NOW + 120_000 });
    // one Changed line for the two
    expect((await client.call("today.list", { held: [], history: { through: null } })).history!.items.map((i) => i.id)).toEqual([`change:dated:${row.id}`]);
    await client.call("today.scheduleUndo", { undoId });
    for (const id of [row.id, twin!.id]) expect(await backend.store.dated.get(id)).toMatchObject({ dueDay: "2026-11-13", changedAt: null });
    // a promise, broken (its Tuesday over when Jess moved it) and due
    raw.run("INSERT INTO followups (thread_id, message_id, item, kind, text, person_name, person_email, sent_at, due_at, dated, state, broken_due_at, created_at) VALUES (?, 999990, 0, 'promise', 'send the script', 'Jess', 'jess@sponsor.test', ?, ?, 1, 'due', ?, ?)", thread, clock.now - DAY, at(2026, 11, 10, 9), at(2026, 11, 9, 9), clock.now);
    const [p] = (await backend.store.followups.ofThread(thread)).filter((f) => f.kind === "promise");
    await client.call("today.schedule", { item: { source: "promise", id: p!.id, revision: p!.revision }, to: { day: "2026-11-12", time: "15:00" } });
    const changed = (await backend.store.followups.get(p!.id))!;
    expect(changed).toMatchObject({ dueAt: at(2026, 11, 12, 15), timed: true, dated: true, state: "open", brokenDueAt: null, changedAt: NOW + 120_000 });
    // Jess moves it: kept as hers to take, the user's Thursday stays
    model.answer = (req) => (promptText(req.messages[0]!.content).includes("p1 (promise") ? reply([], [{ label: "p1", due: "2026-11-16", time: null, evidence: "Monday works better" }]) : reply());
    await receive({ subject: "Re: Script", bodyText: "Monday works better for me." });
    await read();
    expect(await backend.store.followups.get(p!.id)).toMatchObject({ dueAt: at(2026, 11, 12, 15), proposal: { dueDay: "2026-11-16", by: "Jess Moreno" }, revision: changed.revision + 1 });
  });
});
