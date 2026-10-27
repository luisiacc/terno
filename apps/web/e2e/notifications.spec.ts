/**
 * Plan 38 in the page (a browser on the dev backend, like the web build):
 * the Notifications settings, the browser's permission, a notification for
 * important new mail while the tab is hidden and its click, and the unread
 * count on the app icon. The browser's Notification, its permission, the tab's
 * visibility and setAppBadge are stubbed; the mail comes through a real sync pass.
 */
import { mkdirSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { IncomingMessage } from "@terno/store";
import type { DesignId } from "@terno/core";
import { E2E_NOW } from "./constants";
import type { AppSettings } from "@terno/core/rpc";
import { expect, readerSubject, test, type DevServerFixture } from "./fixtures";

const SHOTS = "/tmp/unica-scratch/notify";

test.use({ backendOptions: { network: true } });

/** Before the page's scripts: the stubs, steered from the test through window.__notify. */
async function stubBrowser(page: Page, o: { permission?: NotificationPermission; answer?: NotificationPermission; badge?: boolean; refuse?: boolean } = {}) {
  await page.addInitScript((o) => {
    const w = window as unknown as { __notify: { permission: string; answer: string; hidden: boolean; shown: { title: string; body: string; tag: string; click(): void }[]; asked: number; badges: number[] } };
    w.__notify = { permission: o.permission ?? "granted", answer: o.answer ?? "granted", hidden: false, shown: [], asked: 0, badges: [] };
    class FakeNotification {
      static get permission() {
        return w.__notify.permission;
      }
      static async requestPermission() {
        w.__notify.asked++;
        w.__notify.permission = w.__notify.answer;
        return w.__notify.answer;
      }
      onclick: (() => void) | null = null;
      onclose: (() => void) | null = null;
      constructor(readonly title: string, readonly options: { body?: string; tag?: string } = {}) {
        // a mobile browser: only a service worker may show one
        if (o.refuse) throw new TypeError("Illegal constructor. Use ServiceWorkerRegistration.showNotification() instead.");
        w.__notify.shown.push({ title, body: options.body ?? "", tag: options.tag ?? "", click: () => this.onclick?.() });
      }
      close() {
        this.onclose?.();
      }
    }
    (window as unknown as { Notification: unknown }).Notification = FakeNotification;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (w.__notify.hidden ? "hidden" : "visible") });
    if (o.badge !== false) {
      const nav = navigator as unknown as { setAppBadge(n?: number): Promise<void>; clearAppBadge(): Promise<void> };
      nav.setAppBadge = async (n?: number) => void w.__notify.badges.push(n ?? 0);
      nav.clearAppBadge = async () => void w.__notify.badges.push(0);
    }
  }, o);
}

/** what the backend saved */
const saved = async (server: DevServerFixture) => ((await server.backend.server.invoke("app.bootstrap", {}, { clientId: "t", origin: "dev" as const })) as { settings: AppSettings }).settings;

/** The app fixture's load, with the stubs in place before the page's first script (the boot reconciles the permission). */
async function load(page: Page, server: DevServerFixture, design: DesignId | null, o: Parameters<typeof stubBrowser>[1] = {}) {
  await stubBrowser(page, o);
  await page.clock.setFixedTime(new Date(E2E_NOW));
  if (design) await server.backend.server.invoke("settings.update", { design }, { clientId: "setup", origin: "dev" as const });
  await page.goto(`/?backend=${encodeURIComponent(server.url)}&token=e2e`);
  await page.locator("[data-ready]").waitFor();
  await page.getByTestId("thread-row").first().waitFor();
}

const state = (page: Page) => page.evaluate(() => (window as unknown as { __notify: { permission: string; hidden: boolean; shown: { title: string; body: string; tag: string }[]; asked: number; badges: number[] } }).__notify);

async function openNotifications(page: Page) {
  await page.getByTestId("open-settings").click();
  await page.getByTestId("tab-general").click();
  const group = page.getByTestId("notifications-group");
  await group.scrollIntoViewIfNeeded();
  return group;
}

/** Gmail marked it Important: important whoever sent it (plan 38 §8.3). */
function important(accountId: number, subject: string): IncomingMessage {
  return {
    accountId, providerMsgId: `notify-${subject}`, providerThreadId: null, rfcMessageId: `${subject.replace(/\W/g, "")}@notify.test`, inReplyTo: null, references: [],
    from: { name: "Valeria Núñez", email: "valeria@studio.example" }, to: [{ name: "Me", email: "me@example.com" }], cc: [], bcc: [],
    subject, date: E2E_NOW - 60_000, snippet: "¿Podemos vernos el jueves?", bodyText: "¿Podemos vernos el jueves?", bodyHtml: null, bodyState: "full", listId: null,
    isRead: false, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 100, gmailLabels: ["INBOX", "IMPORTANT", "UNREAD"],
  };
}

test.describe("notifications and the unread count (plan 38)", () => {
  test("@design Settings → General → Notifications: the switches save, the preview follows the main switch, axe-clean; screenshots", async ({ page, server, design }) => {
    await load(page, server, design);
    const group = await openNotifications(page);
    await expect(page.getByTestId("notify-switch")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("notify-preview-switch")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("badge-switch")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("badge-row")).toContainText("Show unread count on the app icon");
    expect((await new AxeBuilder({ page }).include("[data-testid=notifications-group]").analyze()).violations).toEqual([]);
    mkdirSync(SHOTS, { recursive: true });
    await group.screenshot({ path: `${SHOTS}/settings-${design ?? "macos"}-light.png` });

    await page.getByTestId("notify-preview-switch").click();
    await page.getByTestId("badge-switch").click();
    await expect(page.getByTestId("badge-switch")).toHaveAttribute("aria-checked", "false");
    await expect.poll(async () => await saved(server)).toMatchObject({ notificationPreview: false, dockBadge: false });
    await page.getByTestId("notify-switch").click();
    await expect(page.getByTestId("notify-preview-switch")).toBeDisabled();
    await expect.poll(async () => (await saved(server)).notifications).toBe(false);

    // dark, everything back on
    await page.getByTestId("notify-switch").click();
    await page.getByTestId("notify-preview-switch").click();
    await page.getByTestId("badge-switch").click();
    await page.getByTestId("tab-appearance").click();
    await page.getByTestId("mode-dark").click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.getByTestId("tab-general").click();
    await page.getByTestId("notifications-group").scrollIntoViewIfNeeded();
    expect((await new AxeBuilder({ page }).include("[data-testid=notifications-group]").analyze()).violations).toEqual([]);
    await page.getByTestId("notifications-group").screenshot({ path: `${SHOTS}/settings-${design ?? "macos"}-dark.png` });
  });

  test("the browser's permission: saved on but not allowed reads off (and is saved off); turning it on asks, a refusal says how to allow it", async ({ page, server, design }) => {
    await load(page, server, design, { permission: "default", answer: "denied" });
    await expect.poll(async () => (await saved(server)).notifications).toBe(false);
    await openNotifications(page);
    await expect(page.getByTestId("notify-switch")).toHaveAttribute("aria-checked", "false");
    await page.getByTestId("notify-switch").click();
    await expect(page.getByTestId("snack-message")).toContainText("Your browser blocks notifications from Terno");
    expect((await state(page)).asked).toBe(1);
    await expect(page.getByTestId("notify-switch")).toHaveAttribute("aria-checked", "false");
    // allowed this time
    await page.evaluate(() => ((window as unknown as { __notify: { answer: string } }).__notify.answer = "granted"));
    await page.getByTestId("notify-switch").click();
    await expect(page.getByTestId("notify-switch")).toHaveAttribute("aria-checked", "true");
    await expect.poll(async () => (await saved(server)).notifications).toBe(true);
  });

  test("important mail arriving while the tab is hidden: one notification, its click opens the conversation; a visible tab gets none", async ({ page, server, design }) => {
    await load(page, server, design);
    const accountId = server.backend.store ? (await server.backend.store.accounts.list())[0]!.id : 1;
    // the accounts synced once at start: the next pass is news
    await server.backend.syncAccount(accountId);

    await page.evaluate(() => ((window as unknown as { __notify: { hidden: boolean } }).__notify.hidden = true));
    server.net.incoming.push(important(accountId, "Reunión del jueves"));
    await server.backend.syncAccount(accountId);
    await expect.poll(async () => (await state(page)).shown.length, { timeout: 10_000 }).toBe(1);
    const [shown] = (await state(page)).shown;
    expect(shown).toMatchObject({ title: "Valeria Núñez", tag: expect.stringMatching(/^terno:mail-/) });
    expect(shown!.body).toContain("Reunión del jueves");

    // the click: the Inbox with that conversation open
    await page.evaluate(() => (window as unknown as { __notify: { shown: { click(): void }[] } }).__notify.shown[0]!.click());
    expect(await readerSubject(page)).toBe("Reunión del jueves");

    // visible: the page shows the mail, no notification (after the gap the backend would send one)
    await page.evaluate(() => ((window as unknown as { __notify: { hidden: boolean } }).__notify.hidden = false));
    server.net.incoming.push(important(accountId, "Otra cosa"));
    await server.backend.syncAccount(accountId);
    await page.waitForTimeout(17_000);
    expect((await state(page)).shown).toHaveLength(1);
  });

  test("Codex code review #9: a browser that refuses to build one from the page: the setting goes off and the row hides", async ({ page, server, design }) => {
    await load(page, server, design, { refuse: true });
    const accountId = (await server.backend.store.accounts.list())[0]!.id;
    await server.backend.syncAccount(accountId);
    await page.evaluate(() => ((window as unknown as { __notify: { hidden: boolean } }).__notify.hidden = true));
    server.net.incoming.push(important(accountId, "Refused"));
    await server.backend.syncAccount(accountId);
    await expect.poll(async () => (await saved(server)).notifications, { timeout: 10_000 }).toBe(false);
    await page.evaluate(() => ((window as unknown as { __notify: { hidden: boolean } }).__notify.hidden = false));
    await openNotifications(page);
    await expect(page.getByTestId("notify-row")).toHaveCount(0);
    await expect(page.getByTestId("badge-row")).toBeVisible();
  });

  test("Codex code review #10: permission granted in the site's settings while Settings is open: the switch turns on and off again", async ({ page, server, design }) => {
    await load(page, server, design, { permission: "default" });
    await expect.poll(async () => (await saved(server)).notifications).toBe(false);
    await openNotifications(page);
    await expect(page.getByTestId("notify-switch")).toHaveAttribute("aria-checked", "false");
    await page.evaluate(() => ((window as unknown as { __notify: { permission: string } }).__notify.permission = "granted"));
    await page.getByTestId("notify-switch").click();
    await expect(page.getByTestId("notify-switch")).toHaveAttribute("aria-checked", "true");
    expect((await state(page)).asked).toBe(0);
    await expect.poll(async () => (await saved(server)).notifications).toBe(true);
    await page.getByTestId("notify-switch").click();
    await expect(page.getByTestId("notify-switch")).toHaveAttribute("aria-checked", "false");
    await expect.poll(async () => (await saved(server)).notifications).toBe(false);
  });

  test("the app icon's count follows the Inbox's unread number; turned off, it clears", async ({ page, server, design }) => {
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
    await page.getByTestId("badge-switch").click();
    await expect.poll(async () => (await state(page)).badges.at(-1)).toBe(0);
  });

  test("no setAppBadge in this browser: no app-icon row", async ({ page, server, design }) => {
    await page.addInitScript(() => {
      delete (Navigator.prototype as unknown as { setAppBadge?: unknown }).setAppBadge;
      delete (Navigator.prototype as unknown as { clearAppBadge?: unknown }).clearAppBadge;
    });
    await load(page, server, design, { badge: false });
    await openNotifications(page);
    await expect(page.getByTestId("notify-row")).toBeVisible();
    await expect(page.getByTestId("badge-row")).toHaveCount(0);
  });
});
