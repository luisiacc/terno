/**
 * Plan 64: a search looks everywhere (every account, category and place,
 * Spam and Trash too), wherever it was typed; rows say where they live; no
 * sender icon is ever asked for a spam row; actions follow the rows' places.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { IncomingMessage } from "@terno/store";
import { sqlDb, type DevServer } from "../../backend-dev/src/server";
import { DESIGNS } from "../../../packages/ui/src/designs/index";
import { E2E_NOW } from "./constants";
import { expect, focusList, navTo, rows, search, selectRows, test } from "./fixtures";

const ctx = { clientId: "setup", origin: "dev" as const };
const SUBJECT = "Pepinillo quarterly report";

/** One thread per place, from its own sender's site, all with SUBJECT: returns their ids by place. */
async function everyPlace(server: DevServer) {
  const db = sqlDb(server.backend.store);
  const accounts = db.all<{ id: number; email: string }>("SELECT id, email FROM accounts ORDER BY id");
  const places = ["inbox", "archive", "spam", "trash"] as const;
  const messages: IncomingMessage[] = places.map((place, i) => ({
    accountId: accounts[i % accounts.length]!.id,
    providerMsgId: `pepinillo-${place}`,
    providerThreadId: `pepinillo-${place}`,
    rfcMessageId: `<pepinillo-${place}@e2e.test>`,
    inReplyTo: null,
    references: [],
    from: { name: `Sender ${place}`, email: `hello@pepinillo-${place}.com` },
    to: [{ name: "Luis", email: accounts[i % accounts.length]!.email }],
    cc: [],
    bcc: [],
    subject: SUBJECT,
    date: E2E_NOW - (i + 1) * 3_600_000,
    snippet: "The numbers for the quarter.",
    bodyText: "The numbers for the quarter.",
    bodyHtml: null,
    bodyState: "full",
    listId: null,
    isRead: true,
    isStarred: false,
    inInbox: place === "inbox",
    isSent: false,
    isDraft: false,
    isTrash: place === "trash",
    isSpam: place === "spam",
    hasAttachments: false,
    size: 1000,
  }));
  await server.backend.store.sync.ingest(messages, { applyFilters: false, now: E2E_NOW, classifier: null });
  const id = (place: string) => db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE provider_msg_id = ?", `pepinillo-${place}`)!.thread_id;
  return { inbox: id("inbox"), archive: id("archive"), spam: id("spam"), trash: id("trash") };
}

const row = (page: Page, id: number) => page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`);

test.describe("search everywhere", { tag: "@design" }, () => {
  test("typed in Inbox, a search finds Inbox, Archive, Spam and Trash mail at once; Spam and Trash rows say so", async ({ app: page, server }) => {
    const ids = await everyPlace(server);
    await search(page, "pepinillo");
    await expect(rows(page)).toHaveCount(4);
    await expect(page.getByTestId("list-title")).toHaveText("Search");
    await expect(row(page, ids.spam).getByTestId("row-place")).toHaveText("Spam");
    await expect(row(page, ids.trash).getByTestId("row-place")).toHaveText("Trash");
    await expect(row(page, ids.inbox).getByTestId("row-place")).toHaveCount(0);
    await expect(row(page, ids.archive).getByTestId("row-place")).toHaveCount(0);
    // a screen reader hears it, once, at the end of the row
    await expect(row(page, ids.spam)).toContainText(", in Spam");
    // results span accounts: each says whose
    await expect(row(page, ids.inbox).getByTestId("account-label")).toBeVisible();
    // in:all is everything but Spam and Trash
    await search(page, "in:all pepinillo");
    await expect(rows(page)).toHaveCount(2);
  });

  test("started inside an account and a category, it still looks everywhere; a sidebar click leaves it", async ({ app: page, server }) => {
    const ids = await everyPlace(server);
    const facturas = sqlDb(server.backend.store).get<{ id: number }>("SELECT id FROM categories WHERE name = 'Facturas'")!.id;
    await page.getByTestId(`nav-category-${facturas}`).click();
    await search(page, "pepinillo");
    await expect(rows(page)).toHaveCount(4);
    await navTo(page, "inbox");
    await expect(page.getByTestId("list-title")).not.toHaveText("Search");
    await expect(row(page, ids.spam)).toHaveCount(0);
  });

  test("no sender icon is asked for a spam row, in any search (a row in the Inbox is)", async ({ app: page, server }) => {
    // classic rows have no avatar, so no icon to ask for (icons.spec)
    const id = await page.locator("html").getAttribute("data-design");
    test.skip(DESIGNS.find((d) => d.id === id)!.variants.row === "classic", "classic rows show no avatar");
    server.icons.everySite = true;
    await server.backend.server.invoke("settings.update", { senderIcons: true }, ctx);
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    const ids = await everyPlace(server);
    await search(page, "pepinillo");
    await expect(rows(page)).toHaveCount(4);
    await expect(row(page, ids.inbox).getByTestId("sender-icon")).toBeVisible();
    await page.waitForTimeout(500);
    const hosts = server.icons.requests.map((u) => new URL(u).hostname);
    expect(hosts.some((h) => h.endsWith("pepinillo-inbox.com"))).toBe(true);
    expect(hosts.some((h) => h.endsWith("pepinillo-spam.com"))).toBe(false);
    await expect(row(page, ids.spam).getByTestId("sender-icon")).toHaveCount(0);
    // trashed, it is still spam mail: still no icon, after the backend's refresh too (plan 22)
    await row(page, ids.spam).dispatchEvent("mousedown", { button: 0 });
    await focusList(page);
    await page.keyboard.press("#");
    await expect(row(page, ids.spam).getByTestId("row-place")).toHaveText("Trash");
    await search(page, "pepinill");
    await search(page, "pepinillo");
    await expect(rows(page)).toHaveCount(4);
    await page.waitForTimeout(500);
    expect(server.icons.requests.map((u) => new URL(u).hostname).some((h) => h.endsWith("pepinillo-spam.com"))).toBe(false);
    await expect(row(page, ids.spam).getByTestId("sender-icon")).toHaveCount(0);
    await row(page, ids.spam).click({ button: "right" });
    // restored to the Inbox: no longer spam once the backend says so (then its icon is an ordinary one)
    await page.getByTestId("menu-inbox").click();
    await expect(row(page, ids.spam).getByTestId("row-place")).toHaveCount(0);
    await expect.poll(() => sqlDb(server.backend.store).get<{ s: number }>("SELECT count(*) AS s FROM messages WHERE thread_id = ? AND is_spam = 1", ids.spam)!.s).toBe(0);
  });

  test("actions follow each row's place: Restore for Trash, Not spam for Spam; marking a result spam tags it in place", async ({ app: page, server }) => {
    const ids = await everyPlace(server);
    await search(page, "pepinillo");
    await row(page, ids.trash).click({ button: "right" });
    await expect(page.getByTestId("menu-inbox")).toHaveText(/Restore to Inbox|Move to Inbox/);
    await page.keyboard.press("Escape");
    await row(page, ids.spam).click({ button: "right" });
    await expect(page.getByTestId("menu-not-spam")).toBeVisible();
    await page.keyboard.press("Escape");
    // a result marked as spam stays in the results (it still matches), tagged at once
    await row(page, ids.inbox).dispatchEvent("mousedown", { button: 0 });
    await focusList(page);
    await page.keyboard.press("!");
    await expect(row(page, ids.inbox).getByTestId("row-place")).toHaveText("Spam");
    await expect.poll(() => sqlDb(server.backend.store).get<{ s: number }>("SELECT in_spam AS s FROM threads WHERE id = ?", ids.inbox)!.s).toBe(1);
  });

  test("the tags are axe-clean in light and dark", async ({ app: page, server }) => {
    await everyPlace(server);
    await search(page, "pepinillo");
    await expect(rows(page)).toHaveCount(4);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const r = await new AxeBuilder({ page }).include("[data-testid=thread-list]").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(r.violations, scheme).toEqual([]);
    }
  });

  test("a selection spanning places: each action for the rows it fits (Restore the trashed one, Archive the Inbox one)", async ({ app: page, server }) => {
    const ids = await everyPlace(server);
    await search(page, "pepinillo");
    await expect(rows(page)).toHaveCount(4);
    await selectRows(page, [ids.inbox, ids.trash]);
    const bar = page.getByTestId("selection-bar");
    await expect(bar.getByTestId("bar-inbox")).toHaveAccessibleName(/Restore to Inbox/);
    await bar.getByTestId("bar-inbox").click();
    const db = sqlDb(server.backend.store);
    await expect.poll(() => db.get<{ t: number; i: number }>("SELECT in_trash AS t, in_inbox AS i FROM threads WHERE id = ?", ids.trash)).toEqual({ t: 0, i: 1 });
    // the Inbox row was never touched
    expect(db.get<{ i: number }>("SELECT in_inbox AS i FROM threads WHERE id = ?", ids.inbox)).toEqual({ i: 1 });
  });
});
