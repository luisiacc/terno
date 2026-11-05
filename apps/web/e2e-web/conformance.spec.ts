import { expect, test, type Page } from "@playwright/test";
import { OPFS_CONTRACT } from "./conformance/opfs-subset";

interface Result {
  name: string;
  state: "pass" | "fail" | "skip";
  ms: number;
  error?: string;
}

async function runSuite(page: Page, suite: string): Promise<Result[]> {
  await page.goto(`/?suite=${suite}`);
  await page.waitForFunction(() => (window as unknown as { __conformance?: { done: boolean } }).__conformance?.done, null, { timeout: 280_000, polling: 100 });
  const c = await page.evaluate(() => (window as unknown as { __conformance: { results: Result[]; error: string | null } }).__conformance);
  expect(c.error).toBeNull();
  return c.results;
}

const failures = (results: Result[]) => results.filter((r) => r.state === "fail").map((r) => `${r.name}\n${r.error}`);

test("the runner reports failures and skips (canary)", async ({ page }) => {
  const results = await runSuite(page, "canary");
  expect(results.map((r) => [r.name, r.state])).toEqual([
    ["canary > passes", "pass"],
    ["canary > fails", "fail"],
    ["canary > is skipped", "skip"],
  ]);
});

test("what of the MailStore contract depends on real files holds on SQLite-WASM over OPFS (sahpool) in a Chromium worker", async ({ page }) => {
  const results = await runSuite(page, "opfs-sqlite");
  expect(failures(results)).toEqual([]);
  // nothing skipped, the journal's own cases there, and no entry of the subset matched by nothing (a renamed test)
  expect(results.every((r) => r.state === "pass")).toBe(true);
  expect(results.filter((r) => r.name.startsWith("OPFS lifecycle > "))).toHaveLength(5);
  for (const entry of OPFS_CONTRACT) expect(results.filter((r) => r.name.includes(entry)).length, entry).toBeGreaterThan(0);
  // the 27 of send recovery, plus the rest of the subset
  expect(results.length).toBeGreaterThan(40);
});

test("the MailStore contract holds on native IndexedDB in a Chromium worker, with the instant index answering", async ({ page }) => {
  test.setTimeout(300_000);
  const results = await runSuite(page, "idb");
  expect(failures(results)).toEqual([]);
  expect(results.filter((r) => r.state === "pass").length).toBeGreaterThan(500);
  expect(results.filter((r) => r.state === "skip").map((r) => r.name)).toEqual([expect.stringContaining("upgrades data written")]);
  // a contract search may scan while the index catches up: this one fails when a store never lets the index answer
  expect(results.filter((r) => r.state === "pass" && r.name.startsWith("the instant index on native IndexedDB > "))).toHaveLength(1);
});

test("the instant engine's conformance holds in a Chromium worker", async ({ page }) => {
  const results = await runSuite(page, "engine");
  expect(failures(results)).toEqual([]);
  expect(results.filter((r) => r.state === "pass").length).toBeGreaterThan(50);
});

test("the incoming processor runs in an emitted nested browser worker", async ({ page }) => {
  const results = await runSuite(page, "incoming");
  expect(failures(results)).toEqual([]);
  expect(results.filter((result) => result.state === "pass")).toHaveLength(4);
});

test("the uncertainty guard holds on native IndexedDB in a Chromium worker", async ({ page }) => {
  const results = await runSuite(page, "idb-uncertainty");
  expect(failures(results)).toEqual([]);
  expect(results.map((result) => result.state)).toEqual(["pass", "pass", "pass", "pass", "pass", "pass"]);
});
