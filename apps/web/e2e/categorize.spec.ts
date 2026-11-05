import type { Locator, Page } from "@playwright/test";
import { termsQuery } from "@terno/core";
import type { DevServer } from "../../backend-dev/src/server";
import { expect, focusList, scenario, selectRows, selectThread, test, searchBox } from "./fixtures";
import { sqlDb } from "../../backend-dev/src/server";

/** What the backend would add for a scope (the same RPC the chips call). */
async function countOf(server: DevServer, categoryId: number, query: string): Promise<number> {
  const r = await server.backend.server.invoke("categorize.count", { categoryId, scope: { kind: "query", query } }, { clientId: "test", origin: "dev" });
  return r.count;
}

/** Opening a thread marks it read after a short dwell and the reader refreshes: hover only after that. */
async function settled(server: DevServer, threadId: number) {
  await expect.poll(() => sqlDb(server.backend.store).get<{ u: number }>("SELECT unread_count AS u FROM threads WHERE id = ?", threadId)!.u).toBe(0);
  await new Promise((r) => setTimeout(r, 300));
}

const toast = (page: Page, text: string | RegExp) => page.locator("[data-testid=snack]").filter({ hasText: text });

/** An Uber receipt in the inbox that isn't in Facturas yet, plus a live count of the ones still outside. */
function uberSetup(server: DevServer) {
  const db = sqlDb(server.backend.store);
  const facturas = db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Facturas'")!.id;
  const target = db.get<{ id: number }>(
    `SELECT t.id FROM threads t WHERE t.in_inbox = 1 AND t.last_from_email = 'uber.receipts@uber.com'
     AND NOT EXISTS (SELECT 1 FROM thread_categories WHERE thread_id = t.id AND category_id = ?) ORDER BY t.last_date DESC LIMIT 1`,
    facturas,
  )!.id;
  const outside = () =>
    db.get<{ c: number }>(
      `SELECT count(*) c FROM threads t WHERE t.last_from_email = 'uber.receipts@uber.com' AND t.in_trash = 0 AND t.in_spam = 0
       AND NOT EXISTS (SELECT 1 FROM thread_categories WHERE thread_id = t.id AND category_id = ?)`,
      facturas,
    )!.c;
  return { db, facturas, target, outside };
}

/** An offer line's key: its number, which follows the lines shown (plan 91). */
const keyOf = async (line: Locator) => (await line.locator("kbd").first().textContent())!;

async function fileWithPicker(page: Page, categoryId: number) {
  await page.keyboard.press("l");
  await expect(page.getByTestId("category-picker")).toBeVisible();
  await page.getByTestId(`pick-category-${categoryId}`).click();
  await focusList(page);
}

test.describe("categorization snackbar", () => {
  test("the sender's line: a key files it and their future mail, Undo and z take it all back; z undoes the add alone, Esc just closes", async ({ app: page, server }) => {
    await scenario("filing one thread offers all mail from its sender: 1 files it and their future mail, the result toast undoes both", async () => {
      const { db, facturas, target, outside } = uberSetup(server);
      const filters = () => db.all<{ rule_json: string }>("SELECT rule_json FROM filters WHERE rule_json LIKE '%uber.receipts@uber.com%'").map((r) => JSON.parse(r.rule_json));
      const rest = outside() - 1;
      expect(rest).toBeGreaterThan(1);
      await selectThread(page, target, "in:inbox from:uber.receipts@uber.com");
      await fileWithPicker(page, facturas);

      const snack = page.getByTestId("category-snackbar");
      await expect(snack.getByTestId("snackbar-title")).toHaveText("Added to Facturas");
      await expect(snack.getByTestId("snackbar-sender")).toContainText("Everything from Uber Receipts");
      await expect(snack.getByTestId("snackbar-sender-count")).toHaveText(`${rest}`);
      await expect(page.getByTestId("reader").locator("[data-testid=category-chip]", { hasText: "Facturas" })).toBeVisible();
      // plan 81: it says it catches new mail too, in a word and in full
      await expect(snack.getByTestId("snackbar-sender-future")).toHaveText("+ new mail");
      await expect(snack.getByTestId("snackbar-sender")).toHaveAccessibleDescription("Adds every conversation from Uber Receipts to Facturas, and their new mail from now on.");
      await snack.getByTestId("snackbar-sender").hover();
      await expect(page.getByTestId("snackbar-sender-help")).toHaveText("Adds every conversation from Uber Receipts to Facturas, and their new mail from now on.");
      // plan 91: each line's key is its place (the same sender and subject comes first when it adds anything)
      await page.keyboard.press(await keyOf(snack.getByTestId("snackbar-sender")));
      await expect(snack).toHaveCount(0);
      const done = toast(page, `${rest} added to Facturas, future mail too`);
      await expect(done).toBeVisible();
      await expect.poll(outside).toBe(0);
      expect(filters()).toEqual([{ match: "all", conditions: [{ field: "from", op: "equals", value: "uber.receipts@uber.com" }], actions: [{ type: "addCategory", categoryId: facturas }] }]);
      await expect(done.getByTestId("snack-action")).toHaveAccessibleName("Undo, and stop adding future mail");
      await done.getByTestId("snack-action").click();
      // plan 91: one Undo takes back the newest first, then the filing it followed: everything is as before
      await expect.poll(outside).toBe(rest + 1);
      await expect.poll(() => filters().length).toBe(0);
      expect(db.get("SELECT 1 FROM thread_categories WHERE thread_id = ? AND category_id = ?", target, facturas) ?? null).toBeNull();
    });
    await scenario("plan 91: z takes back the sender line, its filter, then the filing that opened the snackbar", async () => {
      const { db, facturas, target, outside } = uberSetup(server);
      const rest = outside() - 1;
      await selectThread(page, target, "in:inbox from:uber.receipts@uber.com");
      await fileWithPicker(page, facturas);
      await expect(page.getByTestId("snackbar-sender-count")).toHaveText(`${rest}`);
      await page.keyboard.press(await keyOf(page.getByTestId("snackbar-sender")));
      await expect(toast(page, "future mail too")).toBeVisible();
      await expect.poll(outside).toBe(0);
      await focusList(page);
      await page.keyboard.press("z");
      await expect.poll(outside).toBe(rest + 1);
      await expect.poll(() => db.get<{ c: number }>("SELECT count(*) c FROM filters WHERE rule_json LIKE '%uber.receipts@uber.com%'")!.c).toBe(0);
      expect(db.get("SELECT 1 FROM thread_categories WHERE thread_id = ? AND category_id = ?", target, facturas) ?? null).toBeNull();
    });
    await scenario("z undoes the add itself without teaching the engine anything; Esc just closes", async () => {
      const { db, facturas, target } = uberSetup(server);
      await selectThread(page, target, "in:inbox from:uber.receipts@uber.com");
      await fileWithPicker(page, facturas);
      await expect(page.getByTestId("category-snackbar")).toBeVisible();
      await expect.poll(() => db.get("SELECT label FROM cls_examples WHERE thread_id = ? AND category_id = ?", target, facturas)).toEqual({ label: 1 });
      await page.keyboard.press("z");
      await expect(page.getByTestId("category-snackbar")).toHaveCount(0);
      await expect.poll(() => db.get("SELECT 1 FROM thread_categories WHERE thread_id = ? AND category_id = ?", target, facturas) ?? null).toBeNull();
      // an undo is not a removal: no negative example
      expect(db.get("SELECT 1 FROM cls_examples WHERE thread_id = ?", target)).toBeUndefined();
      await expect(page.getByTestId("reader").locator("[data-testid=category-chip]", { hasText: "Facturas" })).toHaveCount(0);

      await fileWithPicker(page, facturas);
      await expect(page.getByTestId("category-snackbar")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("category-snackbar")).toHaveCount(0);
      expect(db.get("SELECT 1 FROM thread_categories WHERE thread_id = ? AND category_id = ?", target, facturas)).toBeDefined();
    });
  });

  test("what the chips offer: several threads share them, and a sender with nothing left", async ({ app: page, server }) => {
    await scenario("several threads: the chips cover what they share, without duplicates", async () => {
      const db = sqlDb(server.backend.store);
      const lecturas = db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Lecturas'")!.id;
      const [a, b] = db.all<{ id: number }>(
        `SELECT t.id FROM threads t WHERE t.in_inbox = 1 AND t.last_from_email IN ('notifications@github.com')
         AND NOT EXISTS (SELECT 1 FROM thread_categories WHERE thread_id = t.id AND category_id = ?) ORDER BY t.last_date DESC LIMIT 2`,
        lecturas,
      );
      await (await searchBox(page)).fill("in:inbox from:notifications@github.com");
      await expect(page.getByTestId("search-stats")).toBeVisible();
      await selectRows(page, [a!.id, b!.id]);
      await fileWithPicker(page, lecturas);
      const snack = page.getByTestId("category-snackbar");
      await expect(snack.getByTestId("snackbar-title")).toHaveText("2 conversations added to Lecturas");
      await expect(snack.getByTestId("snackbar-sender")).toContainText("Everything from GitHub");
      // @github.com has no mail beyond this sender: no second chip saying the same
      await expect(snack.getByTestId("snackbar-sender-count")).toBeVisible();
      await expect(snack.getByTestId("snackbar-domain")).toHaveCount(0);
      const githubOutside = () =>
        db.get<{ c: number }>(
          `SELECT count(*) c FROM threads t WHERE t.in_trash = 0 AND t.in_spam = 0 AND t.id IN (SELECT thread_id FROM messages WHERE from_email = 'notifications@github.com')
           AND NOT EXISTS (SELECT 1 FROM thread_categories WHERE thread_id = t.id AND category_id = ?)`,
          lecturas,
        )!.c;
      await expect(snack.getByTestId("snackbar-sender-count")).toHaveText(`${githubOutside()}`);
      // plan 81: the hidden domain line has no key: the next number names whatever line is there (plan 91: they follow the lines)
      const keys = await snack.getByTestId("snackbar-offers").locator("kbd").allTextContents();
      expect(keys).toEqual(keys.map((_, i) => String(i + 1)));
      expect(db.get<{ c: number }>("SELECT count(*) c FROM filters WHERE rule_json LIKE '%fromDomain%github.com%'")!.c).toBe(0);
      await snack.getByTestId("snackbar-sender").click();
      await expect.poll(githubOutside).toBe(0);
    });
    await scenario("plan 81: a sender with nothing left still offers 1, without a count: it makes only the filter; 5 is gone", async () => {
      const { db, facturas, target, outside } = uberSetup(server);
      // everything else from them is already in Facturas
      db.exec(
        `INSERT OR IGNORE INTO thread_categories (thread_id, category_id, added_by, added_at)
         SELECT DISTINCT t.id, ${facturas}, 'user', 0 FROM threads t JOIN messages m ON m.thread_id = t.id WHERE m.from_email = 'uber.receipts@uber.com' AND t.id != ${target}`,
      );
      await selectThread(page, target, "in:inbox from:uber.receipts@uber.com");
      await fileWithPicker(page, facturas);
      expect(outside()).toBe(0);
      const snack = page.getByTestId("category-snackbar");
      await expect(snack.getByTestId("snackbar-sender")).toContainText("Everything from Uber Receipts");
      await expect(snack.getByTestId("snackbar-count-loading")).toHaveCount(0);
      await expect(snack.getByTestId("snackbar-sender-count")).toHaveCount(0);
      await page.keyboard.press("5");
      await expect(snack).toBeVisible();
      await page.keyboard.press("1");
      await expect(toast(page, "New mail like this will be added to Facturas")).toBeVisible();
      expect(db.get<{ c: number }>("SELECT count(*) c FROM filters WHERE rule_json LIKE '%uber.receipts@uber.com%'")!.c).toBe(1);
    });
  });
});

test.describe("everything about X and Y", () => {
  test("topic chips and View", async ({ app: page, server }) => {
    await scenario("topic chips recount as they toggle, View previews the query, 4 files it", async () => {
      const { db, facturas, target } = uberSetup(server);
      await selectThread(page, target, "in:inbox from:uber.receipts@uber.com");
      await fileWithPicker(page, facturas);
      const snack = page.getByTestId("category-snackbar");
      const chips = snack.getByTestId("snackbar-term");
      await expect(chips.first()).toBeVisible();
      const pressed = snack.locator("[data-testid=snackbar-term][aria-pressed=true]");
      await expect(pressed).toHaveCount(2);
      const selected = await pressed.allTextContents();
      // plan 89: the words come only from the sender at first; from anyone once that's off
      const onlyFrom = snack.getByTestId("snackbar-only-from");
      await expect(onlyFrom).toHaveAttribute("aria-pressed", "true");
      const fromSender = await countOf(server, facturas, `${termsQuery(selected, "Facturas")} from:uber.receipts@uber.com`);
      await expect(snack.getByTestId("snackbar-topic-count")).toHaveText(`${fromSender}`);
      await expect(snack.getByTestId("snackbar-topic-future")).toHaveText("+ new mail");
      await onlyFrom.click();
      await expect(onlyFrom).toHaveAttribute("aria-pressed", "false");
      const count = (terms: string[]) => countOf(server, facturas, termsQuery(terms, "Facturas"));
      const both = await count(selected);
      await expect(snack.getByTestId("snackbar-topic-count")).toHaveText(`${both}`);
      // one word alone matches at least as much
      await pressed.first().click();
      await expect(snack.getByTestId("snackbar-topic-count")).toHaveText(`${await count(selected.slice(1))}`);
      await pressed.first().click(); // back off: nothing selected
      await expect(snack.getByTestId("snackbar-topic-count")).toHaveCount(0);
      await chips.filter({ hasText: selected[0]! }).click();
      await chips.filter({ hasText: selected[1]! }).click();
      await expect(snack.getByTestId("snackbar-topic-count")).toHaveText(`${both}`);

      await snack.getByTestId("snackbar-view").click();
      await expect(page.getByTestId("search-input")).toHaveValue(`${selected.map((w) => `"${w}"`).join(" ")} -category:Facturas`);
      await expect(page.getByTestId("search-stats")).toBeVisible();

      // filing it from a fresh snackbar with the keyboard
      await (await searchBox(page)).fill("in:inbox from:uber.receipts@uber.com");
      await selectThread(page, target, "in:inbox from:uber.receipts@uber.com");
      await fileWithPicker(page, db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Viajes'")!.id);
      await expect(page.getByTestId("snackbar-topic-count")).toBeVisible();
      // the words line's key is whatever number its line has (plan 91)
      await page.keyboard.press((await page.getByTestId("snackbar-topic-apply").locator("kbd").textContent())!);
      // plan 89: checked words file now and become a filter for new mail (from the sender: "Only from" is on again)
      await expect(toast(page, /\d+ added to Viajes, future mail too/)).toBeVisible();
      const viajes = db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Viajes'")!.id;
      const filters = db.all<{ rule_json: string }>("SELECT rule_json FROM filters");
      const rule = filters.map((f) => JSON.parse(f.rule_json) as { conditions: { field: string; op: string; value: string }[]; actions: { categoryId?: number }[] }).find((r) => r.actions[0]?.categoryId === viajes)!;
      // the words the new snackbar had checked (its own two), then the sender
      expect(rule.conditions).toHaveLength(3);
      expect(rule.conditions.slice(0, 2).every((c) => c.field === "text" && c.op === "contains")).toBe(true);
      expect(rule.conditions[2]).toEqual({ field: "from", op: "equals", value: "uber.receipts@uber.com" });
    });
    await scenario("View shows the same set bulk apply would file: no account or review scope carried over", async () => {
      const { facturas, target } = uberSetup(server);
      const account = sqlDb(server.backend.store).get<{ account_id: number }>("SELECT account_id FROM threads WHERE id = ?", target)!.account_id;
      await page.getByTestId(`nav-account-${account}`).click();
      await selectThread(page, target, "in:inbox from:uber.receipts@uber.com");
      await fileWithPicker(page, facturas);
      const snack = page.getByTestId("category-snackbar");
      await expect(snack.getByTestId("snackbar-topic-count")).toHaveText(/^\d/);
      const count = Number((await snack.getByTestId("snackbar-topic-count").textContent())!.replace(/\D/g, ""));
      await snack.getByTestId("snackbar-view").click();
      await expect(page.getByTestId("thread-list")).toHaveAttribute("data-results-for", /^\["all",null,null,null,/);
      if (count < 100) await expect(page.getByTestId("search-stats")).toContainText(`${count} results`);
    });
  });

  test("the offers' lines, their help and countdown, and More…", async ({ app: page, server }) => {
    // the next scenario's own snackbar: z takes this filing back
    const undoFiling = async () => {
      await focusList(page);
      await page.keyboard.press("z");
      await expect(page.getByTestId("category-snackbar")).toHaveCount(0);
    };
    await scenario("plan 81: one offer per line, all of it in view; 4 says what it files, on hover and to a screen reader", async () => {
      const { facturas, target } = uberSetup(server);
      await selectThread(page, target, "in:inbox from:uber.receipts@uber.com");
      await fileWithPicker(page, facturas);
      const snack = page.getByTestId("category-snackbar");
      await expect(snack.getByTestId("snackbar-topic-count")).toHaveText(/^\d/);
      // stacked: every line sits inside the bar, the sender's above the topic's, nothing clipped sideways
      const bar = (await snack.boundingBox())!;
      for (const id of ["snackbar-sender", "snackbar-topic"]) {
        const box = (await snack.getByTestId(id).boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(bar.x);
        expect(box.x + box.width).toBeLessThanOrEqual(bar.x + bar.width + 0.5);
      }
      expect((await snack.getByTestId("snackbar-sender").boundingBox())!.y).toBeLessThan((await snack.getByTestId("snackbar-topic").boundingBox())!.y);
      for (const term of await snack.getByTestId("snackbar-term").all()) {
        const box = (await term.boundingBox())!;
        expect(box.x + box.width).toBeLessThanOrEqual(bar.x + bar.width + 0.5);
      }

      const apply = snack.getByTestId("snackbar-topic-apply");
      await expect(apply).toContainText("Everything mentioning");
      const pressed = snack.locator("[data-testid=snackbar-term][aria-pressed=true]");
      const [a, b] = await pressed.allTextContents();
      const words = `“${a}” and “${b}”`;
      // plan 89: from the sender at first, and a filter too
      await expect(apply).toHaveAccessibleDescription(`Adds every conversation from Uber Receipts that mentions ${words} to Facturas, and their new mail that does too. Click a word to add or remove it.`);
      await snack.getByTestId("snackbar-only-from").click();
      await expect(apply).toHaveAccessibleDescription(new RegExp(`mentions ${words} to Facturas`));
      await apply.hover();
      const help = page.getByTestId("snackbar-topic-help");
      await expect(help).toHaveText(`Adds every conversation that mentions ${words} to Facturas, from all your mail, and new mail that does too. Click a word to add or remove it.`);
      // it follows the words, the visible tooltip too
      await pressed.first().click();
      await expect(apply).toHaveAccessibleDescription(new RegExp(`mentions “${b}” to Facturas`));
      await apply.hover();
      await expect(help).toContainText(`mentions “${b}” to Facturas`);
      await pressed.first().click();
      // nothing checked: 4 is still reachable and says how to start, and does nothing
      await expect(apply).toHaveAttribute("aria-disabled", "true");
      await expect(apply).toHaveAccessibleDescription("Check a word to add every conversation that mentions it to Facturas.");
      await apply.click({ force: true });
      await expect(snack).toBeVisible();
      // from the keyboard too: Tab onto 4 shows the same help
      await page.mouse.move(900, 100);
      await snack.getByTestId("snackbar-sender").focus();
      await page.keyboard.press("Tab");
      await expect(apply).toBeFocused();
      await expect(help).toHaveText("Check a word to add every conversation that mentions it to Facturas.");

      // More…: the description says the text; Esc brings More… back with focus on it
      await snack.getByTestId("snackbar-more").click();
      await snack.getByTestId("snackbar-query").fill("recibo");
      await expect(apply).toHaveAccessibleDescription("Adds every conversation that matches “recibo” to Facturas, from the mail you have now (a search isn’t a filter: new mail isn’t included).");
      await apply.hover();
      await expect(help).toHaveText("Adds every conversation that matches “recibo” to Facturas, from the mail you have now (a search isn’t a filter: new mail isn’t included).");
      await snack.getByTestId("snackbar-query").press("Escape");
      await expect(snack.getByTestId("snackbar-more")).toBeFocused();
      await expect(snack).toBeVisible();
      await undoFiling();
    });
    await scenario("typing in More… keeps the snackbar up even after the pointer leaves", async () => {
      const { facturas, target } = uberSetup(server);
      await selectThread(page, target, "in:inbox from:uber.receipts@uber.com");
      await fileWithPicker(page, facturas);
      const snack = page.getByTestId("category-snackbar");
      await snack.getByTestId("snackbar-more").click();
      await expect(snack.getByTestId("snackbar-query")).toBeFocused();
      await page.mouse.move(900, 100);
      await page.clock.fastForward(11_000);
      await expect(snack).toBeVisible();
      await expect(snack.getByTestId("snackbar-query")).toBeFocused();
      await undoFiling();
    });
    await scenario("More… takes the search language", async () => {
      const { facturas, target } = uberSetup(server);
      await selectThread(page, target, "in:inbox from:uber.receipts@uber.com");
      await fileWithPicker(page, facturas);
      const snack = page.getByTestId("category-snackbar");
      await snack.getByTestId("snackbar-more").click();
      const field = snack.getByTestId("snackbar-query");
      await expect(field).toBeFocused();
      await field.fill("recibo from:recibos@rappi.com");
      const expected = await countOf(server, facturas, "recibo from:recibos@rappi.com");
      expect(expected).toBeGreaterThan(0);
      await expect(snack.getByTestId("snackbar-topic-count")).toHaveText(`${expected}`);
      // typing doesn't trigger the snackbar's keys
      await field.press("Enter");
      await expect(toast(page, `${expected} added to Facturas`)).toBeVisible();
      await expect.poll(() => countOf(server, facturas, "recibo from:recibos@rappi.com")).toBe(0);
    });
    await scenario("plan 81: reading 4's tooltip holds the countdown (a React portal of the bar: still its hover); the next snack still runs", async () => {
      const { facturas, target } = uberSetup(server);
      await selectThread(page, target, "in:inbox from:uber.receipts@uber.com");
      await fileWithPicker(page, facturas);
      const snack = page.getByTestId("category-snackbar");
      await snack.getByTestId("snackbar-topic-apply").hover();
      const help = page.getByTestId("snackbar-topic-help");
      await expect(help).toBeVisible();
      // onto the tooltip (portaled out of the bar's DOM): still reading
      await help.hover();
      await page.clock.fastForward(11_000);
      await expect(help).toBeVisible();
      await expect(snack).toBeVisible();
      // the tooltip open from the keyboard while 1 replaces the bar: the next snack still expires
      await page.mouse.move(900, 100);
      await snack.getByTestId("snackbar-sender").focus();
      await page.keyboard.press("Tab");
      await expect(help).toBeVisible();
      await page.keyboard.press("1");
      const added = page.getByTestId("snack").filter({ hasText: /added to Facturas/ });
      await expect(added).toBeVisible();
      // (its countdown starts once the keyboard's focus has left the bar it replaced: the ring runs with it)
      await expect.poll(() => page.evaluate(() => document.getAnimations().find((a) => a.id === "snack-countdown")?.playState)).toBe("running");
      await page.clock.fastForward(15_000);
      await expect(added).toHaveCount(0);
    });
  });

});

test.describe("the engine's suggestions and auto adds in the UI", () => {
  /** Two uncategorized inbox threads with a pending Facturas suggestion, then a fresh page (counts at boot). */
  async function withSuggestions(page: Page, server: DevServer) {
    const db = sqlDb(server.backend.store);
    const facturas = db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Facturas'")!.id;
    const threads = db
      .all<{ id: number }>(
        `SELECT t.id FROM threads t WHERE t.in_inbox = 1 AND t.last_from_email = 'recibos@rappi.com'
         AND NOT EXISTS (SELECT 1 FROM thread_categories WHERE thread_id = t.id) ORDER BY t.last_date DESC LIMIT 2`,
      )
      .map((r) => r.id);
    expect(threads).toHaveLength(2);
    for (const t of threads) {
      db.run(
        "INSERT INTO cls_decisions (thread_id, category_id, kind, p, explain_json, at) VALUES (?, ?, 'suggest', 0.91, ?, ?)",
        t,
        facturas,
        JSON.stringify([{ k: "reason.sameSender", p: { count: 12, category: "Facturas" } }, { k: "reason.intent.amount" }]),
        Date.now(),
      );
    }
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    return { db, facturas, threads };
  }

  test("Review lists the suggestions; y accepts (with the snackbar), n rejects", { tag: "@variant" }, async ({ app: page, server }) => {
    const { db, facturas, threads } = await withSuggestions(page, server);
    const review = page.getByTestId(`nav-review-${facturas}`);
    await expect(review).toContainText("2");
    await review.click();
    await expect(page.getByTestId("list-title")).toHaveText("Review · Facturas");
    await expect(page.getByTestId("thread-row")).toHaveCount(2);

    await page.locator(`[data-thread-id="${threads[0]}"]`).dispatchEvent("mousedown");
    const chip = page.getByTestId("reader").getByTestId("suggestion-chip");
    await expect(chip).toContainText("Facturas?");
    await settled(server, threads[0]!);
    await chip.getByTestId("suggestion-accept").hover();
    await expect(page.getByTestId("category-reasons")).toContainText("same sender as 12 conversations in Facturas · includes an amount");
    await focusList(page);
    await page.keyboard.press("y");
    await expect(page.getByTestId("category-snackbar")).toBeVisible();
    await expect.poll(() => db.get("SELECT added_by FROM thread_categories WHERE thread_id = ? AND category_id = ?", threads[0]!, facturas)).toEqual({ added_by: "suggestion" });
    expect(db.get("SELECT outcome FROM cls_decisions WHERE thread_id = ?", threads[0]!)).toEqual({ outcome: "accepted" });

    await page.keyboard.press("Escape");
    await page.locator(`[data-thread-id="${threads[1]}"]`).dispatchEvent("mousedown");
    await expect(page.getByTestId("reader").getByTestId("suggestion-chip")).toBeVisible();
    await focusList(page);
    await page.keyboard.press("n");
    await expect.poll(() => db.get("SELECT label, weight, source FROM cls_examples WHERE thread_id = ?", threads[1]!)).toEqual({ label: -1, weight: 1, source: "reject" });
    await expect(page.getByTestId("reader").getByTestId("suggestion-chip")).toHaveCount(0);
    await expect(page.getByTestId(`nav-review-${facturas}`)).toHaveCount(0);
  });

  test("out of a category, by hand and by the engine; Settings → Categories", async ({ app: page, server }) => {
    await scenario("an auto add says so and why; 'Not Facturas' reverts it and teaches the engine", async () => {
      const db = sqlDb(server.backend.store);
      const facturas = db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Facturas'")!.id;
      const t = db.get<{ id: number }>(
        `SELECT t.id FROM threads t WHERE t.in_inbox = 1 AND t.last_from_email = 'recibos@rappi.com'
         AND NOT EXISTS (SELECT 1 FROM thread_categories WHERE thread_id = t.id) ORDER BY t.last_date DESC LIMIT 1`,
      )!.id;
      db.run("INSERT INTO thread_categories (thread_id, category_id, added_by, added_at) VALUES (?, ?, 'auto', ?)", t, facturas, Date.now());
      db.run("INSERT INTO cls_decisions (thread_id, category_id, kind, p, explain_json, at) VALUES (?, ?, 'auto', 0.99, ?, ?)", t, facturas, JSON.stringify([{ k: "reason.sameSender", p: { count: 12, category: "Facturas" } }]), Date.now());
      await selectThread(page, t, "in:inbox from:recibos@rappi.com");
      const badge = page.getByTestId("reader").locator("[data-testid=category-chip]", { hasText: "Facturas" });
      await expect(badge.getByTestId("auto-mark")).toHaveText("auto");
      await settled(server, t);
      // keyboard and assistive tech reach the explanation too
      const mark = badge.getByRole("button", { name: /Terno added it to Facturas: same sender as 12 conversations in Facturas/ });
      await mark.focus();
      await expect(page.getByTestId("category-reasons")).toContainText("Terno added it to Facturas");
      await badge.getByRole("button", { name: "Not Facturas" }).click();
      await expect(badge).toHaveCount(0);
      await expect.poll(() => db.get("SELECT outcome FROM cls_decisions WHERE thread_id = ?", t)).toEqual({ outcome: "reverted" });
      expect(db.get("SELECT label, weight FROM cls_examples WHERE thread_id = ?", t)).toEqual({ label: -1, weight: 3 });
    });
    await scenario("the menu's Everything from X → Out of Facturas takes all their mail out; Undo files it back", async () => {
      const db = sqlDb(server.backend.store);
      const cat = (name: string) => db.get<{ id: number }>("SELECT id FROM categories WHERE name = ?", name)!.id;
      const [facturas, viajes] = [cat("Facturas"), cat("Viajes")];
      const rappi = "SELECT DISTINCT thread_id FROM messages WHERE from_email = 'recibos@rappi.com'";
      const ids = db.all<{ thread_id: number }>(rappi).map((r) => r.thread_id);
      expect(ids.length).toBeGreaterThan(1);
      await server.backend.server.invoke("categories.removeThreads", { categoryId: viajes, threadIds: ids, reason: "undo" }, { clientId: "test", origin: "dev" });
      await server.backend.server.invoke("categories.addThreads", { categoryId: facturas, threadIds: ids, source: "picker" }, { clientId: "test", origin: "dev" });
      const inFacturas = () => db.get<{ c: number }>(`SELECT count(*) c FROM thread_categories WHERE category_id = ? AND thread_id IN (${rappi})`, facturas)!.c;
      expect(inFacturas()).toBe(ids.length);

      await selectThread(page, ids[0]!, "from:recibos@rappi.com");
      const row = page.locator(`[data-testid=thread-row][data-thread-id="${ids[0]}"]`);
      // filed behind the list's back: the row shows it once the change arrives
      await expect(row.locator("[data-cat-dot]")).toHaveCount(1);
      await row.click({ button: "right" });
      await page.getByTestId("menu-sender-file").hover();
      // only the categories this mail is in are offered to leave
      await expect(page.getByTestId(`menu-sender-out-${facturas}`)).toHaveText("Out of Facturas");
      await expect(page.getByTestId(`menu-sender-out-${viajes}`)).toHaveCount(0);
      // and only the others are offered to file into: "To Facturas" would do nothing
      await expect(page.getByTestId(`menu-sender-file-${facturas}`)).toHaveCount(0);
      await expect(page.getByTestId(`menu-sender-file-${viajes}`)).toHaveText("To Viajes");
      await page.getByTestId(`menu-sender-out-${facturas}`).click();
      await expect(toast(page, `${ids.length} removed from Facturas`)).toBeVisible();
      expect(inFacturas()).toBe(0);
      // a user removal: the engine learns it
      expect(db.get<{ c: number }>(`SELECT count(*) c FROM cls_examples WHERE category_id = ? AND label < 0 AND thread_id IN (${rappi})`, facturas)!.c).toBe(ids.length);
      await expect(page.getByTestId("reader").locator("[data-testid=category-chip]", { hasText: "Facturas" })).toHaveCount(0);

      await toast(page, "removed from Facturas").getByTestId("snack-action").click();
      await expect(toast(page, "Undone: Facturas")).toBeVisible();
      await expect.poll(inFacturas).toBe(ids.length);
      await expect(page.getByTestId("reader").locator("[data-testid=category-chip]", { hasText: "Facturas" })).toBeVisible();
    });
    await scenario("taking mail out of a category its filter files offers to stop filing; Undo keeps it filing", async () => {
      const { db, facturas, target } = uberSetup(server);
      await server.backend.server.invoke("categorize.apply", { categoryId: facturas, scope: { kind: "sender", email: "uber.receipts@uber.com" }, always: true, filterName: "Uber → Facturas" }, { clientId: "t", origin: "dev" });
      const enabled = () => db.get<{ enabled: number }>("SELECT enabled FROM filters WHERE name = 'Uber → Facturas'")!.enabled;
      await selectThread(page, target, "from:uber.receipts@uber.com");
      await page.getByTestId("reader").getByRole("button", { name: "Remove Facturas" }).click();
      const offer = toast(page, "Removed from Facturas. A filter Terno made files mail like this there.");
      await expect(offer).toBeVisible();
      await offer.getByRole("button", { name: "Stop filing mail like this into Facturas" }).click();
      await expect.poll(enabled).toBe(0);
      await toast(page, "Mail like this won’t go to Facturas anymore").getByTestId("snack-action").click();
      await expect.poll(enabled).toBe(1);
    });
    await scenario("Settings → Categories: the global switch, per-category auto, and stats", async () => {
      const db = sqlDb(server.backend.store);
      const facturas = db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Facturas'")!.id;
      await page.getByTestId("open-settings").click();
      await page.getByTestId("tab-categories").click();
      const row = page.getByTestId(`category-stats-${facturas}`);
      const examples = db.get<{ n: number }>("SELECT count(*) AS n FROM cls_examples WHERE category_id = ? AND label = 1 AND weight > 0", facturas)!.n;
      await expect(row).toContainText(`${examples} examples`);
      await page.getByTestId(`category-auto-${facturas}`).click();
      await expect.poll(() => db.get("SELECT auto_apply FROM categories WHERE id = ?", facturas)).toEqual({ auto_apply: 0 });
      await page.getByTestId("auto-categorize-select").click();
      await page.getByTestId("auto-categorize-suggest").click();
      await expect.poll(async () => (await server.backend.server.invoke("app.bootstrap", {}, { clientId: "t", origin: "dev" })).settings.autoCategorize).toBe("suggest");
      await expect(page.getByTestId(`category-auto-${facturas}`)).toBeDisabled();
    });
  });

});
