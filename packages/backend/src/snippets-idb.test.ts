/** Plan 93: snippets in the IndexedDB store (the web's): the same module as SQLite, the cap and the byte budget. */
import "fake-indexeddb/auto";
import { SNIPPETS_MAX, type Snippet } from "@terno/core";
import { IdbMailStore } from "@terno/idb";
import { afterEach, describe, expect, it } from "vitest";
import { deleteSnippet, importSnippets, listSnippets, saveSnippet } from "./snippets";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const fields = { name: "Intro call", bodyHtml: "<p>Hi {first_name},</p>", bodyText: "Hi {first_name},", subject: "", to: "", cc: "", bcc: "" };
const errorOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { code?: string });

describe("snippets in the IndexedDB store", () => {
  it("save, list, update, delete and the cap", async () => {
    const store = await IdbMailStore.open({ name: crypto.randomUUID(), factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
    cleanups.push(() => store.close());
    const a = await saveSnippet(store, { ...fields, id: "s_aaaaaaaa", base: null }, 10);
    expect(await listSnippets(store)).toEqual([a]);
    const b = await saveSnippet(store, { ...fields, name: "B", id: a.id, base: a.updatedAt }, 10);
    // the same clock still makes a later version
    expect(b.updatedAt).toBe(11);
    await deleteSnippet(store, a.id);
    expect(await listSnippets(store)).toEqual([]);
    const many: Snippet[] = Array.from({ length: SNIPPETS_MAX + 5 }, (_, i) => ({ ...fields, name: `n${i}`, id: `s_many${String(i).padStart(4, "0")}`, createdAt: 0, updatedAt: 0 }));
    expect(await importSnippets(store, many)).toBe(SNIPPETS_MAX);
    expect(await errorOf(saveSnippet(store, { ...fields, id: "s_onemore1", base: null }, 20))).toMatchObject({ code: "BAD_REQUEST" });
  });

  it("an imported snippet too large for what's left is skipped; a smaller one after it still comes in (Codex code review 7)", async () => {
    const store = await IdbMailStore.open({ name: crypto.randomUUID(), factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
    cleanups.push(() => store.close());
    const big = (i: number): Snippet => ({ ...fields, name: `big${i}`, bodyHtml: "x".repeat(30_000), bodyText: "y".repeat(15_000), id: `s_big${String(i).padStart(5, "0")}`, createdAt: 0, updatedAt: 0 });
    // fill it to within one big snippet of the budget
    let n = 0;
    while (await importSnippets(store, [big(n)])) n++;
    const small: Snippet = { ...fields, name: "small", id: "s_small001", createdAt: 0, updatedAt: 0 };
    expect(await importSnippets(store, [big(n + 1), small])).toBe(1);
    expect((await listSnippets(store)).some((s) => s.id === "s_small001")).toBe(true);
  });

  it("keeps the whole list within the byte budget", async () => {
    const store = await IdbMailStore.open({ name: crypto.randomUUID(), factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
    cleanups.push(() => store.close());
    const big = { ...fields, bodyHtml: "x".repeat(30_000), bodyText: "y".repeat(15_000) };
    let saved = 0;
    for (let i = 0; i < 40; i++) {
      const e = await errorOf(saveSnippet(store, { ...big, name: `b${i}`, id: `s_big${String(i).padStart(5, "0")}`, base: null }, i));
      if (e) {
        expect(e).toMatchObject({ code: "BAD_REQUEST" });
        break;
      }
      saved++;
    }
    expect(saved).toBeGreaterThan(10);
    expect(saved).toBeLessThan(40);
    const t0 = performance.now();
    await listSnippets(store);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});
