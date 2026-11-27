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

/** In the second account: a draft from the first (compose's fallback) would be wrong */
async function ingest(server: DevServer, key: string, subject: string, body: { html: string } | { text: string }): Promise<{ id: number; accountId: number }> {
  const [, account] = await server.backend.store.accounts.list();
  const { touched } = await server.backend.store.sync.ingest([{
    accountId: account!.id, providerMsgId: key, providerThreadId: null, rfcMessageId: `${key}@x.test`, inReplyTo: null, references: [],
    from: { name: "Esof Team", email: "esof@sender.test" }, replyTo: [], to: [], cc: [], bcc: [], subject, date: E2E_NOW, snippet: "",
    bodyText: "text" in body ? body.text : null, bodyHtml: "html" in body ? body.html : null, bodyState: "full", listId: null,
    isRead: true, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 100,
  }], { applyFilters: false, now: E2E_NOW, classifier: null });
  return { id: touched[0]!, accountId: account!.id };
}

/**
 * Whether the right-click that comes next was cancelled: kept as it starts (capture, on the mail's window or the page's),
 * read once it's over, by the page (mail runs no script)
 */
async function watchCancel(page: Page, frame: boolean): Promise<void> {
  await page.evaluate((frame) => {
    const w = window as unknown as { menuEvent?: Event };
    delete w.menuEvent;
    const on = frame ? document.querySelector<HTMLIFrameElement>("[data-testid=reader] iframe[data-mail]")!.contentWindow! : window;
    on.addEventListener("contextmenu", (e) => { w.menuEvent = e; }, { once: true, capture: true });
  }, frame);
}
const cancelled = (page: Page) => page.evaluate(() => (window as unknown as { menuEvent?: Event }).menuEvent?.defaultPrevented);

test("a right-click on a link in a mail offers the link's own items", async ({ app: page, server, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const html = `<p>Questions? Write to <a id="support" href="mailto:casasupport@support.test?subject=Assessment%2042"><span>casasupport@support.test</span></a>.</p>`
    + `<p>Or to <a id="plain" href="mailto:help@support.test">help</a>, read <a id="page" href="https://support.test/guide">the guide</a>.</p>`
    + `<p><a id="icon" href="mailto:icon@support.test"><img alt="Write to us" width="24" height="24" style="display:inline-block;background:#888"></a></p>`;
  const { id, accountId } = await ingest(server, "link-menu", "Assessment steps", { html });
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

  await scenario("a picture in an address's link is the address's", async () => {
    await mail.locator("#icon img").click({ button: "right" });
    await expect(menu(page).getByTestId("link-menu-new-message")).toHaveText("New message to icon@support.test");
    await close(page);
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
    await watchCancel(page, true);
    await mail.locator("#page").click({ button: "right" });
    await expect.poll(() => cancelled(page)).toBe(false);
    await page.keyboard.press("Escape");
    // (the browser's menu chose the link's words: a selection keeps it for every right-click after)
    await page.evaluate(() => document.querySelector<HTMLIFrameElement>("[data-testid=reader] iframe[data-mail]")!.contentDocument!.getSelection()!.removeAllRanges());
    await expect(menu(page)).toHaveCount(0);
  });

  await scenario("from the keyboard: the menu key on a focused address; not on a page's link (the web's), nor off a link", async () => {
    await mail.locator("#plain").focus();
    await page.keyboard.press("Shift+F10");
    await expect(menu(page).getByTestId("link-menu-new-message")).toHaveText("New message to help@support.test");
    await close(page);
    // (no menu of ours, nor the list's for its selection: a moment for one to have opened)
    await mail.locator("#page").focus();
    await page.keyboard.press("Shift+F10");
    await page.waitForTimeout(300);
    await expect(page.getByRole("menu")).toHaveCount(0);
    const frame = (await page.getByTestId("reader").locator("iframe[data-mail]").boundingBox())!;
    await page.mouse.click(frame.x + frame.width - 12, frame.y + 12);
    await page.keyboard.press("Shift+F10");
    await page.waitForTimeout(300);
    await expect(page.getByRole("menu")).toHaveCount(0);
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

  await scenario("on the web, a page's link in a plain-text mail keeps the browser's menu too", async () => {
    const text = await ingest(server, "link-menu-text", "Plain guide", { text: "Read https://support.test/plain for the steps." });
    await page.keyboard.press("Escape");
    await selectThread(page, text.id, 'subject:"Plain guide"');
    const link = page.getByTestId("reader").getByRole("link", { name: "https://support.test/plain" });
    await watchCancel(page, false);
    await link.click({ button: "right" });
    await expect.poll(() => cancelled(page)).toBe(false);
    await page.keyboard.press("Escape");
    await expect(menu(page)).toHaveCount(0);
  });
});
