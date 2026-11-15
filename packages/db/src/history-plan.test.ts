import { expect, it } from "vitest";
import type { SqlValue } from "./connection";
import { closedDatedPage, newestClosedDated } from "./dated";
import { closedFollowupPage, newestClosedFollowup } from "./followups";
import { testDb } from "./test/helpers";

// plan 210 (Codex code review): a deep page of the history seeks its index to the key, never walking the newer closings
// again; a conversation's newest closing is one seek, never its every row. The plan, not its speed (the 50k gate times it)
it("pages seek the closing-time index from the key, and a thread's newest closing is one seek of its thread's index", () => {
  const db = testDb();
  const plans: string[] = [];
  const explain = (sql: string, params: SqlValue[]) => plans.push(all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params).map((r) => r.detail).join("\n"));
  const all = db.all.bind(db);
  const get = db.get.bind(db);
  (db as { all: typeof db.all }).all = ((sql: string, ...params: SqlValue[]) => {
    if (/closed_at, id\) </.test(sql)) explain(sql, params);
    return all(sql, ...params);
  }) as typeof db.all;
  (db as { get: typeof db.get }).get = ((sql: string, ...params: SqlValue[]) => {
    if (/closed_thread/.test(sql)) explain(sql, params);
    return get(sql, ...params);
  }) as typeof db.get;
  closedDatedPage(db, { since: 0, after: { at: 5_000, id: 7 }, limit: 10 });
  closedFollowupPage(db, { since: 0, after: { at: 5_000, id: 7 }, limit: 10 });
  newestClosedDated(db, [3], 0);
  newestClosedFollowup(db, [3], 0);
  expect(plans).toHaveLength(4);
  expect(plans[0]).toMatch(/SEARCH dated_items USING INDEX dated_closed \(.*<\?/);
  expect(plans[1]).toMatch(/SEARCH followups USING INDEX followups_closed \(.*<\?/);
  expect(plans[2]).toMatch(/SEARCH dated_items USING INDEX dated_closed_thread \(thread_id=\?/);
  expect(plans[3]).toMatch(/SEARCH followups USING INDEX followups_closed_thread \(thread_id=\?/);
  expect(plans.join("\n")).not.toMatch(/TEMP B-TREE/);
});
