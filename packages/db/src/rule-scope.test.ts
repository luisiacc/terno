import type { Condition, FilterRule } from "@terno/core";
import { describe, expect, it, vi } from "vitest";
import { ingestMessages } from "./ingest";
import { findRuleMatches } from "./rules";
import { msg, testDb, withAccounts } from "./test/helpers";
import { populateRuleScope } from "./test/rule-scope";

const rule = (conditions: Condition[], match: "all" | "any" = "all"): FilterRule => ({ match, conditions, actions: [{ type: "star" }] });

describe("incoming rule candidate scopes", () => {
  it("probes exact incoming rowids on 50k actual threads, including sparse repairs", () => {
    const db = testDb();
    const [accountId] = withAccounts(db, 1);
    populateRuleScope(db, accountId!);
    expect(db.get("SELECT count(*) count FROM threads")).toEqual({ count: 50000 });
    for (const ids of [[49981, 49970, 49970, 49980], [50000, 1, 27000], [49999]]) {
      for (const candidate of [rule([{ field: "body", op: "contains", value: "shared budget" }]), rule([{ field: "body", op: "contains", value: "missing", negate: true }, { field: "subject", op: "equals", value: "missing" }], "any")]) {
        const reads = vi.spyOn(db, "all");
        const result = findRuleMatches(db, candidate, 0, ids);
        const query = reads.mock.calls.find(([sql]) => sql.startsWith("SELECT m.id, m.thread_id"));
        reads.mockRestore();
        expect(result.messageIds.toSorted((a, b) => a - b)).toEqual([...new Set(ids)].sort((a, b) => a - b));
        expect(query).toBeDefined();
        const plan = db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${query![0]}`, ...query!.slice(1));
        const fts = plan.filter((row) => row.detail.includes("messages_fts"));
        expect(fts).toHaveLength(1);
        expect(fts[0]!.detail, "Each candidate must probe its FTS rowid, including widely separated repair IDs").toMatch(/INDEX .*=/);
        expect(plan.some((row) => /SEARCH m USING INTEGER PRIMARY KEY/.test(row.detail))).toBe(true);
      }
    }
  });

  it("preserves exact sparse ID, range, completeness and predicate semantics", () => {
    const db = testDb();
    const [accountId] = withAccounts(db, 1);
    const ids = ingestMessages(db, [
      msg({ accountId: accountId!, bodyText: "budget final", subject: "Selected", providerThreadId: "same" }),
      msg({ accountId: accountId!, bodyText: "other budget final", subject: "Other" }),
      msg({ accountId: accountId!, bodyText: "other", subject: "Selected" }),
      msg({ accountId: accountId!, bodyText: "budget final", bodyState: "partial", subject: "Selected" }),
      msg({ accountId: accountId!, bodyText: "budget final", isTrash: true, subject: "Selected" }),
      msg({ accountId: accountId!, bodyText: "budget final", subject: "Selected", providerThreadId: "same" }),
    ]).inserted;
    const selected = [ids[5]!, ids[0]!, ids[5]!, ids[3]!, ids[4]!, 900000];
    const conditions: Condition[] = [
      { field: "body", op: "contains", value: "budget" },
      { field: "body", op: "startsWith", value: "budget" },
      { field: "body", op: "equals", value: "budget final" },
      { field: "body", op: "endsWith", value: "final" },
      { field: "body", op: "contains", value: "missing", negate: true },
    ];
    for (const body of conditions) {
      for (const candidate of [rule([body]), rule([body, { field: "subject", op: "equals", value: "selected" }], "any")]) {
        const all = findRuleMatches(db, candidate, 0);
        for (const range of [undefined, { from: ids[1]!, to: ids[5]! }, { from: ids[1]!, to: ids[2]! }, { from: ids[5]! + 1, to: ids[5]! + 10 }]) {
          const expected = all.messageIds.filter((id) => selected.includes(id) && (!range || (id >= range.from && id <= range.to)));
          const actual = findRuleMatches(db, candidate, 0, selected, range);
          expect(actual.messageIds.toSorted()).toEqual(expected.toSorted());
          const threads = db.all<{ thread_id: number }>("SELECT DISTINCT thread_id FROM messages WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(expected)).map((row) => row.thread_id);
          expect(actual.threadIds.toSorted()).toEqual(threads.toSorted());
        }
      }
    }
    const noReads = vi.spyOn(db, "all");
    expect(findRuleMatches(db, rule([conditions[0]!]), 0, [])).toEqual({ messageIds: [], threadIds: [] });
    expect(findRuleMatches(db, rule([conditions[0]!]), 0, selected, { from: 10, to: 1 })).toEqual({ messageIds: [], threadIds: [] });
    expect(noReads).not.toHaveBeenCalled();
    noReads.mockRestore();
  });

  it("retains long-suffix verification and reusable SQL across changing scopes", () => {
    const db = testDb();
    const [accountId] = withAccounts(db, 1);
    const suffix = Array.from({ length: 33 }, (_, index) => `word${index}`).join(" ");
    const ids = ingestMessages(db, [
      msg({ accountId: accountId!, bodyText: `start ${suffix}` }),
      msg({ accountId: accountId!, bodyText: `start ${suffix} extra` }),
      msg({ accountId: accountId!, bodyText: suffix }),
    ]).inserted;
    for (const length of [32, 33]) {
      const value = suffix.split(" ").slice(-length).join(" ");
      const ends = rule([{ field: "body", op: "endsWith", value }, { field: "body", op: "contains", value: "word20" }]);
      expect(findRuleMatches(db, ends, 0, ids).messageIds.toSorted()).toEqual([ids[0], ids[2]].toSorted());
    }
    const equals = rule([{ field: "body", op: "equals", value: suffix }]);
    expect(findRuleMatches(db, equals, 0, ids).messageIds).toEqual([ids[2]]);
    const reads = vi.spyOn(db, "all");
    for (const id of ids) findRuleMatches(db, equals, 0, [id]);
    const sql = reads.mock.calls.map(([query]) => query);
    reads.mockRestore();
    expect(new Set(sql).size).toBe(1);
  });
});
