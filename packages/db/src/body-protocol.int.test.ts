import { expect, it, vi } from "vitest";
import { openDatabase } from "./index";
import { nodePlatform } from "./node-driver";
import { SqlMailStore } from "./sql-store";
import { msg, withAccounts } from "../../store/src/conformance/fixtures";

for (const operation of ["ingest", "setBody"] as const) it(`publishes exact ${operation} content with the filter definition acknowledged during token preparation`, async () => {
  const db = openDatabase(":memory:");
  let entered!: () => void, release!: () => void;
  const held = new Promise<void>((r) => { entered = r; }), resume = new Promise<void>((r) => { release = r; });
  let armed = false, tokenRead = false;
  const platform = { ...nodePlatform, async yield() { await nodePlatform.yield(); if (armed && tokenRead) { armed = false; entered(); await resume; } } };
  const store = new SqlMailStore(db, { platform, instantSearch: false });
  const get = db.get.bind(db);
  const spy = vi.spyOn(db, "get").mockImplementation((sql, ...args) => { const row = get(sql, ...args); if (sql.includes("SELECT ordinal,value FROM body_parts") && args[1] === 2) tokenRead = true; return row; });
  let pending: Promise<unknown> | undefined;
  try {
    const [accountId] = await withAccounts(store, 1);
    const filter = await store.filters.save({ name: "live definition", enabled: true, source: "manual", rule: { match: "all", conditions: [{ field: "body", op: "contains", value: "alpha" }], actions: [{ type: "star" }] } }, 1);
    const initial = operation === "setBody" ? await store.sync.ingest([msg({ accountId: accountId!, bodyText: "old cached content", bodyState: "partial" })], { now: 1, classifier: null, applyFilters: false }) : undefined;
    const messageId = initial ? (await store.threads.get(initial.touched[0]!))!.messages[0]!.id : undefined;
    const text = "😀 beta exact\r\n".repeat(5000), html = `<p>${text}</p>`;
    tokenRead = false; armed = true;
    pending = messageId === undefined ? store.sync.ingest([msg({ accountId: accountId!, bodyText: text, bodyHtml: html, bodyState: "full" })], { now: 2, classifier: null, applyFilters: true }) : store.sync.setBody(messageId, text, html, { now: 2, classifier: null });
    const outcome = pending.then(() => null, (error: unknown) => error);
    await held;
    await store.filters.save({ ...filter, rule: { ...filter.rule, conditions: [{ field: "body", op: "contains", value: "beta exact" }] } }, 3);
    release();
    expect(await outcome).toBeNull();
    const result = await store.threads.searchText({ query: '"beta exact"', now: 4, limit: 10 });
    expect(result.items).toHaveLength(1);
    const message = (await store.threads.get(result.items[0]!.id))!.messages[0]!;
    expect(message.bodyText === text && message.bodyHtml === html).toBe(true);
    expect(message.isStarred).toBe(true);
  } finally { release(); await Promise.allSettled(pending ? [pending] : []); spy.mockRestore(); await store.close(); }
});

it("reclaims retired bodies after repeated tokenless searches without reopening", async () => {
  const db = openDatabase(":memory:"), store = new SqlMailStore(db, { platform: nodePlatform, instantSearch: false });
  try {
    const [accountId] = await withAccounts(store, 1);
    const result = await store.sync.ingest([msg({ accountId: accountId!, bodyText: "old exact body ".repeat(4000), bodyState: "full" })], { now: 1, classifier: null, applyFilters: false });
    const message = (await store.threads.get(result.touched[0]!))!.messages[0]!;
    for (let cycle = 0; cycle < 3; cycle++) {
      expect((await store.threads.searchText({ query: "😀", now: 2, limit: 10 })).items).toHaveLength(1);
      await store.sync.setBody(message.id, "new exact body ".repeat(4000), null, { now: 3, classifier: null });
      expect(db.get<{ n: number }>("SELECT count(*) n FROM body_captures")!.n).toBe(1);
    }
  } finally { await store.close(); }
});

for (const terminal of ["consume", "abandon", "unstarted", "deferred"] as const) it(`keeps a selected search page exact through replacement and ${terminal}`, async () => {
  const db = openDatabase(":memory:"), store = new SqlMailStore(db, { platform: nodePlatform, instantSearch: false });
  let build: Awaited<ReturnType<typeof store.feed.beginBuild>> | undefined;
  let pages: AsyncIterator<readonly import("@terno/store").SearchMessageDoc[]> | undefined;
  let spy: { mockRestore(): void } | undefined, retired = false, retiredDone!: () => void;
  const retirement = new Promise<void>((r) => { retiredDone = r; });
  try {
    const [accountId] = await withAccounts(store, 1);
    const result = await store.sync.ingest([msg({ accountId: accountId!, bodyText: "old exact phrase ".repeat(5000), bodyState: "full" })], { now: 1, classifier: null, applyFilters: false });
    const message = (await store.threads.get(result.touched[0]!, { bodyFormat: "parts" }))!.messages[0]!;
    build = await store.feed.beginBuild(); pages = build.messages()[Symbol.asyncIterator]();
    const docs = (await pages.next()).value!;
    const run = db.run.bind(db);
    spy = vi.spyOn(db, "run").mockImplementation((statement, ...args) => { const r = run(statement, ...args); if (statement === "DELETE FROM body_captures WHERE id=?" && args[0] === message.bodyReference!.version) { retired = true; retiredDone(); } return r; });
    if (terminal === "deferred") await pages.return?.();
    await store.sync.setBody(message.id, "new complete phrase ".repeat(5000), null, { now: 2, classifier: null });
    expect(retired, "selected page owns its old capture before the first token read").toBe(false);
    if (terminal === "consume" || terminal === "deferred") {
      let tokens = "";
      for await (const part of docs[0]!.bodyTokenParts!()) tokens += part;
      expect(tokens === `\0${"old\0exact\0phrase\0".repeat(5000)}`).toBe(true);
    }
    if (terminal === "unstarted") { const unread = docs[0]!.bodyTokenParts!()[Symbol.asyncIterator](); await unread.return?.(); }
    await pages.return?.(); await build.release();
    await retirement;
    expect((await store.threads.get(result.touched[0]!))!.messages[0]!.bodyText === "new complete phrase ".repeat(5000)).toBe(true);
  } finally { await pages?.return?.(); await build?.release(); spy?.mockRestore(); await store.close(); }
});

it("releases selected projections when a yielded incremental feed fails before returning its batch", async () => {
  const db = openDatabase(":memory:");
  let fail = false;
  const platform = { ...nodePlatform, async yield() { await nodePlatform.yield(); if (fail) { fail = false; throw new Error("Synthetic projection interruption"); } } };
  const store = new SqlMailStore(db, { platform, instantSearch: false });
  try {
    const [accountId] = await withAccounts(store, 1), before = await store.feed.head();
    const result = await store.sync.ingest(Array.from({ length: 501 }, (_, i) => msg({ accountId: accountId!, bodyText: i === 0 ? "old exact phrase ".repeat(5000) : "small body", bodyState: "full" })), { now: 1, classifier: null, applyFilters: false });
    const message = (await store.threads.get(result.touched[0]!))!.messages[0]!;
    const after = await store.feed.head();
    fail = true;
    await expect(store.feed.changes(before, after, 16)).rejects.toThrow("Synthetic projection interruption");
    await store.sync.setBody(message.id, "new exact phrase ".repeat(5000), null, { now: 2, classifier: null });
    expect(db.get<{ n: number }>("SELECT count(*) n FROM body_captures")!.n).toBe(1);
  } finally { await store.close(); }
});
