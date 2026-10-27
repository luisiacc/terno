/**
 * Plan 38 in the page (a browser on the dev backend, like the web build):
 * the unread count on the app icon. setAppBadge is stubbed.
 */
import type { Page } from "@playwright/test";
import type { DesignId } from "@terno/core";
import { E2E_NOW } from "./constants";
import { expect, test, type DevServerFixture } from "./fixtures";

/** Before the page's scripts: a setAppBadge that records what it was asked. */
async function stubBrowser(page: Page, o: { badge?: boolean } = {}) {
  await page.addInitScript((o) => {
    const w = window as unknown as { __notify: { badges: number[] } };
    w.__notify = { badges: [] };
    if (o.badge !== false) {
      const nav = navigator as unknown as { setAppBadge(n?: number): Promise<void>; clearAppBadge(): Promise<void> };
      nav.setAppBadge = async (n?: number) => void w.__notify.badges.push(n ?? 0);
      nav.clearAppBadge = async () => void w.__notify.badges.push(0);
    }
  }, o);
}

/** The app fixture's load, with the stubs in place before the page's first script. */
async function load(page: Page, server: DevServerFixture, design: DesignId | null, o: Parameters<typeof stubBrowser>[1] = {}) {
  await stubBrowser(page, o);
  await page.clock.setFixedTime(new Date(E2E_NOW));
  if (design) await server.backend.server.invoke("settings.update", { design }, { clientId: "setup", origin: "dev" as const });
  await page.goto(`/?backend=${encodeURIComponent(server.url)}&token=e2e`);
  await page.locator("[data-ready]").waitFor();
  await page.getByTestId("thread-row").first().waitFor();
}

const state = (page: Page) => page.evaluate(() => (window as unknown as { __notify: { badges: number[] } }).__notify);

async function openNotifications(page: Page) {
  await page.getByTestId("open-settings").click();
  await page.getByTestId("tab-general").click();
  const group = page.getByTestId("notifications-group");
  await group.scrollIntoViewIfNeeded();
  return group;
}

test.describe("the unread count on the app icon (plan 38)", () => {
  test("@design follows the Inbox's unread number; turned off, it clears", async ({ page, server, design }) => {
    await load(page, server, design);
    const unread = () => page.evaluate(() => (window as unknown as { __terno: { getApp(): { counts: { inboxUnread: number } } } }).__terno.getApp().counts.inboxUnread);
    const n = await unread();
    expect(n).toBeGreaterThan(0);
    await expect.poll(async () => (await state(page)).badges.at(-1)).toBe(n);
    // one read (on another device, say): the count goes down with the sidebar's
    const ctx = { clientId: "t", origin: "dev" as const };
    const first = ((await server.backend.server.invoke("threads.list", { view: "inbox", filter: "unread" }, ctx)) as { items: { id: number }[] }).items[0]!.id;
    await server.backend.server.invoke("threads.act", { threadIds: [first], action: "markRead" }, ctx);
    await expect.poll(unread).toBeLessThan(n);
    await expect.poll(async () => (await state(page)).badges.at(-1)).toBe(await unread());
    await openNotifications(page);
    await expect(page.getByTestId("badge-row")).toContainText("Show unread count on the app icon");
    await page.getByTestId("badge-switch").click();
    await expect.poll(async () => (await state(page)).badges.at(-1)).toBe(0);
  });

  test("no setAppBadge in this browser: no Notifications group", async ({ page, server, design }) => {
    await page.addInitScript(() => {
      delete (Navigator.prototype as unknown as { setAppBadge?: unknown }).setAppBadge;
      delete (Navigator.prototype as unknown as { clearAppBadge?: unknown }).clearAppBadge;
    });
    await load(page, server, design, { badge: false });
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-general").click();
    await expect(page.getByTestId("general-tab")).toBeVisible();
    await expect(page.getByTestId("badge-row")).toHaveCount(0);
  });
});
