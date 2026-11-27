/** Plan 292 (revision 3): the written demo mailbox seeds into SQLite whole: every message its own row, threads as written. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoRegistry } from "@terno/mail";
import { demoCorpusDataset } from "@terno/mock-data";
import { DEMO_CORPUS_DIR, readCorpusSources } from "@terno/mock-data/corpus-node";
import { afterAll, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { demoEditionOf, seedDemo } from "./demo";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
function backend() {
  const dir = mkdtempSync(join(tmpdir(), "terno-demo-corpus-"));
  const b = new Backend({ dbPath: join(dir, "u.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false });
  cleanups.push(async () => {
    await b.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return b;
}
const { sources, manifest } = readCorpusSources(DEMO_CORPUS_DIR);
const dataset = demoCorpusDataset(sources);

it("keeps every message its own row and every written thread one thread (no id reused, headers chained)", async () => {
  const { messageCount, threadCount } = await backend().store.dev.seed(dataset, { now: Date.parse(sources.world.anchor) });
  expect(messageCount).toBe(dataset.messages.length);
  // each written thread is one thread; machine mail and spam are one message a thread
  expect(threadCount).toBe(sources.threads.length + dataset.messages.filter((m) => m.bulk).length);
});

it("seeds as the demo does: its rule, its record, and his mail in Sent on the accounts he wrote from", async () => {
  const b = backend();
  expect(await seedDemo(b.store, { mailbox: () => ({ dataset, rule: manifest!.rule, learningSender: manifest!.learningSender }) })).toBe(true);
  expect(await demoEditionOf(b.store)).toBe("corpus");
  expect((await b.store.filters.list()).map((f) => f.name)).toEqual([manifest!.rule.name]);
  for (const a of await b.store.accounts.list()) {
    const sent = await b.store.threads.list({ view: "sent", accountId: a.id, limit: 5 });
    expect(sent.items.length, a.email).toBeGreaterThan(0);
  }
});
