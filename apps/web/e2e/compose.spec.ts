/**
 * Writing mail. Replies, reply-all and forwards are drafted inline at the end
 * of their conversation (no dialog); new messages still open on their own.
 * Drafts are kept: Esc collapses one, switching threads and reloading keep it,
 * r/a/f resume or convert it without losing what was written, and discarding
 * can be undone.
 */
import type { Page } from "@playwright/test";
import { UNDO_SEND_MS } from "@terno/core";
import { E2E_NOW } from "./constants";
import { axeBothModes, addRecipients, chipsOf, expect, navTo, focusList, ingestConversation, openRow, recipientEmails, rows, selectThread, stabilize, test, scenario, freshNoDrafts, respond } from "./fixtures";
import { sqlDb } from "../../backend-dev/src/server";

const composer = (page: Page) => page.getByTestId("reader").getByTestId("composer");
const toast = (page: Page, text: string) => page.locator("[data-testid=snack]").filter({ hasText: text });

test.describe("inline reply, reply-all, forward", () => {
  test("r, a and f: a reply, reply-all, a forward, and text keys", async ({ app: page, server }) => {
    await scenario("r opens a reply inline, focused, with the quote apart; ⌘↵ sends and the message appears in the thread", async () => {
      await openRow(page, 0);
      const subject = (await page.getByTestId("reader-subject").textContent())!;
      const before = await page.getByTestId("message").count();
      await focusList(page);
      await page.keyboard.press("r");
      await expect(composer(page)).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(composer(page)).toHaveAccessibleName(/^Reply to /);
      // the sender, as a chip (plan 34)
      await expect(chipsOf(page, "compose-to")).toHaveCount(1);
      await expect(chipsOf(page, "compose-to")).toHaveAttribute("data-email", /@/);
      await expect(page.getByTestId("compose-to")).toHaveValue("");
      // a reply's subject is there, behind its button
      await expect(page.getByTestId("compose-subject")).toHaveCount(0);
      await page.getByTestId("compose-show-subject").click();
      await expect(page.getByTestId("compose-subject")).toHaveValue(`Re: ${subject}`);
      // the text is the user's alone; the quote is apart
      await expect(page.getByTestId("compose-body")).toHaveText("");
      await page.getByTestId("compose-quote").click();
      await expect(composer(page)).toContainText("wrote:");
      await page.getByTestId("compose-body").focus();
      await page.keyboard.type("¡Nos vemos ahí!");
      await page.keyboard.press("Meta+Enter");
      await expect(composer(page)).toHaveCount(0);
      await expect(page.getByTestId("quick-reply")).toBeFocused();
      await expect(page.getByTestId("message")).toHaveCount(before + 1);
      // a reply is sent rich (plan 16): the sent copy reads as HTML, in its frame
      await expect(page.getByTestId("message").last().locator("iframe").contentFrame().locator("body")).toContainText("¡Nos vemos ahí!");
      await expect(toast(page, "Message sent")).toBeVisible();
    });
    await scenario("the reply opens focused and in view at the end of a long conversation", async () => {
      await freshNoDrafts(page, server);
      await openRow(page, 0);
      await page.getByTestId("quick-reply").click();
      const body = page.getByTestId("compose-body");
      await expect(body).toBeFocused();
      await expect(body).toBeInViewport();
    });
    await scenario("reply-all puts the other recipients in Cc, never me", async () => {
      await freshNoDrafts(page, server);
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
      const ccs = await recipientEmails(page, "compose-cc");
      const to = await recipientEmails(page, "compose-to");
      expect(ccs.length).toBeGreaterThanOrEqual(1);
      expect(ccs).not.toContain(row.email);
      expect(ccs).not.toContain(to[0]);
    });
    await scenario("f forwards with Fwd: and an empty To (focused); invalid recipients keep the draft open", async () => {
      await freshNoDrafts(page, server);
      await openRow(page, 1);
      const subject = (await page.getByTestId("reader-subject").textContent())!;
      await focusList(page);
      await page.keyboard.press("f");
      await expect(composer(page)).toHaveAccessibleName(/^Forward/);
      await expect(page.getByTestId("compose-subject")).toHaveValue(`Fwd: ${subject}`);
      await expect(page.getByTestId("compose-to")).toHaveValue("");
      await expect(page.getByTestId("compose-to")).toBeFocused();
      await page.getByTestId("compose-quote").click();
      await expect(composer(page)).toContainText("Forwarded message");
      await page.getByTestId("compose-to").fill("esto no es un correo");
      // it reads as unavailable, and a click still says why (plan 158: force, as Playwright won't click aria-disabled)
      await page.getByTestId("compose-send").click({ force: true });
      // Send says which entry isn't an address, at its field, and shows it: its chip selected (plan 34)
      await expect(page.getByTestId("compose-field-problem")).toHaveText("“esto no es un correo” isn’t an email address. Fix or remove it, then send.");
      await expect(composer(page)).toBeVisible();
      await expect(chipsOf(page, "compose-to").first()).toBeFocused();
      await expect(chipsOf(page, "compose-to").first()).toHaveAttribute("aria-invalid", "true");
    });
    await scenario("text keys stay text inside the draft: j, k, e, #, r and ⌫ don't navigate, archive or reply", async () => {
      await freshNoDrafts(page, server);
      const id = await openRow(page, 0);
      await focusList(page);
      await page.keyboard.press("r");
      await page.getByTestId("compose-body").focus();
      await page.keyboard.type("jke#r");
      await page.keyboard.press("Backspace");
      await expect(page.getByTestId("compose-body")).toHaveText("jke#");
      await expect(page.locator("[data-cursor]")).toHaveAttribute("data-thread-id", id);
      await expect(rows(page).filter({ has: page.locator(`[data-thread-id="${id}"]`) })).toHaveCount(0);
      await expect(page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`)).toHaveCount(1);
    });
  });

  test("a reply sent: where the reader goes", async ({ app: page, server }) => {
    await scenario("a reply sent from the thread scrolls the reader to it, wherever the reader was", async () => {
      await page.setViewportSize({ width: 1100, height: 520 });
      await openRow(page, 0);
      const before = await page.getByTestId("message").count();
      await page.getByTestId("quick-reply").click();
      const body = page.getByTestId("compose-body");
      await expect(body).toBeFocused();
      await page.keyboard.type("Enviado y a la vista");
      // the reader back at the top: the sent message lands below the fold
      const scroller = page.locator("[data-reader-scroller]");
      await scroller.evaluate((el) => { el.scrollTop = 0; });
      await page.keyboard.press("Meta+Enter");
      await expect(page.getByTestId("message")).toHaveCount(before + 1);
      const sent = page.getByTestId("message").last();
      await expect(sent).toBeInViewport();
      // its top, not just a sliver of its foot
      await expect.poll(async () => {
        const [m, s] = await Promise.all([sent.boundingBox(), scroller.boundingBox()]);
        return m!.y >= s!.y && m!.y < s!.y + s!.height / 2;
      }).toBe(true);
    });
    await scenario("a reply sent into a run of read messages shows open, never folded away", async () => {
      await freshNoDrafts(page, server);
      // mail dated after the send (a skewed clock): the sent copy sorts first, ahead of five read messages
      const id = await ingestConversation(server, { subject: "Reloj adelantado", count: 6, now: E2E_NOW + 10 * 86_400_000 });
      await selectThread(page, id, 'subject:"Reloj adelantado"');
      await page.getByTestId("quick-reply").click();
      await expect(page.getByTestId("compose-body")).toBeFocused();
      await page.keyboard.type("Primero en la fila");
      await page.keyboard.press("Meta+Enter");
      await expect(page.getByTestId("message")).toHaveCount(2);
      const sent = page.getByTestId("message").first();
      await expect(sent.getByTestId("message-toggle")).toHaveAttribute("aria-expanded", "true");
      await expect(sent.locator("iframe").contentFrame().locator("body")).toContainText("Primero en la fila");
      await expect(sent).toBeInViewport();
      await expect(page.getByTestId("more-messages")).toHaveCount(1);
    });
  });

});

test.describe("drafts are kept", () => {
  test("drafts are kept: Esc, a reload, a typed recipient, conversions, Discard", async ({ app: page, server }) => {
    await scenario("Esc collapses the draft (focus on it), the text survives switching threads, and Enter reopens it", async () => {
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
      await expect(page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`)).toContainText("Draft");
      await page.keyboard.press("j");
      await expect(page.locator("[data-cursor]")).not.toHaveAttribute("data-thread-id", id);
      await page.keyboard.press("k");
      await expect(page.locator("[data-cursor]")).toHaveAttribute("data-thread-id", id);
      // plan 158: it comes back to its own conversation, one line, its source checked (plan 44); only a key opens it
      await expect(page.getByTestId("draft-slot")).toHaveAttribute("data-state", "collapsed");
      await expect(page.getByTestId("draft-collapsed")).toContainText("Lo pienso y te digo.");
      await expect(page.getByTestId("compose-body")).toHaveCount(0);
      await expect(page.getByTestId("strip-item")).toHaveCount(0);
      await expect(page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`)).toContainText("Draft");
      await page.keyboard.press("r");
      await expect(page.getByTestId("compose-body")).toBeFocused();
      await expect(page.getByTestId("compose-body")).toHaveText("Lo pienso y te digo.");
      await page.keyboard.press("Escape");
      await page.getByTestId("draft-collapsed").focus();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("compose-body")).toBeFocused();
      await expect(page.getByTestId("compose-body")).toHaveText("Lo pienso y te digo.");
    });
    await scenario("a draft survives a reload: r on its thread resumes it", async () => {
      await freshNoDrafts(page, server);
      const id = await openRow(page, 0);
      await focusList(page);
      await page.keyboard.press("r");
      await page.getByTestId("compose-body").focus();
      await page.keyboard.type("No lo pierdas.");
      await expect(page.getByTestId("draft-status")).toHaveText("Saved");
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`).dispatchEvent("mousedown");
      await expect(page.getByTestId("reader-subject")).toBeVisible();
      await focusList(page);
      await page.keyboard.press("r");
      await expect(page.getByTestId("compose-body")).toHaveText("No lo pierdas.");
    });
    await scenario("an unfinished recipient is kept as typed: «bob@» survives a reload", async () => {
      await freshNoDrafts(page, server);
      const id = await openRow(page, 0);
      await focusList(page);
      await page.keyboard.press("f");
      await page.getByTestId("compose-to").fill("alice@example.com, bob@");
      await expect(page.getByTestId("draft-status")).toHaveText("Saved");
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`).dispatchEvent("mousedown");
      await expect(page.getByTestId("reader-subject")).toBeVisible();
      await focusList(page);
      await page.keyboard.press("f");
      // two chips, Bob's marked (plan 34)
      expect(await recipientEmails(page, "compose-to")).toEqual(["alice@example.com", "bob@"]);
      await expect(chipsOf(page, "compose-to").nth(1)).toHaveAttribute("aria-invalid", "true");
      // and it isn't sent like that
      await page.getByTestId("compose-send").click({ force: true });
      await expect(page.getByTestId("compose-field-problem")).toHaveText("“bob@” isn’t an email address. Fix or remove it, then send.");
    });
    await scenario("r, then a, then f, then r: what was written and typed recipients survive every conversion, even with a save pending; Undo goes back", async () => {
      await freshNoDrafts(page, server);
      await openRow(page, 0);
      await focusList(page);
      await page.keyboard.press("r");
      await page.getByTestId("compose-body").focus();
      await page.keyboard.type("Mi respuesta.");
      const to = page.getByTestId("compose-to");
      await addRecipients(page, "compose-to", "Extra <extra@example.com>");
      // collapse and convert at once: the autosave hasn't run yet
      await page.keyboard.press("Escape");
      await page.keyboard.press("a");
      await expect(toast(page, "Converted to reply all")).toBeVisible();
      await expect(composer(page)).toHaveAttribute("data-mode", "replyAll");
      await expect(page.getByTestId("compose-body")).toHaveText("Mi respuesta.");
      expect(await recipientEmails(page, "compose-to")).toContain("extra@example.com");
      await page.keyboard.press("Escape");
      await page.keyboard.press("f");
      await expect(composer(page)).toHaveAttribute("data-mode", "forward");
      await expect(page.getByTestId("compose-body")).toHaveText("Mi respuesta.");
      // a forward drops the recipients Terno filled in, keeps the one typed
      await expect.poll(() => recipientEmails(page, "compose-to")).toEqual(["extra@example.com"]);
      await expect(to).toHaveValue("");
      await toast(page, "Converted to a forward").getByTestId("snack-action").click();
      await expect(composer(page)).toHaveAttribute("data-mode", "replyAll");
      await page.keyboard.press("Escape");
      await page.keyboard.press("r");
      // Source validation is asynchronous; wait for this explicit open before the next Escape.
      await expect(composer(page)).toHaveAttribute("data-mode", "reply");
      await expect(page.getByTestId("compose-body")).toBeFocused();
      await page.keyboard.press("Escape");
      await page.keyboard.press("r");
      await expect(composer(page)).toHaveAttribute("data-mode", "reply");
      await expect(page.getByTestId("compose-body")).toHaveText("Mi respuesta.");
      expect(await recipientEmails(page, "compose-to")).toContain("extra@example.com");
    });
    await scenario("converting while the draft is open shows what the new mode fills in: Cc after reply-all, Subject after forward", async () => {
      await freshNoDrafts(page, server);
      const row = sqlDb(server.backend.store).get<{ thread_id: number; subject: string }>(
        `SELECT m.thread_id, t.subject FROM messages m JOIN threads t ON t.id = m.thread_id
         WHERE t.in_inbox = 1 AND m.is_sent = 0 AND json_array_length(m.to_json) >= 3
           AND m.id = (SELECT id FROM messages WHERE thread_id = m.thread_id AND is_sent = 0 ORDER BY date DESC, id DESC LIMIT 1)
         ORDER BY t.last_date DESC LIMIT 1`,
      )!;
      await selectThread(page, row.thread_id, `in:inbox subject:"${row.subject}"`);
      await page.keyboard.press("r");
      await page.getByTestId("compose-body").focus();
      await page.keyboard.type("Escribiendo.");
      await expect(page.getByTestId("compose-cc")).toHaveCount(0);
      // no collapse in between: the palette converts the open draft (Reply all isn't in the toolbar, plan 158), focus kept in it
      await respond(page, "reply-all");
      await expect(composer(page)).toHaveAttribute("data-mode", "replyAll");
      await expect(page.getByTestId("compose-body")).toBeFocused();
      await expect(page.getByTestId("compose-cc")).toBeVisible();
      expect((await recipientEmails(page, "compose-cc")).length).toBeGreaterThan(0);
      await respond(page, "forward");
      await expect(composer(page)).toHaveAttribute("data-mode", "forward");
      await expect(page.getByTestId("compose-subject")).toBeVisible();
      await expect(page.getByTestId("compose-subject")).toHaveValue(/^Fwd: /);
    });
    await scenario("Discard deletes the draft; Undo brings it back", async () => {
      await freshNoDrafts(page, server);
      await openRow(page, 0);
      await focusList(page);
      await page.keyboard.press("r");
      await page.getByTestId("compose-body").focus();
      await page.keyboard.type("Quizá no.");
      await expect(page.getByTestId("draft-status")).toHaveText("Saved");
      await page.getByTestId("compose-discard").click();
      await expect(composer(page)).toHaveCount(0);
      await expect(page.getByTestId("quick-reply")).toBeFocused();
      await expect.poll(() => sqlDb(server.backend.store).get<{ c: number }>("SELECT count(*) AS c FROM drafts")!.c).toBe(0);
      await toast(page, "Draft discarded").getByTestId("snack-action").click();
      await expect(page.getByTestId("compose-body")).toHaveText("Quizá no.");
      await expect.poll(() => sqlDb(server.backend.store).get<{ c: number }>("SELECT count(*) AS c FROM drafts")!.c).toBe(1);
    });
  });

});

test.describe("new message, in the reader pane", () => {
  // plan 139: where the control is, a design's variant: the list header, the sidebar's pill, outline or row
  test("the compose control opens a new message, focused in To, and it can be left and come back to", { tag: ["@variant", "@variant-graphite"] }, async ({ app: page }) => {
    await page.getByTestId("compose-button").click();
    await expect(page.getByRole("form", { name: "New message" })).toBeVisible();
    await expect(page.getByTestId("compose-to")).toBeFocused();
    await page.keyboard.type("ana@example.com");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("composer")).toHaveCount(0);
    await expect(page.getByTestId("strip-item").first()).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("compose-to-field").getByTestId("recipient-chip")).toHaveCount(1);
  });

  test("the new message: c, Esc, a bulk selection", async ({ app: page, server }) => {
    await scenario("c writes a new message in the reader (no dialog), with the drafts strip; it lands in Sent", async () => {
      await openRow(page, 0);
      await focusList(page);
      await page.keyboard.press("c");
      const form = page.getByRole("form", { name: "New message" });
      await expect(form).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByTestId("reader")).toHaveCount(0);
      await expect(page.getByTestId("compose-to")).toBeFocused();
      // what's being written is on screen: it isn't in the strip too
      await expect(page.getByTestId("strip-item")).toHaveCount(0);
      await page.getByTestId("compose-to").fill("Ana Torres <ana@example.com>");
      await page.getByTestId("compose-subject").fill("Propuesta de colaboración");
      // the subject is in its field, once (plan 158)
      await expect(page.getByTestId("compose-title")).toHaveText("New message");
      await page.getByTestId("compose-body").fill("Hola Ana, te comparto la propuesta.");
      await page.keyboard.press("Meta+Enter");
      await expect(page.getByTestId("composer")).toHaveCount(0);
      await expect(page.getByTestId("reader")).toBeVisible();
      await expect(page.getByTestId("drafts-strip")).toHaveCount(0);
      await navTo(page, "sent");
      await expect(page.getByTestId("row-subject").first()).toHaveText("Propuesta de colaboración");
    });
    await scenario("Esc leaves the new message (kept, its strip item focused); the conversation shows; the strip brings it back", async () => {
      await freshNoDrafts(page, server);
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
      await expect(item).toContainText("To ana@example.com");
      await item.click();
      await expect(page.getByTestId("compose-body")).toHaveText("Borrador nuevo");
      // opening a conversation steps the new message aside, kept
      await page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`).dispatchEvent("mousedown");
      await expect(page.getByTestId("reader")).toBeVisible();
      await expect(page.getByTestId("strip-item")).toHaveCount(1);
    });
    await scenario("a bulk selection takes the pane over the new message, which comes back when it clears", async () => {
      await freshNoDrafts(page, server);
      await page.keyboard.press("c");
      await page.getByTestId("compose-body").fill("Sigo aquí");
      const meta = process.platform === "darwin" ? "Meta" : "Control";
      await rows(page).nth(1).click({ modifiers: [meta] });
      await rows(page).nth(2).click({ modifiers: [meta] });
      await expect(page.getByTestId("selection-bar")).toBeVisible();
      await focusList(page);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("compose-body")).toHaveText("Sigo aquí");
    });
  });

  test("Bcc is sent, and kept out of To and Cc", async ({ app: page, server }) => {
    await freshNoDrafts(page, server);
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
    await expect(page.getByTestId("compose-body")).toHaveText("Texto");
    await expect(page.getByTestId("compose-body")).toHaveAttribute("contenteditable", "false");
    const pendingDraft = (await server.backend.store.drafts.list())[0]!;
    expect(pendingDraft).toMatchObject({ subject: "Una sola vez", body_text: "Texto", revision: 1 });
    expect(pendingDraft.generation).toBeTruthy();
    await stabilize(page);
    await axeBothModes(page, "[data-testid=composer]");
    release();
    handlers["compose.send"] = original;
    await expect.poll(sends).toBe(before + 1);
    await page.waitForTimeout(300);
    expect(sends()).toBe(before + 1);
    await expect(page.getByTestId("drafts-strip")).toHaveCount(0);
  });

  test("the strip: an archived conversation, an older draft, a reload", async ({ app: page, server }) => {
    await scenario("a reply draft whose conversation was archived waits in the strip and opens its conversation", async () => {
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
      await expect(page.getByTestId("compose-body")).toHaveText("Te contesto luego.");
    });
    await scenario("an older draft of a conversation opens as itself from the strip, not as the newest one", async () => {
      await freshNoDrafts(page, server);
      const db = sqlDb(server.backend.store);
      const id = await openRow(page, 0);
      const m = db.get<{ id: number; account_id: number }>("SELECT id, account_id FROM messages WHERE thread_id = ? ORDER BY date DESC LIMIT 1", Number(id))!;
      const base = { accountId: m.account_id, threadId: Number(id), to: [], cc: [], subject: "Re: x", inReplyToMessageId: m.id };
      await server.backend.store.drafts.save({ ...base, mode: "forward", bodyText: "Versión vieja", inReplyToMessageId: null, forwardOfMessageId: m.id, subject: "Fwd: x" }, Date.now() - 60_000);
      await server.backend.store.drafts.save({ ...base, mode: "reply", bodyText: "Versión nueva" }, Date.now());
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`).dispatchEvent("mousedown");
      await expect(page.getByTestId("draft-collapsed").or(page.getByTestId("composer"))).toContainText(/Versión nueva/);
      await page.getByTestId("strip-item").filter({ hasText: "Fwd: x" }).click();
      await expect(composer(page)).toHaveAttribute("data-mode", "forward");
      await expect(page.getByTestId("compose-body")).toHaveText("Versión vieja");
      // the newest is untouched, and now waits in the strip
      await expect(page.getByTestId("strip-item").filter({ hasText: "Re: x" })).toBeVisible();
      expect(db.get<{ c: number }>("SELECT count(*) AS c FROM drafts WHERE body_text = 'Versión nueva' AND mode = 'reply'")!.c).toBe(1);
    });
    await scenario("new drafts come back to the strip after a reload", async () => {
      await freshNoDrafts(page, server);
      await page.keyboard.press("c");
      await page.getByTestId("compose-to").fill("ana@example.com");
      await page.getByTestId("compose-body").fill("Para después");
      await expect(page.getByTestId("draft-status")).toHaveText("Saved");
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await page.getByTestId("strip-item").first().click();
      await expect(page.getByTestId("compose-body")).toHaveText("Para después");
    });
  });

});

test.describe("the composer at rest and at its limits (plan 158)", () => {
  const send = (page: Page) => page.getByTestId("compose-send");
  const reply = async (page: Page, row = 0) => {
    await openRow(page, row);
    await focusList(page);
    await page.keyboard.press("r");
    await expect(page.getByTestId("compose-body")).toBeFocused();
  };

  test("Send stays on screen and the caret clear of it, typing from the first key, in any window", async ({ app: page, server }) => {
    await scenario("the format bar starts closed; Aa opens it and that's remembered; its shortcuts work either way", async () => {
      await reply(page);
      await expect(page.getByTestId("format-bar")).toHaveCount(0);
      await expect(page.getByTestId("format-toggle")).toHaveAttribute("aria-expanded", "false");
      await page.getByTestId("format-toggle").click();
      await expect(page.getByTestId("format-bar")).toBeVisible();
      expect(await page.evaluate(() => localStorage.getItem("terno:format-bar"))).toBe("shown");
      await page.getByTestId("format-toggle").click();
      await expect(page.getByTestId("format-bar")).toHaveCount(0);
    });
    await scenario("in a short window, typing right after r: Send in view, the subject still there", async () => {
      await freshNoDrafts(page, server);
      await page.setViewportSize({ width: 1100, height: 700 });
      await openRow(page, 0);
      await focusList(page);
      await page.keyboard.press("r");
      // spaces too: a space scrolls the reader only when it isn't being typed into something
      await page.keyboard.type("una respuesta con varias palabras", { delay: 0 });
      await expect(page.getByTestId("compose-body")).toContainText("una respuesta");
      await expect(send(page)).toBeInViewport({ ratio: 1 });
    });
    await scenario("a draft taller than the view: Send stays at the pane's foot, the line being typed above it", async () => {
      for (let i = 0; i < 40; i++) { await page.keyboard.press("Enter"); await page.keyboard.type(`línea ${i}`); }
      await expect(send(page)).toBeInViewport({ ratio: 1 });
      const foot = await page.locator("[data-draft-foot]").boundingBox(), caret = await page.evaluate(() => {
        const node = getSelection()!.anchorNode!;
        return (node.nodeType === 1 ? node as Element : node.parentElement!).getBoundingClientRect().bottom;
      });
      expect(caret).toBeLessThanOrEqual(foot!.y);
      // scrolled up to read what was written, it's still there; scrolled past the draft's top, it goes with it
      await page.locator("[data-reader-scroller]").evaluate((el) => { el.scrollTop -= 200; });
      await expect(send(page)).toBeInViewport({ ratio: 1 });
      await page.setViewportSize({ width: 1280, height: 800 });
    });
    await scenario("a link on the line above the foot: its bubble opens above, never over Send", async () => {
      await freshNoDrafts(page, server);
      await reply(page);
      for (let i = 0; i < 40; i++) { await page.keyboard.type(`línea ${i}`); await page.keyboard.press("Enter"); }
      await page.keyboard.type("https://example.com ");
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("ArrowLeft");
      const bubble = page.getByTestId("link-bubble");
      await expect(bubble).toBeVisible();
      const clear = async () => {
        const b = (await bubble.boundingBox())!, foot = (await page.locator("[data-draft-foot]").boundingBox())!;
        expect(b.y + b.height).toBeLessThanOrEqual(foot.y);
      };
      await clear();
      // Aa raises the foot under an open bubble
      await page.getByTestId("format-toggle").click();
      await expect(page.getByTestId("format-bar")).toBeVisible();
      await expect(bubble).toBeVisible();
      await expect.poll(async () => { const b = (await bubble.boundingBox())!, foot = (await page.locator("[data-draft-foot]").boundingBox())!; return b.y + b.height <= foot.y; }).toBe(true);
      await page.getByTestId("format-toggle").click();
    });
    await scenario("a chip doesn't take the To row to a second line until it has to, and values share one line", async () => {
      await freshNoDrafts(page, server);
      await page.setViewportSize({ width: 1100, height: 700 });
      await reply(page);
      const row = page.locator("[data-recipient-row]").first();
      expect((await row.boundingBox())!.height).toBe(38);
      await page.getByTestId("compose-show-subject").click();
      const subject = await page.getByTestId("compose-subject").evaluate((el: HTMLElement) => el.getBoundingClientRect().x + parseFloat(getComputedStyle(el).paddingLeft));
      expect(await page.getByTestId("recipient-chips").locator("[role=option]").first().evaluate((el) => {
        const range = document.createRange(); range.selectNodeContents(el.querySelector("span")!); return range.getBoundingClientRect().x;
      })).toBeCloseTo(subject, 0);
      await page.setViewportSize({ width: 1280, height: 800 });
    });
  });

  test("a saved reply stays with its conversation; the strip takes what isn't on a row, and no row moves for it", async ({ app: page, server }) => {
    const row = (id: string) => page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`);
    await scenario("away and back, by j/k and by clicks: the same Draft line, the same mark, nothing in the strip, the same words", async () => {
      await reply(page);
      await page.keyboard.type("Lo veo mañana.");
      await page.keyboard.press("Escape");
      const id = (await page.locator("[data-cursor]").getAttribute("data-thread-id"))!;
      const y = (await page.getByTestId("thread-row").nth(1).boundingBox())!.y;
      await focusList(page);
      await page.keyboard.press("j");
      await expect(page.locator("[data-cursor]")).not.toHaveAttribute("data-thread-id", id);
      await expect(row(id)).toContainText("Draft");
      await expect(page.getByTestId("strip-item")).toHaveCount(0);
      // j/k never moves a row: there's nothing above the list to come and go
      expect((await page.getByTestId("thread-row").nth(1).boundingBox())!.y).toBe(y);
      await page.keyboard.press("k");
      await expect(page.getByTestId("draft-collapsed")).toContainText("Lo veo mañana.");
      await page.keyboard.press("j");
      await row(id).click();
      await expect(page.getByTestId("draft-collapsed")).toContainText("Lo veo mañana.");
      await expect(row(id)).toContainText("Draft");
      // and opens as it was, in place, focus in the text
      await page.getByTestId("draft-collapsed").click();
      await expect(page.getByTestId("compose-body")).toBeFocused();
      await expect(page.getByTestId("compose-body")).toHaveText("Lo veo mañana.");
    });
    await scenario("left open, it comes back as the same one line, without taking focus or the scroll", async () => {
      await page.getByTestId("thread-row").nth(1).click();
      await page.getByTestId("thread-row").first().click();
      await expect(page.getByTestId("draft-slot")).toHaveAttribute("data-state", "collapsed");
      await expect(page.getByTestId("compose-body")).toHaveCount(0);
    });
    await scenario("Discard, then Undo, after coming back: the exact words again", async () => {
      await page.getByTestId("draft-collapsed").click();
      await page.getByTestId("compose-discard").click();
      await expect(page.getByTestId("draft-slot")).toHaveAttribute("data-state", "bar");
      await page.getByRole("button", { name: /undo/i }).click();
      await expect(page.getByTestId("compose-body")).toHaveText("Lo veo mañana.");
    });
    await scenario("the strip is one line and a count at the list's foot: opening it, writing a new message and putting it away move no row", async () => {
      await freshNoDrafts(page, server);
      const y = async () => (await page.getByTestId("thread-row").nth(1).boundingBox())!.y;
      const before = await y();
      for (const subject of ["Primera nota", "Segunda nota", "Tercera nota"]) {
        await focusList(page);
        await page.keyboard.press("c");
        await expect(page.getByTestId("compose-to")).toBeFocused();
        await page.getByTestId("compose-subject").fill(subject);
        expect(await y()).toBe(before);
        // being written, it's on screen: not in the strip as well
        await expect(page.locator("[data-testid=strip-item]").filter({ hasText: subject })).toHaveCount(0);
        await page.keyboard.press("Escape");
        // and Esc lands on it, on the one line
        await expect(page.locator("[data-testid=strip-item]").filter({ hasText: subject })).toBeFocused();
        expect(await y()).toBe(before);
      }
      await expect(page.getByTestId("strip-item")).toHaveCount(1);
      await expect(page.getByTestId("strip-more")).toHaveText("+2 drafts");
      const strip = (await page.getByTestId("drafts-strip").boundingBox())!, list = (await page.getByTestId("thread-list").boundingBox())!;
      expect(strip.y + strip.height).toBeCloseTo(list.y + list.height, 0);
      await page.getByTestId("strip-more").click();
      await expect(page.getByTestId("strip-item")).toHaveCount(3);
      expect(await y()).toBe(before);
      await page.getByTestId("strip-item").filter({ hasText: "Primera nota" }).click();
      await expect(page.getByTestId("compose-subject")).toHaveValue("Primera nota");
      await page.keyboard.press("Escape");
      await expect(page.locator("[data-testid=strip-item]").filter({ hasText: "Primera nota" })).toBeFocused();
      await page.getByTestId("strip-more").click();
      await expect(page.getByTestId("strip-item")).toHaveCount(1);
    });
    await scenario("a snack never covers the strip (plan 158: Split's is over the reader)", async () => {
      await page.getByTestId("strip-item").first().click();
      await page.getByTestId("compose-discard").click();
      const strip = (await page.getByTestId("drafts-strip").boundingBox())!, snack = (await page.getByTestId("snack").boundingBox())!;
      expect(snack.x).toBeGreaterThanOrEqual(strip.x + strip.width);
    });
  });

  test("Send says why at the field, and a refused send leaves nothing behind", async ({ app: page, server }) => {
    const compose = async () => {
      await focusList(page);
      await page.keyboard.press("c");
      await expect(page.getByTestId("compose-to")).toBeFocused();
    };
    await scenario("with nobody to send to, Send reads as unavailable; a click and ⌘↵ say so at To, not in a toast", async () => {
      await compose();
      await expect(page.getByTestId("compose-send")).toHaveAttribute("aria-disabled", "true");
      await page.getByTestId("compose-send").click({ force: true });
      await expect(page.getByTestId("compose-field-problem")).toHaveText("Add a recipient to send");
      await expect(page.getByTestId("compose-to")).toBeFocused();
      await expect(page.getByTestId("compose-to")).toHaveAttribute("aria-describedby", await page.getByTestId("compose-field-problem").getAttribute("id") as string);
      await expect(page.getByTestId("snack")).toHaveCount(0);
      // every time (plan 158): ⌘↵ with focus nowhere (a click on the pane's blank space) is still this message's Send, and the alert is new, so it's said again
      await page.getByTestId("compose-field-problem").evaluate((el) => el.setAttribute("data-was", ""));
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("ControlOrMeta+Enter");
      await expect(page.getByTestId("compose-to")).toBeFocused();
      await expect(page.getByTestId("compose-field-problem")).toHaveText("Add a recipient to send");
      await expect(page.getByTestId("compose-field-problem")).not.toHaveAttribute("data-was");
    });
    await scenario("Esc: the message goes with the composer, and no empty draft stays, here or after a reload", async () => {
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("compose-field-problem")).toHaveCount(0);
      await expect(page.getByTestId("strip-item")).toHaveCount(0);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await expect(page.getByTestId("strip-item")).toHaveCount(0);
    });
    await scenario("fixing the field takes the message away and Send is ready", async () => {
      await compose();
      await page.keyboard.press("ControlOrMeta+Enter");
      await expect(page.getByTestId("compose-field-problem")).toBeVisible();
      await page.keyboard.type("ana@example.com");
      await expect(page.getByTestId("compose-field-problem")).toHaveCount(0);
      await expect(page.getByTestId("compose-send")).not.toHaveAttribute("aria-disabled", "true");
      await page.getByTestId("compose-discard").click();
    });
    await scenario("an untouched forward or reply put away is gone, the reply bar back; with words in it, it's kept", async () => {
      await freshNoDrafts(page, server);
      await openRow(page, 0);
      await focusList(page);
      await page.keyboard.press("f");
      await expect(page.getByTestId("compose-to")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("draft-slot")).toHaveAttribute("data-state", "bar");
      await expect(page.getByTestId("quick-reply")).toBeFocused();
      await page.keyboard.press("r");
      await expect(page.getByTestId("compose-body")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("draft-slot")).toHaveAttribute("data-state", "bar");
      await page.keyboard.press("r");
      await expect(page.getByTestId("compose-body")).toBeFocused();
      await page.keyboard.type("algo");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("draft-slot")).toHaveAttribute("data-state", "collapsed");
    });
  });
});

test.describe("the composer in List (plan 158)", () => {
  test.use({ layout: "list" });
  test("Send is in view when typing starts right after r", async ({ app: page }) => {
    await rows(page).first().click();
    await expect(page.getByTestId("reader-subject")).toBeVisible();
    await page.keyboard.press("r");
    await page.keyboard.type("Hola, gracias por escribir", { delay: 0 });
    await expect(page.getByTestId("compose-body")).toContainText("Hola");
    await expect(page.getByTestId("compose-send")).toBeInViewport({ ratio: 1 });
  });
});

test("Undo send (plan 158): a spinner, not a check, while it's held; Undo brings the draft back exactly; too late says so", async ({ app: page, server }) => {
  const dev = { clientId: "setup", origin: "dev" as const };
  await server.backend.server.invoke("settings.update", { undoSend: true }, dev);
  await page.reload();
  await page.locator("[data-ready]").waitFor();
  await openRow(page, 0);
  const before = await page.getByTestId("message").count();
  await page.keyboard.press("r");
  const body = page.getByTestId("compose-body");
  await expect(body).toBeFocused();
  await page.keyboard.type("Exactly these words");
  await page.getByTestId("compose-show-cc").click();
  await addRecipients(page, "compose-cc", "copy@example.com");
  await body.click();
  await page.keyboard.press("ControlOrMeta+Enter");

  const snack = page.locator("[data-testid=snack]").filter({ hasText: "Sending…" });
  await expect(snack).toBeVisible();
  await expect(snack.locator("[data-slot=spinner]")).toBeVisible();
  await expect(snack.locator("svg.text-success-ink")).toHaveCount(0);
  await expect(snack.getByTestId("snack-action")).toHaveAccessibleName("Undo send");
  await expect(page.getByTestId("composer")).toHaveCount(0);
  // not a thing the user scheduled, and nothing has gone
  await expect(page.getByTestId("strip-scheduled")).toHaveCount(0);
  expect(await page.getByTestId("message").count()).toBe(before);

  await snack.getByTestId("snack-action").click();
  await expect(page.getByTestId("composer")).toBeVisible();
  await expect(body).toHaveText("Exactly these words");
  await expect(body).toBeFocused();
  expect(await recipientEmails(page, "compose-cc")).toEqual(["copy@example.com"]);
  expect(await page.getByTestId("message").count()).toBe(before);

  // again, and past its moment on the backend's clock (fixed here): Undo finds it gone, and says so
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(snack.getByTestId("snack-action")).toBeVisible();
  await expect.poll(async () => (await server.backend.store.scheduled.list()).length).toBe(1);
  const { draftId } = (await server.backend.store.scheduled.list())[0]!;
  await server.backend.server.invoke("scheduled.reschedule", { draftId, sendAt: E2E_NOW - 1 }, dev);
  await expect(page.getByTestId("message")).toHaveCount(before + 1);
  // the reader goes to its copy
  await expect(page.getByTestId("message").last()).toBeInViewport();
  await snack.getByTestId("snack-action").click();
  await expect(page.locator("[data-testid=snack]").filter({ hasText: "Too late to undo" })).toBeVisible();
  await expect(page.getByTestId("composer")).toHaveCount(0);

  // the hold's end on this side: the spinner goes on, the Undo's gone, and z no longer reaches it
  await page.keyboard.press("r");
  await expect(body).toBeFocused();
  await page.keyboard.type("Second");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(snack.getByTestId("snack-action")).toBeVisible();
  await page.clock.fastForward(UNDO_SEND_MS);
  await expect(snack).toBeVisible();
  await expect(snack.locator("[data-slot=spinner]")).toBeVisible();
  await expect(snack.getByTestId("snack-action")).toHaveCount(0);

  // and Settings turns it off
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("undo-send-switch")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("undo-send-switch").click();
  await expect(page.getByTestId("undo-send-switch")).toHaveAttribute("aria-checked", "false");
});

test("Undo send from the pinned card: back on the card, with the reader where it is (plan 158)", async ({ app: page, server }) => {
  await server.backend.server.invoke("settings.update", { undoSend: true }, { clientId: "setup", origin: "dev" as const });
  await page.reload();
  await page.locator("[data-ready]").waitFor();
  await openRow(page, 0);
  await page.keyboard.press("r");
  await expect(page.getByTestId("compose-body")).toBeFocused();
  await page.keyboard.type("Pinned words");
  await page.getByTestId("compose-pin").click();
  const card = page.getByTestId("pinned-draft");
  await expect(card).toBeVisible();
  await openRow(page, 2);
  const reading = await page.getByTestId("reader-subject").textContent();
  await card.getByTestId("compose-send").click();
  await expect(card).toHaveCount(0);
  await page.locator("[data-testid=snack]").filter({ hasText: "Sending…" }).getByTestId("snack-action").click();
  await expect(card.getByTestId("compose-body")).toHaveText("Pinned words");
  await expect(page.getByTestId("reader-subject")).toHaveText(reading!);
});

test("the To row: Tab goes To, Subject, text; Cc and Bcc by key or button; the sending account shows (plan 158)", async ({ app: page }) => {
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
  await scenario("a new message: To, Subject, the text, with Cc and Bcc off the path and two keys away", async () => {
    await focusList(page);
    await page.keyboard.press("c");
    await expect(page.getByTestId("compose-to")).toBeFocused();
    await page.keyboard.type("ana@example.com");
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("compose-subject")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("compose-body")).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    expect(await focused()).toBe("compose-to");
    // the buttons are named and big enough, and keep working
    for (const [id, name] of [["compose-show-cc", "Add Cc"], ["compose-show-bcc", "Add Bcc"]] as const) {
      const button = page.getByTestId(id);
      await expect(button).toHaveAccessibleName(name);
      await expect(button).toBeVisible();
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(24);
    }
    await page.getByTestId("compose-body").focus();
    await page.keyboard.press("ControlOrMeta+Shift+C");
    await expect(page.getByTestId("compose-cc")).toBeFocused();
    await page.getByTestId("compose-body").focus();
    await page.keyboard.press("ControlOrMeta+Shift+B");
    await expect(page.getByTestId("compose-bcc")).toBeFocused();
    // again, with the field showing: it goes there
    await page.getByTestId("compose-body").focus();
    await page.keyboard.press("ControlOrMeta+Shift+C");
    await expect(page.getByTestId("compose-cc")).toBeFocused();
    await page.getByTestId("compose-discard").click();
  });
  await scenario("a reply says who it's from in the To row, on one line, and the whole row is one click away", async () => {
    await openRow(page, 0);
    await page.keyboard.press("r");
    await expect(page.getByTestId("compose-body")).toBeFocused();
    const label = page.getByTestId("compose-from-label");
    await expect(label).toHaveText(/^from \S/);
    await expect(page.getByTestId("compose-from")).toHaveCount(0);
    const to = await page.locator("[data-recipient-row]").first().boundingBox();
    expect(to!.height).toBe(38);
    await page.getByTestId("compose-quote").waitFor();
    expect((await page.getByTestId("compose-quote").boundingBox())!.height).toBeGreaterThanOrEqual(24);
    await page.getByTestId("compose-show-from").click();
    await expect(page.getByTestId("compose-from")).toBeFocused();
    await expect(label).toHaveCount(0);
  });
});

test("the composer's states: unavailable Send, Saving and Saved, an invalid address in words (plan 158)", async ({ app: page }) => {
  await focusList(page);
  await page.keyboard.press("c");
  const group = page.getByTestId("compose-send-group"), clock = page.getByTestId("compose-send-later");
  const css = (l: typeof group, prop: "backgroundColor" | "color") => l.evaluate((el, p) => getComputedStyle(el)[p], prop);
  // nothing to send to: no fill, its label and clock in the muted ink, and it says why
  expect(await css(group, "backgroundColor")).toBe("rgba(0, 0, 0, 0)");
  expect(await css(clock, "color")).toBe(await css(page.getByTestId("compose-send"), "color"));
  await page.getByTestId("compose-send").hover();
  await expect(page.locator("[data-slot=tooltip-content]")).toContainText("Add a recipient to send");
  await page.mouse.move(1, 1);

  // what's still being typed isn't wrong yet
  const to = page.getByTestId("compose-to");
  await to.focus();
  await page.keyboard.type("bad-addr");
  await expect(page.getByTestId("compose-field-problem")).toHaveCount(0);
  await page.keyboard.press("Tab");
  const note = page.getByTestId("compose-field-problem");
  await expect(note).toHaveText("“bad-addr” isn’t an email address. Fix or remove it, then send.");
  await expect(to).toHaveAttribute("aria-describedby", /problem/);
  await page.getByTestId("compose-send").hover();
  await expect(page.locator("[data-slot=tooltip-content]")).toContainText("“bad-addr” isn’t an email address.");
  await page.mouse.move(1, 1);
  // put away like that, the strip still says it won't go (plan 158: it read "To bad-addr", as if it were fine)
  await to.focus();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("strip-item-recipients")).toHaveText("— “bad-addr” isn’t an email address");
  await page.getByTestId("strip-item").click();
  await expect(note).toBeVisible();
  // fixed: it goes, and Send is ready again
  // (chosen, the wrong one is ringed in the destructive ink, its fill kept: the primary's fill read as fine, plan 158)
  const chip = page.getByTestId("recipient-chip");
  const rest = await chip.evaluate((el) => getComputedStyle(el).backgroundColor);
  await chip.click();
  await expect(chip).toHaveAttribute("aria-selected", "true");
  expect(await chip.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(rest);
  expect(await chip.evaluate((el) => getComputedStyle(el).boxShadow)).toContain("inset");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await to.focus();
  await page.keyboard.type("ana@example.com,");
  await expect(note).toHaveCount(0);
  expect(await css(group, "backgroundColor")).not.toBe("rgba(0, 0, 0, 0)");

  // a saved state in the form, not a toast: said aloud only once it's true
  const status = page.getByTestId("draft-status");
  await page.getByTestId("compose-body").click();
  await page.keyboard.type("Something");
  // (Saving… only for a save that takes a while: save-state.test.tsx)
  await expect(status).toHaveText("Saved");
  await expect(status.locator("[aria-live]")).toHaveText("Saved");

  // what the draft's lifecycle controls do can be read
  // it says it keeps the draft, in the words it's named by (plan 158)
  await expect(page.getByTestId("compose-collapse")).toHaveText("Save and close");
  await expect(page.getByTestId("compose-collapse")).toHaveAccessibleName("Save and close");
  await expect(page.getByTestId("compose-pin")).toHaveAccessibleName(/stays open/);
  await expect(page.getByTestId("compose-pin")).toHaveAttribute("aria-pressed", "false");
  await page.getByTestId("compose-pin").hover();
  await expect(page.locator("[data-slot=tooltip-content]")).toContainText("Keeps it open at the bottom right while you read other mail.");
  await page.mouse.move(1, 1);
});

test("the composer reads like the message above it, and a short window gives it room, whole (plan 158)", { tag: "@design" }, async ({ app: page }) => {
  await openRow(page, 0);
  await page.keyboard.press("r");
  const body = page.getByTestId("compose-body");
  await expect(body).toBeFocused();
  await page.keyboard.type("A long enough line to reach the width of the text, whatever that is here, and go on to the next one.");
  const set = (l: ReturnType<Page["locator"]>) => l.evaluate((el) => { const s = getComputedStyle(el); return { size: s.fontSize, line: s.lineHeight, family: s.fontFamily, width: el.getBoundingClientRect().width }; });
  const message = await set(page.locator("[data-testid=message][data-expanded] .type-body").last());
  const written = await set(body.locator("p").first());
  expect(written).toEqual(message);

  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1100, height: 700 });
  // what sticks at the reader's top says so in its scroll padding: the opening composer clears it (plan 158)
  const scroller = page.locator("[data-reader-scroller]");
  await scroller.evaluate((el) => { el.style.scrollPaddingTop = "44px"; });
  for (const open of [() => page.getByTestId("draft-collapsed").click(), () => page.keyboard.press("r")]) {
    await open();
    await expect(body).toBeFocused();
    const composer = page.getByTestId("composer");
    await expect(composer).toBeInViewport({ ratio: 1 });
    const pane = (await scroller.boundingBox())!;
    // a two-line reply keeps no blank page: the text is about its own height, so the message stays in view above it
    expect((await body.boundingBox())!.height).toBeLessThanOrEqual(120);
    const card = (await composer.boundingBox())!;
    expect(card.y - pane.y, "the composer clears what sticks at the top").toBeGreaterThanOrEqual(44);
    // the card's foot isn't against the window, unless a little of that room keeps the subject whole above (plan 158)
    const subject = (await page.getByTestId("reader-subject").boundingBox())!;
    const whole = subject.y >= pane.y && subject.y + subject.height <= pane.y + pane.height;
    expect(pane.y + pane.height - (card.y + card.height), "the card's foot isn't against the window").toBeGreaterThanOrEqual(whole ? 0 : 8);
    if (!whole) expect(subject.y + subject.height, "a subject not whole is wholly gone").toBeLessThanOrEqual(pane.y);
    // a chip and the row's own controls fit on the row: it doesn't double for them
    expect((await page.locator("[data-recipient-row]").first().boundingBox())!.height).toBe(38);
    await page.keyboard.press("Escape");
    await page.getByTestId("reader-subject").evaluate((el) => el.closest("[data-reader-scroller]")!.scrollTo(0, 0));
  }
  await scroller.evaluate((el) => { el.style.scrollPaddingTop = ""; });
});
