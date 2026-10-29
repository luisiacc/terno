import { describe, expect, it } from "vitest";
import { openDatabase } from "./index";
import { pageSql } from "./similar";

/** Plan 63: a sweep's later pages seek their cursor in the index; a first page reads from its start. */
describe("similar scope pages", () => {
  const db = openDatabase(":memory:");
  const own = { emails: new Set(["me@x.com"]), domains: new Set(["x.com"]) };
  const plan = (cursor: number | null, scope: Parameters<typeof pageSql>[0]) => {
    const q = pageSql(scope, "spam", own, cursor, 2000);
    return db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${q.sql}`, ...q.params).map((r) => r.detail).join("\n");
  };

  it("a later page is a range of the index (no rescan of what earlier pages read), in index order (no sort)", () => {
    for (const scope of [{ kind: "sender", email: "a@b.com" }, { kind: "subject", email: "a@b.com", subject: "Hi" }, { kind: "domain", domain: "b.com" }, { kind: "list", listId: "l.b.com" }] as const) {
      const later = plan(42, scope);
      expect(later, scope.kind).toMatch(/SEARCH m USING INDEX messages_(from|domain|list) \((from_email|from_domain|list_id)=\? AND rowid>\?\)/);
      expect(later, scope.kind).not.toMatch(/TEMP B-TREE/);
      expect(plan(null, scope), scope.kind).toMatch(/SEARCH m USING INDEX messages_(from|domain|list) \((from_email|from_domain|list_id)=\?\)/);
    }
  });
});
