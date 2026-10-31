/** Codex review of plans 90/86: SimilarFilters' journal under failures, races and reuse. */
import { categoryRule, type Filter, type FilterSave, type FilterState } from "@terno/core";
import { RpcError } from "@terno/core/rpc";
import { describe, expect, it } from "vitest";
import { SimilarFilters } from "./similar";

/** An in-memory filters store, with hooks to fail or race a write. */
function fakeStore() {
  const rows = new Map<number, Filter>();
  let id = 0;
  const hooks = { beforeSave: null as null | ((f: FilterSave) => void), beforeDelete: null as null | ((id: number) => void) };
  const same = (a: Filter, b: FilterState) => a.name === b.name && a.enabled === b.enabled && a.auto === b.auto && JSON.stringify(a.rule) === JSON.stringify(b.rule);
  const filters = {
    list: async () => [...rows.values()],
    get: async (i: number) => rows.get(i) ?? null,
    save: async (f: FilterSave) => {
      hooks.beforeSave?.(f);
      const prev = f.id === undefined ? undefined : rows.get(f.id);
      if (f.expect && (!prev || !same(prev, f.expect))) throw new RpcError("CANCELLED", "changed");
      const next: Filter = { id: f.id ?? ++id, name: f.name, enabled: f.enabled, source: f.source, auto: f.auto ?? prev?.auto ?? false, rule: f.rule, hits: 0, createdAt: 0 };
      rows.set(next.id, next);
      return next;
    },
    delete: async (i: number, expect?: FilterState) => {
      hooks.beforeDelete?.(i);
      const cur = rows.get(i);
      if (expect && cur && !same(cur, expect)) throw new RpcError("CANCELLED", "changed");
      rows.delete(i);
    },
  };
  return { store: { filters } as never, rows, hooks };
}

const sender = (cat: number) => categoryRule({ kind: "sender", email: "a@shop.com" }, cat);
const subject = (cat: number) => categoryRule({ kind: "subject", email: "a@shop.com", subject: "Order 1" }, cat);

describe("SimilarFilters (Codex review)", () => {
  it("a failure after a committed write still returns the undo of what committed", async () => {
    const { store, rows, hooks } = fakeStore();
    const f = new SimilarFilters(store, () => 0);
    await f.ensureRule(subject(2), "sub");
    // the sender filter is made; turning off the subject one then fails for real
    hooks.beforeSave = (s) => {
      if (s.id !== undefined) throw new Error("disk full");
    };
    const error = await f.ensureRule(sender(1), "all").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    const filterUndo = (error as RpcError).details as { filterUndo: number };
    expect(rows.size).toBe(2);
    hooks.beforeSave = null;
    await f.undo(filterUndo.filterUndo);
    expect([...rows.values()].map((r) => r.name)).toEqual(["sub"]);
  });

  it("undo never deletes a filter the user edited between its read and the delete", async () => {
    const { store, rows, hooks } = fakeStore();
    const f = new SimilarFilters(store, () => 0);
    const made = await f.ensureRule(sender(1), "all");
    hooks.beforeDelete = (i) => rows.set(i, { ...rows.get(i)!, name: "Mine", auto: false });
    await f.undo(made.filterUndo!);
    expect([...rows.values()].map((r) => [r.name, r.auto])).toEqual([["Mine", false]]);
  });

  it("reusing an enabled sender filter still turns off their subject filter filing elsewhere", async () => {
    const { store, rows } = fakeStore();
    const f = new SimilarFilters(store, () => 0);
    await f.ensureRule(sender(1), "all");
    const sub = await f.ensureRule(subject(2), "sub");
    const again = await f.ensureRule(sender(1), "all");
    expect(again.filterUndo).not.toBeNull();
    expect(rows.get(sub.filter.id)!.enabled).toBe(false);
  });
});
