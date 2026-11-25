import type { ArrivalRow, Counts, MailNotice } from "@terno/core";
import { describe, expect, it } from "vitest";
import { Attention, BODY_WAITS, GATHER_MS, MAX_PENDING, NOTICE_GAP_MS, READ_CHUNK, READING_WAIT_MS } from "./attention";

const NOW = Date.UTC(2026, 9, 26, 12);
const counts = (inboxUnread: number): Counts => ({ inboxUnread, inboxUnreadByAccount: {}, categoryUnread: {}, categoryTotal: {}, categorySuggestions: {} });

function person(id: number, o: Partial<ArrivalRow> = {}): ArrivalRow {
  return {
    id, threadId: 100 + id, accountId: 1, date: NOW - 1000, fromName: `Person ${id}`, fromEmail: `p${id}@example.com`, subject: `Subject ${id}`, snippet: `Snippet ${id}`,
    isRead: false, isSent: false, isDraft: false, inInbox: true, isTrash: false, isSpam: false, listId: null, isBulk: false, gmailLabels: null, own: false, written: true, yourConversation: false, bodyPending: false,
    ...o,
  };
}

/** A fake clock and timers, a fake store answering from `rows`, and the host's calls. */
function setup(o: { settings?: Record<string, unknown>; host?: boolean; rows?: Map<number, ArrivalRow>; bodyFilter?: boolean } = {}) {
  // plan 273: What matters' verdict, as the test sets it (`shown` false: it isn't shown, null)
  const whatMatters = { shown: true, counted: new Set<number>(), reading: new Set<number>(), asked: [] as number[][], hold: null as Promise<void> | null };
  const filters = { body: o.bodyFilter ?? false };
  let now = NOW;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let seq = 0;
  const app: Record<string, unknown> = { ...o.settings };
  const rows = o.rows ?? new Map<number, ArrivalRow>();
  const reads: number[][] = [];
  let hold: Promise<void> | null = null;
  const badges: number[] = [];
  const notices: MailNotice[] = [];
  const emitted: MailNotice[] = [];
  let published = 0, filterReads = 0;
  const attention = new Attention({
    store: {
      settings: { get: async (key: string, dflt: unknown) => (key === "app" ? app : dflt) },
      secrets: {},
      filters: { list: async () => (filterReads++, filters.body ? [{ enabled: true, rule: { match: "all", conditions: [{ field: "body", op: "contains", value: "x" }], actions: [{ type: "archive" }] } }] : []) },
      sync: {
        arrivals: async (ids: readonly number[]) => {
          reads.push([...ids]);
          if (hold) await hold;
          return ids.flatMap((id) => (rows.has(id) ? [rows.get(id)!] : []));
        },
      },
    } as never,
    host: o.host === false ? null : { badge: (n) => badges.push(n), notify: (n) => notices.push(n) },
    emit: (n) => emitted.push(n),
    publishCounts: () => void published++,
    now: () => now,
    whatMatters: async (arrivals) => {
      whatMatters.asked.push(arrivals.map((m) => m.id));
      // read when asked, as the store's reads are: what changes while it's on its way isn't in it (Codex code review #2)
      const verdict = whatMatters.shown ? { counted: new Set(arrivals.filter((m) => whatMatters.counted.has(m.id)).map((m) => m.id)), reading: new Set(arrivals.filter((m) => whatMatters.reading.has(m.id)).map((m) => m.id)) } : null;
      if (whatMatters.hold) await whatMatters.hold;
      return verdict;
    },
    timers: {
      setTimeout: (fn, ms) => (timers.push({ at: now + ms, fn, id: ++seq }), seq),
      clearTimeout: (id) => {
        const i = timers.findIndex((t) => t.id === id);
        if (i >= 0) timers.splice(i, 1);
      },
      now: () => now,
    },
  });
  /** advances the clock, firing due timers and letting their async work settle */
  /** lets every queued promise run (the screen's reads, a flush) */
  const settle = async () => {
    for (let i = 0; i < 300; i++) await Promise.resolve();
  };
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      await settle();
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > until) break;
      timers.shift();
      now = next.at;
      next.fn();
    }
    now = until;
    await settle();
  };
  return {
    attention, app, rows, reads, badges, notices, emitted, advance, filters, whatMatters,
    timers: () => timers.length,
    published: () => published,
    filterReads: () => filterReads,
    hold: (p: Promise<void> | null) => (hold = p),
  };
}

async function primed(t: ReturnType<typeof setup>, accountId = 1) {
  await t.attention.start();
  t.attention.prime(accountId);
}

describe("the Dock badge", () => {
  it("asks the sidebar's publisher at start, then shows the Inbox number only when it changes", async () => {
    const t = setup();
    await t.attention.start();
    expect(t.published()).toBe(1);
    t.attention.counts(counts(3));
    t.attention.counts(counts(3));
    t.attention.counts(counts(0));
    expect(t.badges).toEqual([3, 0]);
  });

  it("off: 0 at start and after a change; on again: the current number at once", async () => {
    const t = setup({ settings: { dockBadge: false } });
    await t.attention.start();
    expect(t.badges).toEqual([0]);
    t.attention.counts(counts(7));
    expect(t.badges).toEqual([0]);
    t.app.dockBadge = true;
    await t.attention.refresh();
    expect(t.badges).toEqual([0, 7]);
    t.app.dockBadge = false;
    await t.attention.refresh();
    expect(t.badges).toEqual([0, 7, 0]);
  });

  it("plan 207: What matters first, its number; chosen or dropped in Settings, at once; its backfill never flashes the Inbox's", async () => {
    const t = setup({ settings: { firstScreen: "whatMatters" } });
    await t.attention.start();
    t.attention.counts({ ...counts(9), today: 2 });
    t.attention.counts({ ...counts(9), today: null });
    // What matters went (AI off, its row hidden): the Inbox's
    t.attention.counts(counts(9));
    t.app.firstScreen = "inbox";
    await t.attention.refresh();
    t.attention.counts({ ...counts(8), today: 2 });
    t.app.firstScreen = "whatMatters";
    await t.attention.refresh();
    expect(t.badges).toEqual([2, 9, 8, 2]);
  });

  it("no host (the web): nothing published, nothing shown (the page reads the counts itself)", async () => {
    const t = setup({ host: false });
    await t.attention.start();
    t.attention.counts(counts(4));
    expect(t.published()).toBe(0);
    expect(t.badges).toEqual([]);
  });
});

describe("notifications", () => {
  it("an account's first pass in this life (initial sync, catch-up at launch) brings nothing", async () => {
    const t = setup({ rows: new Map([[1, person(1)]]) });
    await t.attention.start();
    const pass = t.attention.beginPass(1);
    pass.add([1]);
    pass.end();
    await t.advance(60_000);
    expect(t.reads).toEqual([]);
    expect(t.timers()).toBe(0);
  });

  it("looks only when the pass is over, after the gather, and merges every slice into one notice", async () => {
    const t = setup({ rows: new Map([[1, person(1)], [2, person(2)]]) });
    await primed(t);
    const pass = t.attention.beginPass(1);
    pass.add([1]);
    await t.advance(10_000);
    expect(t.reads).toEqual([]);
    pass.add([2]);
    pass.end();
    await t.advance(GATHER_MS - 1);
    // screened when the pass ended; read again when it's said
    expect(t.reads).toEqual([[2, 1]]);
    expect(t.notices).toEqual([]);
    await t.advance(1);
    expect(t.reads).toEqual([[2, 1], [2, 1]]);
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]).toMatchObject({ count: 2, senderCount: 2, threadId: null });
  });

  it("at most one notice per gap: mail meanwhile is merged into the next one, read again when the gap ends", async () => {
    const t = setup({ rows: new Map([[1, person(1)], [2, person(2)], [3, person(3)]]) });
    await primed(t);
    const first = t.attention.beginPass(1);
    first.add([1]);
    first.end();
    await t.advance(GATHER_MS);
    expect(t.notices).toHaveLength(1);
    for (const id of [2, 3]) {
      const pass = t.attention.beginPass(1);
      pass.add([id]);
      pass.end();
      await t.advance(2000);
    }
    expect(t.notices).toHaveLength(1);
    // read on another device while it waited: it isn't in the next notice
    t.rows.set(3, person(3, { isRead: true }));
    await t.advance(NOTICE_GAP_MS);
    expect(t.notices).toHaveLength(2);
    expect(t.notices[1]).toMatchObject({ count: 1, threadId: 102 });
  });

  it("drops what isn't still news or isn't important, and notifies nothing when nothing is left", async () => {
    const rows = new Map([
      [1, person(1, { isRead: true })],
      [2, person(2, { inInbox: false })],
      [3, person(3, { written: false })],
      [4, person(4, { listId: "l.example" })],
      [5, person(5, { own: true })],
    ]);
    const t = setup({ rows });
    await primed(t);
    const pass = t.attention.beginPass(1);
    pass.add([1, 2, 3, 4, 5, 6]);
    pass.end();
    await t.advance(GATHER_MS);
    expect(t.notices).toEqual([]);
    // no notice: the next one isn't held back by a gap
    t.rows.set(7, person(7));
    const next = t.attention.beginPass(1);
    next.add([7]);
    next.end();
    await t.advance(GATHER_MS);
    expect(t.notices).toHaveLength(1);
  });

  it("reads in bounded chunks and keeps important mail however much else came (capped at the newest MAX_PENDING)", async () => {
    const rows = new Map<number, ArrivalRow>();
    for (let id = 1; id <= MAX_PENDING + 500; id++) rows.set(id, person(id, { written: false, listId: "news.example" }));
    rows.set(600, person(600));
    const t = setup({ rows });
    await primed(t);
    const pass = t.attention.beginPass(1);
    for (let id = 1; id <= MAX_PENDING + 500; id += 50) pass.add(Array.from({ length: 50 }, (_, i) => id + i));
    pass.end();
    await t.advance(GATHER_MS);
    expect(t.reads.every((r) => r.length <= READ_CHUNK)).toBe(true);
    // the pass's newest MAX_PENDING screened, then the one important message read again
    expect(t.reads.slice(0, -1).flat()).toHaveLength(MAX_PENDING);
    expect(Math.min(...t.reads.slice(0, -1).flat())).toBe(501);
    expect(t.reads.at(-1)).toEqual([600]);
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]).toMatchObject({ count: 1, threadId: 700 });
  });

  it("off: nothing collected, no timer, no read; turned off during a read: nothing delivered", async () => {
    const t = setup({ settings: { notifications: false }, rows: new Map([[1, person(1)]]) });
    await primed(t);
    const pass = t.attention.beginPass(1);
    pass.add([1]);
    pass.end();
    expect(t.timers()).toBe(0);
    await t.advance(60_000);
    expect(t.reads).toEqual([]);

    t.app.notifications = true;
    await t.attention.refresh();
    let release!: () => void;
    t.hold(new Promise<void>((r) => (release = r)));
    const again = t.attention.beginPass(1);
    again.add([1]);
    again.end();
    await t.advance(1);
    expect(t.reads).toHaveLength(1);
    t.app.notifications = false;
    await t.attention.refresh();
    release();
    await t.advance(60_000);
    expect(t.notices).toEqual([]);
    expect(t.timers()).toBe(0);
  });

  it("the last look reads the mail and the filters together", async () => {
    const t = setup({ rows: new Map([[1, person(1)]]) });
    await primed(t);
    const pass = t.attention.beginPass(1);
    pass.add([1]);
    pass.end();
    // the screen looks; the notice waits for its last look
    await t.advance(1);
    expect(t.reads).toHaveLength(1);
    let release!: () => void;
    t.hold(new Promise<void>((r) => (release = r)));
    const screened = t.filterReads();
    await t.advance(60_000);
    expect(t.reads).toHaveLength(2);
    expect(t.filterReads()).toBe(screened + 1);
    t.hold(null);
    release();
    await t.advance(60_000);
    expect(t.notices).toHaveLength(1);
  });

  it("a pass that began before notifications went off hands over nothing", async () => {
    const t = setup({ rows: new Map([[1, person(1)]]) });
    await primed(t);
    const pass = t.attention.beginPass(1);
    pass.add([1]);
    t.app.notifications = false;
    await t.attention.refresh();
    t.app.notifications = true;
    await t.attention.refresh();
    pass.end();
    await t.advance(60_000);
    expect(t.reads).toEqual([]);
  });

  it("Codex review #5: newsletters in a later pass during the gap never push out important mail already screened", async () => {
    const rows = new Map<number, ArrivalRow>([[1, person(1)], [2, person(2)]]);
    for (let id = 10; id < 10 + MAX_PENDING; id++) rows.set(id, person(id, { written: false, listId: "news.example" }));
    const t = setup({ rows });
    await primed(t);
    const first = t.attention.beginPass(1);
    first.add([1]);
    first.end();
    await t.advance(GATHER_MS);
    expect(t.notices).toHaveLength(1);
    // in the gap: one important message, then a pass of 2,000 newsletters
    const second = t.attention.beginPass(1);
    second.add([2]);
    second.end();
    await t.advance(1000);
    const flood = t.attention.beginPass(1);
    flood.add(Array.from({ length: MAX_PENDING }, (_, i) => 10 + i));
    flood.end();
    await t.advance(NOTICE_GAP_MS);
    expect(t.notices).toHaveLength(2);
    expect(t.notices[1]).toMatchObject({ count: 1, threadId: 102 });
  });

  it("Codex review #3: while a filter reads bodies, mail whose body hasn't arrived waits for a later pass, then says it (or never)", async () => {
    const rows = new Map([[1, person(1, { bodyPending: true })]]);
    const t = setup({ rows, bodyFilter: true });
    await primed(t);
    const pass = t.attention.beginPass(1);
    pass.add([1]);
    pass.end();
    await t.advance(60_000);
    expect(t.notices).toEqual([]);
    // the body came in the next pass and no filter took it away: now it's said
    t.rows.set(1, person(1, { bodyPending: false }));
    const next = t.attention.beginPass(1);
    next.end();
    await t.advance(GATHER_MS);
    expect(t.notices).toHaveLength(1);

    // a body that never comes: let go quietly after BODY_WAITS passes
    t.rows.set(2, person(2, { bodyPending: true }));
    const p = t.attention.beginPass(1);
    p.add([2]);
    p.end();
    for (let i = 0; i < BODY_WAITS + 2; i++) {
      const again = t.attention.beginPass(1);
      again.end();
      await t.advance(NOTICE_GAP_MS);
    }
    expect(t.notices).toHaveLength(1);
    const reads = t.reads.length;
    const last = t.attention.beginPass(1);
    last.end();
    await t.advance(NOTICE_GAP_MS);
    expect(t.reads.length).toBe(reads);
  });

  it("Codex review #3: without a filter that reads bodies, mail whose body hasn't arrived is said at once", async () => {
    const t = setup({ rows: new Map([[1, person(1, { bodyPending: true })]]) });
    await primed(t);
    const pass = t.attention.beginPass(1);
    pass.add([1]);
    pass.end();
    await t.advance(GATHER_MS);
    expect(t.notices).toHaveLength(1);
  });

  it("Codex re-review #1: two passes ending back to back never retry the same waiting message twice (once said, it isn't said again)", async () => {
    const t = setup({ rows: new Map([[1, person(1, { bodyPending: true })]]), bodyFilter: true });
    await primed(t);
    const first = t.attention.beginPass(1);
    first.add([1]);
    first.end();
    await t.advance(1);
    expect(t.reads).toHaveLength(1);
    // its body came; two passes end back to back; the second's screen is slow, the first's notice goes meanwhile
    t.rows.set(1, person(1, { bodyPending: false }));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sync = (t.attention as unknown as { o: { store: { sync: { arrivals(ids: readonly number[]): Promise<ArrivalRow[]> } } } }).o.store.sync;
    const original = sync.arrivals.bind(sync);
    let calls = 1;
    sync.arrivals = async (ids) => {
      if (++calls === 3) await gate;
      return original(ids);
    };
    t.attention.beginPass(1).end();
    // the second pass brought something of its own (not important), so its screen reads too
    const second = t.attention.beginPass(1);
    second.add([50]);
    second.end();
    await t.advance(GATHER_MS);
    expect(t.notices).toHaveLength(1);
    release();
    await t.advance(NOTICE_GAP_MS * 3);
    expect(t.notices).toHaveLength(1);
  });

  it("Codex re-review #2: a flush due while a big screen runs never sees more than the bound", async () => {
    const rows = new Map<number, ArrivalRow>([[1, person(1, { date: NOW - 5000 })]]);
    for (let id = 100; id < 100 + 300; id++) rows.set(id, person(id, { date: NOW - 1000 + id }));
    const t = setup({ rows });
    await primed(t);
    const first = t.attention.beginPass(1);
    first.add([1]);
    first.end();
    await t.advance(1);
    // the timer is armed; a pass of 300 important ones is screened in two chunks, the second one slow
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sync = (t.attention as unknown as { o: { store: { sync: { arrivals(ids: readonly number[]): Promise<ArrivalRow[]> } } } }).o.store.sync;
    const original = sync.arrivals.bind(sync);
    sync.arrivals = async (ids) => {
      if (ids.length === 100) await gate;
      return original(ids);
    };
    const big = t.attention.beginPass(1);
    big.add([...rows.keys()].filter((id) => id >= 100));
    big.end();
    await t.advance(GATHER_MS);
    release();
    await t.advance(NOTICE_GAP_MS * 2);
    expect(t.reads.every((r) => r.length <= READ_CHUNK)).toBe(true);
    expect(t.notices.length).toBeGreaterThan(0);
    expect(t.notices.every((n) => n.count <= READ_CHUNK)).toBe(true);
  });

  it("Codex re-review #3: a body filter turned on during the gap holds mail whose body hasn't come", async () => {
    const t = setup({ rows: new Map([[1, person(1, { bodyPending: true })]]) });
    await primed(t);
    const pass = t.attention.beginPass(1);
    pass.add([1]);
    pass.end();
    await t.advance(1);
    t.filters.body = true;
    await t.advance(GATHER_MS);
    expect(t.notices).toEqual([]);
    // its body arrives with the next pass, no filter took it: now it's said
    t.rows.set(1, person(1, { bodyPending: false }));
    t.attention.beginPass(1).end();
    await t.advance(GATHER_MS);
    expect(t.notices).toHaveLength(1);
  });

  it("Codex review #4: an account removed while its mail is queued, or while its pass runs, says nothing of it", async () => {
    const t = setup({ rows: new Map([[1, person(1)], [2, person(2, { accountId: 2 })], [3, person(3)]]) });
    await t.attention.start();
    t.attention.prime(1);
    t.attention.prime(2);
    const a = t.attention.beginPass(1);
    a.add([1]);
    a.end();
    const b = t.attention.beginPass(2);
    b.add([2]);
    b.end();
    await t.advance(1);
    // screened and queued; account 1 goes before the notice
    t.attention.forget(1);
    await t.advance(GATHER_MS);
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]).toMatchObject({ count: 1, threadId: 102 });
    // a pass that began before its account went hands over nothing, even after it's primed again
    t.attention.prime(1);
    const running = t.attention.beginPass(1);
    running.add([3]);
    t.attention.forget(1);
    t.attention.prime(1);
    running.end();
    await t.advance(60_000);
    expect(t.notices).toHaveLength(1);
  });

  it("Codex review #4: removed during the screen's read: nothing of it is queued", async () => {
    const t = setup({ rows: new Map([[1, person(1)]]) });
    await primed(t);
    let release!: () => void;
    t.hold(new Promise<void>((r) => (release = r)));
    const pass = t.attention.beginPass(1);
    pass.add([1]);
    pass.end();
    await t.advance(1);
    t.attention.forget(1);
    release();
    t.hold(null);
    await t.advance(60_000);
    expect(t.notices).toEqual([]);
  });

  it("a forgotten account (removed, closed) starts over: its next pass is a first pass", async () => {
    const t = setup({ rows: new Map([[1, person(1)]]) });
    await primed(t);
    t.attention.forget(1);
    const pass = t.attention.beginPass(1);
    pass.add([1]);
    pass.end();
    await t.advance(60_000);
    expect(t.reads).toEqual([]);
  });

  it("preview off: the notice carries no sender, subject or snippet", async () => {
    const t = setup({ settings: { notificationPreview: false }, rows: new Map([[1, person(1)]]) });
    await primed(t);
    const pass = t.attention.beginPass(1);
    pass.add([1]);
    pass.end();
    await t.advance(GATHER_MS);
    expect(t.notices[0]).toMatchObject({ count: 1, senders: [], subject: "", snippet: "" });
    expect(JSON.stringify(t.notices[0])).not.toMatch(/Person|Subject|Snippet/);
  });

  it("no host (the web): the notice goes to the page", async () => {
    const t = setup({ host: false, rows: new Map([[1, person(1)]]) });
    await primed(t);
    const pass = t.attention.beginPass(1);
    pass.add([1]);
    pass.end();
    await t.advance(GATHER_MS);
    expect(t.notices).toEqual([]);
    expect(t.emitted).toHaveLength(1);
  });

  it("stopped: pending work and its timer go", async () => {
    const t = setup({ rows: new Map([[1, person(1)]]) });
    await primed(t);
    const pass = t.attention.beginPass(1);
    pass.add([1]);
    pass.end();
    await t.advance(0);
    expect(t.timers()).toBe(1);
    t.attention.stop();
    expect(t.timers()).toBe(0);
    await t.advance(60_000);
    // the pass's screen ran before the stop; nothing is read again or said
    expect(t.reads).toEqual([[1]]);
    expect(t.notices).toEqual([]);
  });
});

describe("plan 273: with What matters first, a notice is for what it counts", () => {
  /** the reported mail: LinkedIn's job alert, Gmail Important, in Updates, bulk with no List-Id, never written to */
  const alert = (id: number) => person(id, { fromName: "LinkedIn Job Alerts", fromEmail: "jobalerts-noreply@linkedin.com", written: false, isBulk: true, gmailLabels: '["IMPORTANT","CATEGORY_UPDATES","INBOX"]' });

  async function arrive(t: ReturnType<typeof setup>, ids: number[]) {
    const pass = t.attention.beginPass(1);
    pass.add(ids);
    pass.end();
    await t.advance(GATHER_MS);
  }

  it("the reported case: Gmail's Important alert What matters doesn't count says nothing; the Inbox first, it's said", async () => {
    const t = setup({ settings: { firstScreen: "whatMatters" }, rows: new Map([[1, alert(1)], [2, alert(2)]]) });
    await primed(t);
    await arrive(t, [1]);
    expect(t.whatMatters.asked).toEqual([[1]]);
    expect(t.notices).toEqual([]);
    // plan 41's rule with the Inbox first: Gmail marked it Important
    t.app.firstScreen = "inbox";
    await t.attention.refresh();
    await arrive(t, [2]);
    expect(t.whatMatters.asked).toEqual([[1]]);
    expect(t.notices.map((n) => n.senders)).toEqual([["LinkedIn Job Alerts"]]);
  });

  it("what What matters counts is said, whatever Gmail or plan 41 think of it; what it doesn't, isn't", async () => {
    const t = setup({ settings: { firstScreen: "whatMatters" }, rows: new Map([[1, person(1)], [2, alert(2)], [3, person(3, { written: false })]]) });
    await primed(t);
    t.whatMatters.counted = new Set([2, 3]);
    await arrive(t, [1, 2, 3]);
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]).toMatchObject({ count: 2, senderCount: 2 });
  });

  it("not shown (AI off, its row hidden): the Inbox leads, plan 41's rule", async () => {
    const t = setup({ settings: { firstScreen: "whatMatters" }, rows: new Map([[1, person(1)], [2, person(2, { written: false })]]) });
    await primed(t);
    t.whatMatters.shown = false;
    await arrive(t, [1, 2]);
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]).toMatchObject({ count: 1, threadId: 101 });
  });

  it("mail its reader hasn't read waits, and is said when a look counts it, once", async () => {
    const t = setup({ settings: { firstScreen: "whatMatters" }, rows: new Map([[1, alert(1)]]) });
    await primed(t);
    t.whatMatters.reading = new Set([1]);
    await arrive(t, [1]);
    expect(t.notices).toEqual([]);
    // a look at another message reads nothing (Codex code review #7)
    const before = t.reads.length;
    t.attention.readerLooked(2);
    await t.advance(GATHER_MS);
    expect(t.reads.length).toBe(before);
    // a look at it while it's still being read (a failure kept its mark): it keeps waiting
    t.attention.readerLooked(1);
    await t.advance(GATHER_MS);
    expect(t.notices).toEqual([]);
    // read: a bill due today
    t.whatMatters.reading.clear();
    t.whatMatters.counted.add(1);
    t.attention.readerLooked(1);
    await t.advance(GATHER_MS);
    expect(t.notices).toHaveLength(1);
    // said once: nothing waits any more, so a look reads nothing
    const reads = t.reads.length;
    t.attention.readerLooked(1);
    await t.advance(NOTICE_GAP_MS);
    expect(t.notices).toHaveLength(1);
    expect(t.reads.length).toBe(reads);
  });

  it("read with nothing that counts: let go quietly; never read within READING_WAIT_MS: let go too", async () => {
    const t = setup({ settings: { firstScreen: "whatMatters" }, rows: new Map([[1, alert(1)], [2, alert(2)]]) });
    await primed(t);
    t.whatMatters.reading = new Set([1, 2]);
    await arrive(t, [1, 2]);
    t.whatMatters.reading.delete(1);
    t.attention.readerLooked(1);
    await t.advance(GATHER_MS);
    // the reader takes too long with the other one: no longer news when it's done
    await t.advance(READING_WAIT_MS);
    t.whatMatters.reading.clear();
    t.whatMatters.counted = new Set([1, 2]);
    const reads = t.reads.length;
    t.attention.readerLooked(2);
    await t.advance(NOTICE_GAP_MS);
    expect(t.notices).toEqual([]);
    expect(t.reads.length).toBe(reads);
  });

  it("the deadline holds through the notice's gap (Codex critique #7)", async () => {
    const t = setup({ settings: { firstScreen: "whatMatters" }, rows: new Map([[1, person(1)], [2, alert(2)], [3, person(3)]]) });
    await primed(t);
    t.whatMatters.counted = new Set([1, 3]);
    t.whatMatters.reading = new Set([2]);
    await arrive(t, [1, 2]);
    expect(t.notices).toHaveLength(1);
    // a notice just before its deadline starts a gap that ends past it
    await t.advance(READING_WAIT_MS - NOTICE_GAP_MS / 2 - 2 * GATHER_MS);
    await arrive(t, [3]);
    expect(t.notices).toHaveLength(2);
    // counted now, before the deadline: but its notice could only come after it
    t.whatMatters.reading.clear();
    t.whatMatters.counted.add(2);
    t.attention.readerLooked(2);
    await t.advance(2 * NOTICE_GAP_MS);
    expect(t.notices).toHaveLength(2);
  });

  it("a look during the verdict isn't lost (Codex critique #3)", async () => {
    const t = setup({ settings: { firstScreen: "whatMatters" }, rows: new Map([[1, alert(1)]]) });
    await primed(t);
    t.whatMatters.reading = new Set([1]);
    let release!: () => void;
    t.whatMatters.hold = new Promise<void>((r) => (release = r));
    const pass = t.attention.beginPass(1);
    pass.add([1]);
    pass.end();
    await t.advance(1);
    expect(t.whatMatters.asked).toEqual([[1]]);
    // the reader finishes it while the verdict (read before: still being read) is on its way, and looks before the wait exists
    t.whatMatters.reading.clear();
    t.whatMatters.counted.add(1);
    t.attention.readerLooked(1);
    t.whatMatters.hold = null;
    release();
    await t.advance(GATHER_MS);
    // judged again, at once
    expect(t.whatMatters.asked).toEqual([[1], [1], [1]]);
    expect(t.notices).toHaveLength(1);
  });

  it("the first screen changed, notifications off, or the account gone: what waits for the reader goes", async () => {
    const t = setup({ settings: { firstScreen: "whatMatters" }, rows: new Map([[1, alert(1)], [2, alert(2)], [3, alert(3)]]) });
    await primed(t);
    t.whatMatters.reading = new Set([1, 2, 3]);
    await arrive(t, [1]);
    t.app.firstScreen = "inbox";
    await t.attention.refresh();
    t.app.firstScreen = "whatMatters";
    await t.attention.refresh();
    await arrive(t, [2]);
    t.attention.forget(1);
    t.attention.prime(1);
    await arrive(t, [3]);
    t.app.notifications = false;
    await t.attention.refresh();
    t.app.notifications = true;
    await t.attention.refresh();
    t.whatMatters.reading.clear();
    t.whatMatters.counted = new Set([1, 2, 3]);
    const reads = t.reads.length;
    for (const id of [1, 2, 3]) t.attention.readerLooked(id);
    await t.advance(NOTICE_GAP_MS);
    expect(t.notices).toEqual([]);
    expect(t.reads.length).toBe(reads);
  });

  it("turned off during the verdict: nothing is said (Codex critique #4)", async () => {
    const t = setup({ settings: { firstScreen: "whatMatters" }, rows: new Map([[1, person(1)]]) });
    await primed(t);
    t.whatMatters.counted = new Set([1]);
    let release!: () => void;
    t.whatMatters.hold = new Promise<void>((r) => (release = r));
    const pass = t.attention.beginPass(1);
    pass.add([1]);
    pass.end();
    await t.advance(1);
    t.app.notifications = false;
    await t.attention.refresh();
    release();
    await t.advance(60_000);
    expect(t.notices).toEqual([]);
  });

  it("the last look judges again: done in What matters (or the Inbox first now) before the notice, nothing", async () => {
    const t = setup({ settings: { firstScreen: "whatMatters" }, rows: new Map([[1, alert(1)]]) });
    await primed(t);
    t.whatMatters.counted = new Set([1]);
    const pass = t.attention.beginPass(1);
    pass.add([1]);
    pass.end();
    await t.advance(1);
    t.whatMatters.counted.clear();
    await t.advance(GATHER_MS);
    expect(t.whatMatters.asked).toEqual([[1], [1]]);
    expect(t.notices).toEqual([]);
  });

  it("idle: a look with nothing waiting reads nothing", async () => {
    const t = setup({ settings: { firstScreen: "whatMatters" } });
    await primed(t);
    t.attention.readerLooked(1);
    await t.advance(60_000);
    expect(t.reads).toEqual([]);
    expect(t.whatMatters.asked).toEqual([]);
  });

  it("mail that waited for What matters never falls back to plan 41's rule: hidden before its notice, nothing (Codex code review #4)", async () => {
    const t = setup({ settings: { firstScreen: "whatMatters" }, rows: new Map([[1, alert(1)], [2, alert(2)]]) });
    await primed(t);
    t.whatMatters.reading = new Set([1]);
    t.whatMatters.counted = new Set([2]);
    await arrive(t, [1, 2]);
    expect(t.notices).toHaveLength(1);
    // counted while the gap holds its notice; then What matters is hidden: Gmail's Important would say it, but it waited
    t.whatMatters.reading.clear();
    t.whatMatters.counted.add(1);
    t.attention.readerLooked(1);
    await t.advance(1);
    t.whatMatters.shown = false;
    await t.advance(NOTICE_GAP_MS);
    expect(t.notices).toHaveLength(1);
  });

  it("the first screen changed during the verdict: judged again by the one that leads (Codex code review #1)", async () => {
    // a bill only What matters would say (plan 41: a stranger, not Important)
    const bill = person(1, { fromName: "Power Co", fromEmail: "billing@power.test", written: false });
    const t = setup({ settings: { firstScreen: "whatMatters" }, rows: new Map([[1, bill]]) });
    await primed(t);
    t.whatMatters.counted = new Set([1]);
    let release!: () => void;
    t.whatMatters.hold = new Promise<void>((r) => (release = r));
    const pass = t.attention.beginPass(1);
    pass.add([1]);
    pass.end();
    await t.advance(1);
    t.app.firstScreen = "inbox";
    await t.attention.refresh();
    t.whatMatters.hold = null;
    release();
    await t.advance(GATHER_MS);
    expect(t.whatMatters.asked).toEqual([[1]]);
    expect(t.notices).toEqual([]);
  });
});
