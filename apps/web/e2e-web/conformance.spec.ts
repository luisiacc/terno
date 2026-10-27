import { expect, test, type Page } from "@playwright/test";

interface Result {
  name: string;
  state: "pass" | "fail" | "skip";
  ms: number;
  error?: string;
}

async function runSuite(page: Page, suite: string): Promise<Result[]> {
  await page.goto(`/?suite=${suite}`);
  await page.waitForFunction(() => (window as unknown as { __conformance?: { done: boolean } }).__conformance?.done, null, { timeout: 600_000, polling: 500 });
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

test("the MailStore contract holds on SQLite-WASM over OPFS (sahpool) in a Chromium worker", async ({ page }) => {
  test.setTimeout(900_000);
  const results = await runSuite(page, "opfs-sqlite");
  expect(failures(results)).toEqual([]);
  // the whole suite ran: only the node:sqlite legacy-fixture upgrade is skipped
  expect(results.filter((r) => r.state === "pass").length).toBeGreaterThan(90);
  expect(results.filter((r) => r.state === "skip").map((r) => r.name)).toEqual([expect.stringContaining("upgrades data written by the previous schema")]);
});

test("the MailStore contract holds on native IndexedDB in a Chromium worker (scan only, and with the instant index)", async ({ page }) => {
  test.setTimeout(900_000);
  const results = await runSuite(page, "idb");
  expect(failures(results)).toEqual([]);
  expect(results.filter((r) => r.state === "pass").length).toBeGreaterThan(180);
  expect(results.filter((r) => r.state === "skip").map((r) => r.name)).toEqual([expect.stringContaining("upgrades data written"), expect.stringContaining("upgrades data written")]);
});

test("the instant engine's conformance holds in a Chromium worker", async ({ page }) => {
  test.setTimeout(600_000);
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
