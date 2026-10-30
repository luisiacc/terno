import type { Page } from "@playwright/test";
import { termsQuery } from "@terno/core";
import type { DevServer } from "../../backend-dev/src/server";
import { expect, focusList, selectRows, selectThread, test, searchBox } from "./fixtures";
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

async function fileWithPicker(page: Page, categoryId: number) {
  await page.keyboard.press("l");
  await expect(page.getByTestId("category-picker")).toBeVisible();
  await page.getByTestId(`pick-category-${categoryId}`).click();
  await focusList(page);
}

test.describe("categorization snackbar", { tag: "@design" }, () => {
  test("filing one thread offers all mail from its sender: 1 files it, the result toast undoes it", async ({ app: page, server }) => {
    const { facturas, target, outside } = uberSetup(server);
    const rest = outside() - 1;
    expect(rest).toBeGreaterThan(1);
    await selectThread(page, target, "in:inbox from:uber.receipts@uber.com");
    await fileWithPicker(page, facturas);

    const snack = page.getByTestId("category-snackbar");
    await expect(snack.getByTestId("snackbar-title")).toHaveText("Added to Facturas");
    await expect(snack.getByTestId("snackbar-sender")).toContainText("Everything from Uber Receipts");
    await expect(snack.getByTestId("snackbar-sender-count")).toHaveText(`${rest}`);
    await expect(page.getByTestId("reader").locator("[data-slot=category-badge]", { hasText: "Facturas" })).toBeVisible();

    await page.keyboard.press("1");
    await expect(snack).toHaveCount(0);
    const done = toast(page, `${rest} added to Facturas`);
    await expect(done).toBeVisible();
    await expect.poll(outside).toBe(0);
    await done.getByTestId("snack-action").click();
    await expect.poll(outside).toBe(rest);
  });

  test("z undoes the add itself without teaching the engine anything; Esc just closes", async ({ app: page, server }) => {
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
    await expect(page.getByTestId("reader").locator("[data-slot=category-badge]", { hasText: "Facturas" })).toHaveCount(0);

    await fileWithPicker(page, facturas);
    await expect(page.getByTestId("category-snackbar")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("category-snackbar")).toHaveCount(0);
    expect(db.get("SELECT 1 FROM thread_categories WHERE thread_id = ? AND category_id = ?", target, facturas)).toBeDefined();
  });

  test("5 makes it a filter for that sender", async ({ app: page, server }) => {
    const { db, facturas, target } = uberSetup(server);
    await selectThread(page, target, "in:inbox from:uber.receipts@uber.com");
    await fileWithPicker(page, facturas);
    await expect(page.getByTestId("snackbar-filter")).toBeVisible();
    await page.keyboard.press("5");
    await expect(toast(page, "Filter created")).toBeVisible();
    const rule = JSON.parse(db.get<{ rule_json: string }>("SELECT rule_json FROM filters ORDER BY id DESC LIMIT 1")!.rule_json);
    expect(rule).toEqual({ match: "all", conditions: [{ field: "from", op: "equals", value: "uber.receipts@uber.com" }], actions: [{ type: "addCategory", categoryId: facturas }] });
    await toast(page, "Filter created").getByTestId("snack-action").click();
    await expect(page.getByTestId("filters-dialog")).toBeVisible();
  });

  test("several threads: the chips cover what they share, without duplicates", async ({ app: page, server }) => {
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
    await page.keyboard.press("1");
    await expect.poll(githubOutside).toBe(0);
  });
});

test.describe("everything from a sender, out of a category (plan 77)", () => {
  test("the menu's Everything from X → Out of Facturas takes all their mail out; Undo files it back", async ({ app: page, server }) => {
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
    await expect(page.getByTestId("reader").locator("[data-slot=category-badge]", { hasText: "Facturas" })).toHaveCount(0);

    await toast(page, "removed from Facturas").getByTestId("snack-action").click();
    await expect(toast(page, "Undone: Facturas")).toBeVisible();
    await expect.poll(inFacturas).toBe(ids.length);
    await expect(page.getByTestId("reader").locator("[data-slot=category-badge]", { hasText: "Facturas" })).toBeVisible();
  });
});

test.describe("everything about X and Y", { tag: "@design" }, () => {
  test("topic chips recount as they toggle, View previews the query, 4 files it", async ({ app: page, server }) => {
    const { db, facturas, target } = uberSetup(server);
    await selectThread(page, target, "in:inbox from:uber.receipts@uber.com");
    await fileWithPicker(page, facturas);
    const snack = page.getByTestId("category-snackbar");
    const chips = snack.getByTestId("snackbar-term");
    await expect(chips.first()).toBeVisible();
    const pressed = snack.locator("[data-testid=snackbar-term][aria-pressed=true]");
    await expect(pressed).toHaveCount(2);
    const selected = await pressed.allTextContents();
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
    await expect(page.getByTestId("search-input")).toHaveValue(termsQuery(selected, "Facturas"));
    await expect(page.getByTestId("search-stats")).toBeVisible();

    // filing it from a fresh snackbar with the keyboard
    await (await searchBox(page)).fill("in:inbox from:uber.receipts@uber.com");
    await selectThread(page, target, "in:inbox from:uber.receipts@uber.com");
    await fileWithPicker(page, db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Viajes'")!.id);
    await expect(page.getByTestId("snackbar-topic-count")).toBeVisible();
    await page.keyboard.press("4");
    await expect(toast(page, /\d+ added to Viajes/)).toBeVisible();
  });

  test("plan 81: one offer per line, all of it in view; 4 says what it files, on hover and to a screen reader", async ({ app: page, server }) => {
    const { facturas, target } = uberSetup(server);
    await selectThread(page, target, "in:inbox from:uber.receipts@uber.com");
    await fileWithPicker(page, facturas);
    const snack = page.getByTestId("category-snackbar");
    await expect(snack.getByTestId("snackbar-topic-count")).toHaveText(/^\d/);
    // stacked: every line sits inside the bar, the sender's above the topic's, nothing clipped sideways
    const bar = (await snack.boundingBox())!;
    for (const id of ["snackbar-sender", "snackbar-topic", "snackbar-filter"]) {
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
    await expect(apply).toHaveAccessibleDescription(new RegExp(`mentions ${words} to Facturas`));
    await apply.hover();
    const help = page.getByTestId("snackbar-topic-help");
    await expect(help).toHaveText(`Moves every conversation that mentions ${words} to Facturas, from all your mail. Click a word to add or remove it.`);
    // it follows the words
    await pressed.first().click();
    await expect(apply).toHaveAccessibleDescription(new RegExp(`mentions “${b}” to Facturas`));
    await pressed.first().click();
    // nothing checked: 4 is still reachable and says how to start, and does nothing
    await expect(apply).toHaveAttribute("aria-disabled", "true");
    await expect(apply).toHaveAccessibleDescription("Check a word to move every conversation that mentions it to Facturas.");
    await apply.click({ force: true });
    await expect(snack).toBeVisible();

    // More…: the description says the text; Esc brings More… back with focus on it
    await snack.getByTestId("snackbar-more").click();
    await snack.getByTestId("snackbar-query").fill("recibo");
    await expect(apply).toHaveAccessibleDescription("Moves every conversation that matches “recibo” to Facturas, from all your mail.");
    await snack.getByTestId("snackbar-query").press("Escape");
    await expect(snack.getByTestId("snackbar-more")).toBeFocused();
    await expect(snack).toBeVisible();
  });

  test("View shows the same set bulk apply would file: no account or review scope carried over", async ({ app: page, server }) => {
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

  test("typing in More… keeps the snackbar up even after the pointer leaves", async ({ app: page, server }) => {
    test.setTimeout(30_000);
    const { facturas, target } = uberSetup(server);
    await selectThread(page, target, "in:inbox from:uber.receipts@uber.com");
    await fileWithPicker(page, facturas);
    const snack = page.getByTestId("category-snackbar");
    await snack.getByTestId("snackbar-more").click();
    await expect(snack.getByTestId("snackbar-query")).toBeFocused();
    await page.mouse.move(900, 100);
    await page.waitForTimeout(11_000);
    await expect(snack).toBeVisible();
    await expect(snack.getByTestId("snackbar-query")).toBeFocused();
  });

  test("More… takes the search language", async ({ app: page, server }) => {
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
});

test.describe("the engine's suggestions and auto adds in the UI", { tag: "@design" }, () => {
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

  test("Review lists the suggestions; y accepts (with the snackbar), n rejects", async ({ app: page, server }) => {
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

  test("an auto add says so and why; 'Not Facturas' reverts it and teaches the engine", async ({ app: page, server }) => {
    const db = sqlDb(server.backend.store);
    const facturas = db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Facturas'")!.id;
    const t = db.get<{ id: number }>(
      `SELECT t.id FROM threads t WHERE t.in_inbox = 1 AND t.last_from_email = 'recibos@rappi.com'
       AND NOT EXISTS (SELECT 1 FROM thread_categories WHERE thread_id = t.id) ORDER BY t.last_date DESC LIMIT 1`,
    )!.id;
    db.run("INSERT INTO thread_categories (thread_id, category_id, added_by, added_at) VALUES (?, ?, 'auto', ?)", t, facturas, Date.now());
    db.run("INSERT INTO cls_decisions (thread_id, category_id, kind, p, explain_json, at) VALUES (?, ?, 'auto', 0.99, ?, ?)", t, facturas, JSON.stringify([{ k: "reason.sameSender", p: { count: 12, category: "Facturas" } }]), Date.now());
    await selectThread(page, t, "in:inbox from:recibos@rappi.com");
    const badge = page.getByTestId("reader").locator("[data-slot=category-badge]", { hasText: "Facturas" });
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

  test("Settings → Categories: the global switch, per-category auto, and stats", async ({ app: page, server }) => {
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
