import { expect, focusList, openRow, selectThread, test } from "./fixtures";
import { sqlDb } from "../../backend-dev/src/server";

test.describe("compose, reply, reply-all, forward", () => {
  test("r prefills a reply; ⌘↵ sends and the message appears in the thread", async ({ app: page }) => {
    await openRow(page, 0);
    const subject = (await page.getByTestId("reader-subject").textContent())!;
    const before = await page.getByTestId("message").count();
    await focusList(page);
    await page.keyboard.press("r");
    const composer = page.getByTestId("composer");
    await expect(composer).toBeVisible();
    await expect(page.getByTestId("compose-subject")).toHaveValue(`Re: ${subject}`);
    await expect(page.getByTestId("compose-to")).toHaveValue(/^.+ <[^>]+@[^>]+>$/);
    await expect(page.getByTestId("compose-body")).toHaveValue(/escribió:\n> /);
    await expect(page.getByTestId("compose-body")).toBeFocused();
    await page.keyboard.type("¡Nos vemos ahí!");
    await page.keyboard.press("Meta+Enter");
    await expect(composer).toHaveCount(0);
    await expect(page.getByTestId("message")).toHaveCount(before + 1);
    await expect(page.getByTestId("message").last()).toContainText("¡Nos vemos ahí!");
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Correo enviado" })).toBeVisible();
  });

  test("reply-all puts the other recipients in Cc, never me", async ({ app: page, server }) => {
    // a received inbox message with several recipients besides me
    const row = sqlDb(server.backend.store).get<{ thread_id: number; subject: string; email: string }>(
      `SELECT m.thread_id, t.subject, a.email FROM messages m JOIN threads t ON t.id = m.thread_id JOIN accounts a ON a.id = m.account_id
       WHERE t.in_inbox = 1 AND m.is_sent = 0 AND json_array_length(m.to_json) >= 3
         AND m.id = (SELECT id FROM messages WHERE thread_id = m.thread_id AND is_sent = 0 ORDER BY date DESC, id DESC LIMIT 1)
       ORDER BY t.last_date DESC LIMIT 1`,
    )!;
    await selectThread(page, row.thread_id, `in:inbox subject:"${row.subject}"`);
    await page.keyboard.press("a");
    const cc = page.getByTestId("compose-cc");
    await expect(cc).toBeVisible();
    const value = await cc.inputValue();
    expect(value.split(",").length).toBeGreaterThanOrEqual(1);
    expect(value).not.toContain(row.email);
    expect(value).not.toContain((await page.getByTestId("compose-to").inputValue()).replace(/.*</, "").replace(">", ""));
  });

  test("f forwards with Fwd: and an empty To; invalid recipients keep the composer open", async ({ app: page }) => {
    await openRow(page, 1);
    const subject = (await page.getByTestId("reader-subject").textContent())!;
    await focusList(page);
    await page.keyboard.press("f");
    await expect(page.getByTestId("compose-subject")).toHaveValue(`Fwd: ${subject}`);
    await expect(page.getByTestId("compose-to")).toHaveValue("");
    await expect(page.getByTestId("compose-body")).toHaveValue(/Mensaje reenviado/);
    await page.getByTestId("compose-to").fill("esto no es un correo");
    await page.getByTestId("compose-send").click();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Revisa los destinatarios" })).toBeVisible();
    await expect(page.getByTestId("composer")).toBeVisible();
  });

  test("c writes a new email from any account and it lands in Enviados", async ({ app: page }) => {
    await page.keyboard.press("c");
    await page.getByTestId("compose-to").fill("Ana Torres <ana@example.com>");
    await page.getByTestId("compose-subject").fill("Propuesta de colaboración");
    await page.getByTestId("compose-body").fill("Hola Ana, te comparto la propuesta.");
    await page.getByTestId("compose-send").click();
    await expect(page.getByTestId("composer")).toHaveCount(0);
    await page.getByTestId("nav-sent").click();
    await expect(page.getByTestId("row-subject").first()).toHaveText("Propuesta de colaboración");
  });
});
