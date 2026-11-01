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
