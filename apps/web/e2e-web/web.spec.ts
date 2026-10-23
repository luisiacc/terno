import { expect, test, type Page } from "@playwright/test";

/** A small demo mailbox: enough rows to triage and search, quick to seed. */
const DEMO = "/?demo=400";
const rows = (page: Page) => page.getByTestId("thread-row");

async function boot(page: Page, url = DEMO) {
  await page.goto(url);
  await rows(page).first().waitFor({ timeout: 60_000 });
}

const web = (page: Page) => page.evaluate(() => window.__unicaWeb!);

test("the backend runs in a worker on SQLite-WASM over OPFS: seeds, lists, searches, opens", async ({ page }) => {
  await boot(page);
  const info = await web(page);
  expect(info.storage).toBe("opfs-sqlite");
  expect(await rows(page).count()).toBeGreaterThan(10);
  await page.getByTestId("search-input").fill("factura");
  await expect(page.getByTestId("search-stats")).toBeVisible();
  await rows(page).first().dispatchEvent("mousedown");
  await expect(page.getByTestId("reader-subject")).toBeVisible();
});

test("a repeat visit opens the stored mailbox (no reseed) and actions persist", async ({ page }) => {
  await boot(page);
  const first = await rows(page).first().getAttribute("data-thread-id");
  await rows(page).first().dispatchEvent("mousedown");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("e"); // archive
  await expect(page.locator(`[data-testid=thread-row][data-thread-id="${first}"]`)).toHaveCount(0);
  await page.reload();
  await rows(page).first().waitFor();
  expect((await web(page)).timings.seed).toBeUndefined();
  await expect(page.locator(`[data-testid=thread-row][data-thread-id="${first}"]`)).toHaveCount(0);
});

test("one tab at a time: a second tab waits, takes over after the first closed its handles, and can be taken back", async ({ context, page }) => {
  await boot(page);
  const second = await context.newPage();
  await second.goto(DEMO);
  await expect(second.getByTestId("web-elsewhere")).toBeVisible();
  await expect(second.getByTestId("thread-row")).toHaveCount(0);
  await second.getByTestId("web-use-here").click();
  await rows(second).first().waitFor();
  await expect(page.getByTestId("web-taken")).toBeVisible();
  await page.getByTestId("web-take-back").click();
  await rows(page).first().waitFor();
  await expect(second.getByTestId("web-taken")).toBeVisible();
  // closing the leader hands the mailbox to a waiting tab on its own
  const third = await context.newPage();
  await third.goto(DEMO);
  await expect(third.getByTestId("web-elsewhere")).toBeVisible();
  await page.close();
  await rows(third).first().waitFor();
});

test("an open error never swaps the mailbox for an empty one", async ({ page }) => {
  await boot(page);
  const before = await rows(page).count();
  // the mailbox is pinned to the adapter it was created with; pretend that one is gone
  await page.evaluate(() => localStorage.setItem("unica:storage:unica", "no-such-store"));
  await page.reload();
  await expect(page.getByTestId("web-fatal")).toBeVisible();
  await expect(page.getByTestId("web-fatal")).toContainText("no se creó un buzón nuevo");
  // an explicit ?storage= that isn't available is refused the same way
  await page.evaluate(() => localStorage.removeItem("unica:storage:unica"));
  await page.goto("/?demo=400&storage=nope");
  await expect(page.getByTestId("web-fatal")).toBeVisible();
  // the stored mailbox is untouched
  await boot(page, "/?demo=0");
  expect(await rows(page).count()).toBe(before);
});

test("offline: the service worker serves this build's shell, worker and WASM", async ({ context, page }) => {
  await boot(page);
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }));
    return reg.active?.state;
  });
  await context.setOffline(true);
  await page.reload();
  await rows(page).first().waitFor();
  await context.setOffline(false);
});
