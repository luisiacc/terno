import type { IncomingMessage } from "@terno/store";
import { sqlDb } from "../../backend-dev/src/server";
import { E2E_NOW } from "./constants";
import { expect, rows, search, test, fresh, scenario } from "./fixtures";

test.describe("search", () => {
  test("search: results and clearing, from:, accents, every account, Escape and /, any of, addresses", async ({ app: page, server }) => {
    await scenario("shows results with timing and restores the inbox when cleared", async () => {
      const inboxFirst = await rows(page).first().getAttribute("data-thread-id");
      await search(page, "factura");
      await expect(page.getByTestId("search-stats")).toHaveText(/\d+\+? results · (<1|\d+) ms/);
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
  });

});
