import "fake-indexeddb/auto";
import type { FolderCountCursor, FolderExportCursor, Platform } from "@terno/store";
import { afterEach, beforeEach, expect, it } from "vitest";
import { exportIds } from "./folder-export";
import { countFolderMessages, countWalks } from "./folders";
import { T, type Ctx } from "./mail";
import { IdbMailStore } from "./store";

/**
 * Plan 107, Codex code review round 12 #1: a live walk of an index kept between slices meets a row again when it's
 * updated after the walk passed it (an update moves its key to the end of the index). Exports and counts take it once.
 */
const platform: Pick<Platform, "uuid" | "yield"> = { uuid: () => crypto.randomUUID(), yield: () => new Promise((r) => setTimeout(r, 0)) };
type Tables = Ctx & { db: { tx<T>(fn: () => T): T; table(name: string): { put(row: Record<string, unknown>): unknown; get(...k: unknown[]): Record<string, unknown> | undefined } } };
let store: IdbMailStore;
let c: Tables;
let account: number;

beforeEach(async () => {
  store = await IdbMailStore.open({ name: `walks-${crypto.randomUUID()}`, factory: indexedDB, platform, instantSearch: false });
  c = (store as unknown as { c: Tables }).c;
  account = (await store.accounts.create({ kind: "imap", email: "w@example.com", displayName: "W", color: "indigo", now: 0 })).account.id;
});
afterEach(async () => {
  await store.close();
});

const message = (id: number, thread: number, extra: Record<string, unknown> = {}) => ({ id, account_id: account, thread_id: thread, provider_msg_id: `w-${id}`, date: id, is_draft: 0, is_trash: 0, is_spam: 0, is_read: 0, gmail_labels: '["Label_w"]', ...extra });

it("an export of a conversation longer than a run takes a message updated between its runs once", () => {
  // longer than a run (16,384 ids a call): its order is read over two calls, the first message updated between them
  const N = 17_000;
  const thread = 1;
  c.db.tx(() => {
    c.db.table("threads").put({ id: thread, account_id: account, last_date: 0, message_count: N, unread_count: 0 });
    c.db.table("thread_folders").put({ thread_id: thread, account_id: account, folder: "Label_w", last_date: 0, unread: 0 });
    for (let i = 1; i <= N; i++) c.db.table("messages").put(message(i, thread));
  });
  const ids: number[] = [];
  let updated = false;
  for (let after: FolderExportCursor | null = null; ; ) {
    const r = exportIds(c, { accountId: account, folder: "Label_w" }, after, 2000);
    ids.push(...r.messages.map((m) => m.id));
    if (!r.next) break;
    after = r.next;
    // read the first run: the first message, already walked, is marked read
    if (!updated) { updated = true; c.db.tx(() => c.db.table("messages").put({ ...c.db.table("messages").get(1)!, is_read: 1 })); }
  }
  expect(ids.slice(0, 3)).toEqual([1, 2, 3]);
  expect(ids.length).toBe(N);
  expect(new Set(ids).size).toBe(N);
});

it("a count of a conversation longer than a run counts a message updated between its runs once", () => {
  const N = 17_000;
  const thread = 1;
  c.db.tx(() => {
    c.db.table("threads").put({ id: thread, account_id: account, last_date: 0, message_count: N, unread_count: 0 });
    c.db.table("thread_folders").put({ thread_id: thread, account_id: account, folder: "Label_w", last_date: 0, unread: 0 });
    for (let i = 1; i <= N; i++) c.db.table("messages").put(message(i, thread));
  });
  let counted = 0;
  let updated = false;
  for (let at: FolderCountCursor | null = null; ; ) {
    const r = countFolderMessages(c, account, ["Label_w"], at, 2000);
    counted += r.messages;
    if (!r.next) break;
    at = r.next;
    if (!updated) { updated = true; c.db.tx(() => c.db.table("messages").put({ ...c.db.table("messages").get(1)!, is_read: 1 })); }
  }
  expect(counted).toBe(N);
});

it("a count of a mailbox's places in one-place slices counts a place updated after it was walked once", () => {
  c.db.tx(() => {
    c.db.table("folders").put({ account_id: account, key: "Work", path_json: '["Work"]', selectable: 1, position: 0 });
    for (let i = 1; i <= 3; i++) {
      c.db.table("threads").put({ id: i, account_id: account, last_date: i, message_count: 1, unread_count: 0 });
      c.db.table("messages").put(message(i, i, { gmail_labels: null }));
      c.db.table("message_locations").put({ message_id: i, account_id: account, mailbox: "Work", uidvalidity: 1, uid: i, flags: "[]" });
    }
  });
  let counted = 0;
  let slices = 0;
  for (let at: FolderCountCursor | null = null; ; ) {
    const r = countFolderMessages(c, account, ["Work"], at, 1);
    counted += r.messages;
    slices++;
    if (!r.next) break;
    at = r.next;
    // the first place, counted in the first slice, gets a flag
    if (slices === 1) c.db.tx(() => c.db.table("message_locations").put({ ...c.db.table("message_locations").get(1, "Work")!, flags: '["\\\\Seen"]' }));
  }
  expect(counted).toBe(3);
});

it("an export of a folder whose members are read over runs takes a thread updated between its runs once (already so: audit)", () => {
  const N = 17_000;
  c.db.tx(() => {
    for (let i = 1; i <= N; i++) {
      c.db.table("threads").put({ id: i, account_id: account, last_date: i, message_count: 1, unread_count: 0 });
      c.db.table("thread_folders").put({ thread_id: i, account_id: account, folder: "Label_w", last_date: i, unread: 0 });
      c.db.table("messages").put(message(i, i));
    }
  });
  const ids: number[] = [];
  let updated = false;
  for (let after: FolderExportCursor | null = null; ; ) {
    const r = exportIds(c, { accountId: account, folder: "Label_w" }, after, 2000);
    ids.push(...r.messages.map((m) => m.id));
    if (!r.next) break;
    after = r.next;
    // the first thread's membership row, already walked, turns unread
    if (!updated) { updated = true; c.db.tx(() => c.db.table("thread_folders").put({ ...c.db.table("thread_folders").get(1, "Label_w")!, unread: 1 })); }
  }
  expect(ids.length).toBe(N);
  expect(new Set(ids).size).toBe(N);
});

it("two counts of one mailbox interleaved each walk their own places, every slice within its limit; a walk lost is found again a slice at a time (Codex code review round 17 #3)", () => {
  const N = 5000;
  c.db.tx(() => {
    c.db.table("folders").put({ account_id: account, key: "Work", path_json: '["Work"]', selectable: 1, position: 0 });
    for (let i = 1; i <= N; i++) {
      c.db.table("threads").put({ id: i, account_id: account, last_date: i, message_count: 1, unread_count: 0 });
      c.db.table("messages").put(message(i, i, { gmail_labels: null }));
      c.db.table("message_locations").put({ message_id: i, account_id: account, mailbox: "Work", uidvalidity: 1, uid: i, flags: "[]" });
    }
  });
  // the places a slice walks
  const locations = T(c, "message_locations");
  const keysBy = locations.keysBy.bind(locations);
  let visits = 0;
  locations.keysBy = (...a: Parameters<typeof keysBy>) => {
    const keys = keysBy(...a);
    return { next: () => { visits++; return keys.next(); }, [Symbol.iterator]() { return this; } } as ReturnType<typeof keysBy>;
  };
  const LIMIT = 500;
  const slice = (at: FolderCountCursor | null) => {
    visits = 0;
    const r = countFolderMessages(c, account, ["Work"], at, LIMIT);
    expect(visits).toBeLessThanOrEqual(LIMIT + 1);
    return r;
  };
  try {
    // two windows counting the same mailbox, a slice each in turn
    const counts = [{ at: null as FolderCountCursor | null, messages: 0, done: false }, { at: null as FolderCountCursor | null, messages: 0, done: false }];
    for (let turn = 0; counts.some((x) => !x.done); turn++) {
      const x = counts[turn % 2]!;
      if (x.done) continue;
      const r = slice(x.at);
      x.messages += r.messages;
      if (r.next) x.at = r.next;
      else x.done = true;
    }
    expect(counts.map((x) => x.messages)).toEqual([N, N]);
    // a count whose walk was let go (the store reopened): what it had counted is passed again a slice at a time
    let messages = 0;
    let at: FolderCountCursor | null = null;
    for (let i = 0; i < 4; i++) {
      const r = slice(at);
      messages += r.messages;
      at = r.next;
    }
    (countWalks as WeakMap<Ctx, Map<string, unknown>>).get(c)?.clear();
    for (let slices = 0; at; slices++) {
      const r = slice(at);
      messages += r.messages;
      at = r.next;
      expect(slices).toBeLessThan(30);
    }
    expect(messages).toBe(N);
  } finally {
    locations.keysBy = keysBy;
  }
});

/** exports interleaved a call each, round robin: the messages each took, and how many calls it took them all */
function interleave(targets: { accountId: number; folder?: string; view?: "inbox" }[], limit: number, max: number): { ids: number[][]; calls: number } {
  const xs = targets.map(() => ({ after: null as FolderExportCursor | null, ids: [] as number[], done: false }));
  let calls = 0;
  for (let turn = 0; xs.some((x) => !x.done) && calls < max; turn++) {
    const i = turn % xs.length;
    const x = xs[i]!;
    if (x.done) continue;
    const t = targets[i]!;
    const r = exportIds(c, t.folder !== undefined ? { accountId: t.accountId, folder: t.folder } : { accountId: t.accountId, view: "inbox" }, x.after, limit);
    calls++;
    x.ids.push(...r.messages.map((m) => m.id));
    if (r.next) x.after = r.next;
    else x.done = true;
  }
  return { ids: xs.map((x) => x.ids), calls };
}

it("five exports of accounts' inboxes longer than a run, interleaved, all finish (Codex code review round 18 #2)", async () => {
  // more threads than a run (16,384 a call) in each of five accounts: each export's walk of them is its own
  const N = 16_500;
  const accounts = [account];
  for (let i = 1; i < 5; i++) accounts.push((await store.accounts.create({ kind: "imap", email: `w${i}@example.com`, displayName: "W", color: "indigo", now: 0 })).account.id);
  c.db.tx(() => {
    let id = 0;
    for (const a of accounts)
      for (let i = 0; i < N; i++) {
        id++;
        c.db.table("threads").put({ id, account_id: a, last_date: id, message_count: 1, unread_count: 0, in_inbox: 1 });
        c.db.table("messages").put({ ...message(id, id), account_id: a, in_inbox: 1, gmail_labels: null });
      }
  });
  const { ids, calls } = interleave(accounts.map((accountId) => ({ accountId, view: "inbox" })), 4000, 200);
  expect(ids.map((x) => x.length)).toEqual(accounts.map(() => N));
  expect(calls).toBeLessThan(200);
});

it("five exports of conversations longer than a run, interleaved, all finish (Codex code review round 18 #2)", async () => {
  // one conversation longer than a run in each of five accounts: each long thread's order is kept while it's read
  const N = 16_500;
  const accounts = [account];
  for (let i = 1; i < 5; i++) accounts.push((await store.accounts.create({ kind: "imap", email: `w${i}@example.com`, displayName: "W", color: "indigo", now: 0 })).account.id);
  c.db.tx(() => {
    let id = 0;
    accounts.forEach((a, t) => {
      const thread = t + 1;
      c.db.table("threads").put({ id: thread, account_id: a, last_date: 0, message_count: N, unread_count: 0 });
      c.db.table("thread_folders").put({ thread_id: thread, account_id: a, folder: "Label_w", last_date: 0, unread: 0 });
      for (let i = 0; i < N; i++) c.db.table("messages").put({ ...message(++id, thread), account_id: a });
    });
  });
  const { ids, calls } = interleave(accounts.map((accountId) => ({ accountId, folder: "Label_w" })), 4000, 200);
  expect(ids.map((x) => new Set(x).size)).toEqual(accounts.map(() => N));
  expect(calls).toBeLessThan(200);
});
