/** Plan 279 in `pnpm dev:demo-ai`: conversations whose summary has something new since you read. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoRegistry } from "@terno/mail";
import { afterEach, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { DEMO_EDITION_KEY, seedDemo } from "./demo";
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
  await seedDemo(backend.store, { threads: 60, accounts: 4, edition: "demo" });
  expect(await seedDemoSince(backend.store)).toBe(true);
  expect(await seedDemoSince(backend.store)).toBe(false);
  const snapshot = await backend.store.debug.snapshot();
  const accounts = await backend.store.accounts.list();
  for (const c of DEMO_SINCE) {
    const mine = snapshot.messages.filter((m) => m.providerMsgId?.startsWith(`demo-since-${c.key}-`));
    expect(mine, c.key).toHaveLength(c.lines.length);
    expect(new Set(mine.map((m) => m.threadId)).size, c.key).toBe(1);
    // plan 289: on its account by address: the English one on Acme Studio (Gmail), the Spanish ones on Freelance (IMAP)
    const account = accounts.find((a) => a.id === mine[0]!.accountId)!;
    expect([account.email, account.kind], c.key).toEqual(c.key === "offsite" ? ["luis@acme.studio", "gmail"] : ["hola@luiscordero.dev", "imap"]);
    // your own mail signed with your name, not the account's label (the seed's sender name is the owner's)
    for (const m of mine.filter((m) => m.isSent)) expect(m.fromName, c.key).toBe(c.key === "offsite" ? "Luis Carlos Cordero" : "Luis Cordero");
    // Gmail's labels on the Gmail account's only
    expect(mine.every((m) => Boolean(m.gmailLabels?.length)), c.key).toBe(account.kind === "gmail");
    // the IMAP account's are in its Inbox with no Gmail labels
    const thread = (await backend.store.threads.list({ view: "inbox", accountId: mine[0]!.accountId, limit: 200 })).items.find((t) => t.id === mine[0]!.threadId);
    expect(thread, c.key).toBeTruthy();
    const sources = (await backend.store.aiSummaries.sources(mine[0]!.threadId))!;
    // by hand, nothing marked: the unread run is what's new, and something of someone else's comes before it
    const first = c.lines.findIndex((l) => !l.read && l.from !== "me");
    expect(sinceBoundary(sources.messages, { floor: 0, snapshot: null, stored: null }), c.key).toBe(sources.messages[first]!.id);
    // newest just under 14:58 UTC, the sixth of the demo Inbox (plan 167's guide names the top six)
    expect(Math.max(...sources.messages.map((m) => m.date)), c.key).toBeLessThan(Date.UTC(2026, 9, 22, 14, 58));
  }
});

it("plan 289: the demo edition names its categories and rule in English and says so in the profile; the fixture stays as it was", async () => {
  for (const edition of ["demo", undefined] as const) {
    const dir = mkdtempSync(join(tmpdir(), "terno-demo-edition-"));
    const backend = new Backend({ dbPath: join(dir, "u.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false });
    cleanups.push(async () => {
      await backend.stop();
      rmSync(dir, { recursive: true, force: true });
    });
    await seedDemo(backend.store, { threads: 40, accounts: 4, ...(edition ? { edition } : {}) });
    const names = (await backend.store.categories.list()).map((c) => c.name);
    const rules = (await backend.store.filters.list()).map((f) => f.name);
    if (edition) {
      expect(names).toEqual(expect.arrayContaining(["Receipts", "Clients", "Travel", "Reading", "Dev"]));
      expect(rules).toEqual(["GitHub notifications → Dev"]);
      expect(await backend.store.settings.get(DEMO_EDITION_KEY, null)).toBe("demo");
    } else {
      expect(names).toEqual(expect.arrayContaining(["Facturas", "Clientes", "Viajes", "Lecturas", "Desarrollo"]));
      expect(rules).toEqual(["Notificaciones de GitHub → Desarrollo"]);
      expect(await backend.store.settings.get(DEMO_EDITION_KEY, null)).toBeNull();
    }
  }
});
