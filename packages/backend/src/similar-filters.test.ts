/** Codex review of plans 90/86: SimilarFilters' journal under failures, races and reuse. */
import { categoryRule, folderRule, type Filter, type FilterSave, type FilterState } from "@terno/core";
import { RpcError } from "@terno/core/rpc";
import { describe, expect, it } from "vitest";
import { followFolderFilters, SimilarFilters } from "./similar";

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

describe("filters that move mail to a folder (plan 128)", () => {
  const SENDER = { kind: "sender", email: "a@shop.com" } as const;
  const SUBJECT = { kind: "subject", email: "a@shop.com", subject: "Order 1" } as const;

  it("the same mail to another folder retargets, and Undo puts it back; a user's own isn't touched", async () => {
    const { store, rows } = fakeStore();
    const f = new SimilarFilters(store, () => 0);
    const a = await f.ensureRule(folderRule(SENDER, 3, "A"), "to A");
    const b = await f.ensureRule(folderRule(SENDER, 3, "B"), "to B");
    expect(b.filter.id).toBe(a.filter.id);
    expect(b.retargetedFolder).toEqual({ from: "A" });
    expect(b.retargeted).toBeNull();
    await f.undo(b.filterUndo!);
    expect(rows.get(a.filter.id)!.rule.actions).toEqual([{ type: "moveToFolder", accountId: 3, folder: "A" }]);
    rows.set(a.filter.id, { ...rows.get(a.filter.id)!, auto: false });
    const again = await f.ensureRule(folderRule(SENDER, 3, "B"), "to B");
    expect(again.filter.id).not.toBe(a.filter.id);
    expect(again.retargetedFolder).toBeNull();
  });

  it("another account's rule for the same sender is its own filter", async () => {
    const { store, rows } = fakeStore();
    const f = new SimilarFilters(store, () => 0);
    await f.ensureRule(folderRule(SENDER, 3, "A"), "here");
    const other = await f.ensureRule(folderRule(SENDER, 4, "A"), "there");
    expect(other.retargetedFolder).toBeNull();
    expect(rows.size).toBe(2);
  });

  it("a category's filter and a folder's for the same mail both stand: mail can be in both", async () => {
    const { store, rows } = fakeStore();
    const f = new SimilarFilters(store, () => 0);
    await f.ensureRule(sender(1), "category");
    const folder = await f.ensureRule(folderRule(SENDER, 3, "A"), "folder");
    expect(folder.retargeted).toBeNull();
    expect([...rows.values()].every((r) => r.enabled)).toBe(true);
    expect(rows.size).toBe(2);
  });

  it("everything from a sender turns off their subject filter to another folder: same account, same kind only", async () => {
    const { store, rows } = fakeStore();
    const f = new SimilarFilters(store, () => 0);
    const here = await f.ensureRule(folderRule(SUBJECT, 3, "B"), "subject here");
    const there = await f.ensureRule(folderRule(SUBJECT, 4, "B"), "subject there");
    const category = await f.ensureRule(subject(2), "subject category");
    await f.ensureRule(folderRule(SENDER, 3, "A"), "sender");
    expect(rows.get(here.filter.id)!.enabled).toBe(false);
    expect(rows.get(there.filter.id)!.enabled).toBe(true);
    expect(rows.get(category.filter.id)!.enabled).toBe(true);
  });

  describe("following the folder", () => {
    const warn = () => undefined;
    const made = async () => {
      const t = fakeStore();
      const f = await new SimilarFilters(t.store, () => 0).ensureRule(folderRule(SENDER, 3, "A"), "to A");
      return { ...t, id: f.filter.id };
    };

    it("a new name is the same folder; another account's isn't", async () => {
      const { store, rows, id } = await made();
      await followFolderFilters(store, 4, { renamed: [{ from: "A", to: "Z" }] }, 0, warn);
      expect(rows.get(id)!.rule.actions).toEqual([{ type: "moveToFolder", accountId: 3, folder: "A" }]);
      await followFolderFilters(store, 3, { renamed: [{ from: "A", to: "Z" }] }, 0, warn);
      expect(rows.get(id)!.rule.actions).toEqual([{ type: "moveToFolder", accountId: 3, folder: "Z" }]);
      expect(rows.get(id)!.enabled).toBe(true);
    });

    it("deleted, or its account removed, turns it off", async () => {
      for (const deleted of [["A"], "all"] as const) {
        const { store, rows, id } = await made();
        await followFolderFilters(store, 3, { deleted }, 0, warn);
        expect(rows.get(id)!.enabled).toBe(false);
      }
    });

    it("an edit meanwhile wins, and a failure is only logged", async () => {
      const { store, rows, hooks, id } = await made();
      hooks.beforeSave = () => rows.set(id, { ...rows.get(id)!, name: "Mine" });
      await followFolderFilters(store, 3, { deleted: ["A"] }, 0, warn);
      expect(rows.get(id)!).toMatchObject({ name: "Mine", enabled: true });
      hooks.beforeSave = () => {
        throw new Error("disk full");
      };
      const logged: string[] = [];
      await followFolderFilters(store, 3, { deleted: ["A"] }, 0, (m) => logged.push(m));
      expect(logged.length).toBe(1);
    });

    it("nothing to follow reads nothing", async () => {
      const { store, hooks } = await made();
      hooks.beforeSave = () => {
        throw new Error("no write expected");
      };
      await followFolderFilters(store, 3, { renamed: [], deleted: [] }, 0, () => {
        throw new Error("no log expected");
      });
    });
  });
});
