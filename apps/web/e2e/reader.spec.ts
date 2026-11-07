/**
 * The reader as a conversation: flat messages, native disclosure buttons
 * (Enter and Space, aria-expanded/aria-controls), bodies mounted only while
 * open, and runs of collapsed messages folded into "N more messages".
 */
import { E2E_NOW } from "./constants";
import { expect, focusList, ingestConversation, openRow, respond, search, selectThread, test, fresh, scenario } from "./fixtures";
import type { Page } from "@playwright/test";
import { sqlDb } from "../../backend-dev/src/server";

test.describe("reader conversation", () => {
  test("messages are disclosure buttons that work with Enter and Space; collapsed bodies aren't mounted", { tag: "@variant" }, async ({ app: page, server }) => {
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

  test("reader: folding, HTML bodies, attachments, the reply bar, selecting text, the message menu", async ({ app: page, server, context }) => {
    await scenario("4 or more collapsed messages in a row fold into «N more messages»", async () => {
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
    await scenario("HTML bodies mount on expand and leave nothing behind when collapsed", async () => {
      await fresh(page);
      const id = await ingestConversation(server, { subject: "Presupuesto anual", count: 3, html: 3, now: E2E_NOW });
      await selectThread(page, id, 'subject:"Presupuesto anual"');
      const frames = page.locator("[data-testid=reader] iframe");
      await expect(frames).toHaveCount(1);
      await page.getByTestId("message").nth(0).getByTestId("message-toggle").click();
      await expect(frames).toHaveCount(2);
      await page.getByTestId("message").nth(0).getByTestId("message-toggle").click();
      await expect(frames).toHaveCount(1);
    });
    await scenario("attachment metadata names its download control and unavailable bytes", async () => {
      await fresh(page);
      await search(page, "in:inbox has:attachment");
      await openRow(page, 0);
      const tile = page.getByTestId("attachment").first();
      await expect(tile).toBeVisible();
      await expect(tile).toContainText("boarding-pass.pdf");
      await expect(tile).toContainText("1.5 MB");
      const download = tile.getByRole("button", { name: "Download boarding-pass.pdf 1.5 MB · Unavailable offline", exact: true });
      await expect(download).toHaveAttribute("aria-description", "application/pdf");
      const reply = page.getByTestId("quick-reply");
      await reply.focus();
      await expect(reply).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(download).toBeFocused();
    });
    await scenario("the reply bar after the last message starts a reply to who wrote last", async () => {
      await fresh(page);
      await openRow(page, 0);
      const subject = (await page.getByTestId("reader-subject").textContent())!;
      await expect(page.getByTestId("quick-reply")).toContainText(/Reply to \S+…/);
      // the account it answers from is words, and only when there's a choice: never initials that read as a person
      await expect(page.getByTestId("quick-reply").getByTestId("sender-avatar")).toHaveCount(0);
      const several = (await server.backend.store.accounts.list()).length > 1;
      await expect(page.getByTestId("quick-reply-from")).toHaveCount(several ? 1 : 0);
      if (several) await expect(page.getByTestId("quick-reply-from")).toHaveText(/^from \S/);
      await page.getByTestId("quick-reply").click();
      await expect(page.getByTestId("reader").getByTestId("composer")).toBeVisible();
      await page.getByTestId("compose-show-subject").click();
      await expect(page.getByTestId("compose-subject")).toHaveValue(`Re: ${subject}`);
    });
    await scenario("a message's text, subject and sender are selectable by dragging", async () => {
      await fresh(page);
      await openRow(page, 0);
      const body = page.getByTestId("message").locator(".type-body").first();
      await expect(body).toBeVisible();
      for (const el of [body, page.getByTestId("reader-subject")]) expect(await el.evaluate((e) => getComputedStyle(e).userSelect)).not.toBe("none");
      const box = (await body.boundingBox())!;
      await page.mouse.move(box.x + 2, box.y + 6);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 4, box.y + 30, { steps: 8 });
      await page.mouse.up();
      expect((await page.evaluate(() => document.getSelection()?.toString() ?? "")).length).toBeGreaterThan(10);
    });
    await scenario("on desktop (no native menu), the message menu copies the selected text; with nothing selected it has no Copy", async () => {
      await fresh(page);
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await openRow(page, 0);
      const body = page.getByTestId("message").locator(".type-body").first();
      await expect(body).toBeVisible();
      // only the right-click's wantsNativeMenu reads it
      await page.evaluate(() => ((window as { ternoDesktop?: unknown }).ternoDesktop = {}));
      await body.click({ button: "right" });
      await expect(page.getByTestId("message-menu")).toBeVisible();
      await expect(page.getByTestId("message-menu-copy")).toHaveCount(0);
      await page.keyboard.press("Escape");

      const selected = await body.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el.firstChild!);
        range.setEnd(el.firstChild!, 12);
        document.getSelection()!.removeAllRanges();
        document.getSelection()!.addRange(range);
        return document.getSelection()!.toString();
      });
      await body.click({ button: "right", position: { x: 4, y: 6 } });
      await page.getByTestId("message-menu-copy").click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(selected);
      await page.evaluate(() => delete (window as { ternoDesktop?: unknown }).ternoDesktop);
    });
  });

});

test.describe("plan 158: the reader's masthead, measure and reply controls", () => {
  const ctx = { clientId: "setup", origin: "dev" as const };
  /** Where the conversation's column has its content, and the toolbar's first glyph and last control. */
  const geometry = (page: Page) => page.evaluate(() => {
    const column = document.querySelector<HTMLElement>("[data-reader-column]")!;
    const box = column.getBoundingClientRect(), style = getComputedStyle(column);
    // on the column: a wide List page keeps Back and the steps at the pane's edges, beside it
    const beside = (b: Element) => { for (let e: Element | null = b; e && !e.matches("[data-reader-toolbar]"); e = e.parentElement) if (getComputedStyle(e).position === "absolute") return true; return false; };
    const bar = [...document.querySelectorAll("[data-reader-toolbar] button")].filter((b) => (b as HTMLElement).offsetParent !== null && !beside(b));
    const body = [...document.querySelectorAll("[data-testid=message][data-expanded] .type-body")].at(-1) as HTMLElement;
    const type = getComputedStyle(body);
    const ctx2d = document.createElement("canvas").getContext("2d")!;
    ctx2d.font = `${type.fontWeight} ${type.fontSize} ${type.fontFamily}`;
    const sample = "the quick brown fox jumps over the lazy dog and keeps on running through the field ";
    return {
      left: box.left + parseFloat(style.paddingLeft),
      right: box.right - parseFloat(style.paddingRight),
      glyph: bar[0]!.querySelector("svg")!.getBoundingClientRect().left,
      end: Math.max(...bar.map((b) => (b.closest("[data-slot=button-group]") ?? b.querySelector("svg")!).getBoundingClientRect().right)),
      overflow: bar.some((b) => b.getBoundingClientRect().right > document.querySelector("[data-testid=reader]")!.getBoundingClientRect().right),
      firstLine: body.getBoundingClientRect().top,
      chars: body.getBoundingClientRect().width / (ctx2d.measureText(sample).width / sample.length),
    };
  });

  test("in every design and layout, the toolbar is on the column, lines are readable and the mail starts in the upper third", { tag: "@design" }, async ({ app: page, server }) => {
    const id = await ingestConversation(server, { subject: "Una conversación con un asunto de longitud bastante normal", count: 3, now: E2E_NOW });
    const check = async (where: string) => {
      await page.locator("[data-testid=message][data-expanded] .type-body").last().waitFor();
      const g = await geometry(page);
      expect(Math.abs(g.glyph - g.left), `${where}: first glyph on the column`).toBeLessThanOrEqual(1);
      expect(Math.abs(g.end - g.right), `${where}: last control on the column`).toBeLessThanOrEqual(1.5);
      expect(g.overflow, where).toBe(false);
      expect(g.chars, `${where}: measure`).toBeLessThanOrEqual(84);
      return g;
    };
    await page.setViewportSize({ width: 1440, height: 900 });
    await selectThread(page, id, 'subject:"Una conversación con un asunto"');
    const wide = await check("split, 1440");
    expect(wide.firstLine).toBeLessThan(300);
    expect(wide.chars).toBeGreaterThanOrEqual(65);
    await page.setViewportSize({ width: 1100, height: 700 });
    await expect.poll(async () => (await geometry(page)).right - (await geometry(page)).left).toBeLessThan(600);
    await check("split, 1100");

    await server.backend.server.invoke("settings.update", { layout: "list" }, ctx);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await search(page, 'subject:"Una conversación con un asunto"');
    await page.getByTestId("thread-row").first().click();
    await page.getByTestId("reader-back").waitFor();
    const list = await check("list, 1440");
    expect(list.firstLine).toBeLessThan(300);
    // Back and the steps hang just outside the column's edges, with the toolbar, not out at the pane's
    const nav = await page.evaluate(() => {
      const column = document.querySelector("[data-reader-toolbar]")!.getBoundingClientRect();
      const box = (id: string) => document.querySelector(`[data-testid=${id}]`)!.parentElement!.getBoundingClientRect();
      return { back: column.left - box("reader-back").right, steps: box("reader-newer").left - column.right };
    });
    expect(Math.abs(nav.back), "Back beside the column").toBeLessThanOrEqual(1);
    expect(Math.abs(nav.steps), "the steps beside the column").toBeLessThanOrEqual(1);
    // New message is reachable from the reader, wherever this design keeps it
    await page.getByTestId("reader-compose").or(page.getByTestId("compose-button")).locator("visible=true").first().click();
    await expect(page.getByTestId("compose-title")).toBeVisible();
  });

  test("one way to reply: Reply and Forward in the toolbar, Reply all in words only with someone else on it, and nothing moves", async ({ app: page, server }) => {
    const store = server.backend.store;
    const id = await ingestConversation(server, { subject: "Solo con Yuki", count: 1, now: E2E_NOW });
    const replyAt = async () => (await page.getByTestId("action-reply").boundingBox())!.x;
    let solo = 0;
    await scenario("one other person: no Reply all, here or in the bar, no menu, and a still works", async () => {
      await selectThread(page, id, 'subject:"Solo con Yuki"');
      await expect(page.getByTestId("action-reply")).toContainText("Reply");
      await expect(page.getByTestId("action-forward")).toHaveAccessibleName("Forward");
      await expect(page.getByTestId("action-reply-all")).toHaveCount(0);
      await expect(page.getByTestId("quick-reply-all")).toHaveCount(0);
      await expect(page.getByTestId("action-reply-menu")).toHaveCount(0);
      solo = await replyAt();
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("a");
      await expect(page.getByTestId("compose-body")).toBeFocused();
      await page.getByTestId("compose-discard").click();
      // the menu put away with Esc and Reply clicked while it's still closing: the closing menu doesn't take focus back
      // from the draft, so every letter typed lands in it (plan 158: "Probe" lost its "Pr" to the trigger and to r)
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.getByTestId("action-reply-menu").click();
      await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[role=menu]") != null)).toBe(true);
      await page.keyboard.press("Escape");
      await page.getByTestId("action-reply").click();
      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect(page.getByTestId("compose-body")).toBeFocused();
      await page.keyboard.type("Probe text.");
      await expect(page.getByTestId("compose-body")).toContainText("Probe text.");
      await expect(page.getByTestId("compose-body")).toBeFocused();
      await page.getByTestId("compose-discard").click();
    });
    await scenario("someone else on it: Reply all in words, on Reply's far side, so Reply stays put", async () => {
      const account = (await store.accounts.list())[0]!;
      const yuki = { name: "Yuki", email: "yuki@acme.studio" };
      const { touched } = await store.sync.ingest([{ accountId: account.id, providerMsgId: "three-people", providerThreadId: "three-people", rfcMessageId: "<three-people@e2e.test>", inReplyTo: null, references: [], from: yuki, replyTo: [], to: [{ name: "", email: account.email }], cc: [{ name: "Ana", email: "ana@x.test" }], bcc: [], subject: "Con Ana también", date: E2E_NOW, snippet: "Hola a los dos", bodyText: "Hola a los dos", bodyHtml: null, bodyState: "full", listId: null, isRead: true, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 100 }], { applyFilters: false, now: E2E_NOW, classifier: null });
      await selectThread(page, touched[0]!, 'subject:"Con Ana también"');
      await expect(page.getByTestId("quick-reply-all")).toBeVisible();
      await expect(page.getByTestId("action-reply-all")).toHaveText("Reply all");
      expect(await page.getByTestId("action-reply-all").locator("span").evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(20);
      expect(Math.abs((await replyAt()) - solo)).toBeLessThanOrEqual(0.5);
      // a reader short of the full column: Reply all is its glyph (its name still read), so a longer language's words never push Forward out
      await page.setViewportSize({ width: 1280, height: 800 });
      await expect.poll(() => page.getByTestId("reader").evaluate((el) => el.getBoundingClientRect().width)).toBeLessThan(720);
      await expect(page.getByTestId("action-reply-all")).toHaveAccessibleName("Reply all");
      expect(await page.getByTestId("action-reply-all").locator("span").evaluate((el) => el.getBoundingClientRect().width)).toBeLessThanOrEqual(1);
      await page.setViewportSize({ width: 1440, height: 900 });
      await respond(page, "reply-all");
      await expect(page.getByTestId("compose-body")).toBeFocused();
    });
  });

  test("replying in a short window: once the header scrolls away, a line under the toolbar keeps the subject and who it's to", async ({ app: page, server }) => {
    const id = await ingestConversation(server, { subject: "Contexto al responder", count: 4, now: E2E_NOW });
    await page.setViewportSize({ width: 1100, height: 700 });
    await selectThread(page, id, 'subject:"Contexto al responder"');
    const line = page.getByTestId("reader-context");
    await page.getByTestId("expand-all").click();
    // the header in view: no line, and the toolbar keeps its own hairline
    await expect(line).not.toHaveAttribute("data-shown");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("r");
    await expect(page.getByTestId("compose-body")).toBeFocused();
    await page.locator("[data-reader-scroller]").evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(line).toHaveAttribute("data-shown");
    await expect(line).toContainText("Contexto al responder");
    await expect(line.getByTestId("reader-context-draft")).toHaveText(/^Reply to /);
    await expect(page.locator("[data-reader-toolbar]").locator("..")).toHaveAttribute("data-context", "");
    await page.locator("[data-reader-scroller]").evaluate((el) => (el.scrollTop = 0));
    await expect(line).not.toHaveAttribute("data-shown");
    await page.locator("[data-reader-scroller]").evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(line).toHaveAttribute("data-shown");
    // a long reply: an undo far above the view brings its caret below the line, not under it (the editor's own scroll)
    await page.keyboard.type("Una línea\n".repeat(40));
    await page.waitForTimeout(600);
    await page.keyboard.press("Meta+ArrowUp");
    await page.keyboard.type("X");
    await page.waitForTimeout(600);
    await page.keyboard.press("Meta+ArrowDown");
    await page.keyboard.press("Meta+z");
    await expect(page.getByTestId("compose-body")).not.toContainText("XUna");
    const caretBelowLine = () => page.evaluate(() => {
      const range = getSelection()!.getRangeAt(0);
      const caret = range.getClientRects()[0] ?? (range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement!).getBoundingClientRect();
      return Math.round(caret.top - document.querySelector("[data-reader-scroller]")!.getBoundingClientRect().top);
    });
    await expect.poll(caretBelowLine).toBeGreaterThanOrEqual(32);
    // another style's header is another heading: the line follows it, off at the top and back once it's gone
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Meta+,");
    await page.getByRole("tab", { name: /appearance/i }).click();
    await page.getByTestId("design-card-atelier").click();
    await expect(page.locator("html")).toHaveAttribute("data-design", "atelier");
    await page.keyboard.press("Escape");
    await page.getByTestId("settings-dialog").waitFor({ state: "detached" });
    await page.locator("[data-reader-scroller]").evaluate((el) => (el.scrollTop = 0));
    await expect(line).not.toHaveAttribute("data-shown");
    await page.locator("[data-reader-scroller]").evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(line).toHaveAttribute("data-shown");
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test("a message's own actions: answer the one you chose, from its header or a right-click, and what's written comes along", async ({ app: page, server }) => {
    const id = await ingestConversation(server, { subject: "Elegir a cuál responder", count: 3, now: E2E_NOW });
    await selectThread(page, id, 'subject:"Elegir a cuál responder"');
    const messages = page.getByTestId("message");
    // its name is who and when, and a preview cut short: not the whole mail
    await expect(messages.nth(0).getByTestId("message-toggle")).toHaveAccessibleName(/^.{1,160}$/);
    await scenario("they show when you point at a message or Tab to it, the newest's too (the reply bar is below it), in a place kept for them", async () => {
      const opacity = (i: number) => messages.nth(i).getByTestId("message-actions").evaluate((el) => getComputedStyle(el).opacity);
      await page.mouse.move(0, 0);
      await expect.poll(() => opacity(2)).toBe("0");
      expect((await messages.nth(2).getByTestId("message-reply").boundingBox())!.height).toBeGreaterThanOrEqual(28);
      await messages.nth(0).getByTestId("message-toggle").click();
      await page.mouse.move(0, 0);
      await expect.poll(() => opacity(0)).toBe("0");
      await messages.nth(0).getByTestId("message-toggle").hover();
      await expect.poll(() => opacity(0)).toBe("1");
      await page.mouse.move(0, 0);
      await messages.nth(0).getByTestId("message-toggle").focus();
      await page.keyboard.press("Tab");
      await expect(messages.nth(0).getByTestId("message-reply")).toBeFocused();
      await expect.poll(() => opacity(0)).toBe("1");
    });
    await scenario("Reply on an older message answers that one, with its words quoted", async () => {
      const older = (await messages.nth(0).locator("[id^=msg-body-]").innerText()).trim().split("\n")[0]!;
      await messages.nth(0).getByTestId("message-reply").click();
      await expect(page.getByTestId("compose-body")).toBeFocused();
      await page.getByTestId("compose-quote").click();
      await expect(page.getByTestId("composer")).toContainText(older);
    });
    await scenario("a direct Reply leaves nothing behind: its menu, opened and closed after, gives focus back", async () => {
      await messages.nth(2).getByTestId("message-more").click();
      await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[role=menu]") != null)).toBe(true);
      await page.keyboard.press("Escape");
      await expect(messages.nth(2).getByTestId("message-more")).toBeFocused();
    });
    await scenario("the ⋯ menu and a right-click offer the same; choosing another message turns the draft to it, keeping the words", async () => {
      await page.getByTestId("compose-body").click();
      await page.keyboard.type("Lo que escribí");
      // the same kind of draft, on another message: the words stay, and the snack says what changed
      await messages.nth(2).getByTestId("message-reply").click();
      await expect(page.getByTestId("snack-message")).toHaveText("The draft is now on that message");
      await expect(page.getByTestId("compose-body")).toContainText("Lo que escribí");
      await messages.nth(2).getByTestId("message-more").click();
      await expect(page.getByTestId("message-actions-menu")).toBeVisible();
      await expect(page.getByTestId("message-menu-print")).toBeVisible();
      await page.getByTestId("message-menu-forward").click();
      await expect(page.getByTestId("composer")).toHaveAttribute("data-mode", "forward");
      await expect(page.getByTestId("compose-body")).toContainText("Lo que escribí");
      await messages.nth(1).getByTestId("message-toggle").click({ button: "right" });
      await page.getByTestId("message-menu-reply").click();
      await expect(page.getByTestId("composer")).toHaveAttribute("data-mode", "reply");
      await expect(page.getByTestId("compose-body")).toContainText("Lo que escribí");
    });
  });

  test("a chosen message that's gone: nothing answers another in its place; a draft on one that's gone can still turn to one that's there", async ({ app: page, server }) => {
    const store = server.backend.store;
    const db = sqlDb(store);
    const id = await ingestConversation(server, { subject: "Mensajes que se van", count: 3, now: E2E_NOW });
    await selectThread(page, id, 'subject:"Mensajes que se van"');
    const messages = page.getByTestId("message");
    const idOf = async (i: number) => Number(await messages.nth(i).getAttribute("data-message-id"));
    const [first, last] = [await idOf(0), await idOf(2)];
    const drafted = async () => (await store.drafts.list())[0];
    await scenario("the draft answers the newest; that message goes; Reply on the first still turns the draft, with its words", async () => {
      await page.keyboard.press("r");
      await page.getByTestId("compose-body").click();
      await page.keyboard.type("Lo escrito");
      await expect.poll(async () => (await drafted())?.body_text).toContain("Lo escrito");
      db.run("DELETE FROM messages WHERE id = ?", last);
      await messages.nth(0).getByTestId("message-toggle").click();
      await messages.nth(0).getByTestId("message-reply").click();
      await expect(page.getByTestId("snack-message")).toHaveText("The draft is now on that message");
      await expect(page.getByTestId("compose-body")).toContainText("Lo escrito");
      await expect.poll(async () => (await drafted())?.in_reply_to_message_id).toBe(first);
    });
    await scenario("the one chosen is gone: the draft stays as it was, and the person is told", async () => {
      const second = await idOf(1);
      db.run("DELETE FROM messages WHERE id = ?", second);
      await messages.nth(1).getByTestId("message-toggle").click();
      await messages.nth(1).getByTestId("message-reply").click();
      await expect(page.getByTestId("snack-message")).toContainText("no longer in this conversation");
      await expect.poll(async () => (await drafted())?.in_reply_to_message_id).toBe(first);
      await expect(page.getByTestId("compose-body")).toContainText("Lo escrito");
    });
  });

  test("the full-message view covers the conversation: its keys wait, and nothing folds under it", async ({ app: page, server }) => {
    const store = server.backend.store;
    const account = (await store.accounts.list())[0]!;
    const yuki = { name: "Yuki", email: "yuki@acme.studio" };
    const one = (n: number, bodyHtml: string) => ({ accountId: account.id, providerMsgId: `tall-${n}`, providerThreadId: "tall-thread", rfcMessageId: `<tall-${n}@e2e.test>`, inReplyTo: null, references: [], from: yuki, replyTo: [], to: [{ name: "", email: account.email }], cc: [], bcc: [], subject: "Una larga de verdad", date: E2E_NOW - 1000 + n, snippet: "Hola", bodyText: null, bodyHtml, bodyState: "full" as const, listId: null, isRead: true, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 100 });
    const tall = `<div>${Array.from({ length: 1400 }, (_, i) => `<p style="margin:0;height:20px">Line ${i}</p>`).join("")}</div>`;
    const { touched } = await store.sync.ingest([one(1, "<p>Corta</p>"), one(2, tall)], { applyFilters: false, now: E2E_NOW, classifier: null });
    await selectThread(page, touched[0]!, 'subject:"Una larga de verdad"');
    await page.getByRole("button", { name: "Show full message", exact: true }).click();
    const scroller = page.locator("[data-full-message-scroller]");
    await expect(scroller.locator("iframe")).toBeVisible();
    await page.keyboard.press("Shift+E");
    await page.keyboard.press("Shift+P");
    await expect(scroller.locator("iframe")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(scroller).toHaveCount(0);
    await expect(page.getByTestId("message-toggle").first()).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("expand-all")).toHaveText("Expand all");
  });

  test("the keyboard through a conversation: N and P go message by message, o and Enter open, ⇧E opens or folds them all", async ({ app: page, server }) => {
    const id = await ingestConversation(server, { subject: "Un hilo largo", count: 7, now: E2E_NOW });
    await selectThread(page, id, 'subject:"Un hilo largo"');
    const toggles = page.getByTestId("message-toggle");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await scenario("P from the newest steps back, into a folded run if it must, with a tint and no ring; N steps on", async () => {
      await expect(page.getByTestId("more-messages")).toBeVisible();
      await page.keyboard.press("Shift+P");
      await expect(page.getByTestId("more-messages")).toHaveCount(0);
      const target = page.locator("[data-testid=message-toggle]:focus");
      await expect(target).toHaveCount(1);
      await expect(target).toHaveAttribute("data-current", "true");
      expect(await target.evaluate((el) => getComputedStyle(el).boxShadow)).not.toContain("rgb");
      await page.keyboard.press("Shift+N");
      await expect(toggles.last()).toBeFocused();
      // each step keeps its mark: the header it left clears only its own
      await expect(toggles.last()).toHaveAttribute("data-current", "true");
      await page.keyboard.press("Shift+P");
      await expect(toggles.nth(5)).toBeFocused();
      await expect(toggles.nth(5)).toHaveAttribute("aria-expanded", "false");
      await page.keyboard.press("o");
      await expect(toggles.nth(5)).toHaveAttribute("aria-expanded", "true");
      await page.keyboard.press("Enter");
      await expect(toggles.nth(5)).toHaveAttribute("aria-expanded", "false");
    });
    await scenario("⇧E and the header's button open everything, then fold back to the newest", async () => {
      await page.keyboard.press("Shift+E");
      for (const i of [0, 3, 6]) await expect(toggles.nth(i)).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByTestId("expand-all")).toHaveText("Collapse all");
      // folding away the header that held focus: focus goes to the newest, never to nothing
      await toggles.nth(2).focus();
      await page.keyboard.press("Shift+E");
      await expect(page.getByTestId("more-messages")).toBeVisible();
      await expect(toggles.last()).toBeFocused();
      await page.keyboard.press("Shift+E");
      await expect(page.getByTestId("expand-all")).toHaveText("Collapse all");
      // the same from inside a body that closes
      await page.getByTestId("message").nth(1).locator(".type-body").evaluate((el: HTMLElement) => { el.tabIndex = -1; el.focus(); });
      await page.keyboard.press("Shift+E");
      await expect(toggles.last()).toBeFocused();
      await page.keyboard.press("Shift+E");
      await expect(page.getByTestId("expand-all")).toHaveText("Collapse all");
      await page.getByTestId("expand-all").click();
      await expect(page.getByTestId("more-messages")).toBeVisible();
      await expect(toggles.last()).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByTestId("expand-all")).toHaveText("Expand all");
    });
  });

  test("older messages say they open, a Tab reaches them, and history folds the same in plain text and HTML", async ({ app: page, server }) => {
    const store = server.backend.store;
    const id = await ingestConversation(server, { subject: "Con mensajes viejos", count: 3, now: E2E_NOW });
    await scenario("Expand all says they open, and Tab reaches a collapsed header with a ring", async () => {
      await selectThread(page, id, 'subject:"Con mensajes viejos"');
      const closed = page.getByTestId("message-toggle").first();
      await expect(closed).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByTestId("message-count")).toContainText("3 messages");
      await expect(page.getByTestId("expand-all")).toHaveText("Expand all");
      // a collapsed header shows it opens, as an open one shows it closes
      await expect(closed.getByTestId("message-disclosure")).toBeVisible();
      await expect(page.getByTestId("message-toggle").last().getByTestId("message-disclosure")).toHaveClass(/rotate-90/);
      await page.getByTestId("action-forward").focus();
      for (let i = 0; i < 8 && !(await closed.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
      await expect(closed).toBeFocused();
      expect(await closed.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe("none");
      await page.keyboard.press("Enter");
      await expect(closed).toHaveAttribute("aria-expanded", "true");
    });
    await scenario("my own sent mail, as Terno writes it: the quote is behind the same toggle as plain text's", async () => {
      const account = (await store.accounts.list())[0]!;
      const me = { name: "Luis", email: account.email };
      const yuki = { name: "Yuki", email: "yuki@acme.studio" };
      const base = { accountId: account.id, providerThreadId: "own-quote", replyTo: [], cc: [], bcc: [], subject: "Mi cita", snippet: "Mi respuesta", bodyState: "full" as const, listId: null, isRead: true, isStarred: false, inInbox: true, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 100 };
      const { touched } = await store.sync.ingest([
        { ...base, providerMsgId: "own-quote-1", rfcMessageId: "<own-quote-1@e2e.test>", inReplyTo: null, references: [], from: yuki, to: [me], date: E2E_NOW - 7_200_000, bodyText: "¿Va?", bodyHtml: null, isSent: false },
        { ...base, providerMsgId: "own-quote-2", rfcMessageId: "<own-quote-2@e2e.test>", inReplyTo: "<own-quote-1@e2e.test>", references: ["<own-quote-1@e2e.test>"], from: me, to: [yuki], date: E2E_NOW, bodyText: "Mi respuesta\n\nOn Monday, Yuki wrote:\n> ¿Va?", bodyHtml: '<div>Mi respuesta</div><div><br></div><div>On Monday, Yuki wrote:</div><blockquote style="margin:0 0 0 0.8ex;border-left:2px solid #ccc;padding-left:1ex"><div>¿Va?</div></blockquote>', isSent: true },
      ], { applyFilters: false, now: E2E_NOW, classifier: null });
      await selectThread(page, touched[0]!, 'subject:"Mi cita"');
      const frame = page.getByTestId("message").last().frameLocator("iframe");
      await expect(frame.getByText("Mi respuesta")).toBeVisible();
      await expect(frame.getByText("wrote:")).toHaveCount(0);
      const toggle = page.getByTestId("message").last().getByRole("button", { name: "Show quoted text" });
      await toggle.click();
      await expect(frame.getByText("wrote:")).toBeVisible();
      await expect(page.getByTestId("message").last().getByRole("button", { name: "Hide quoted text" })).toHaveAttribute("aria-expanded", "true");
    });
  });
});

test.describe("plan 37: “Load content” for every remote image the frame would block", () => {
  type Probe = { __terno: { hasRemoteContent(h: string, protocolRelative?: boolean): boolean } };
  test("“Load content”: detection reads the markup as the browser does; an SVG image's encoded scheme", async ({ app: page, server }) => {
    await scenario("detection reads the markup as the browser does, and stays linear on hostile input", async () => {
      const cases: [string, boolean, boolean?][] = [
        ['<img src="https://t.test/p.gif">', true],
        ['<div style="background:url(https://x.test/a.png)">x</div>', true],
        ['<table background="http://t.test/bg.png"><tr><td>x</td></tr></table>', true],
        ['<img src="cid:logo">', false],
        ['<svg><image href="https://t.test/i.png"/></svg>', true],
        ['<svg><image width="1" xlink:href="https://t.test/i.png"/></svg>', true],
        // Codex code review: an entity-encoded scheme, and a quoted ">" before the source
        ['<svg><image href="&#104;ttps://t.test/i.png"/></svg>', true],
        ['<img alt="a > b" src="https://t.test/p.gif">', true],
        ['<a href="https://acme.test/">Acme</a>', false],
        ['<p>see https://acme.test/ or //acme.test</p>', false],
        ['<img src="//t.test/p.gif">', false],
        ['<img src="//t.test/p.gif">', true, true],
        ['<div style="background:url(//t.test/a.png)">x</div>', true, true],
        ['<a href="//acme.test/">Acme</a>', false, true],
      ];
      const results = await page.evaluate((list) => list.map(([html, , rel]) => (window as unknown as Probe).__terno.hasRemoteContent(html, rel)), cases);
      expect(results).toEqual(cases.map(([, expected]) => expected));
      // (that it stays linear on hostile input is timed alone: reader-input.perf.spec.ts)
    });
    await scenario("an SVG image with an encoded scheme gets the row and its button; the button loads it", async () => {
      await fresh(page);
      const thread = Number(await page.locator("[data-testid=thread-row]").first().getAttribute("data-thread-id"));
      sqlDb(server.backend.store).run("UPDATE message_bodies SET body_html = ? WHERE message_id IN (SELECT id FROM messages WHERE thread_id = ?)", '<p>Logo</p><svg width="10" height="10"><image href="&#104;ttps://svg.test/logo.png" width="10" height="10"/></svg>', thread);
      const hits: string[] = [];
      await page.route(/svg\.test/, (route) => (hits.push(route.request().url()), route.abort()));
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await openRow(page, 0);
      const row = page.getByTestId("remote-blocked").first();
      await expect(row).toBeVisible();
      expect(hits).toEqual([]);
      await row.getByRole("button", { name: "Load content" }).click();
      await expect.poll(() => hits).toContain("https://svg.test/logo.png");
    });
  });

});
