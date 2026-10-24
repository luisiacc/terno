/**
 * Writing mail. Replies, reply-all and forwards are drafted inline at the end
 * of their conversation (no dialog); new messages still open on their own.
 * Drafts are kept: Esc collapses one, switching threads and reloading keep it,
 * r/a/f resume or convert it without losing what was written, and discarding
 * can be undone.
 */
import type { Page } from "@playwright/test";
import { expect, focusList, openRow, rows, selectThread, test } from "./fixtures";
import { sqlDb } from "../../backend-dev/src/server";

const composer = (page: Page) => page.getByTestId("reader").getByTestId("composer");
const toast = (page: Page, text: string) => page.locator("[data-sonner-toast]").filter({ hasText: text });

test.describe("inline reply, reply-all, forward", () => {
  test("r opens a reply inline, focused, with the quote apart; ⌘↵ sends and the message appears in the thread", async ({ app: page }) => {
    await openRow(page, 0);
    const subject = (await page.getByTestId("reader-subject").textContent())!;
    const before = await page.getByTestId("message").count();
    await focusList(page);
    await page.keyboard.press("r");
    await expect(composer(page)).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(composer(page)).toHaveAccessibleName(/^Responder a /);
    await expect(page.getByTestId("compose-to")).toHaveValue(/^.+ <[^>]+@[^>]+>$/);
    // a reply's subject is there, behind its button
    await expect(page.getByTestId("compose-subject")).toHaveCount(0);
    await page.getByTestId("compose-show-subject").click();
    await expect(page.getByTestId("compose-subject")).toHaveValue(`Re: ${subject}`);
    // the text is the user's alone; the quote is apart
    await expect(page.getByTestId("compose-body")).toHaveValue("");
    await page.getByTestId("compose-quote").click();
    await expect(composer(page)).toContainText("escribió:");
    await page.getByTestId("compose-body").focus();
    await page.keyboard.type("¡Nos vemos ahí!");
    await page.keyboard.press("Meta+Enter");
    await expect(composer(page)).toHaveCount(0);
    await expect(page.getByTestId("quick-reply")).toBeFocused();
    await expect(page.getByTestId("message")).toHaveCount(before + 1);
    await expect(page.getByTestId("message").last()).toContainText("¡Nos vemos ahí!");
    await expect(toast(page, "Correo enviado")).toBeVisible();
  });

  test("the reply opens focused and in view at the end of a long conversation", async ({ app: page }) => {
    await openRow(page, 0);
    await page.getByTestId("quick-reply").click();
    const body = page.getByTestId("compose-body");
    await expect(body).toBeFocused();
    await expect(body).toBeInViewport();
  });

  test("reply-all puts the other recipients in Cc, never me", async ({ app: page, server }) => {
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

  test("f forwards with Fwd: and an empty To (focused); invalid recipients keep the draft open", async ({ app: page }) => {
    await openRow(page, 1);
    const subject = (await page.getByTestId("reader-subject").textContent())!;
    await focusList(page);
    await page.keyboard.press("f");
    await expect(composer(page)).toHaveAccessibleName(/^Reenviar/);
    await expect(page.getByTestId("compose-subject")).toHaveValue(`Fwd: ${subject}`);
    await expect(page.getByTestId("compose-to")).toHaveValue("");
    await expect(page.getByTestId("compose-to")).toBeFocused();
    await page.getByTestId("compose-quote").click();
    await expect(composer(page)).toContainText("Mensaje reenviado");
    await page.getByTestId("compose-to").fill("esto no es un correo");
    await page.getByTestId("compose-send").click();
    await expect(toast(page, "Revisa los destinatarios")).toBeVisible();
    await expect(composer(page)).toBeVisible();
  });

  test("text keys stay text inside the draft: j, k, e, #, r and ⌫ don't navigate, archive or reply", async ({ app: page }) => {
    const id = await openRow(page, 0);
    await focusList(page);
    await page.keyboard.press("r");
    await page.getByTestId("compose-body").focus();
    await page.keyboard.type("jke#r");
    await page.keyboard.press("Backspace");
    await expect(page.getByTestId("compose-body")).toHaveValue("jke#");
    await expect(page.locator("[data-cursor]")).toHaveAttribute("data-thread-id", id);
    await expect(rows(page).filter({ has: page.locator(`[data-thread-id="${id}"]`) })).toHaveCount(0);
    await expect(page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`)).toHaveCount(1);
  });
});

test.describe("drafts are kept", () => {
  test("Esc collapses the draft (focus on it), the text survives switching threads, and Enter reopens it", async ({ app: page }) => {
    const id = await openRow(page, 0);
    await focusList(page);
    await page.keyboard.press("r");
    await page.getByTestId("compose-body").focus();
    await page.keyboard.type("Lo pienso y te digo.");
    await page.keyboard.press("Escape");
    const collapsed = page.getByTestId("draft-collapsed");
    await expect(collapsed).toBeFocused();
    await expect(collapsed).toContainText("Lo pienso y te digo.");
    // the row says it has a draft
    await expect(page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`)).toContainText("Borrador");
    await page.keyboard.press("j");
    await expect(page.locator("[data-cursor]")).not.toHaveAttribute("data-thread-id", id);
    await page.keyboard.press("k");
    await expect(page.locator("[data-cursor]")).toHaveAttribute("data-thread-id", id);
    // coming back never steals focus into the draft
    await expect(page.getByTestId("draft-collapsed")).not.toBeFocused();
    await page.getByTestId("draft-collapsed").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("compose-body")).toBeFocused();
    await expect(page.getByTestId("compose-body")).toHaveValue("Lo pienso y te digo.");
  });

  test("a draft survives a reload: r on its thread resumes it", async ({ app: page }) => {
    const id = await openRow(page, 0);
    await focusList(page);
    await page.keyboard.press("r");
    await page.getByTestId("compose-body").focus();
    await page.keyboard.type("No lo pierdas.");
    await expect(page.getByTestId("draft-status")).toHaveText("Borrador guardado");
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`).dispatchEvent("mousedown");
    await expect(page.getByTestId("reader-subject")).toBeVisible();
    await focusList(page);
    await page.keyboard.press("r");
    await expect(page.getByTestId("compose-body")).toHaveValue("No lo pierdas.");
  });

  test("an unfinished recipient is kept as typed: «bob@» survives a reload", async ({ app: page }) => {
    const id = await openRow(page, 0);
    await focusList(page);
    await page.keyboard.press("f");
    await page.getByTestId("compose-to").fill("alice@example.com, bob@");
    await expect(page.getByTestId("draft-status")).toHaveText("Borrador guardado");
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`).dispatchEvent("mousedown");
    await expect(page.getByTestId("reader-subject")).toBeVisible();
    await focusList(page);
    await page.keyboard.press("f");
    await expect(page.getByTestId("compose-to")).toHaveValue("alice@example.com, bob@");
    // and it isn't sent like that
    await page.getByTestId("compose-send").click();
    await expect(toast(page, "Revisa los destinatarios")).toBeVisible();
  });

  test("r, then a, then f, then r: what was written and typed recipients survive every conversion, even with a save pending; Deshacer goes back", async ({ app: page }) => {
    await openRow(page, 0);
    await focusList(page);
    await page.keyboard.press("r");
    await page.getByTestId("compose-body").focus();
    await page.keyboard.type("Mi respuesta.");
    const to = page.getByTestId("compose-to");
    const auto = await to.inputValue();
    await to.fill(`${auto}, Extra <extra@example.com>`);
    // collapse and convert at once: the autosave hasn't run yet
    await page.keyboard.press("Escape");
    await page.keyboard.press("a");
    await expect(toast(page, "Convertido en Responder a todos")).toBeVisible();
    await expect(composer(page)).toHaveAttribute("data-mode", "replyAll");
    await expect(page.getByTestId("compose-body")).toHaveValue("Mi respuesta.");
    await expect(to).toHaveValue(/extra@example\.com/);
    await page.keyboard.press("Escape");
    await page.keyboard.press("f");
    await expect(composer(page)).toHaveAttribute("data-mode", "forward");
    await expect(page.getByTestId("compose-body")).toHaveValue("Mi respuesta.");
    // a forward drops the recipients Única filled in, keeps the one typed
    await expect(to).toHaveValue("Extra <extra@example.com>");
    await toast(page, "Convertido en Reenviar").getByRole("button", { name: "Deshacer" }).click();
    await expect(composer(page)).toHaveAttribute("data-mode", "replyAll");
    await page.keyboard.press("Escape");
    await page.keyboard.press("r");
    await page.keyboard.press("Escape");
    await page.keyboard.press("r");
    await expect(composer(page)).toHaveAttribute("data-mode", "reply");
    await expect(page.getByTestId("compose-body")).toHaveValue("Mi respuesta.");
    await expect(to).toHaveValue(/extra@example\.com/);
  });

  test("Descartar deletes the draft; Deshacer brings it back", async ({ app: page, server }) => {
    await openRow(page, 0);
    await focusList(page);
    await page.keyboard.press("r");
    await page.getByTestId("compose-body").focus();
    await page.keyboard.type("Quizá no.");
    await expect(page.getByTestId("draft-status")).toHaveText("Borrador guardado");
    await page.getByTestId("compose-discard").click();
    await expect(composer(page)).toHaveCount(0);
    await expect(page.getByTestId("quick-reply")).toBeFocused();
    await expect.poll(() => sqlDb(server.backend.store).get<{ c: number }>("SELECT count(*) AS c FROM drafts")!.c).toBe(0);
    await toast(page, "Borrador descartado").getByRole("button", { name: "Deshacer" }).click();
    await expect(page.getByTestId("compose-body")).toHaveValue("Quizá no.");
    await expect.poll(() => sqlDb(server.backend.store).get<{ c: number }>("SELECT count(*) AS c FROM drafts")!.c).toBe(1);
  });
});

test.describe("new message, in the reader pane", () => {
  test("c writes a new message in the reader (no dialog), with the drafts strip; it lands in Enviados", async ({ app: page }) => {
    await openRow(page, 0);
    await focusList(page);
    await page.keyboard.press("c");
    const form = page.getByRole("form", { name: "Mensaje nuevo" });
    await expect(form).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByTestId("reader")).toHaveCount(0);
    await expect(page.getByTestId("compose-to")).toBeFocused();
    await expect(page.getByTestId("strip-item").first()).toHaveAttribute("aria-current", "true");
    await page.getByTestId("compose-to").fill("Ana Torres <ana@example.com>");
    await page.getByTestId("compose-subject").fill("Propuesta de colaboración");
    await expect(page.getByTestId("compose-title")).toHaveText("Propuesta de colaboración");
    await page.getByTestId("compose-body").fill("Hola Ana, te comparto la propuesta.");
    await page.keyboard.press("Meta+Enter");
    await expect(page.getByTestId("composer")).toHaveCount(0);
    await expect(page.getByTestId("reader")).toBeVisible();
    await expect(page.getByTestId("drafts-strip")).toHaveCount(0);
    await page.getByTestId("nav-sent").click();
    await expect(page.getByTestId("row-subject").first()).toHaveText("Propuesta de colaboración");
  });

  test("Esc leaves the new message (kept, its strip item focused); the conversation shows; the strip brings it back", async ({ app: page }) => {
    const id = await openRow(page, 0);
    await focusList(page);
    await page.keyboard.press("c");
    await page.getByTestId("compose-to").fill("ana@example.com");
    await page.getByTestId("compose-body").fill("Borrador nuevo");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("reader")).toBeVisible();
    await expect(page.locator("[data-cursor]")).toHaveAttribute("data-thread-id", id);
    const item = page.getByTestId("strip-item").first();
    await expect(item).toBeFocused();
    await expect(item).toContainText("Para ana@example.com");
    await item.click();
    await expect(page.getByTestId("compose-body")).toHaveValue("Borrador nuevo");
    // opening a conversation steps the new message aside, kept
    await page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`).dispatchEvent("mousedown");
    await expect(page.getByTestId("reader")).toBeVisible();
    await expect(page.getByTestId("strip-item")).toHaveCount(1);
  });

  test("a bulk selection takes the pane over the new message, which comes back when it clears", async ({ app: page }) => {
    await page.keyboard.press("c");
    await page.getByTestId("compose-body").fill("Sigo aquí");
    const meta = process.platform === "darwin" ? "Meta" : "Control";
    await rows(page).nth(1).click({ modifiers: [meta] });
    await rows(page).nth(2).click({ modifiers: [meta] });
    await expect(page.getByTestId("selection-bar")).toBeVisible();
    await focusList(page);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("compose-body")).toHaveValue("Sigo aquí");
  });

  test("a send in flight can't be sent again: Esc out, reopen from the strip, send again → one send", async ({ app: page, server }) => {
    // hold compose.send so the first send is still in flight
    const handlers = (server.backend.server as unknown as { handlers: Record<string, (...a: unknown[]) => unknown> }).handlers;
    const original = handlers["compose.send"]!;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    handlers["compose.send"] = async (...args: unknown[]) => {
      await gate;
      return original(...args);
    };
    const sends = () => sqlDb(server.backend.store).get<{ c: number }>("SELECT count(*) AS c FROM ops WHERE kind = 'send'")!.c;
    const before = sends();
    await page.keyboard.press("c");
    await page.getByTestId("compose-to").fill("ana@example.com");
    await page.getByTestId("compose-subject").fill("Una sola vez");
    await page.getByTestId("compose-body").fill("Texto");
    await page.keyboard.press("Meta+Enter");
    await expect(page.getByTestId("compose-send")).toBeDisabled();
    await page.keyboard.press("Escape");
    await page.getByTestId("strip-item").filter({ hasText: "Una sola vez" }).click();
    await page.getByTestId("compose-body").focus();
    await page.keyboard.press("Meta+Enter");
    await expect(page.getByTestId("compose-send")).toBeDisabled();
    await expect(page.getByTestId("compose-discard")).toBeDisabled();
    release();
    handlers["compose.send"] = original;
    await expect.poll(sends).toBe(before + 1);
    await page.waitForTimeout(300);
    expect(sends()).toBe(before + 1);
    await expect(page.getByTestId("drafts-strip")).toHaveCount(0);
  });

  test("Bcc is sent, and kept out of To and Cc", async ({ app: page, server }) => {
    await page.keyboard.press("c");
    await page.getByTestId("compose-to").fill("ana@example.com");
    await page.getByTestId("compose-show-bcc").click();
    await expect(page.getByTestId("compose-bcc")).toBeFocused();
    await page.keyboard.type("jefa@example.com");
    await page.getByTestId("compose-subject").fill("Con copia oculta");
    await page.getByTestId("compose-body").fill("Texto");
    await page.getByTestId("compose-send").click();
    await expect(page.getByTestId("composer")).toHaveCount(0);
    await expect
      .poll(() => sqlDb(server.backend.store).get<{ payload_json: string }>("SELECT payload_json FROM ops WHERE kind = 'send' ORDER BY created_at DESC LIMIT 1")?.payload_json ?? "")
      .toContain("jefa@example.com");
    const payload = JSON.parse(sqlDb(server.backend.store).get<{ payload_json: string }>("SELECT payload_json FROM ops WHERE kind = 'send' ORDER BY created_at DESC LIMIT 1")!.payload_json);
    expect(payload.bcc).toEqual([{ name: "", email: "jefa@example.com" }]);
    expect(JSON.stringify(payload.to)).not.toContain("jefa");
  });

  test("a reply draft whose conversation was archived waits in the strip and opens its conversation", async ({ app: page }) => {
    await openRow(page, 0);
    const subject = (await page.getByTestId("reader-subject").textContent())!;
    await focusList(page);
    await page.keyboard.press("r");
    await page.getByTestId("compose-body").focus();
    await page.keyboard.type("Te contesto luego.");
    await page.keyboard.press("Escape");
    await focusList(page);
    await page.keyboard.press("e");
    const item = page.getByTestId("strip-item").filter({ hasText: `Re: ${subject}` });
    await expect(item).toBeVisible();
    await item.click();
    await expect(page.getByTestId("reader-subject")).toHaveText(subject);
    await expect(page.getByTestId("compose-body")).toHaveValue("Te contesto luego.");
  });

  test("new drafts come back to the strip after a reload", async ({ app: page }) => {
    await page.keyboard.press("c");
    await page.getByTestId("compose-to").fill("ana@example.com");
    await page.getByTestId("compose-body").fill("Para después");
    await expect(page.getByTestId("draft-status")).toHaveText("Borrador guardado");
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await page.getByTestId("strip-item").first().click();
    await expect(page.getByTestId("compose-body")).toHaveValue("Para después");
  });
});
