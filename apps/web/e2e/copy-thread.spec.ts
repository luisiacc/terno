/**
 * Copy conversation as text (plan 149): a right-click anywhere in the thread, the list's menu and the palette all
 * put the same formatted text on the clipboard; the composer and the full-message view's controls stay out of it;
 * the mail's remote content never loads. What the text says is `thread-text.test.ts`.
 */
import type { Page } from "@playwright/test";
import { E2E_NOW } from "./constants";
import { menuPath, expect, focusList, ingestPrintFixtures, scenario, selectThread, test } from "./fixtures";
import type { DevServer } from "../../backend-dev/src/server";

const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
const blank = (page: Page) => page.evaluate(() => navigator.clipboard.writeText(""));
const menu = (page: Page) => page.getByTestId("message-menu");

/** Once the menu holds focus (a key before that goes to where the click was: a mail's frame), Escape; shortcuts wait until it has really gone. */
async function close(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[role=menu]") != null)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
}

async function ingest(server: DevServer, id: string, subject: string, html: string): Promise<number> {
  const [account] = await server.backend.store.accounts.list();
  const { touched } = await server.backend.store.sync.ingest([{
    accountId: account!.id, providerMsgId: id, providerThreadId: null, rfcMessageId: `${id}@x.test`, inReplyTo: null, references: [],
    from: { name: "Long", email: "long@x.test" }, replyTo: [], to: [], cc: [], bcc: [], subject, date: E2E_NOW, snippet: "", bodyText: null, bodyHtml: html, bodyState: "full", listId: null,
    isRead: true, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: html.length,
  }], { applyFilters: false, now: E2E_NOW, classifier: null });
  return touched[0]!;
}

async function copied(page: Page): Promise<string> {
  await expect.poll(() => clipboard(page)).not.toBe("");
  return clipboard(page);
}

test("copying a conversation as text: from the thread, the list and the palette", async ({ app: page, server, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const ids = await ingestPrintFixtures(server);
  await selectThread(page, ids["inline-replies"], 'subject:"Preguntas sobre el contrato"');
  const scroller = page.locator("[data-reader-scroller]");
  await page.getByTestId("more-messages").click();
  const messages = page.getByTestId("reader").getByTestId("message");
  await expect(messages).toHaveCount(5);

  await scenario("on a message: the text, and that message's own actions; the text is the whole thread, once", async () => {
    await messages.nth(1).getByTestId("message-toggle").click({ button: "right" });
    await expect(menu(page).getByRole("menuitem")).toHaveText(["Reply", "Forward", "Copy conversation as text", "Print this message…", "Export message as PDF…"]);
    await blank(page);
    await page.getByTestId("message-menu-copy-text").click();
    const text = await copied(page);
    expect(text).toMatch(/^Subject: Preguntas sobre el contrato de servicios\n\nFrom: /);
    expect(text.match(/^From: /gm)).toHaveLength(5);
    expect(text.split("\n---\n")).toHaveLength(5);
    // Outlook's HTML lines, formatted; its history below them gone
    expect(text).toContain("Perfecto, con eso lo firmamos el lunes.\n\nSaludos,\nAna Ruiz\nDespacho Ruiz & Asociados");
    await expect(page.getByTestId("snack-message")).toHaveText("Copied 5 messages");
  });

  await scenario("in an HTML mail's frame, which replays its right-click", async () => {
    const frame = messages.last().locator("iframe");
    await expect(frame).toBeVisible();
    await frame.scrollIntoViewIfNeeded();
    const box = (await frame.boundingBox())!;
    await page.mouse.click(box.x + 40, box.y + 12, { button: "right" });
    await expect(page.getByTestId("message-menu-copy-text")).toBeVisible();
    await expect(page.getByTestId("message-menu-print")).toBeVisible();
    await close(page);
  });

  await scenario("on the background and the header: only the text", async () => {
    const box = (await scroller.boundingBox())!;
    await page.mouse.click(box.x + 3, box.y + box.height - 12, { button: "right" });
    await expect(menu(page).getByRole("menuitem")).toHaveText(["Copy conversation as text"]);
    await close(page);
    await scroller.evaluate((el) => el.scrollTo(0, 0));
    await page.getByTestId("reader").getByRole("heading").first().click({ button: "right" });
    await expect(menu(page).getByRole("menuitem")).toHaveText(["Copy conversation as text"]);
    await close(page);
  });

  await scenario("the composer keeps its own right-click: no menu, nothing cancelled", async () => {
    await focusList(page);
    await page.keyboard.press("r");
    const editor = page.locator('[data-reader-scroller] [contenteditable="true"]').first();
    await expect(editor).toBeVisible();
    const cancelled = page.evaluate(() => new Promise<boolean>((resolve) => document.addEventListener("contextmenu", (e) => setTimeout(() => resolve(e.defaultPrevented)), { once: true })));
    await editor.click({ button: "right" });
    expect(await cancelled).toBe(false);
    await expect(menu(page)).toHaveCount(0);
    await page.keyboard.press("Escape");
  });

  await scenario("from the list's menu", async () => {
    await selectThread(page, ids.images, 'subject:"Fotos de la visita"');
    const row = page.locator(`[role=listbox] [data-thread-id="${ids.images}"]`);
    await row.click({ button: "right" });
    await blank(page);
    await menuPath(page, "menu-more");
    await page.getByTestId("menu-copy-text").click();
    expect(await copied(page)).toMatch(/^Subject: Fotos de la visita a la obra/);
  });

  await scenario("from the palette, on the open thread", async () => {
    await blank(page);
    await page.keyboard.press("ControlOrMeta+k");
    await page.keyboard.type("copy conversation");
    await page.getByTestId("palette-copy-text").click();
    const text = await copied(page);
    // images are their descriptions, inline ones aren't attachments
    expect(text).toContain("Vista del terreno desde el acceso norte");
    expect(text).toMatch(/^Attachments: Reporte de visita 22-10-2026\.pdf$/m);
  });
});

test("a link reaches both kinds of paste: real in a document, written out in a composer", async ({ app: page, server, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const html = '<p>See <a href="https://x.test/report?a=1">the <b>report</b></a> and <a href="https://x.test/b">https://x.test/b</a>.</p>';
  await selectThread(page, await ingest(server, "linked-copy", "Linked copy", html), 'subject:"Linked copy"');
  await blank(page);
  await page.locator("[data-reader-scroller]").getByRole("heading").first().click({ button: "right" });
  await page.getByTestId("message-menu-copy-text").click();
  expect(await copied(page)).toContain("See the report (https://x.test/report?a=1) and https://x.test/b.");
  const rich = await page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    return (await item!.getType("text/html")).text();
  });
  expect(rich).toContain('<a href="https://x.test/report?a=1">the <b>report</b></a>');
  expect(rich).toContain('<a href="https://x.test/b">https://x.test/b</a>');
});

test("copying loads nothing the mail points at: a pixel, a frame and a stylesheet", async ({ app: page, server, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const html = '<link rel="stylesheet" href="https://css.tracker.test/a.css"><p>Tracked words</p><iframe src="https://frame.tracker.test/"></iframe><img src="https://pixel.tracker.test/p.gif" alt=""><object data="https://object.tracker.test/o"></object>';
  await selectThread(page, await ingest(server, "tracked-copy", "Tracked copy", html), 'subject:"Tracked copy"');
  // from here on: the reader's own frame asked as it opened, and its CSP refused (not this feature's request)
  await expect(page.locator("iframe[data-mail]").first()).toBeVisible();
  await page.waitForTimeout(300);
  const remote: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).hostname.endsWith("tracker.test")) remote.push(r.url());
  });
  await blank(page);
  const box = (await page.locator("[data-reader-scroller]").boundingBox())!;
  await page.mouse.click(box.x + 3, box.y + box.height - 12, { button: "right" });
  await page.getByTestId("message-menu-copy-text").click();
  expect(await copied(page)).toContain("Tracked words");
  await page.waitForTimeout(200);
  expect(remote).toEqual([]);
});

test("the full-message view: its own text gets the menu, its controls don't", async ({ app: page, server, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const html = `<div>${Array.from({ length: 1400 }, (_, i) => `<p style="margin:0;height:20px">Line ${i}</p>`).join("")}</div>`;
  await selectThread(page, await ingest(server, "tall-copy", "Very tall copy", html), 'subject:"Very tall copy"');
  await page.getByRole("button", { name: "Show full message", exact: true }).click();
  const scroller = page.locator("[data-full-message-scroller]");
  await expect(scroller.locator("iframe")).toBeVisible();
  await page.getByRole("region", { name: /./ }).filter({ has: scroller }).locator("p").first().click({ button: "right" });
  await expect(menu(page)).toHaveCount(0);
  const box = (await scroller.locator("iframe").boundingBox())!;
  await page.mouse.click(box.x + 40, box.y + 12, { button: "right" });
  await expect(menu(page)).toHaveCount(1);
  await blank(page);
  await page.getByTestId("message-menu-copy-text").click();
  const text = await copied(page);
  expect(text).toContain("Line 0\nLine 1\n");
  expect(text).toContain("Line 1399");
});
