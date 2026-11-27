/** Plan 292: seedDemo takes another mailbox (the written corpus) and records it in plan 289's demo.edition. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoRegistry } from "@terno/mail";
import { generateDataset } from "@terno/mock-data";
import { afterEach, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { demoEditionOf, demoSeedProblem, seedDemo, type DemoMailbox } from "./demo";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function backend() {
  const dir = mkdtempSync(join(tmpdir(), "terno-demo-mailbox-"));
  const b = new Backend({ dbPath: join(dir, "u.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false });
  cleanups.push(async () => {
    await b.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return b;
}

it("seeds the given mailbox with its rule and learning example by name, and records it as the corpus once complete", async () => {
  const b = backend();
  const dataset = generateDataset({ threads: 80, accounts: 2, seed: 7 });
  const mailbox: DemoMailbox = { dataset, rule: { name: "Branch Ferries → Reading", from: "crew@morningbrew.com", category: "Lecturas" }, learningSender: "crew@morningbrew.com" };
  let built = 0;
  expect(await seedDemo(b.store, { mailbox: () => (built++, mailbox) })).toBe(true);
  expect(await demoEditionOf(b.store)).toBe("corpus");
  const [rule] = await b.store.filters.list();
  const reading = (await b.store.categories.list()).find((c) => c.name === "Lecturas")!;
  expect(rule).toMatchObject({ name: "Branch Ferries → Reading", rule: { conditions: [{ field: "from", op: "equals", value: "crew@morningbrew.com" }], actions: [{ type: "addCategory", categoryId: reading.id }] } });
  // a seeded profile is left alone, and the corpus isn't even read
  expect(await seedDemo(b.store, { mailbox: () => (built++, mailbox) })).toBe(false);
  expect(built).toBe(1);
});

it("leaves a seed that stops part way marked, so the next launch refuses it instead of starting on half a mailbox (Codex code review)", async () => {
  const b = backend();
  const dataset = generateDataset({ threads: 30, accounts: 1, seed: 3 });
  // a message for an account the dataset doesn't have: the accounts are written, then the seed fails
  dataset.messages.push({ ...dataset.messages[0]!, accountIndex: 7, providerMsgId: "x-1", rfcMessageId: "x-1@broken.example" });
  const mailbox: DemoMailbox = { dataset, rule: { name: "r", from: "a@b.example", category: dataset.categories[0]!.name }, learningSender: "a@b.example" };
  await expect(seedDemo(b.store, { mailbox: () => mailbox })).rejects.toThrow();
  expect((await b.store.accounts.list()).length).toBeGreaterThan(0);
  expect(await demoEditionOf(b.store)).toBe("seeding");
  expect(await demoSeedProblem(b.store)).toMatch(/stopped seeding part way.*--cleandb.*--fresh/);
  // a launch doesn't seed over it, and a whole one has no problem
  expect(await seedDemo(b.store, { mailbox: () => mailbox })).toBe(false);
  const c = backend();
  await seedDemo(c.store, { threads: 30, accounts: 1, edition: "demo" });
  expect(await demoEditionOf(c.store)).toBe("demo");
  expect(await demoSeedProblem(c.store)).toBeNull();
});

it("refuses a rule naming a category the mailbox lacks before writing anything, and the fixture records nothing", async () => {
  const b = backend();
  await seedDemo(b.store, { threads: 40, accounts: 1 });
  expect(await demoEditionOf(b.store)).toBeNull();
  const c = backend();
  const mailbox: DemoMailbox = { dataset: generateDataset({ threads: 20, accounts: 1 }), rule: { name: "r", from: "a@b.example", category: "Nope" }, learningSender: "a@b.example" };
  await expect(seedDemo(c.store, { mailbox: () => mailbox })).rejects.toThrow(/Nope/);
  expect(await c.store.accounts.list()).toEqual([]);
  expect(await demoEditionOf(c.store)).toBeNull();
});
