/**
 * Plan 59: one sender header. In Lumen the card above the subject is the
 * header of a one-message conversation (who wrote it, to whom, when), so the
 * message shows no second one. Longer conversations keep a header per message;
 * the other designs never had a sender card and don't change.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { sqlDb, type DevServer } from "../../backend-dev/src/server";
import { E2E_NOW } from "./constants";
import { expect, ingestConversation, selectThread, test } from "./fixtures";

const reader = (page: Page) => page.getByTestId("reader");
const card = (page: Page) => page.getByTestId("sender-card");
const ownerEmail = (server: DevServer) => sqlDb(server.backend.store).get<{ email: string }>("SELECT email FROM accounts ORDER BY id LIMIT 1")!.email;
const YUKI = "yuki.gutierrez@acme.studio";
/** what ingestConversation dates a conversation's only message: 8:30 AM in the tests' Mexico City, the same day */
const ONLY = E2E_NOW - 3_600_000;

test.describe("Lumen's sender card", () => {
  test.use({ design: "lumen" });

  test("a one-message conversation shows its header once: the card has To and the date, the message only its body", async ({ app: page, server }) => {
    const id = await ingestConversation(server, { subject: "Propuesta de marca", count: 1, html: 1, now: E2E_NOW });
    await selectThread(page, id, 'subject:"Propuesta de marca"');
    await expect(card(page)).toContainText("Yuki Gutiérrez");
    await expect(card(page)).toContainText(YUKI);
    await expect(card(page).getByTestId("recipients")).toHaveText("To: Luis Cordero");
    const date = card(page).getByTestId("message-date");
    await expect(date).toHaveAttribute("title", /Oct 22, 2026.*8:30\sAM/);
    await expect(date).toHaveAttribute("datetime", new Date(ONLY).toISOString());
    // read out in full; the short form is for the eye
    await expect(date.locator(".sr-only")).toHaveText((await date.getAttribute("title"))!);
    await expect(date.locator("[aria-hidden]")).toHaveText(/^8:30\sAM$/);
    // nothing said twice: one date, one address, no header on the message
    await expect(reader(page).getByTestId("message-date")).toHaveCount(1);
    await expect(reader(page).getByTestId("recipients")).toHaveCount(1);
    await expect(reader(page).getByText(YUKI, { exact: true })).toHaveCount(1);
    await expect(reader(page).getByTestId("message-toggle")).toHaveCount(0);
    await expect(reader(page).getByTestId("message")).toHaveAttribute("data-expanded", "true");
    await expect(reader(page).locator("iframe")).toHaveCount(1);
    expect((await new AxeBuilder({ page }).include("[data-testid=sender-card]").analyze()).violations).toEqual([]);
  });

  test("a right-click on the card is a right-click on the message", async ({ app: page, server }) => {
    const id = await ingestConversation(server, { subject: "Cotización", count: 1, now: E2E_NOW });
    await selectThread(page, id, 'subject:"Cotización"');
    await card(page).getByTestId("recipients").click({ button: "right" });
    await expect(page.getByTestId("message-menu-print")).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("a conversation you started shows you as the sender and who it went to", async ({ app: page, server }) => {
    const id = await ingestConversation(server, { subject: "Seguimiento enviado", count: 1, mineFirst: true, now: E2E_NOW });
    await selectThread(page, id, 'subject:"Seguimiento enviado"');
    await expect(card(page)).toContainText("Luis Cordero");
    await expect(card(page)).toContainText(ownerEmail(server));
    await expect(card(page).getByTestId("recipients")).toHaveText("To: Yuki Gutiérrez");
    await expect(reader(page).getByTestId("message-toggle")).toHaveCount(0);
  });

  test("a reply draft leaves the card alone; a second message brings back a header per message without reloading the first", async ({ app: page, server }) => {
    const id = await ingestConversation(server, { subject: "Fechas del rodaje", count: 1, html: 1, now: E2E_NOW });
    await selectThread(page, id, 'subject:"Fechas del rodaje"');
    await page.keyboard.press("r");
    await expect(page.getByTestId("compose-body")).toBeFocused();
    await expect(card(page).getByTestId("message-date")).toHaveCount(1);
    await expect(reader(page).getByTestId("message-toggle")).toHaveCount(0);
    await page.evaluate(() => ((window as unknown as { __frame: Element | null }).__frame = document.querySelector("[data-testid=reader] [data-testid=message] iframe")));

    await ingestConversation(server, { subject: "Fechas del rodaje", count: 2, html: 1, unread: 1, now: E2E_NOW });
    server.backend.notifyChanged([id]);
    const messages = reader(page).getByTestId("message");
    await expect(messages).toHaveCount(2);
    // the card is the conversation again: who it's with, no date of its own
    await expect(card(page).getByTestId("message-date")).toHaveCount(0);
    await expect(card(page).getByTestId("recipients")).toHaveCount(0);
    await expect(card(page)).not.toHaveAttribute("data-message-id");
    for (const i of [0, 1]) await expect(messages.nth(i).getByTestId("message-toggle")).toHaveAttribute("aria-expanded", "true");
    // the first message's body (and its frame) stayed where it was, and so did the caret
    expect(await page.evaluate(() => (window as unknown as { __frame: Element | null }).__frame?.isConnected)).toBe(true);
    await expect(page.getByTestId("compose-body")).toBeFocused();
  });

  test("in a longer conversation the card's address isn't revealed again on a message header; others' still are", async ({ app: page, server }) => {
    const id = await ingestConversation(server, { subject: "Plan de medios", count: 3, now: E2E_NOW });
    await selectThread(page, id, 'subject:"Plan de medios"');
    const messages = reader(page).getByTestId("message");
    await messages.nth(1).getByTestId("message-toggle").click();
    for (const i of [0, 1, 2]) await expect(messages.nth(i).getByTestId("message-toggle")).toBeVisible();
    await expect(card(page).getByTestId("message-date")).toHaveCount(0);
    await expect(card(page)).toContainText(YUKI);
    await expect(messages.getByText(YUKI, { exact: true })).toHaveCount(0);
    await expect(messages.nth(1).getByText(ownerEmail(server), { exact: true })).toHaveCount(1);
  });

  test("a one-message conversation with attachments keeps them under the body", async ({ app: page, server }) => {
    const row = sqlDb(server.backend.store).get<{ thread_id: number; subject: string }>(
      "SELECT m.thread_id, m.subject FROM messages m JOIN attachments a ON a.message_id = m.id JOIN threads t ON t.id = m.thread_id WHERE t.in_inbox = 1 AND m.subject NOT GLOB '*[^A-Za-z ]*' AND (SELECT count(*) FROM messages x WHERE x.thread_id = m.thread_id) = 1 ORDER BY m.date DESC LIMIT 1",
    )!;
    await selectThread(page, row.thread_id, `subject:"${row.subject}"`);
    await expect(card(page).getByTestId("message-date")).toHaveCount(1);
    await expect(reader(page).getByTestId("message").getByTestId("attachment").first()).toBeVisible();
  });
});

test("a one-message conversation has one header in every design @design", async ({ app: page, server, design }) => {
  const id = await ingestConversation(server, { subject: "Una sola nota", count: 1, now: E2E_NOW });
  await selectThread(page, id, 'subject:"Una sola nota"');
  await expect(reader(page).getByTestId("message-date")).toHaveCount(design === "lumen" ? 1 : 0);
  await expect(reader(page).getByTestId("message-toggle")).toHaveCount(design === "lumen" ? 0 : 1);
  await expect(reader(page).getByTestId("recipients")).toHaveCount(1);
});
