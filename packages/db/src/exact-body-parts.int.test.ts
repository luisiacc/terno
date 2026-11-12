import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openDatabase } from "./index";
import { nodePlatform } from "./node-driver";
import { SqlMailStore } from "./sql-store";
import { defineExactBodyLifecycle } from "../../store/src/conformance/exact-body-lifecycle";
import { msg, withAccounts } from "../../store/src/conformance/fixtures";

defineExactBodyLifecycle(async () => {
  const directory = mkdtempSync(join(tmpdir(), "terno-exact-parts-")), path = join(directory, "mail.db");
  let fail = false;
  const platform = { ...nodePlatform, async yield() { await nodePlatform.yield(); if (fail) { fail = false; throw new Error("Interrupted preparation"); } } };
  const create = () => new SqlMailStore(openDatabase(path), { instantSearch: false, platform });
  let store = create();
  return { store, async reopen() { await store.close(); return store = create(); }, async dispose() { rmSync(directory, { recursive: true, force: true }); }, async interrupt(work) { fail = true; await expect(work()).rejects.toThrow("Interrupted preparation"); } };
});

it("keeps SQL code-point sent prefixes and query category scopes exact for captured bodies", async () => {
  const store = new SqlMailStore(openDatabase(":memory:"), { instantSearch: false, platform: nodePlatform });
  try {
    const [accountId] = await withAccounts(store, 1), text = `${"😀a".repeat(40000)} unique boundary phrase`;
    const result = await store.sync.ingest([msg({ accountId: accountId!, isSent: true, size: 200000, bodyText: text, bodyState: "full" })], { now: 1, classifier: null, applyFilters: false });
    const message = (await store.threads.get(result.touched[0]!))!.messages[0]!;
    expect((await store.autocomplete.sentTexts([message.id]))[0]?.text === [...text].slice(0, 65536).join("")).toBe(true);
    const category = await store.categories.create("synthetic", "brown");
    expect(await store.categorize.resolveScope(category.id, { kind: "query", query: '"unique boundary phrase"' }, 1, 10)).toEqual(result.touched);
  } finally { await store.close(); }
});
