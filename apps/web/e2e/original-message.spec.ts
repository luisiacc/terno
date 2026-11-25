/**
 * Show original (plan 272): a message's ⋯ menu and its right-click open its original over the conversation: the
 * summary its headers give (SPF, DKIM and DMARC named with their reporter), its headers, the HTML Terno renders and
 * its source; Copy and Download; Back and Esc return focus to the message's ⋯. A message only on this computer says
 * there's no original, and still shows its HTML. The demo provider makes the original up from what's stored.
 */
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { E2E_NOW } from "./constants";
import { axeBothModes, expect, scenario, selectThread, test } from "./fixtures";
import type { DevServer } from "../../backend-dev/src/server";

const view = (page: Page) => page.getByTestId("original-message");

async function ingest(server: DevServer, id: string, subject: string, html: string): Promise<number> {
  const [account] = await server.backend.store.accounts.list();
  const { touched } = await server.backend.store.sync.ingest([{
    accountId: account!.id, providerMsgId: id, providerThreadId: null, rfcMessageId: `${id}@x.test`, inReplyTo: null, references: [],
    from: { name: "Orla", email: "orla@news.example.test" }, replyTo: [], to: [], cc: [], bcc: [], subject, date: E2E_NOW, snippet: "", bodyText: null, bodyHtml: html, bodyState: "full", listId: null,
    isRead: true, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: html.length,
  }], { applyFilters: false, now: E2E_NOW, classifier: null });
  return touched[0]!;
}

test("Show original: the summary, headers, HTML and source; Copy, Download, and back to the message @variant", async ({ app: page, server, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const threadId = await ingest(server, "orig-1", "Boletín de noviembre", "<table><tr><td><p>Hola <b>Ana</b></p></td></tr></table>");
  await selectThread(page, threadId, 'subject:"Boletín de noviembre"');
  const more = page.getByTestId("reader").getByTestId("message-more").first();

  await scenario("from the ⋯ menu: the summary and the headers, focus on Back", async () => {
    await more.click();
    await page.getByTestId("message-menu-original").click();
    await expect(view(page)).toBeVisible();
    await expect(page.locator("[data-original-back]")).toBeFocused();
    await expect(page.getByTestId("original-subject")).toContainText("Boletín de noviembre");
    await expect(page.getByTestId("original-from")).toContainText("orla@news.example.test");
    await expect(page.getByTestId("original-spf")).toContainText("PASS · orla@news.example.test");
    await expect(page.getByTestId("original-dkim")).toContainText("PASS · news.example.test");
    await expect(page.getByTestId("original-dmarc")).toContainText("PASS · news.example.test");
    await expect(page.getByTestId("original-reporter")).toHaveText("Checked bymx.demo.example.test");
    await expect(page.getByTestId("original-headers")).toContainText("Authentication-Results: mx.demo.example.test;");
    await expect(page.getByTestId("original-headers")).not.toContainText("--demo");
  });

  await scenario("Copy copies the open part: the headers, then the HTML Terno renders", async () => {
    await page.getByTestId("original-copy").click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/^Delivered-To: .*\r?\nReceived: /);
    await expect(page.getByTestId("original-copy")).toHaveText("Copied");
    await page.getByTestId("original-tab-html").click();
    await expect(page.getByTestId("original-copy")).toHaveText("Copy HTML");
    await expect(page.getByTestId("original-html")).toContainText("<p>Hola <b>Ana</b></p>");
    await page.getByTestId("original-copy").click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("<table><tr><td><p>Hola <b>Ana</b></p></td></tr></table>");
  });

  await scenario("the source, and Download saves it whole as <subject>.eml", async () => {
    await page.getByTestId("original-tab-source").click();
    await expect(page.getByTestId("original-source")).toContainText("Content-Type: multipart/alternative");
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("original-download").click()]);
    expect(download.suggestedFilename()).toBe("Boletín de noviembre.eml");
    const saved = readFileSync((await download.path())!, "utf8");
    expect(saved).toMatch(/^Delivered-To: /);
    expect(saved).toContain("--demo--");
  });

  await scenario("in light and dark, axe-clean", async () => {
    await page.getByTestId("original-tab-headers").click();
    await axeBothModes(page, "[data-testid=original-message]");
  });

  await scenario("Esc returns to the conversation, focus on the message's ⋯", async () => {
    await page.keyboard.press("Escape");
    await expect(view(page)).toHaveCount(0);
    await expect(more).toBeFocused();
  });

  await scenario("from a right-click on the message; Back returns to its ⋯", async () => {
    await page.getByTestId("reader").getByTestId("message").first().click({ button: "right", position: { x: 40, y: 12 } });
    await page.getByTestId("message-menu-original").click();
    await expect(view(page)).toBeVisible();
    await expect(page.locator("[data-original-back]")).toBeFocused();
    await page.locator("[data-original-back]").click();
    await expect(view(page)).toHaveCount(0);
    await expect(more).toBeFocused();
  });

  await scenario("by keyboard from ⋯ to Back; arrows and Delete scroll the view, never the list or the conversation (Codex code review #2, #10)", async () => {
    await more.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("message-actions-menu")).toBeVisible();
    // down the rows to the last, as a keyboard goes
    const item = page.getByTestId("message-menu-original");
    for (let i = 0; i < 20 && !(await item.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("ArrowDown");
    await expect(item).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-original-back]")).toBeFocused();
    await page.locator("[data-original-scroller]").focus();
    for (const key of ["ArrowDown", "ArrowUp", "Delete", "Backspace"]) await page.keyboard.press(key);
    await expect(view(page)).toBeVisible();
    await expect(page.getByTestId("reader-subject")).toHaveText("Boletín de noviembre");
    // (searched mail includes the Trash, so a trashed conversation would stay on screen: what's stored says)
    await page.waitForTimeout(300);
    expect((await server.backend.store.threads.get(threadId))!.thread.inTrash).toBe(false);
    await page.keyboard.press("Escape");
    await expect(view(page)).toHaveCount(0);
    await expect(more).toBeFocused();
  });

  const local = await ingest(server, "local:orig-2", "Solo aquí", "<p>Borrador local</p>");
  await scenario("leaving for another conversation ends it: coming back shows the conversation (Codex code review #4)", async () => {
    await more.click();
    await page.getByTestId("message-menu-original").click();
    await expect(view(page)).toBeVisible();
    await selectThread(page, local, 'subject:"Solo aquí"');
    await expect(view(page)).toHaveCount(0);
    await selectThread(page, threadId, 'subject:"Boletín de noviembre"');
    await expect(page.getByTestId("reader-subject")).toHaveText("Boletín de noviembre");
    await expect(view(page)).toHaveCount(0);
  });

  await scenario("a message only on this computer: no original, and its HTML still shows", async () => {
    await selectThread(page, local, 'subject:"Solo aquí"');
    await page.getByTestId("reader").getByTestId("message-more").first().click();
    await page.getByTestId("message-menu-original").click();
    await expect(page.getByTestId("original-none")).toHaveText("This message hasn’t reached your mail server yet, so there’s no original to show.");
    await expect(page.getByTestId("original-html")).toContainText("<p>Borrador local</p>");
    await expect(page.getByTestId("original-download")).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(view(page)).toHaveCount(0);
  });
});
