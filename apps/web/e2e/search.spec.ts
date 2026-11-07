import type { IncomingMessage } from "@terno/store";
import { sqlDb } from "../../backend-dev/src/server";
import { E2E_NOW } from "./constants";
import type { Page } from "@playwright/test";
import { expect, focusList, navTo, rows, search, selectedRow, test, fresh, scenario, ingestConversation } from "./fixtures";

const scrollerOf = (page: Page) => page.locator("[data-testid=thread-list] [data-keep-scroll=list]");

test.describe("search", () => {
  test("search: results and clearing, from:, accents, every account, Escape and /, any of, addresses", async ({ app: page, server }) => {
    await scenario("shows results with timing and restores the inbox when cleared", async () => {
      const inboxFirst = await rows(page).first().getAttribute("data-thread-id");
      await search(page, "factura");
      await expect(page.getByTestId("search-stats")).toHaveText(/^\d+\+? results?$/);
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
      const bars = await page.getByTestId("account-mark").evaluateAll((els) => new Set(els.map((e) => e.className)).size);
      expect(bars).toBeGreaterThan(1);
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
    await page.getByTestId("unread-filter").click();
    await search(page, "zzfiltro");
    await expect(rows(page)).toHaveCount(1);
    await expect(page.getByTestId("unread-filter-status")).toBeVisible();
    await page.getByRole("button", { name: "Clear filter" }).click();
    await expect(rows(page)).toHaveCount(2);
    await expect(page.getByTestId("unread-filter-status")).toHaveCount(0);
    await expect(page.getByTestId("search-input")).toBeFocused();

    // a draft that isn't one of the results steps aside for the search, and comes back after it
    await page.getByRole("button", { name: "Clear search" }).click();
    await focusList(page);
    await page.keyboard.press("c");
    await page.getByTestId("compose-subject").fill("Borrador aparte");
    await focusList(page);
    await expect(page.getByTestId("drafts-strip")).toBeVisible();
    await search(page, "zzfiltro");
    await expect(page.getByTestId("drafts-strip")).toHaveCount(0);
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(page.getByTestId("drafts-strip")).toBeVisible();
  });
});
