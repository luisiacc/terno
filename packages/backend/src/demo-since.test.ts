/** Plan 279 in `pnpm dev:demo-ai`: conversations whose summary has something new since you read. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoRegistry } from "@terno/mail";
import { afterEach, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { seedDemo } from "./demo";
import { DEMO_SINCE, seedDemoSince } from "./demo-since";
import { sinceBoundary } from "./summary-since";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

it("seeds once: each conversation's new mail starts where its unread run does, under the Inbox's top six", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-demo-since-"));
  const backend = new Backend({ dbPath: join(dir, "u.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false });
  cleanups.push(async () => {
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  await seedDemo(backend.store, { threads: 60, accounts: 2 });
  expect(await seedDemoSince(backend.store)).toBe(true);
  expect(await seedDemoSince(backend.store)).toBe(false);
  const snapshot = await backend.store.debug.snapshot();
  for (const c of DEMO_SINCE) {
    const mine = snapshot.messages.filter((m) => m.providerMsgId?.startsWith(`demo-since-${c.key}-`));
    expect(mine, c.key).toHaveLength(c.lines.length);
    expect(new Set(mine.map((m) => m.threadId)).size, c.key).toBe(1);
    const sources = (await backend.store.aiSummaries.sources(mine[0]!.threadId))!;
    // by hand, nothing marked: the unread run is what's new, and something of someone else's comes before it
    const first = c.lines.findIndex((l) => !l.read && l.from !== "me");
    expect(sinceBoundary(sources.messages, { floor: 0, snapshot: null, stored: null }), c.key).toBe(sources.messages[first]!.id);
    // newest just under 14:58 UTC, the sixth of the demo Inbox (plan 167's guide names the top six)
    expect(Math.max(...sources.messages.map((m) => m.date)), c.key).toBeLessThan(Date.UTC(2026, 9, 22, 14, 58));
  }
});
