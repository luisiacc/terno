/** Plan 89: snippets in the settings store (both stores), saved with a base version, exported and imported. */
import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SNIPPETS_MAX, type Snippet } from "@terno/core";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { IdbMailStore } from "@terno/idb";
import { demoRegistry } from "@terno/mail";
import { afterEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { deleteSnippet, importSnippets, listSnippets, saveSnippet } from "./snippets";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function open(): RpcClient {
  const dir = mkdtempSync(join(tmpdir(), "terno-snippets-"));
  const backend = new Backend({ dbPath: join(dir, "u.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false });
  cleanups.push(async () => {
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "r", origin: "renderer" });
  return new RpcClient(c);
}

const fields = { name: "Intro call", bodyHtml: "<p>Hi {first_name},</p>", bodyText: "Hi {first_name},", subject: "", to: "", cc: "", bcc: "" };
const errorOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { code?: string });

describe("snippets over RPC (SQLite)", () => {
  it("creates, lists by name, updates on its base, deletes", async () => {
    const client = open();
    expect(await client.call("snippets.list", {})).toEqual([]);
    const a = await client.call("snippets.save", { ...fields, id: "s_aaaaaaaa", base: null });
    await client.call("snippets.save", { ...fields, name: "Already done", id: "s_bbbbbbbb", base: null });
    expect((await client.call("snippets.list", {})).map((s) => s.name)).toEqual(["Already done", "Intro call"]);
    const b = await client.call("snippets.save", { ...fields, name: "Intro", id: a.id, base: a.updatedAt });
    expect(b).toMatchObject({ id: a.id, name: "Intro", createdAt: a.createdAt });
    expect(b.updatedAt).toBeGreaterThan(a.updatedAt);
    await client.call("snippets.delete", { id: a.id });
    expect((await client.call("snippets.list", {})).map((s) => s.id)).toEqual(["s_bbbbbbbb"]);
  });

  it("refuses an edit based on another version, or of a deleted one, unless forced", async () => {
    const client = open();
    const a = await client.call("snippets.save", { ...fields, id: "s_aaaaaaaa", base: null });
    await client.call("snippets.save", { ...fields, name: "Other window", id: a.id, base: a.updatedAt });
    expect(await errorOf(client.call("snippets.save", { ...fields, name: "Mine", id: a.id, base: a.updatedAt }))).toMatchObject({ code: "STALE" });
    expect(await client.call("snippets.save", { ...fields, name: "Mine", id: a.id, base: a.updatedAt, force: true })).toMatchObject({ name: "Mine" });
    // created twice is refused too: a second editor can't silently replace it
    expect(await errorOf(client.call("snippets.save", { ...fields, id: a.id, base: null }))).toMatchObject({ code: "STALE" });
    const last = (await client.call("snippets.list", {}))[0]!;
    await client.call("snippets.delete", { id: a.id });
    // an old editor can't bring back what another window deleted
    expect(await errorOf(client.call("snippets.save", { ...fields, id: a.id, base: last.updatedAt }))).toMatchObject({ code: "STALE" });
    // Undo of a delete puts the same snippet back (its id kept)
    expect(await client.call("snippets.save", { ...fields, id: a.id, base: null })).toMatchObject({ id: a.id });
  });

  it("rejects images, oversized bodies and bad ids", async () => {
    const client = open();
    expect(await errorOf(client.call("snippets.save", { ...fields, bodyHtml: '<p><img src="cid:x"></p>', id: "s_aaaaaaaa", base: null }))).toMatchObject({ code: "BAD_REQUEST" });
    expect(await errorOf(client.call("snippets.save", { ...fields, bodyHtml: "x".repeat(40_000), id: "s_aaaaaaaa", base: null }))).toMatchObject({ code: "BAD_REQUEST" });
    expect(await errorOf(client.call("snippets.save", { ...fields, id: "../x", base: null }))).toMatchObject({ code: "BAD_REQUEST" });
  });

  it("travels in an export and comes back once, keeping a snippet already here by name", async () => {
    const source = open();
    await source.call("snippets.save", { ...fields, id: "s_aaaaaaaa", base: null });
    await source.call("snippets.save", { ...fields, name: "Thanks", id: "s_bbbbbbbb", base: null });
    const dump = await source.call("app.export", {});
    expect(dump.snippets.map((s) => s.name)).toEqual(["Intro call", "Thanks"]);
    const target = open();
    await target.call("snippets.save", { ...fields, name: "thanks", bodyText: "mine", id: "s_cccccccc", base: null });
    const bad = { ...dump.snippets[0], id: "s_dddddddd", name: "Bad", bodyHtml: "<img src=x>" };
    const result = await target.call("app.import", { data: { ...dump, snippets: [...dump.snippets, bad] } as never });
    expect(result.snippets).toBe(1);
    expect((await target.call("snippets.list", {})).map((s) => [s.name, s.bodyText])).toEqual([["Intro call", "Hi {first_name},"], ["thanks", "mine"]]);
    expect((await target.call("app.import", { data: dump as never })).snippets).toBe(0);
    // a file from before snippets imports as before
    const { snippets: _none, ...older } = dump;
    expect((await target.call("app.import", { data: older as never })).snippets).toBe(0);
  });
});

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
