/**
 * The reader as a conversation: flat messages, native disclosure buttons
 * (Enter and Space, aria-expanded/aria-controls), bodies mounted only while
 * open, and runs of collapsed messages folded into "N more messages".
 */
import { E2E_NOW } from "./constants";
import { expect, focusList, ingestConversation, openRow, search, selectThread, test } from "./fixtures";

test.describe("reader conversation", { tag: "@design" }, () => {
  test("messages are disclosure buttons that work with Enter and Space; collapsed bodies aren't mounted", async ({ app: page, server }) => {
    const id = await ingestConversation(server, { subject: "Propuesta campaña de Navidad", count: 3, now: E2E_NOW });
    await selectThread(page, id, 'subject:"Propuesta campaña de Navidad"');
    const reader = page.getByTestId("reader");
    const messages = reader.getByTestId("message");
    await expect(messages).toHaveCount(3);
    // read conversation: only the last message is open
    const first = messages.nth(0).getByTestId("message-toggle");
    await expect(first).toHaveAttribute("aria-expanded", "false");
    const region = await first.getAttribute("aria-controls");
    expect(region).toBe(`msg-body-${(await messages.nth(0).locator("[id^=msg-body-]").getAttribute("id"))!.replace("msg-body-", "")}`);
    // nothing of the collapsed body is in the DOM
    await expect(page.locator(`#${region}`)).toBeEmpty();
    await expect(messages.nth(2).getByTestId("message-toggle")).toHaveAttribute("aria-expanded", "true");

    await first.focus();
    await page.keyboard.press("Enter");
    const header = messages.nth(0).getByTestId("message-toggle");
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(`#${region}`)).toContainText("Mensaje 1");
    // focus stays on the same control through both transitions: no refocusing
    await expect(header).toBeFocused();
    await page.keyboard.press(" ");
    await expect(header).toBeFocused();
    await expect(messages.nth(0).getByTestId("message-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(`#${region}`)).toBeEmpty();
  });

  test("4 or more collapsed messages in a row fold into «N more messages»", async ({ app: page, server }) => {
    const id = await ingestConversation(server, { subject: "Sprint de diseño", count: 7, now: E2E_NOW });
    await selectThread(page, id, 'subject:"Sprint de diseño"');
    const more = page.getByTestId("more-messages");
    await expect(more).toHaveText("6 more messages");
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("message")).toHaveCount(1);
    await more.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("message")).toHaveCount(7);
    await expect(more).toHaveCount(0);
    // focus goes to the first message it revealed, not to the document
    await expect(page.getByTestId("message").first().getByTestId("message-toggle")).toBeFocused();
    await focusList(page);
  });

  test("HTML bodies mount on expand and leave nothing behind when collapsed", async ({ app: page, server }) => {
    const id = await ingestConversation(server, { subject: "Presupuesto anual", count: 3, html: 3, now: E2E_NOW });
    await selectThread(page, id, 'subject:"Presupuesto anual"');
    const frames = page.locator("[data-testid=reader] iframe");
    await expect(frames).toHaveCount(1);
    await page.getByTestId("message").nth(0).getByTestId("message-toggle").click();
    await expect(frames).toHaveCount(2);
    await page.getByTestId("message").nth(0).getByTestId("message-toggle").click();
    await expect(frames).toHaveCount(1);
  });

  test("attachments are view-only tiles: name, type and size, no download control", async ({ app: page }) => {
    await search(page, "has:attachment");
    await openRow(page, 0);
    const tile = page.getByTestId("attachment").first();
    await expect(tile).toBeVisible();
    await expect(tile).toContainText(/\d/);
    await expect(page.getByTestId("attachment").getByRole("button")).toHaveCount(0);
  });

  test("the reply bar after the last message starts a reply to who wrote last", async ({ app: page }) => {
    await openRow(page, 0);
    const subject = (await page.getByTestId("reader-subject").textContent())!;
    await expect(page.getByTestId("quick-reply")).toContainText(/Reply to \S+…$/);
    await page.getByTestId("quick-reply").click();
    await expect(page.getByTestId("reader").getByTestId("composer")).toBeVisible();
    await page.getByTestId("compose-show-subject").click();
    await expect(page.getByTestId("compose-subject")).toHaveValue(`Re: ${subject}`);
  });
});
