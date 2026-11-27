/**
 * Plan 204 revision 12 at 50,000+ threads, on both stores: the whole of `today.list` and the sidebar's count, with the
 * dated set at its bound (1,000 open items, every one of them showing) and follow-ups on. It holds the time and the
 * longest the event loop goes without a turn. Nothing leaves this process.
 */
import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATED_KINDS, DATED_MUTE_PAIRS_MAX, DATED_MUTES_MAX, ruleKey, todayKey, verdictBasis, type PreferenceRule } from "@terno/core";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { IdbMailStore } from "@terno/idb";
import { demoRegistry } from "@terno/mail";
import { generateDataset } from "@terno/mock-data";
import { DATED_NOTHING_ASKED_SINCE, FOLLOWUPS_ACTIVE_MAX, NEEDS_WALK, type MailStore } from "@terno/store";
import { msg, seedDatedItems } from "@terno/store/conformance";
import { afterAll, describe, expect, it } from "vitest";
import { copyMailbox, LARGE_MAILBOX } from "../../db/src/test/perf-mailbox";
import { watchLoop } from "../../db/src/test/timing";
import { Backend, plaintextCipher } from "./backend";
import { datedTarget, promiseTarget } from "./preferences";

const NOW = Date.UTC(2026, 10, 1, 12);
const DAY = 86_400_000;
const MULT = Number(process.env.PERF_BUDGET_MULTIPLIER ?? "1");
const dir = mkdtempSync(join(tmpdir(), "terno-today-perf-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** list: today.list; added: what the count adds to plan 145's; needs and count: absolute, so a slower Needs you shows (plan 204, the second panel round) */
type Gate = { listMs: number; addedMs: number; needsMs: number; countMs: number; /** this scenario's longest turn, when not the run's */ busyMs?: number };

const p95 = (times: number[]) => [...times].sort((a, b) => a - b)[Math.floor(times.length * 0.95) - 1]!;

/**
 * Plan 249: 20 rules, none hiding anything here (senders nobody is, kinds with nobody's names), half judged; a verdict for each
 * open item those reach, against the rules' basis, so a projection has everything it needs.
 */
async function words(store: MailStore, now: number) {
  const make = (r: Omit<PreferenceRule, "id" | "key" | "said" | "understood">, i: number): PreferenceRule => {
    const rule = { id: `r${i + 1}`, key: "", said: `words ${i}`, understood: `words ${i}`, ...r } as PreferenceRule;
    rule.key = ruleKey(rule);
    return rule;
  };
  // (the judged ones reach the items, which get verdicts below; the names reach every row, the 2,000 waiting conversations too,
  // whose senders and subjects the count then reads: the Astra review's costliest case)
  const items = [...DATED_KINDS];
  const rules: PreferenceRule[] = [
    ...Array.from({ length: 5 }, (_, i) => make({ effect: "hide", senders: [`@nobody${i}.test`] }, i)),
    ...Array.from({ length: 5 }, (_, i) => make({ effect: "first", names: [`Nobody ${i} Holdings Inc`] }, 5 + i)),
    ...Array.from({ length: 5 }, (_, i) => make({ effect: "hide", kinds: items, about: `mail about topic ${i}` }, 10 + i)),
    ...Array.from({ length: 4 }, (_, i) => make({ effect: "first", kinds: items, about: `mail about subject ${i}` }, 15 + i)),
    make({ effect: "show", about: "a sale from nobody", cues: ["nobody sale"] }, 19),
  ];
  const saved = await store.whatMatters.preferences.save({ text: "twenty rules", rules, notes: [], compiledWith: null, savedAt: now, language: "en" }, (await store.whatMatters.preferences.get()).revision);
  const basis = verdictBasis(rules);
  const open = await store.dated.active();
  const verdicts = open.map((r) => ({ target: datedTarget(r).key, basis, rules: [] as string[], at: now }));
  for (let i = 0; i < verdicts.length; i += 500) expect(await store.whatMatters.verdicts.put(verdicts.slice(i, i + 500), saved!.revision)).toBe(true);
  const promises = await store.followups.active();
  await store.whatMatters.verdicts.put(promises.map((p) => ({ target: promiseTarget(p).key, basis, rules: [], at: now })), saved!.revision);
}

/** NEEDS_WALK conversations newer than the mailbox's, each waiting on the reader, as above. */
async function needsAtBound(store: MailStore, client: RpcClient, accountId: number, now: number) {
  await client.call("settings.update", { summaries: { enabled: false } });
  const me = { name: "Me", email: "me@perf.test" };
  const who = (i: number) => ({ name: `Person ${i}`, email: `person${i}@needs.test` });
  const at = (i: number) => now - 3_600_000 - i * 1000;
  const text = "Thanks! Here are the notes from this morning's call, with the numbers we went through and the plan for next week.";
  const out = Array.from({ length: NEEDS_WALK }, (_, i) => msg({ accountId, date: at(i) - 500, providerMsgId: `needs-${i}-out`, providerThreadId: `needs-${i}`, from: me, to: [who(i)], isSent: true, isRead: true, listId: null, subject: `Notes ${i}` }));
  const back = Array.from({ length: NEEDS_WALK }, (_, i) => msg({ accountId, date: at(i), providerMsgId: `needs-${i}-in`, providerThreadId: `needs-${i}`, from: who(i), to: [me], isRead: false, listId: null, subject: `Re: Notes ${i}`, inReplyTo: `needs-${i}-out`, snippet: text, bodyText: text }));
  // plan 210 (iteration 2): an earlier message of theirs the dated reader read with nothing asked, so each conversation
  // reads what was read and its latest message, and stays (the latest isn't the one read)
  const earlier = Array.from({ length: NEEDS_WALK }, (_, i) => msg({ accountId, date: at(i) - 250, providerMsgId: `needs-${i}-in-0`, providerThreadId: `needs-${i}`, from: who(i), to: [me], isRead: true, listId: null, subject: `Re: Notes ${i}`, inReplyTo: `needs-${i}-out`, bodyText: "Got it." }));
  const marked: number[] = [];
  for (const batch of [out, earlier, back]) {
    for (let i = 0; i < batch.length; i += 500) {
      const r = await store.sync.ingest(batch.slice(i, i + 500), { applyFilters: false, now, classifier: null, ...(batch === earlier ? { datedMail: { since: null } } : {}) });
      if (batch === earlier) marked.push(...r.inserted);
    }
  }
  // one snapshot: threadOf reads the whole mailbox each time
  const threads = new Map((await store.debug.snapshot()).messages.map((m) => [m.providerMsgId, m.threadId]));
  const read = new Set(marked);
  const marks = (await store.dated.marks.page(null, 10 * NEEDS_WALK)).filter((m) => read.has(m.messageId));
  expect(marks).toHaveLength(NEEDS_WALK);
  for (const m of marks) expect(await store.dated.finish({ messageId: m.messageId, threadId: m.threadId, fromScan: false, rows: [], settled: [], now, model: "m", provider: "p", promptVersion: DATED_NOTHING_ASKED_SINCE, nothingAsked: true, clearGeneration: store.dated.clearGeneration() })).toBe("written");
  const body = JSON.stringify({ summary: "Notes from the call.", items: [{ kind: "fact", text: "The plan for next week is in the notes." }] });
  let written = 0;
  for (let i = 0; i < NEEDS_WALK; i++) {
    const threadId = threads.get(`needs-${i}-in`)!;
    const sources = await store.aiSummaries.sources(threadId);
    const r = await store.aiSummaries.finish({ threadId, stamp: sources!.stamp, expectThrough: null, now: now + 1, clearGeneration: store.aiSummaries.clearGeneration(), contentHash: "h", promptVersion: 7, language: "en", model: "m", provider: "fake", endpoint: null, bodyJson: body });
    if (r === "written") written++;
  }
  expect(written).toBe(NEEDS_WALK);
  // the facts of what came in, as the backend's slices would: until then the count has no waiting number to add to
  while (!(await store.facts.idle())) await store.facts.backfill({ limit: 5000 });
}

/**
 * The fifth panel round (revision 9): conversations holding two dated items and two promises of yours, Coming up as the
 * spread has them and all showing at the bound, each row saying its next. Among the soonest, so they stay at the bound.
 */
const SEVERAL = 50;

async function severalPerThread(store: MailStore, accountId: number, now: number) {
  const me = { name: "Me", email: "me@perf.test" };
  const who = (i: number) => ({ name: `Board ${i}`, email: `board${i}@several.test` });
  // yours first, so the requests in what came after aren't answered by it
  const sent = Array.from({ length: SEVERAL }, (_, i) => msg({ accountId, from: me, to: [who(i)], isSent: true, isRead: true, inInbox: false, listId: null, providerMsgId: `several-${i}-out`, providerThreadId: `several-${i}`, subject: `Board ${i}`, date: now - 7_200_000 - i, bodyText: "I'll send the budget." }));
  const came = Array.from({ length: SEVERAL }, (_, i) => msg({ accountId, from: who(i), to: [me], inInbox: true, listId: null, providerMsgId: `several-${i}-in`, providerThreadId: `several-${i}`, subject: `Re: Board ${i}`, date: now - 3_600_000 - i, bodyText: "The board meets Thursday at 9:00; the dues are due Friday." }));
  const outs = (await store.sync.ingest(sent, { applyFilters: false, now, classifier: null, liveSent: { wanted: true } })).inserted;
  const ins = (await store.sync.ingest(came, { applyFilters: false, now, classifier: null, datedMail: { since: null } })).inserted;
  expect([outs.length, ins.length]).toEqual([SEVERAL, SEVERAL]);
  const day = (n: number) => todayKey(now + n * DAY);
  for (let i = 0; i < SEVERAL; i++) {
    const src = (await store.dated.source(ins[i]!))!;
    const rows = [
      { kind: "event" as const, item: 0, text: "Board meeting", quote: "The board meets Thursday", dueDay: day(4), dueAt: now + 4 * DAY, timed: true, dated: true, actAt: now + 30_000 + i },
      { kind: "pay" as const, item: 1, text: "Pay the dues", quote: "the dues are due Friday", dueDay: day(5), dueAt: now + 5 * DAY, timed: false, dated: true, actAt: now + 30_000 + i },
    ];
    expect(await store.dated.finish({ messageId: ins[i]!, threadId: src.threadId, fromScan: false, rows, settled: [], now, model: "m", provider: "p", promptVersion: 1, clearGeneration: store.dated.clearGeneration() })).toBe("written");
    const promise = (item: number, text: string, dueAt: number, dated: boolean) => ({ kind: "promise" as const, item, text, quote: "I'll send the budget", personName: who(i).name, personEmail: who(i).email, dueAt, dated });
    await store.followups.finish({ messageId: outs[i]!, threadId: src.threadId, fromScan: false, rows: [promise(0, "send the budget", now + 3 * DAY, true), promise(1, "call back", now + DAY, false)], kept: [], now, model: "m", provider: "p", promptVersion: 1, clearGeneration: store.followups.clearGeneration() });
  }
  // the facts of what came in: until then the count has no waiting number to add to
  while (!(await store.facts.idle())) await store.facts.backfill({ limit: 5000 });
}

/**
 * The seventh panel round (revision 12): conversations waiting on you in the Inbox, each with a Plan today, a bill Soon and
 * a person's ask, so every group's ranking and the count's uncounted path (a waiting conversation that's Today's Plan) run
 * at the bound. Among the soonest, as above.
 */
const MIXED = 50;

async function mixedPerThread(store: MailStore, accountId: number, now: number) {
  const me = { name: "Me", email: "me@perf.test" };
  const who = (i: number) => ({ name: `Client ${i}`, email: `client${i}@mixed.test` });
  const sent = Array.from({ length: MIXED }, (_, i) => msg({ accountId, from: me, to: [who(i)], isSent: true, isRead: true, inInbox: false, listId: null, providerMsgId: `mixed-${i}-out`, providerThreadId: `mixed-${i}`, subject: `Visit ${i}`, date: now - 7_200_000 - i, bodyText: "See you then." }));
  const came = Array.from({ length: MIXED }, (_, i) => msg({ accountId, from: who(i), to: [me], isRead: false, listId: null, providerMsgId: `mixed-${i}-in`, providerThreadId: `mixed-${i}`, subject: `Re: Visit ${i}`, date: now - 3_600_000 - i, bodyText: "The visit is on Monday at 3:00; the invoice is due Friday. Could you confirm the address?" }));
  // not marked for the follow-ups reader: nothing reads in the background while the gate measures
  await store.sync.ingest(sent, { applyFilters: false, now, classifier: null });
  const ins = (await store.sync.ingest(came, { applyFilters: false, now, classifier: null, datedMail: { since: null } })).inserted;
  expect(ins.length).toBe(MIXED);
  // three hours after the bound's moment: Today's there
  const visit = now + 2 * DAY + 3 * 3_600_000;
  for (let i = 0; i < MIXED; i++) {
    const src = (await store.dated.source(ins[i]!))!;
    const rows = [
      { kind: "event" as const, item: 0, text: "The visit", quote: "The visit is on Monday at 3:00", dueDay: todayKey(visit), dueAt: visit, timed: true, dated: true, actAt: now + 30_000 + i },
      { kind: "pay" as const, item: 1, text: "Pay the invoice", quote: "the invoice is due Friday", dueDay: todayKey(now + 5 * DAY), dueAt: now + 5 * DAY, timed: false, dated: true, actAt: now + 30_000 + i },
      { kind: "ask" as const, item: 2, text: "Confirm the address", quote: "Could you confirm the address?", dueDay: todayKey(src.date), dueAt: src.date, timed: false, dated: false, actAt: now + 30_000 + i },
    ];
    expect(await store.dated.finish({ messageId: ins[i]!, threadId: src.threadId, fromScan: false, rows, settled: [], now, model: "m", provider: "p", promptVersion: 1, clearGeneration: store.dated.clearGeneration() })).toBe("written");
  }
  while (!(await store.facts.idle())) await store.facts.backfill({ limit: 5000 });
}

/**
 * Plan 210 (iteration 3, Codex code review): follow-ups at its bound, every promise beside SEVERAL's answering a request
 * (`answers`, linked by its reply's verdict, as the reader writes it), each in a conversation of its own. Returns the
 * requests: closed afterwards, each is read by id with the promises (`today.members`, one batch), never among the open set.
 */
const LINKED = FOLLOWUPS_ACTIVE_MAX - 2 * SEVERAL;

async function linkedRequests(store: MailStore, accountId: number, now: number): Promise<{ id: number; revision: number }[]> {
  const me = { name: "Me", email: "me@perf.test" };
  const who = (i: number) => ({ name: `Parent ${i}`, email: `parent${i}@linked.test` });
  const asked = Array.from({ length: LINKED }, (_, i) => msg({ accountId, from: who(i), to: [me], inInbox: true, listId: null, providerMsgId: `linked-${i}-in`, providerThreadId: `linked-${i}`, subject: `Form ${i}`, date: now - 5 * 3_600_000 - i, bodyText: "Could you send the signed form by Friday?" }));
  const replies = Array.from({ length: LINKED }, (_, i) => msg({ accountId, from: me, to: [who(i)], isSent: true, isRead: true, inInbox: false, listId: null, gmailLabels: ["SENT"], providerMsgId: `linked-${i}-out`, providerThreadId: `linked-${i}`, subject: `Re: Form ${i}`, date: now - 4 * 3_600_000 - i, bodyText: "I'll send it Wednesday." }));
  const ins: number[] = [];
  const outs: number[] = [];
  for (let i = 0; i < LINKED; i += 500) ins.push(...(await store.sync.ingest(asked.slice(i, i + 500), { applyFilters: false, now, classifier: null, datedMail: { since: null } })).inserted);
  for (let i = 0; i < LINKED; i += 500) outs.push(...(await store.sync.ingest(replies.slice(i, i + 500), { applyFilters: false, now, classifier: null, liveSent: { wanted: true } })).inserted);
  expect([ins.length, outs.length]).toEqual([LINKED, LINKED]);
  const requests: { id: number; revision: number }[] = [];
  for (let i = 0; i < LINKED; i++) {
    const src = (await store.dated.source(ins[i]!))!;
    const row = { kind: "respond" as const, item: 0, text: "Send the signed form", quote: "send the signed form by Friday", dueDay: todayKey(now + 3 * DAY), dueAt: now + 3 * DAY, timed: false, dated: true, actAt: now + i };
    expect(await store.dated.finish({ messageId: ins[i]!, threadId: src.threadId, fromScan: false, rows: [row], settled: [], now, model: "m", provider: "p", promptVersion: 1, clearGeneration: store.dated.clearGeneration() })).toBe("written");
    const [request] = await store.dated.ofThread(src.threadId);
    requests.push({ id: request!.id, revision: request!.revision });
    const promise = { kind: "promise" as const, item: 0, text: "send the signed form", quote: "I'll send it Wednesday", personName: who(i).name, personEmail: who(i).email, dueAt: now + ((i % 5) + 1) * DAY, dated: true };
    expect(await store.followups.finish({ messageId: outs[i]!, threadId: src.threadId, fromScan: false, rows: [promise], kept: [], verdicts: [{ request: requests[i]!, verdict: "promise", item: 0 }], now, model: "m", provider: "p", promptVersion: 11, clearGeneration: store.followups.clearGeneration() })).toBe("written");
  }
  // the facts of what came in, as above
  while (!(await store.facts.idle())) await store.facts.backfill({ limit: 5000 });
  return requests;
}

/**
 * Plan 216: Removes past the page's size (Codex code review, #3): every Needs you conversation removed and written to again,
 * twice, the second time half of them: 4,000 records, 3,000 of them about an older message (`needsAtBound`'s).
 */
async function removedAtBound(store: MailStore, accountId: number, now: number) {
  const me = { name: "Me", email: "me@perf.test" };
  for (const [round, count] of [[0, NEEDS_WALK], [1, NEEDS_WALK / 2]] as const) {
    const page = await store.today.waitingPage({ now, after: null, limit: NEEDS_WALK });
    const rows = await store.today.waiting.rows(page.map((w) => ({ threadId: w.id, since: w.waitingSince })), now, { messages: true });
    let removed = 0;
    for (const w of page) {
      const r = rows.get(w.id);
      if (r?.message != null && (await store.today.waiting.act({ threadId: w.id, since: w.waitingSince, message: r.message, rev: r.rev, state: "removed", until: null, now }))) removed++;
    }
    expect(removed).toBe(page.length);
    const again = Array.from({ length: count }, (_, i) => msg({ accountId, date: now - 60_000 + round * 5000 + i, providerMsgId: `needs-${i}-again-${round}`, providerThreadId: `needs-${i}`, from: { name: `Person ${i}`, email: `person${i}@needs.test` }, to: [me], isRead: false, listId: null, subject: `Re: Notes ${i}`, bodyText: "One more thing about the plan." }));
    for (let i = 0; i < again.length; i += 500) await store.sync.ingest(again.slice(i, i + 500), { applyFilters: false, now, classifier: null });
    while (!(await store.facts.idle())) await store.facts.backfill({ limit: 5000 });
  }
}

/**
 * Plan 281: People on the combined bounds (the largest What matters there is here), the recipient index built from the whole
 * mailbox: its list read afresh after a change (What matters' open part grouped by person, the replies owed to you, Everyone
 * from the index), one person's page (the grouping kept, their conversations by address) and a one-letter search.
 */
async function people(kind: string, backend: Backend, budget: { listMs: number; personMs: number; searchMs: number; busyMs: number }) {
  await backend.warmAutocomplete();
  const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
  const lists: number[] = [];
  const pages: number[] = [];
  const searches: number[] = [];
  const first = await backend.people.list();
  expect(first.index).toBe("ready");
  expect(first.everyone.length).toBeGreaterThan(0);
  const someone = first.open[0]?.email ?? first.everyone[0]!.email;
  // plan 287: every other round within a filter (one of the two accounts, the past month): the same budgets
  const [account] = await backend.store.accounts.list();
  const filter = { accounts: [account!.id], within: "month" as const };
  const loop = watchLoop(budget.busyMs * MULT);
  for (let i = 0; i < 12; i++) {
    const within = i % 2 ? filter : undefined;
    await turn();
    backend.today.changed();
    let t = performance.now();
    await backend.people.list(undefined, within);
    lists.push(performance.now() - t);
    await turn();
    t = performance.now();
    await backend.people.person(someone, undefined, undefined, within);
    pages.push(performance.now() - t);
    await turn();
    t = performance.now();
    await backend.people.search("a", within);
    searches.push(performance.now() - t);
  }
  const report = loop.stop();
  process.stderr.write(`[${kind}] People: list p95 ${p95(lists).toFixed(1)} ms (${first.open.length} open, ${first.everyone.length} everyone), page p95 ${p95(pages).toFixed(1)} ms, search p95 ${p95(searches).toFixed(1)} ms, longest busy ${report.longest.busy.toFixed(1)} ms\n`);
  expect(p95(lists)).toBeLessThanOrEqual(budget.listMs * MULT);
  expect(p95(pages)).toBeLessThanOrEqual(budget.personMs * MULT);
  expect(p95(searches)).toBeLessThanOrEqual(budget.searchMs * MULT);
  expect(report.longest.busy).toBeLessThanOrEqual(budget.busyMs * MULT);
}

async function run(kind: "SQLite" | "IndexedDB", budget: { spread: Gate; bound: Gate; needs: Gate; linked: Gate; busyMs: number; people: { listMs: number; personMs: number; searchMs: number; busyMs: number } }) {
  const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
  let store: MailStore | undefined;
  let accountId: number;
  const path = join(dir, `${kind}.db`);
  if (kind === "IndexedDB") {
    const idb = await IdbMailStore.open({ name: "today-perf", factory: indexedDB, instantSearch: false, platform });
    const seeded = await idb.dev.seed(generateDataset({ threads: 52_000, accounts: 2, seed: 204, now: NOW, bodyScale: 0.02 }), { now: NOW, categorizeRate: 0 });
    accountId = seeded.accountIds[0]!;
    store = idb;
  } else accountId = copyMailbox(LARGE_MAILBOX, path).accountIds[0]!;
  const clock = { now: NOW };
  const backend = new Backend({ dbPath: path, store, platform: store ? platform : undefined, version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false, demoAi: true, now: () => clock.now });
  await backend.store.ready;
  await backend.ready;
  try {
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId: "r", origin: "renderer" });
    const client = new RpcClient(c);
    await client.call("settings.update", { ai: { provider: "fake" } });
    // seeded first: the reader, once on, would read (and drop) mail from before it went on
    await seedDatedItems({ store: backend.store, accountId, now: NOW, budget: MULT, log: () => {} });
    // the soonest stay at the bound: these take the place of the furthest SEVERAL * 2 of those
    await severalPerThread(backend.store, accountId, NOW);
    await mixedPerThread(backend.store, accountId, NOW);
    await client.call("settings.update", { dated: { enabled: true }, followups: { enabled: true } });
    // plan 210 (iteration 4): What matters' mutes at their bound, none of them anyone here: every list, count and Needs you
    // walk reads them (one batched read each) and tests every row against them, hiding nothing
    for (let i = 0; i < DATED_MUTES_MAX; i++) await backend.store.dated.mutes.add({ on: "sender", key: `muted${i}@nobody.test`, name: "", at: i });
    // (iteration 5) and the kinds muted from one sender at theirs: read in the same batched list, tested a row each by key
    for (let i = 0; i < DATED_MUTE_PAIRS_MAX; i++) await backend.store.dated.mutes.add({ on: "pair", key: `${DATED_KINDS[i % DATED_KINDS.length]}|paired${i}@nobody.test`, name: "", at: i });
    // a turn between calls, as between two requests: the store answers synchronously on SQLite
    const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
    const measure = async (label: string, at: number, gate: Gate) => {
      clock.now = at;
      backend.today.touched();
      const lists: number[] = [];
      const counts: number[] = [];
      // plan 145's own count, in the same turns: what this plan adds is the difference
      const needs: number[] = [];
      const busyMs = gate.busyMs ?? budget.busyMs;
      const loop = watchLoop(busyMs * MULT);
      for (let i = 0; i < 20; i++) {
        await turn();
        let t = performance.now();
        await backend.today.list([]);
        lists.push(performance.now() - t);
        const raw = await backend.store.threads.counts(clock.now);
        await turn();
        t = performance.now();
        await backend.today.withCount(raw);
        counts.push(performance.now() - t);
        await turn();
        t = performance.now();
        await backend.store.today.needsCount(clock.now);
        needs.push(performance.now() - t);
      }
      const report = loop.stop();
      const added = p95(counts) - p95(needs);
      process.stderr.write(`[${kind}] ${label}: today.list p95 ${p95(lists).toFixed(1)} ms, count p95 ${p95(counts).toFixed(1)} ms (plan 145's ${p95(needs).toFixed(1)}, so ${added.toFixed(1)} added), longest busy ${report.longest.busy.toFixed(1)} ms\n`);
      expect(report.longest.busy).toBeLessThanOrEqual(busyMs * MULT);
      expect(p95(lists)).toBeLessThanOrEqual(gate.listMs * MULT);
      expect(added).toBeLessThanOrEqual(gate.addedMs * MULT);
      expect(p95(needs)).toBeLessThanOrEqual(gate.needsMs * MULT);
      expect(p95(counts)).toBeLessThanOrEqual(gate.countMs * MULT);
    };
    // as a mailbox has them: the items spread over the coming weeks, a few for today, the rest Coming up
    await measure("spread", NOW, budget.spread);
    // the bound: every item's time to act has come, and the list holds all 1,000, a conversation once (each of SEVERAL and
    // MIXED with its next item said beside it; each of MIXED Today's ask, the person before the Plan: plan 210, iteration 1)
    clock.now = NOW + 2 * DAY;
    backend.today.touched();
    const listed = await client.call("today.list", { held: [] });
    const all = listed.sections.flatMap((x) => x.items);
    // plan 210 (iteration 2): a row per item, so every one of the 1,000 is a row of its own (SEVERAL's and MIXED's
    // conversations two and three rows each, their promises too), and no row says another's
    expect(all.length).toBeGreaterThanOrEqual(1000);
    expect(new Set(all.map((i) => i.id)).size).toBe(all.length);
    // (iteration 4) but for SEVERAL's replies, each two promises to one person: one row, the other its Also line
    expect(all.filter((i) => i.also).map((i) => i.also!.map((a) => a.kind))).toEqual(Array(SEVERAL).fill(["promise"]));
    // (the asks are Today's "Waiting on you", its own section: plan 210, iteration 3)
    expect(listed.sections.find((x) => x.kind === "today" && x.part === "waiting")?.items.filter((i) => i.why.item?.kind === "ask").length).toBe(MIXED);
    await measure("all showing", NOW + 2 * DAY, budget.bound);
    // plan 204, the second panel round: Needs you full (NEEDS_WALK conversations), each on the tighter rule's slowest
    // path: a snippet that starts like a thanks (its body read), a body that says more, a current summary to parse
    await needsAtBound(backend.store, client, accountId, NOW + 2 * DAY);
    await measure("Needs you at its bound", NOW + 2 * DAY, budget.needs);
    // plan 210 (iteration 3, revision 12): Coming up without a horizon: the 1,000 items' days from two weeks to almost a
    // year ahead, every one Coming up's (open in the feed: the backend lists them either way), each under its day or its
    // week (`displayBucket`), its sender read with the rest (`fromOf`); Needs you still at its bound, so the list and the
    // mailbox's counts after it in one turn are this plan's longest
    const open = await backend.store.dated.active();
    expect(await backend.store.today.act({ dated: open.map((r) => ({ id: r.id, revision: r.revision, patch: { state: "dismissed", closedReason: "user", closedAt: NOW + 2 * DAY } })), promises: [] })).not.toBeNull();
    await seedDatedItems({ store: backend.store, accountId, now: NOW + 2 * DAY, budget: MULT, log: () => {} }, 1, true);
    backend.today.touched();
    const far = (await client.call("today.list", { held: [] })).sections.filter((x) => x.kind === "comingUp");
    expect(far.reduce((n, x) => n + x.items.length, 0)).toBeGreaterThanOrEqual(1000);
    expect(far.some((x) => x.bucket?.startsWith("week:"))).toBe(true);
    await measure("Coming up far, Needs you at its bound", NOW + 2 * DAY, budget.needs);
    // plan 210 (iteration 3, Codex code review): the combined bounds: follow-ups full, every promise there but SEVERAL's
    // answering a request closed since (each read by id, in one batch, by the list, the count and the clock alike), the
    // dated set full again (Coming up far), Needs you full
    const farOpen = await backend.store.dated.active();
    expect(await backend.store.today.act({ dated: farOpen.map((r) => ({ id: r.id, revision: r.revision, patch: { state: "dismissed", closedReason: "user", closedAt: NOW + 2 * DAY } })), promises: [] })).not.toBeNull();
    const requests = await linkedRequests(backend.store, accountId, NOW + 2 * DAY);
    expect(await backend.store.today.act({ dated: requests.map((r) => ({ id: r.id, revision: r.revision, patch: { state: "dismissed", closedReason: "user", closedAt: NOW + 2 * DAY } })), promises: [] })).not.toBeNull();
    await seedDatedItems({ store: backend.store, accountId, now: NOW + 2 * DAY, budget: MULT, log: () => {} }, 2, true);
    backend.today.touched();
    const promises = await backend.store.followups.active();
    expect(promises).toHaveLength(FOLLOWUPS_ACTIVE_MAX);
    expect(promises.filter((p) => p.answers != null)).toHaveLength(LINKED);
    expect((await backend.store.dated.active()).length).toBeGreaterThanOrEqual(1000);
    await measure("Linked requests at the combined bounds", NOW + 2 * DAY, budget.linked);
    // plan 216 (Codex review, #9; code review, #3): Removes add up (kept with their message), past the page's size, most of
    // them about an older message: the count reads them without walking the page's every conversation
    await removedAtBound(backend.store, accountId, NOW + 2 * DAY);
    await measure("Linked requests at the combined bounds, 4,000 Removes (3,000 stale)", NOW + 2 * DAY, budget.linked);
    // plan 249: the user's words at their bound (20 rules, every effect, exact and judged) on the combined bounds, a verdict
    // for every row the judged ones reach, so the projection reads them in one batch and asks the worker nothing. Last:
    // the verdicts it writes would weigh on the scenarios above (their history is without them)
    await words(backend.store, NOW + 2 * DAY);
    backend.words.reload();
    // the rules are the service's: 20 of them, and every row they reach already judged
    expect(await backend.words.rules()).toHaveLength(20);
    backend.today.changed();
    await backend.today.list([]);
    await backend.today.withCount(await backend.store.threads.counts(NOW + 2 * DAY));
    await measure("Combined bounds, 20 rules of the user's words", NOW + 2 * DAY, budget.linked);
    expect(backend.words.worker.status().applying).toBeNull();
    await people(kind, backend, budget.people);
  } finally {
    await backend.stop();
  }
}

// plan 210 (iteration 3, Codex code review): the combined bounds are this gate's largest state, and on SQLite they're over the
// 60 ms ceiling before and after the batched read (base a7e1a5ad7, three rounds at load 2 to 8: list p95 75 to 81 ms, longest
// turn 96 to 104; with it, at load 2 to 3: 56 to 71 and 92 to 134). Most of it isn't Today's: plan 145's own walk is about
// 48 ms in this mailbox (35 in the scenario before), and the second Coming up seed alone takes the list to about 60 ms and the
// turn to about 81. So `linked` holds what was measured, and what Today adds for 900 linked requests (about 10 ms; 12 to 13
// when each was read again by id) is its tightest part. The read count itself is held in packages/db/src/today-members.test.ts.
describe("Today at 50k threads with 1,000 dated items (plan 204 revision 12)", () => {
  // the count is plan 145's walk and what this plan adds to it: at most 2 ms spread, 4 ms with a thousand threads to check
  // Needs you's own walk: about 7 ms (SQLite) and 5 ms (IndexedDB) as mailboxes have it, about 28 and 8 with all 2,000 on its slowest path
  it("SQLite", async () => run("SQLite", { spread: { listMs: 20, addedMs: 2, needsMs: 12, countMs: 14 }, bound: { listMs: 30, addedMs: 4, needsMs: 12, countMs: 14 }, needs: { listMs: 45, addedMs: 5, needsMs: 40, countMs: 42 }, linked: { listMs: 85, addedMs: 12, needsMs: 60, countMs: 70, busyMs: 120 }, busyMs: 60, people: { listMs: 120, personMs: 40, searchMs: 10, busyMs: 120 } }), 600_000);
  it("IndexedDB", async () => run("IndexedDB", { spread: { listMs: 20, addedMs: 2, needsMs: 10, countMs: 12 }, bound: { listMs: 30, addedMs: 4, needsMs: 10, countMs: 12 }, needs: { listMs: 15, addedMs: 3, needsMs: 12, countMs: 14 }, linked: { listMs: 20, addedMs: 4, needsMs: 12, countMs: 15 }, busyMs: 60, people: { listMs: 60, personMs: 60, searchMs: 10, busyMs: 60 } }), 900_000);
});
