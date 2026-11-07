import type { IncomingMessage } from "@terno/store";
import { sqlDb } from "../../backend-dev/src/server";
import { E2E_NOW } from "./constants";
import type { Page } from "@playwright/test";
import { expect, focusList, navTo, rows, search, selectedRow, test, fresh, scenario, ingestConversation, pickFilter } from "./fixtures";

const scrollerOf = (page: Page) => page.locator("[data-testid=thread-list] [data-keep-scroll=list]");

test.describe("search", () => {
  test("search: results and clearing, from:, accents, every account, Escape and /, any of, addresses", async ({ app: page, server }) => {
    await scenario("shows results with timing and restores the inbox when cleared", async () => {
      const inboxFirst = await rows(page).first().getAttribute("data-thread-id");
      await search(page, "factura");
      await expect(page.getByTestId("search-stats")).toHaveText(/^\d+\+? conversations? in saved mail$/);
      // plan 64: a search looks everywhere, so the list is the search's
      await expect(page.getByTestId("list-title")).toHaveText("Search");
      const n = await rows(page).count();
      expect(n).toBeGreaterThan(0);
      await page.getByRole("button", { name: "Clear search" }).click();
      await expect(page.getByTestId("search-stats")).toHaveCount(0);
      await expect(rows(page).first()).toHaveAttribute("data-thread-id", inboxFirst!);
    });
    await scenario("from: with an exact address only returns that sender", async () => {
      await fresh(page);
      await search(page, "in:all from:crew@morningbrew.com");
      await expect(rows(page).first()).toBeVisible();
      const senders = [...new Set(await page.getByTestId("row-from").allTextContents())];
      expect(senders).toEqual(["Morning Brew"]);
    });
    await scenario("is accent- and case-insensitive", async () => {
      await fresh(page);
      await search(page, "in:all REUNION");
      const subjects = await rows(page).evaluateAll((els) => els.map((e) => e.textContent ?? ""));
      expect(subjects.length).toBeGreaterThan(0);
      expect(subjects.some((s) => /reunión/i.test(s))).toBe(true);
    });
    await scenario("searches across all accounts at once", async () => {
      await fresh(page);
      await search(page, "in:all factura");
      expect(new Set(await page.getByTestId("account-label").allTextContents()).size).toBeGreaterThan(1);
    });
    await scenario("Escape clears an active query; / focuses the box from anywhere", async () => {
      await fresh(page);
      await page.keyboard.press("/");
      await expect(page.getByTestId("search-input")).toBeFocused();
      await page.keyboard.type("zzqxjv");
      await expect(page.getByTestId("list-empty")).toContainText("No results");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("search-input")).toHaveValue("");
      await expect(rows(page).first()).toBeVisible();
    });
    await scenario("a comma finds either; an address finds its sender and recipients, never a lookalike or a mention (plan 140)", async () => {
      const accountId = sqlDb(server.backend.store).get<{ id: number }>("SELECT id FROM accounts ORDER BY id LIMIT 1")!.id;
      const mail = (subject: string, over: Partial<IncomingMessage>, i: number): IncomingMessage => ({
        accountId, providerMsgId: `any-of-${i}`, providerThreadId: `any-of-${i}`, rfcMessageId: `<any-of-${i}@e2e.test>`, inReplyTo: null, references: [],
        from: { name: "Otro", email: "otro@else.example" }, to: [{ name: "Luis", email: "luis@else.example" }], cc: [], bcc: [],
        subject, date: E2E_NOW - i * 3_600_000, snippet: "", bodyText: "nada", bodyHtml: null, bodyState: "full", listId: null,
        isRead: true, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 1000, ...over,
      });
      await server.backend.store.sync.ingest([
        mail("Pepino uno", { from: { name: "Ana", email: "ana@pepino.test" } }, 1),
        mail("Pepino dos", { cc: [{ name: "Bob", email: "bob@pepino.studio" }] }, 2),
        mail("Pepino mencion", { bodyText: "Escribe a ana@pepino.test" }, 3),
        mail("Pepino parecido", { from: { name: "Maria", email: "maria.ana@pepino.test" } }, 4),
        mail("Pepino otro", { bodyText: "pepino.example" }, 5),
      ], { applyFilters: false, now: E2E_NOW, classifier: null });
      await fresh(page);
      const found = async (query: string, subjects: string[]) => {
        await search(page, query);
        await expect.poll(async () => (await rows(page).getByTestId("row-subject").allTextContents()).sort(), query).toEqual([...subjects].sort());
      };
      await found("pepino.test,pepino.studio ", ["Pepino uno", "Pepino dos", "Pepino mencion", "Pepino parecido"]);
      await found("pepino.test, pepino.studio", ["Pepino uno", "Pepino dos", "Pepino mencion", "Pepino parecido"]);
      await found("ana@pepino.test ", ["Pepino uno"]);
      await found("ana@pepino.test bob@pepino.studio ", ["Pepino uno", "Pepino dos"]);
      await found("ana@pepino.test,bob@pepino.studio", ["Pepino uno", "Pepino dos"]);
      await found('"ana@pepino.test"', ["Pepino uno", "Pepino mencion", "Pepino parecido"]);
    });
    await scenario("the coverage note: only with few results or none, and drafts stay out of the results (plan 158)", async () => {
      await fresh(page);
      await search(page, "factura");
      await expect(page.getByTestId("search-coverage")).toHaveCount(0);
      await search(page, "zzqxjv");
      await expect(page.getByTestId("search-coverage")).toBeVisible();
      await expect(page.getByTestId("search-input")).toHaveAccessibleDescription(await page.getByTestId("search-coverage").innerText());
    });
  });

  test("Esc: from the results to the field, the query kept; from the field out, the mailbox as it was (plan 158)", async ({ app: page, server }) => {
    for (let i = 0; i < 3; i++) await ingestConversation(server, { subject: `zzvuelta ${i}`, count: 1, now: E2E_NOW - i });
    await fresh(page);
    const input = page.getByTestId("search-input");
    const scroller = scrollerOf(page);
    await focusList(page);
    for (let i = 0; i < 12; i++) await page.keyboard.press("j");
    await scroller.evaluate((el) => (el.scrollTop = 320));
    const open = await selectedRow(page).getAttribute("data-thread-id");

    await search(page, "zzvuelta");
    await expect(rows(page)).toHaveCount(3);
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(0);
    const subject = await page.getByTestId("reader-subject").innerText();

    await page.keyboard.press("ArrowDown");
    await expect(scroller).toBeFocused();
    // ↓ arrives on the top hit; it doesn't step past it
    await expect(selectedRow(page)).toHaveText(/zzvuelta/);
    await expect(page.getByTestId("reader-subject")).toHaveText(subject);
    await page.keyboard.press("j");
    await page.keyboard.press("Escape");
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("zzvuelta");

    await page.keyboard.press("Escape");
    await expect(input).toHaveValue("");
    await expect(page.getByTestId("search-stats")).toHaveCount(0);
    await expect(selectedRow(page)).toHaveAttribute("data-thread-id", open!);
    await expect(scroller).toBeFocused();
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(320);

    // and the same across a mailbox and back
    await navTo(page, "sent");
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(0);
    await navTo(page, "inbox");
    await expect(selectedRow(page)).toHaveAttribute("data-thread-id", open!);
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(320);
  });

  test("before a search it says what it can do; an operator waits for its value; with no results the reader is about the search (plan 158)", async ({ app: page }) => {
    await scenario("focused and empty, the syntax, and what's looked through; a click types it, a letter hides it", async () => {
      const help = page.getByTestId("search-help-panel");
      await expect(help).toHaveCount(0);
      await page.keyboard.press("/");
      await expect(help).toBeVisible();
      await expect(help).toContainText("from:ana");
      await expect(help.getByTestId("search-help-scope")).toContainText("Archive, Spam and Trash");
      // Esc from a row is Esc from the field
      await page.keyboard.press("Tab");
      await expect(help.getByTestId("search-help-row").first()).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(help).toHaveCount(0);
      await expect(page.getByTestId("search-input")).not.toBeFocused();
      await page.keyboard.press("/");
      // emptied again, it's the mailbox that's back: its rows aren't covered
      await page.keyboard.type("z");
      await expect(help).toHaveCount(0);
      await page.keyboard.press("Backspace");
      await expect(page.getByTestId("search-input")).toBeFocused();
      await page.waitForTimeout(100);
      await expect(help).toHaveCount(0);
      await page.keyboard.press("Escape");
      await page.keyboard.press("/");
      await help.getByTestId("search-help-row").filter({ hasText: "from:ana" }).click();
      await expect(page.getByTestId("search-input")).toHaveValue("from:");
      await expect(page.getByTestId("search-input")).toBeFocused();
      await expect(help).toHaveCount(0);
    });
    await scenario("from: alone isn't the word from: nothing is marked until it has a value", async () => {
      await expect(page.getByTestId("thread-list")).toHaveAttribute("data-results-for", /from:"\]$/);
      await expect(page.getByTestId("row-match")).toHaveCount(0);
      await page.getByTestId("search-input").pressSequentially("mo");
      await expect(rows(page).first().getByTestId("row-from").getByTestId("row-match")).toBeVisible();
    });
    await scenario("no results: under the field, for what and what a search understands, a row puts the words to use; the reader stays quiet", async () => {
      await fresh(page);
      await search(page, "zzqxjv");
      const empty = page.getByTestId("list-empty");
      await expect(empty).toContainText("No results for “zzqxjv”");
      await expect(empty.getByTestId("search-help")).toContainText("has:attachment");
      // said, not shown: the list says it
      await expect(page.getByTestId("search-stats")).toHaveClass(/sr-only/);
      await expect(page.getByTestId("reader-search-empty")).toHaveText("");
      await expect(page.getByTestId("reader-empty")).toHaveCount(0);
      await empty.getByTestId("search-help-row").filter({ hasText: "from:ana" }).click();
      await expect(page.getByTestId("search-input")).toHaveValue("from:zzqxjv");
      await expect(page.getByTestId("search-input")).toBeFocused();
      // a place or a date only takes its own values: the words go beside it
      await search(page, "zzqxjv");
      await empty.getByTestId("search-help-row").filter({ hasText: "in:archive" }).click();
      await expect(page.getByTestId("search-input")).toHaveValue("zzqxjv in:archive ");
    });
  });

  test("opening a result shows the match: marked in the message, in a frame too, in view, with next and previous (plan 158)", async ({ app: page, server }) => {
    const accountId = sqlDb(server.backend.store).get<{ id: number }>("SELECT id FROM accounts ORDER BY id LIMIT 1")!.id;
    const filler = "<p>Una línea cualquiera para llenar la pantalla.</p>".repeat(120);
    const mail = (i: number, thread: string, over: Partial<IncomingMessage>): IncomingMessage => ({
      accountId, providerMsgId: `find-${thread}-${i}`, providerThreadId: `find-${thread}`, rfcMessageId: `<find-${thread}-${i}@e2e.test>`, inReplyTo: i ? `<find-${thread}-${i - 1}@e2e.test>` : null, references: i ? [`<find-${thread}-${i - 1}@e2e.test>`] : [],
      from: { name: "Otro", email: "otro@else.example" }, to: [{ name: "Luis", email: "luis@else.example" }], cc: [], bcc: [],
      subject: `Asunto ${thread}`, date: E2E_NOW - (9 - i) * 3_600_000, snippet: "", bodyText: "Sin nada.", bodyHtml: null, bodyState: "full", listId: null,
      isRead: true, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 1000, ...over,
    });
    await server.backend.store.sync.ingest([
      mail(0, "html", { subject: "Zzhallazgo en el asunto", bodyText: null, bodyHtml: `${filler}<p id="far">El zzhallazgo está <b>aquí abajo</b> y otro zzhallazgo después.</p>${filler}` }),
      mail(0, "clip", { bodyText: "El zzrecortado de arriba.", bodyHtml: `<p>El zzrecortado de arriba.</p>${"<p>Una línea más para pasar del corte del marco.</p>".repeat(1200)}<p>El zzrecortado de abajo.</p>` }),
      mail(0, "two", { bodyText: "Uno con el zzdoble.", isRead: false }),
      mail(1, "two", { bodyText: "Otro con el zzdoble." }),
      mail(0, "link", { bodyText: "Mira https://example.test/zzenlace/1 cuando puedas." }),
      mail(0, "folded", { bodyText: "Primero: el zzplegado está aquí." }),
      mail(1, "folded", { bodyText: "Luego nada." }),
      mail(2, "folded", { bodyText: "Y al final tampoco." }),
    ], { applyFilters: false, now: E2E_NOW, classifier: null });
    await fresh(page);
    await search(page, "zzhallazgo");
    await rows(page).first().click();

    await scenario("an HTML mail: marked in its frame, the reader (not the frame) scrolled to the first, the count and the steps", async () => {
      await expect(page.getByTestId("reader-subject-match")).toHaveText("Zzhallazgo");
      const count = page.getByTestId("reader-matches-count");
      await expect(count).toHaveText("Match 1 of 2");
      const frame = page.getByTestId("reader").locator("iframe");
      const scroller = page.locator("[data-reader-scroller]");
      const shown = () => frame.evaluate((f: HTMLIFrameElement) => {
        const mark = f.contentDocument!.querySelector<HTMLElement>("mark[data-reader-current]")!;
        const top = f.getBoundingClientRect().top + mark.getBoundingClientRect().top;
        const box = f.closest("[data-reader-scroller]")!.getBoundingClientRect();
        return { text: mark.textContent, inView: top >= box.top && top <= box.bottom, frameScroll: f.contentDocument!.documentElement.scrollTop + f.contentDocument!.body.scrollTop };
      });
      await expect.poll(async () => (await shown()).inView).toBe(true);
      expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      expect(await shown()).toMatchObject({ text: "zzhallazgo", frameScroll: 0 });
      await page.getByTestId("reader-match-next").click();
      await expect(count).toHaveText("Match 2 of 2");
      await page.getByTestId("reader-match-next").click();
      await expect(count).toHaveText("Match 1 of 2");
      await page.keyboard.press("ControlOrMeta+Shift+g");
      await expect(count).toHaveText("Match 2 of 2");
      // with focus in the mail too
      await frame.evaluate((f: HTMLIFrameElement) => f.contentDocument!.body.setAttribute("tabindex", "-1"));
      await frame.evaluate((f: HTMLIFrameElement) => f.contentDocument!.body.focus());
      await page.keyboard.press("ControlOrMeta+g");
      await expect(count).toHaveText("Match 1 of 2");
    });
    await scenario("past where a frame clips, a match can't be shown, so it isn't counted", async () => {
      await search(page, "zzrecortado");
      await rows(page).first().click();
      await expect(page.getByTestId("reader-matches-count")).toHaveText("Match 1 of 1");
    });
    await scenario("folding the message before the one in hand: that one's still in hand, its number corrected; a link's text is marked, still a link", async () => {
      await search(page, "zzdoble");
      await rows(page).first().click();
      const count = page.getByTestId("reader-matches-count");
      await expect(count).toHaveText("Match 1 of 2");
      await page.getByTestId("reader-match-next").click();
      await expect(count).toHaveText("Match 2 of 2");
      await page.getByTestId("message").first().getByTestId("message-toggle").click();
      await expect(count).toHaveText("Match 1 of 1");
      await expect(page.locator("mark[data-reader-current]")).toHaveCount(1);
      await expect(page.locator("mark[data-reader-current]")).toHaveText("zzdoble");
      await search(page, "zzenlace");
      await rows(page).first().click();
      await expect(page.getByTestId("reader").locator("a[href*=zzenlace] mark")).toHaveText("zzenlace");
    });
    await scenario("a folded message holding the words opens, plain text marked; leaving the search takes the marks and the steps away", async () => {
      await search(page, "zzplegado");
      await rows(page).first().click();
      await expect(page.getByTestId("reader-match")).toHaveText("zzplegado");
      await expect(page.getByTestId("reader-matches-count")).toHaveText("Match 1 of 1");
      // folded away: its marks with it, and no steps to nothing
      await page.getByTestId("message").filter({ hasText: "zzplegado" }).getByTestId("message-toggle").click();
      await expect(page.getByTestId("reader-matches")).toHaveCount(0);
      await page.getByTestId("message").filter({ has: page.getByTestId("message-toggle") }).first().getByTestId("message-toggle").click();
      await expect(page.getByTestId("reader-matches-count")).toHaveText("Match 1 of 1");
      await page.getByRole("button", { name: "Clear search" }).click();
      await expect(page.getByTestId("reader-matches")).toHaveCount(0);
      await expect(page.getByTestId("reader-match")).toHaveCount(0);
    });
  });

  test("at the smallest window a result shows its match, in the subject too (plan 158)", async ({ app: page, server }) => {
    const accountId = sqlDb(server.backend.store).get<{ id: number }>("SELECT id FROM accounts ORDER BY id LIMIT 1")!.id;
    await server.backend.store.sync.ingest([{
      accountId, providerMsgId: "narrow-1", providerThreadId: "narrow", rfcMessageId: "<narrow-1@e2e.test>", inReplyTo: null, references: [],
      from: { name: "Otro", email: "otro@else.example" }, to: [{ name: "Luis", email: "luis@else.example" }], cc: [], bcc: [],
      subject: "Sobre el zzcobro", date: E2E_NOW, snippet: "Hola Luis, te escribo porque hubo un problema con el zzcobro de este mes", bodyText: "Hola Luis, te escribo porque hubo un problema con el zzcobro de este mes", bodyHtml: null, bodyState: "full", listId: null,
      isRead: true, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 1000,
    }], { applyFilters: false, now: E2E_NOW, classifier: null });
    await page.setViewportSize({ width: 1100, height: 700 });
    await fresh(page);
    await search(page, "zzcobro");
    const row = rows(page).first();
    await expect(row.getByTestId("row-subject").getByTestId("row-match")).toHaveText("zzcobro");
    const mark = row.getByTestId("row-snippet").getByTestId("row-match");
    await expect(mark).toHaveText("zzcobro");
    // whole, inside what the snippet's box shows
    const box = await row.getByTestId("row-snippet").evaluate((el) => {
      const m = el.querySelector("mark")!.getBoundingClientRect();
      return { end: m.right, edge: el.getBoundingClientRect().right };
    });
    expect(box.end).toBeLessThanOrEqual(box.edge);
  });

  test("results say why they matched: the words marked, and for a match in the body the sentence it's in, not a quote of it (plan 158)", async ({ app: page, server }) => {
    const accountId = sqlDb(server.backend.store).get<{ id: number }>("SELECT id FROM accounts ORDER BY id LIMIT 1")!.id;
    const mail = (i: number, over: Partial<IncomingMessage>): IncomingMessage => ({
      accountId, providerMsgId: `why-${i}`, providerThreadId: "why", rfcMessageId: `<why-${i}@e2e.test>`, inReplyTo: i ? `<why-${i - 1}@e2e.test>` : null, references: i ? [`<why-${i - 1}@e2e.test>`] : [],
      from: { name: "Otro Remitente", email: "otro@else.example" }, to: [{ name: "Luis", email: "luis@else.example" }], cc: [], bcc: [],
      subject: "Cena del viernes", date: E2E_NOW - (5 - i) * 3_600_000, snippet: "Nos vemos a las ocho", bodyText: "Nos vemos a las ocho.", bodyHtml: null, bodyState: "full", listId: null,
      isRead: true, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 1000, ...over,
    });
    await server.backend.store.sync.ingest([
      mail(0, { bodyText: "Hola Luis.\nTe paso el zzpresupuesto del local, a ver qué te parece.\nUn abrazo." }),
      mail(1, { bodyText: "Nos vemos a las ocho.\n\nOn Tue, Otro wrote:\n> Te paso el zzpresupuesto del local" }),
    ], { applyFilters: false, now: E2E_NOW, classifier: null });
    await fresh(page);
    await search(page, "zzpresupuesto");
    const row = rows(page).first();
    await expect(row.getByTestId("row-snippet")).toHaveAttribute("data-excerpt");
    await expect(row.getByTestId("row-snippet")).toContainText("zzpresupuesto del local, a ver qué te parece.");
    await expect(row.getByTestId("row-match")).toHaveText("zzpresupuesto");

    // accents and case, in the sender and the subject, and only where the operator looks
    await search(page, "CENA");
    await expect(rows(page).first().getByTestId("row-subject").getByTestId("row-match")).toHaveText("Cena");
    await search(page, "from:remitente");
    await expect(rows(page).first().getByTestId("row-from").getByTestId("row-match")).toHaveText("Remitente");
    await expect(rows(page).first().getByTestId("row-subject").getByTestId("row-match")).toHaveCount(0);

    // and only in a search
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(page.getByTestId("search-stats")).toHaveCount(0);
    await expect(page.getByTestId("row-match")).toHaveCount(0);
  });

  test("an inherited quick filter shows in the search's header and clears there; nothing above the results but results (plan 158)", async ({ app: page, server }) => {
    await ingestConversation(server, { subject: "zzfiltro leido", count: 1, now: E2E_NOW });
    await ingestConversation(server, { subject: "zzfiltro nuevo", count: 1, unread: 1, now: E2E_NOW });
    await fresh(page);
    await pickFilter(page, "unread");
    await search(page, "zzfiltro");
    await expect(rows(page)).toHaveCount(1);
    await expect(page.getByTestId("filter-menu")).toHaveText("Unread");
    await page.getByRole("button", { name: "Clear filter" }).click();
    await expect(rows(page)).toHaveCount(2);
    await expect(page.getByTestId("filter-menu")).toHaveText("Filter");

    // a draft that isn't one of the results steps aside for the search, and comes back after it
    await page.getByRole("button", { name: "Clear search" }).click();
    await focusList(page);
    await page.keyboard.press("c");
    await page.getByTestId("compose-subject").fill("Borrador aparte");
    // left as Esc leaves it: open, it's on screen, not in the strip
    await page.getByTestId("compose-subject").press("Escape");
    await focusList(page);
    await expect(page.getByTestId("drafts-strip")).toBeVisible();
    await search(page, "zzfiltro");
    await expect(page.getByTestId("drafts-strip")).toHaveCount(0);
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(page.getByTestId("drafts-strip")).toBeVisible();
  });
});
