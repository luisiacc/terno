import { expect, it } from "vitest";
import type { SqlValue } from "./connection";
import { closedDatedPage } from "./dated";
import { closedFollowupPage } from "./followups";
import { testDb } from "./test/helpers";

// plan 210 (Codex code review): a deep page of the history seeks its index to the key, never walking the newer closings
// again. The plan, not its speed (the 50k gate times it)
it("pages seek the closing-time index from the key", () => {
  const db = testDb();
  const plans: string[] = [];
  const all = db.all.bind(db);
  (db as { all: typeof db.all }).all = ((sql: string, ...params: SqlValue[]) => {
    if (/closed_at, id\) </.test(sql)) plans.push(all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params).map((r) => r.detail).join("\n"));
    return all(sql, ...params);
  }) as typeof db.all;
  closedDatedPage(db, { since: 0, after: { at: 5_000, id: 7 }, limit: 10 });
  closedFollowupPage(db, { since: 0, after: { at: 5_000, id: 7 }, limit: 10 });
  expect(plans).toHaveLength(2);
  expect(plans[0]).toMatch(/SEARCH dated_items USING INDEX dated_closed \(.*<\?/);
  expect(plans[1]).toMatch(/SEARCH followups USING INDEX followups_closed \(.*<\?/);
  expect(plans.join("\n")).not.toMatch(/TEMP B-TREE/);
});
