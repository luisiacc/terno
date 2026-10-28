/**
 * Plan 22: sender icons. The backend's real fetcher runs against e2e/icon-stub.ts (no internet):
 * a few seeded senders' sites have icons, the rest 404. Tagged @design: every design, light.
 */
import type { Page } from "@playwright/test";
import { DESIGNS } from "../../../packages/ui/src/designs/index";
import { expect, focusList, navTo, rows, test } from "./fixtures";

const ctx = { clientId: "setup", origin: "dev" as const };

async function design(page: Page) {
  const id = await page.locator("html").getAttribute("data-design");
  return DESIGNS.find((d) => d.id === id)!;
}

async function reload(page: Page) {
  await page.reload();
  await page.locator("[data-ready]").waitFor();
  await rows(page).first().waitFor();
}

test.describe("sender icons", { tag: "@design" }, () => {
  test("turned off: the list and the reader ask nothing, nothing is requested", async ({ app: page, server }) => {
    await rows(page).nth(2).dispatchEvent("mousedown", { button: 0 });
    await expect(page.getByTestId("reader-subject")).toBeVisible();
    await page.getByTestId("thread-list").locator("[role=listbox]").evaluate((el) => (el.scrollTop = 4000));
    await page.waitForTimeout(500);
    expect(server.icons.requests).toEqual([]);
    await expect(page.getByTestId("sender-icon")).toHaveCount(0);
  });

  test("turned on, icons appear in the avatar's own box (no layout shift); unknown sites and freemail keep their initials; one request chain per site", async ({ app: page, server }) => {
    const d = await design(page);
    await server.backend.server.invoke("settings.update", { senderIcons: true }, ctx);
    await reload(page);
    if (d.variants.row !== "classic") {
      const withIcon = page.locator("[data-testid=thread-row]:has([data-testid=sender-icon])").first();
      await expect(withIcon).toBeVisible();
      await expect(withIcon).toHaveCSS("height", `${d.rows.comfortable}px`);
      // the icon sits exactly on the avatar, which is the same size as an initials one
      const box = async (row: ReturnType<typeof rows>) => (await row.getByTestId("sender-avatar").boundingBox())!;
      const plain = page.locator("[data-testid=thread-row]:not(:has([data-testid=sender-icon]))").first();
      const [a, b] = [await box(withIcon), await box(plain)];
      expect([a.width, a.height, a.x]).toEqual([b.width, b.height, b.x]);
      const icon = (await withIcon.getByTestId("sender-icon").boundingBox())!;
      expect(icon).toEqual(a);
      // freemail people never get their provider's icon
      const freemail = page.locator("[data-testid=thread-row]", { has: page.locator("[data-testid=row-from]") }).filter({ hasNot: page.getByTestId("sender-icon") });
      expect(await freemail.count()).toBeGreaterThan(0);
    }
    // the reader: the open message's avatar
    const iconRow = page.locator("[data-testid=thread-row]", { hasText: /Xataka|Figma|GitHub|Stripe|Linear|Vercel|Spotify|Uber/ }).first();
    await iconRow.dispatchEvent("mousedown", { button: 0 });
    await expect(page.getByTestId("reader").getByTestId("sender-icon").first()).toBeVisible();
    // each site once, never a freemail provider, never a query string
    const pages = server.icons.requests.filter((u) => new URL(u).pathname === "/");
    expect(new Set(pages).size).toBe(pages.length);
    expect(server.icons.requests.some((u) => /gmail\.com|outlook\.com|hotmail\.com|icloud\.com/.test(new URL(u).hostname))).toBe(false);
    expect(server.icons.requests.every((u) => !new URL(u).search)).toBe(true);
  });

  test("the Spam view asks for nothing", async ({ app: page, server }) => {
    await server.backend.server.invoke("settings.update", { senderIcons: true }, ctx);
    await reload(page);
    await page.waitForTimeout(400);
    const before = server.icons.requests.length;
    await navTo(page, "spam");
    await expect(page.getByTestId("list-title")).toHaveText("Spam");
    await rows(page).first().waitFor();
    await rows(page).first().dispatchEvent("mousedown", { button: 0 });
    await expect(page.getByTestId("reader-subject")).toBeVisible();
    await page.waitForTimeout(500);
    expect(server.icons.requests.slice(before)).toEqual([]);
    await expect(page.getByTestId("sender-icon")).toHaveCount(0);
  });
});

test.describe("a fresh install's default", () => {
  test.use({ siteIcons: true });
  test("Settings → Appearance: website icons are on in local mode too, General says so, and one tap turns them off", async ({ app: page }) => {
    await focusList(page);
    await page.keyboard.press("Meta+,");
    await page.getByTestId("tab-general").click();
    await expect(page.getByTestId("local-mode-row")).toContainText("and website icons (Appearance)");
    await page.getByTestId("tab-appearance").click();
    const row = page.getByTestId("site-icons-row");
    await row.scrollIntoViewIfNeeded();
    await expect(row).toContainText("On in local mode too");
    const sw = page.getByTestId("site-icons-switch");
    await expect(sw).toBeChecked();
    await sw.click();
    await expect(sw).not.toBeChecked();
    await page.getByTestId("tab-general").click();
    await expect(page.getByTestId("local-mode-row")).not.toContainText("website icons");
    await page.getByTestId("tab-appearance").click();
    await page.getByTestId("forget-icons").click();
    await expect(page.getByText("Saved icons forgotten").first()).toBeVisible();
  });
});
