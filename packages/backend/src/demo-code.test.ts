/** plan 69: `pnpm dev:demo` always has a fresh verification code at the top of the inbox. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeFresh, findCode } from "@terno/core";
import { demoRegistry } from "@terno/mail";
import { afterEach, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { seedDemo, seedDemoCode } from "./demo";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

it("each launch adds a new code, dated now, to one thread at the top of the inbox", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-demo-code-"));
  const backend = new Backend({ dbPath: join(dir, "u.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false });
  cleanups.push(async () => {
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  await seedDemo(backend.store, { threads: 60, accounts: 2 });
  const first = Date.now();
  const a = await seedDemoCode(backend.store, first);
  const b = await seedDemoCode(backend.store, first + 3 * 3_600_000 + 7);
  expect(a).toMatch(/^\d{6}$/);
  expect(b).not.toBe(a);
  const account = (await backend.store.accounts.list())[0]!;
  const top = (await backend.store.threads.list({ view: "inbox", accountId: account.id, limit: 1 })).items[0]!;
  expect(top.subject).toBe("Your Acme sign-in code");
  expect(top.messageCount).toBe(2);
  // what a row reads (apps/web/src/lib/codes.ts): the newest message's snippet, the subject only for a lone message
  expect(codeFresh(top.lastDate, first + 3 * 3_600_000 + 60_000)).toBe(true);
  expect(findCode(top.messageCount > 1 ? "" : top.subject, top.snippet)).toBe(b);
});
