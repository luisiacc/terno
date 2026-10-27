import type { ArrivalRow, Counts, MailNotice } from "@terno/core";
import { describe, expect, it } from "vitest";
import { Attention, GATHER_MS, MAX_PENDING, NOTICE_GAP_MS, READ_CHUNK } from "./attention";

const NOW = Date.UTC(2026, 9, 26, 12);
const counts = (inboxUnread: number): Counts => ({ inboxUnread, inboxUnreadByAccount: {}, categoryUnread: {}, categoryTotal: {}, categorySuggestions: {} });

function person(id: number, o: Partial<ArrivalRow> = {}): ArrivalRow {
  return {
    id, threadId: 100 + id, accountId: 1, date: NOW - 1000, fromName: `Person ${id}`, fromEmail: `p${id}@example.com`, subject: `Subject ${id}`, snippet: `Snippet ${id}`,
    isRead: false, isSent: false, isDraft: false, inInbox: true, isTrash: false, isSpam: false, listId: null, isBulk: false, gmailLabels: null, own: false, written: true, yourConversation: false,
    ...o,
  };
}

/** A fake clock and timers, a fake store answering from `rows`, and the host's calls. */
function setup(o: { settings?: Record<string, unknown>; host?: boolean; rows?: Map<number, ArrivalRow> } = {}) {
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
  let published = 0;
  const attention = new Attention({
    store: {
      settings: { get: async (key: string, dflt: unknown) => (key === "app" ? app : dflt) },
      secrets: {},
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
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > until) break;
      timers.shift();
      now = next.at;
      next.fn();
      for (let i = 0; i < 20; i++) await Promise.resolve();
    }
    now = until;
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  return {
    attention, app, rows, reads, badges, notices, emitted, advance,
    timers: () => timers.length,
    published: () => published,
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
    expect(t.notices).toEqual([]);
    await t.advance(1);
    expect(t.reads).toEqual([[2, 1]]);
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
    expect(t.reads.flat()).toHaveLength(MAX_PENDING);
    expect(Math.min(...t.reads.flat())).toBe(501);
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
    await t.advance(GATHER_MS);
    expect(t.reads).toHaveLength(1);
    t.app.notifications = false;
    await t.attention.refresh();
    release();
    await t.advance(1);
    expect(t.notices).toEqual([]);
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
    expect(t.timers()).toBe(1);
    t.attention.stop();
    expect(t.timers()).toBe(0);
    await t.advance(60_000);
    expect(t.reads).toEqual([]);
  });
});
