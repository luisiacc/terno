/**
 * Plan 284: a right-click on a link in a mail is about the link: an address to write to, look up or copy, never the
 * sender's. Beside the link, the message's own items. On the web a page's link keeps the browser's menu; the desktop's
 * Open link and Copy link are the same items (`menu-link.test.ts` says which link is which).
 */
import type { Page } from "@playwright/test";
import { E2E_NOW } from "./constants";
import { expect, scenario, selectThread, test } from "./fixtures";
import type { DevServer } from "../../backend-dev/src/server";

const menu = (page: Page) => page.getByTestId("message-menu");
type Draft = { mode: string; toText: string; subject: string; accountId: number };
const draft = (page: Page) => page.evaluate(() => (window as unknown as { __terno: { draft(): Draft | undefined } }).__terno.draft() ?? null);

async function close(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[role=menu]") != null)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
}

async function ingest(server: DevServer, html: string): Promise<{ id: number; accountId: number }> {
  const [account] = await server.backend.store.accounts.list();
  const { touched } = await server.backend.store.sync.ingest([{
    accountId: account!.id, providerMsgId: "link-menu", providerThreadId: null, rfcMessageId: "link-menu@x.test", inReplyTo: null, references: [],
    from: { name: "Esof Team", email: "esof@sender.test" }, replyTo: [], to: [], cc: [], bcc: [], subject: "Assessment steps", date: E2E_NOW, snippet: "", bodyText: null, bodyHtml: html, bodyState: "full", listId: null,
    isRead: true, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: html.length,
  }], { applyFilters: false, now: E2E_NOW, classifier: null });
  return { id: touched[0]!, accountId: account!.id };
}

test("a right-click on a link in a mail offers the link's own items", async ({ app: page, server, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const html = `<p>Questions? Write to <a id="support" href="mailto:casasupport@support.test?subject=Assessment%2042"><span>casasupport@support.test</span></a>.</p>`
    + `<p>Or to <a id="plain" href="mailto:help@support.test">help</a>, read <a id="page" href="https://support.test/guide">the guide</a>.</p>`;
  const { id, accountId } = await ingest(server, html);
  await selectThread(page, id, 'subject:"Assessment steps"');
  const mail = page.getByTestId("reader").frameLocator("iframe[data-mail]");
  await expect(mail.locator("#support")).toBeVisible();

  await scenario("an address: write to it, its conversations, copy it; not the sender's", async () => {
    await mail.locator("#support span").click({ button: "right" });
    await expect(menu(page).getByRole("menuitem")).toHaveText(["New message to casasupport@support.test", "Conversations with casasupport@support.test", "Copy address"]);
    await page.evaluate(() => navigator.clipboard.writeText(""));
    await page.getByTestId("link-menu-copy-address").click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("casasupport@support.test");
    await expect(page.getByTestId("snack-message")).toHaveText("Copied: casasupport@support.test");
  });

  await scenario("beside the link, the message's own items", async () => {
    // (empty room past the text: a right-click on a word selects it, which keeps the browser's menu on the web)
    const frame = (await page.getByTestId("reader").locator("iframe[data-mail]").boundingBox())!;
    await page.mouse.click(frame.x + frame.width - 12, frame.y + 12, { button: "right" });
    await expect(menu(page).getByTestId("message-menu-reply")).toBeVisible();
    await expect(menu(page).getByTestId("link-menu-new-message")).toHaveCount(0);
    await close(page);
  });

  await scenario("on the web, a page's link keeps the browser's menu: ours doesn't open, nothing cancels it", async () => {
    // (heard on the frame's window, after the mail's own listener on its document, by the page: the mail runs no script)
    await page.evaluate(() => {
      const w = window as unknown as { cancelled?: boolean };
      document.querySelector<HTMLIFrameElement>("[data-testid=reader] iframe[data-mail]")!.contentWindow!.addEventListener("contextmenu", (e) => { w.cancelled = e.defaultPrevented; }, { once: true });
    });
    await mail.locator("#page").click({ button: "right" });
    await expect.poll(() => page.evaluate(() => (window as unknown as { cancelled?: boolean }).cancelled)).toBe(false);
    await page.keyboard.press("Escape");
    // (the browser's menu chose the link's words: a selection keeps it for every right-click after)
    await page.evaluate(() => document.querySelector<HTMLIFrameElement>("[data-testid=reader] iframe[data-mail]")!.contentDocument!.getSelection()!.removeAllRanges());
    await expect(menu(page)).toHaveCount(0);
  });

  await scenario("from the keyboard: the menu key on a focused link", async () => {
    await mail.locator("#plain").focus();
    await page.keyboard.press("Shift+F10");
    await expect(menu(page).getByTestId("link-menu-new-message")).toHaveText("New message to help@support.test");
    await close(page);
  });

  await scenario("its conversations: the address, searched", async () => {
    await mail.locator("#plain").click({ button: "right" });
    await page.getByTestId("link-menu-conversations").click();
    await expect(page.getByTestId("search-input")).toHaveValue("help@support.test");
    await page.getByTestId("search-input").fill("");
    await selectThread(page, id, 'subject:"Assessment steps"');
  });

  await scenario("a new message to it, from the conversation's account, with the link's subject", async () => {
    await mail.locator("#support").click({ button: "right" });
    await page.getByTestId("link-menu-new-message").click();
    await expect.poll(() => draft(page)).toMatchObject({ mode: "new", toText: "casasupport@support.test", subject: "Assessment 42", accountId });
    // the menu went: shortcuts aren't left waiting on it
    expect(await page.evaluate(() => (window as unknown as { __terno: { getApp(): { menuOpen: boolean } } }).__terno.getApp().menuOpen)).toBe(false);
  });
});
