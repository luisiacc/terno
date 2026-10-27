import type { FilterRule } from "@terno/core";
import { expect, it } from "vitest";
import { findRuleMatches } from "./rules";
import { testDb, withAccounts } from "./test/helpers";
import { populateRuleScope } from "./test/rule-scope";
import { threadCpuMs } from "./test/timing";

it("bounds populated incoming body-rule work for compact and sparse repair batches", async () => {
  const db = testDb();
  const [accountId] = withAccounts(db, 1);
  populateRuleScope(db, accountId!);
  expect(db.get("SELECT count(*) count FROM threads")).toEqual({ count: 50000 });
  const rule: FilterRule = { match: "all", conditions: [{ field: "body", op: "contains", value: "shared budget" }], actions: [{ type: "star" }] };
  let maximum = 0;
  for (let sample = 0; sample < 30; sample++) {
    for (const ids of [[sample + 1], Array.from({ length: 50 }, (_, index) => 40000 + sample * 50 + index), Array.from({ length: 50 }, (_, index) => 1 + index * 1000 + sample)]) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const started = threadCpuMs();
      const result = findRuleMatches(db, rule, 0, ids);
      maximum = Math.max(maximum, threadCpuMs() - started);
      expect(result.messageIds.toSorted((a, b) => a - b)).toEqual(ids);
    }
  }
  expect(maximum, `50k-thread incoming rule maximum CPU ${maximum.toFixed(2)}ms`).toBeLessThanOrEqual(15);
});
