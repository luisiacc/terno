import { expect, it, vi } from "vitest";
import { openDatabase } from "./index";
import { nodePlatform } from "./node-driver";
import { SqlMailStore } from "./sql-store";
import { msg, withAccounts } from "../../store/src/conformance/fixtures";

function gate() {
  let release!: () => void;
  return { promise: new Promise<void>((resolve) => { release = resolve; }), get release() { return release; } };
}

for (const consumer of ["search", "filter", "category"] as const) it(`fences a yielded captured ${consumer} predicate through current committed consumption`, async () => {
  const entered = gate(), release = gate(), db = openDatabase(":memory:");
  let armed = false, sourceRead = false;
  const platform = { ...nodePlatform, async yield() { await nodePlatform.yield(); if (armed && sourceRead) { armed = false; entered.release(); await release.promise; } } };
  const store = new SqlMailStore(db, { platform, instantSearch: false });
  let pending: Promise<unknown> | undefined;
  const get = db.get.bind(db);
  const spy = vi.spyOn(db, "get").mockImplementation((sql, ...params) => { const result = get(sql, ...params); if (sql === "SELECT text_parts,html_parts,token_parts,ready FROM body_captures WHERE id=?") sourceRead = true; return result; });
  try {
    const [accountId] = await withAccounts(store, 1);
    const inserted = await store.sync.ingest([msg({ accountId: accountId!, bodyText: "old exact phrase ".repeat(5000), bodyState: "full" })], { now: 1, classifier: null, applyFilters: false });
    const id = inserted.touched[0]!, message = (await store.threads.get(id, { bodyFormat: "parts" }))!.messages[0]!;
    const category = await store.categories.create("synthetic", "brown"), rule = { match: "all" as const, conditions: [{ field: "body" as const, op: "contains" as const, value: "new exact phrase" }], actions: [{ type: "star" as const }] };
    const consume = async (): Promise<number[]> => consumer === "search" ? (await store.threads.searchText({ query: '"new exact phrase"', now: 2, limit: 10 })).items.map((t) => t.id) : consumer === "filter" ? (await store.filters.preview(rule, 2, 10)).sample.map((t) => t.id) : store.categorize.resolveScope(category.id, { kind: "query", query: '"new exact phrase"' }, 2, 10);
    sourceRead = false; armed = true;
    pending = consume(); const outcome = pending.then((ids) => ({ ids }), (error: unknown) => ({ error }));
    await entered.promise;
    const text = "😀 new exact phrase\r\n".repeat(5000);
    await store.sync.setBody(message.id, text, `<p>${text}</p>`, { now: 2, classifier: null });
    release.release();
    const result = await outcome;
    if ("error" in result) expect(result.error).toMatchObject({ code: "STALE", details: { reason: "revision" } });
    else expect(result.ids).toEqual([id]);
    // Existing explicit stale contract: a fresh request prepares the now-committed capture.
    expect(await consume()).toEqual([id]);
    const current = (await store.threads.get(id))!.messages[0]!;
    expect(current.bodyText === text && current.bodyHtml === `<p>${text}</p>`).toBe(true); expect(current.isStarred).toBe(false);
    expect((await store.threads.list({ view: "inbox", categoryId: category.id, limit: 10 })).items).toEqual([]);
  } finally { release.release(); await Promise.allSettled(pending ? [pending] : []); spy.mockRestore(); await store.close(); }
});
