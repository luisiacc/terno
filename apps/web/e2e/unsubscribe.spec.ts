import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { IncomingMessage } from "@terno/store";
import { E2E_NOW } from "./constants";
import { menuPath, expect, search, stabilize, test, type DevServerFixture } from "./fixtures";

const ctx = { clientId: "setup", origin: "dev" as const };
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/** Plan 96: one conversation from a sender, with what its mail says about unsubscribing. */
async function ingest(server: DevServerFixture, o: { id: string; subject: string; from?: { name: string; email: string }; unsubscribe?: IncomingMessage["unsubscribe"]; bodyHtml?: string }): Promise<number> {
  const [account] = await server.backend.store.accounts.list();
  const text = "This week: three things worth reading.";
  const incoming: IncomingMessage = {
    accountId: account!.id, providerMsgId: o.id, providerThreadId: null, rfcMessageId: `${o.id}@weekly.test`, inReplyTo: null, references: [],
    from: o.from ?? { name: "The Weekly", email: "news@weekly.example" }, replyTo: [], to: [{ name: "Me", email: account!.email }], cc: [], bcc: [],
    subject: o.subject, date: E2E_NOW - 60_000, snippet: text, bodyText: text, bodyHtml: o.bodyHtml ?? null, bodyState: "full", listId: o.from ? null : "weekly.example",
    unsubscribe: o.unsubscribe ?? null, isRead: false, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 1000,
  };
  const { touched } = await server.backend.store.sync.ingest([incoming], { applyFilters: false, now: E2E_NOW, classifier: null });
  return touched[0]!;
}

const rowOf = (page: Page, id: number) => page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`);

/** window.open, recorded instead of opening a tab (the web build opens pages with it) */
async function recordOpens(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const w = window as unknown as { __opened: string[] };
    w.__opened = [];
    window.open = (url?: string | URL) => (w.__opened.push(String(url)), null);
  });
  return () => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
}

const ONE_CLICK = { oneClick: "https://weekly.example/u/1", url: "https://weekly.example/u/1" };

test("one-click: the menu offers it, axe-clean in light and dark, and it's done in one click", async ({ app: page, server }) => {
  const id = await ingest(server, { id: "weekly", subject: "Weekly issue", unsubscribe: ONE_CLICK });
  await page.reload();
  await page.locator("[data-ready]").waitFor();
  await search(page, '"Weekly issue"');
  await rowOf(page, id).click({ button: "right" });
  await menuPath(page, "menu-more");
  const item = page.getByTestId("menu-unsubscribe");
  await expect(item).toHaveText("Unsubscribe weekly.example");
  await expect(item).toHaveAttribute("role", "menuitem");
  await stabilize(page);
  // (stabilizing parks the pointer, which closes a submenu)
  await menuPath(page, "menu-more");
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveClass(theme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
    const axe = await new AxeBuilder({ page }).setLegacyMode().include("[data-testid=thread-menu]").include("[data-testid=menu-more-list]").withTags(AXE_TAGS).analyze();
    expect(axe.violations.map((v) => v.id), theme).toEqual([]);
  }
  // nothing went out just because the menu opened
  expect(server.unsubscribes.posted).toEqual([]);
  await item.click();
  await expect(page.getByTestId("snack-message")).toHaveText("Unsubscribed from The Weekly.");
  expect(server.unsubscribes.posted).toEqual(["https://weekly.example/u/1"]);
});

test("a refused one-click offers the sender's page instead", async ({ app: page, server }) => {
  server.unsubscribes.status = 500;
  const id = await ingest(server, { id: "weekly-refused", subject: "Weekly refused issue", unsubscribe: ONE_CLICK });
  await search(page, '"Weekly refused issue"');
  const opened = await recordOpens(page);
  await rowOf(page, id).click({ button: "right" });
  await menuPath(page, "menu-more");
  await page.getByTestId("menu-unsubscribe").click();
  await expect(page.getByTestId("snack-message")).toHaveText("weekly.example didn’t take the one-click request. Finish on its unsubscribe page.");
  await page.getByRole("button", { name: "Open page" }).click();
  expect(await opened()).toEqual(["https://weekly.example/u/1"]);
});

test("mail: queues the unsubscribe message from the account it came to", async ({ app: page, server }) => {
  const id = await ingest(server, { id: "weekly-mail", subject: "Weekly mail issue", unsubscribe: { mailto: "mailto:off@weekly.example?subject=unsubscribe" } });
  await search(page, '"Weekly mail issue"');
  await rowOf(page, id).click({ button: "right" });
  await menuPath(page, "menu-more");
  await expect(page.getByTestId("menu-unsubscribe")).toHaveText("Unsubscribe off@weekly.example");
  await page.getByTestId("menu-unsubscribe").click();
  await expect(page.getByTestId("snack-message")).toHaveText("Queued an unsubscribe request to off@weekly.example.");
  const sent = (await server.backend.store.debug.snapshot()).messages.filter((m) => m.isSent && m.subject === "unsubscribe");
  expect(sent).toHaveLength(1);
  expect(sent[0]!.recipients).toContain("off@weekly.example");
});

test("the link in the mail opens in the click itself", async ({ app: page, server }) => {
  const id = await ingest(server, { id: "shop-link", subject: "Shop sale this week", from: { name: "Shop", email: "deals@shop.example" }, bodyHtml: '<p>Sale!</p><p><a href="https://shop.example/bye?u=9">Unsubscribe</a></p>' });
  await search(page, '"Shop sale this week"');
  const opened = await recordOpens(page);
  await rowOf(page, id).click({ button: "right" });
  await menuPath(page, "menu-more");
  await expect(page.getByTestId("menu-unsubscribe")).toHaveText("Unsubscribe shop.example");
  await page.getByTestId("menu-unsubscribe").click();
  expect(await opened()).toEqual(["https://shop.example/bye?u=9"]);
  await expect(page.getByTestId("snack-message")).toHaveText("Opened shop.example’s unsubscribe page in your browser.");
  expect(server.unsubscribes.posted).toEqual([]);
});

test("no item for personal mail or a selection of several", async ({ app: page, server }) => {
  const personal = await ingest(server, { id: "ana-lunch", subject: "Lunch on Friday unsub test", from: { name: "Ana", email: "ana@friends.example" } });
  const a = await ingest(server, { id: "weekly-sel-a", subject: "Weekly sel issue A", unsubscribe: ONE_CLICK });
  const b = await ingest(server, { id: "weekly-sel-b", subject: "Weekly sel issue B", unsubscribe: ONE_CLICK });
  await search(page, '"Lunch on Friday unsub test"');
  await rowOf(page, personal).click({ button: "right" });
  await menuPath(page, "menu-more");
  await expect(page.getByTestId("menu-copy")).toBeVisible();
  // the lookup is a local read: give it time to answer, then nothing may have appeared
  await page.waitForTimeout(300);
  await expect(page.getByTestId("menu-unsubscribe")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  await search(page, '"Weekly sel issue"');
  await rowOf(page, a).click();
  await rowOf(page, b).click({ modifiers: ["ControlOrMeta"] });
  await rowOf(page, b).click({ button: "right" });
  await expect(page.getByTestId("menu-count")).toBeVisible();
  await menuPath(page, "menu-more");
  await page.waitForTimeout(300);
  await expect(page.getByTestId("menu-unsubscribe")).toHaveCount(0);
});

test("Spanish", async ({ app: page, server }) => {
  const id = await ingest(server, { id: "weekly-es", subject: "Boletín semanal baja", unsubscribe: ONE_CLICK });
  await server.backend.server.invoke("settings.update", { language: "es" }, ctx);
  await page.reload();
  await page.locator("[data-ready]").waitFor();
  await search(page, '"Boletín semanal baja"');
  await rowOf(page, id).click({ button: "right" });
  await menuPath(page, "menu-more");
  await expect(page.getByTestId("menu-unsubscribe")).toHaveText("Cancelar suscripción weekly.example");
  await page.getByTestId("menu-unsubscribe").click();
  await expect(page.getByTestId("snack-message")).toHaveText("Cancelaste tu suscripción a The Weekly.");
});

test("Codex review #3: the menu moved onto another row never keeps the last row's offer", async ({ app: page, server }) => {
  const shop = await ingest(server, { id: "shop-move", subject: "Moving menu shop deal", from: { name: "Shop", email: "deals@shop.example" }, bodyHtml: '<a href="https://shop.example/bye">Unsubscribe</a>' });
  const ana = await ingest(server, { id: "ana-move", subject: "Moving menu lunch plan", from: { name: "Ana", email: "ana@friends.example" } });
  await search(page, '"Moving menu"');
  const opened = await recordOpens(page);
  // Ana's lookup fails: nothing may stand in for it (the last row's offer least of all)
  const threads = server.backend.store.threads;
  const read = threads.unsubscribeSource.bind(threads);
  threads.unsubscribeSource = (id) => (id === ana ? Promise.reject(new Error("synthetic lookup failure")) : read(id));
  const box = (await rowOf(page, ana).boundingBox())!;
  await rowOf(page, shop).click({ button: "right" });
  await menuPath(page, "menu-more");
  await expect(page.getByTestId("menu-unsubscribe")).toHaveText("Unsubscribe shop.example");
  // right-click the other row while the menu is open (over the menu's backdrop, as a person would): it moves there,
  // and Ana's mail offers nothing
  await page.mouse.click(box.x + 40, box.y + box.height / 2, { button: "right" });
  await menuPath(page, "menu-more");
  await expect(page.getByTestId("menu-sender")).toHaveText("From Ana");
  await expect(page.getByTestId("menu-unsubscribe")).toHaveCount(0);
  await page.waitForTimeout(300);
  await expect(page.getByTestId("menu-unsubscribe")).toHaveCount(0);
  expect(await opened()).toEqual([]);
  threads.unsubscribeSource = read;
});
