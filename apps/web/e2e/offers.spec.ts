/**
 * Plan 91: the same offers after every action, and the defaults. A drag of an
 * automated sender's mail moves the rest with the same sender and subject
 * (numbers standing for any number) and files their new mail; "No, only move
 * this email" (0) takes that back and keeps the drag; z takes back all of it.
 * A person's mail moves alone. Spam marks everything from the sender.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { normalizeText, subjectKey } from "@terno/core";
import type { DevServer } from "../../backend-dev/src/server";
import { sqlDb } from "../../backend-dev/src/server";
import { menuPath, expect, focusList, selectThread, test, fresh, scenario, openOffers, rows } from "./fixtures";

test.use({ reducedMotion: "no-preference" });

async function center(l: Locator) {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

async function drop(page: Page, row: Locator, target: Locator) {
  const from = await center(row);
  const to = await center(target);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 6, from.y + 2, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}

/**
 * The largest group from one automated sender with one numbered subject (its key) that has an
 * uncategorized plain inbox thread to drag; the group is every thread of theirs with that key.
 */
function group(server: DevServer, categoryId: number) {
  const db = sqlDb(server.backend.store);
  const rows = db.all<{ id: number; email: string; subject: string; draggable: number }>(
    `SELECT t.id, m.from_email AS email, m.subject,
            (t.in_inbox = 1 AND t.person = 0 AND t.message_count = 1 AND NOT EXISTS (SELECT 1 FROM thread_categories c WHERE c.thread_id = t.id)) AS draggable
     FROM threads t JOIN messages m ON m.thread_id = t.id AND m.is_sent = 0 WHERE t.in_trash = 0 AND t.in_spam = 0
     ORDER BY t.last_date DESC`,
  );
  const groups = new Map<string, { email: string; ids: Set<number>; draggable: number[] }>();
  for (const r of rows) {
    const subject = normalizeText(r.subject);
    if (!/[0-9]/.test(subject)) continue;
    const key = `${r.email}\n${subjectKey(subject)}`;
    const g = groups.get(key) ?? { email: r.email, ids: new Set<number>(), draggable: [] };
    g.ids.add(r.id);
    if (r.draggable) g.draggable.push(r.id);
    groups.set(key, g);
  }
  const best = [...groups.values()].filter((g) => g.draggable.length).sort((a, b) => b.ids.size - a.ids.size)[0]!;
  const ids = [...best.ids].sort((a, b) => a - b);
  const inCategory = () => db.all<{ thread_id: number }>(`SELECT thread_id FROM thread_categories WHERE category_id = ? AND thread_id IN (${ids.join(",")})`, categoryId).map((r) => r.thread_id).sort((a, b) => a - b);
  const autoFilters = () => db.get<{ c: number }>("SELECT count(*) c FROM filters WHERE auto = 1")!.c;
  return { email: best.email, ids, target: best.draggable[0]!, inCategory, autoFilters, db };
}

const catId = (server: DevServer, name: string) => sqlDb(server.backend.store).get<{ id: number }>("SELECT id FROM categories WHERE name = ?", name)!.id;

test.describe("one line first (plan 158)", () => {
  test("a filing is one line and Undo: its offers open on asking, a number opens them and runs nothing", async ({ app: page, server }) => {
    const facturas = catId(server, "Facturas");
    const db = sqlDb(server.backend.store);
    const filters = () => db.get<{ c: number }>("SELECT count(*) c FROM filters")!.c;
    const before = filters();
    await rows(page).nth(2).dispatchEvent("mousedown");
    await focusList(page);
    await page.keyboard.press("l");
    await page.getByTestId(`pick-category-${facturas}`).click();
    await focusList(page);
    const snack = page.getByTestId("category-snackbar");
    const more = snack.getByTestId("snackbar-similar");
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await expect(snack.getByTestId("snackbar-offers")).toHaveCount(0);
    expect((await snack.boundingBox())!.height).toBeLessThanOrEqual(48);
    await page.keyboard.press("1");
    await expect(more).toHaveAttribute("aria-expanded", "true");
    await expect(snack.getByTestId("snackbar-offers")).toBeVisible();
    expect(filters()).toBe(before);
    await page.keyboard.press("Escape");
  });
});

test.describe("plan 91: defaults and the same offers everywhere", () => {
  test("defaults: a drag of bulk mail, Undo, a person's mail, spam, a filter that can't be saved, More…", async ({ app: page, server }) => {
    await scenario("a drag of bulk mail moves its sender + subject group and files their new mail; 0 keeps only the drag; z undoes the drag", async () => {
      const facturas = catId(server, "Facturas");
      const g = group(server, facturas);
      expect(g.ids.length).toBeGreaterThan(1);
      const target = g.target;
      const autoBefore = g.autoFilters();
      // some may be filed there already (the mock's engine): those stay as they are
      const before = g.inCategory();
      await selectThread(page, target, `from:${g.email}`);
      await drop(page, page.locator(`[data-testid=thread-row][data-thread-id="${target}"]`), page.getByTestId(`nav-category-${facturas}`));

      const snack = page.getByTestId("category-snackbar");
      await expect(snack).toHaveAttribute("data-default", "done");
      await expect(snack.getByTestId("snackbar-title")).toHaveText(`Moved ${g.ids.length - before.length} emails with the same sender and subject to Facturas`);
      await expect(snack.getByTestId("snackbar-note")).toHaveText("New mail like this goes there too.");
      await expect.poll(g.inCategory).toEqual(g.ids);
      // a filter of Terno's, its subject's numbers as any number
      expect(g.autoFilters()).toBe(autoBefore + 1);
      const made = g.db.get<{ rule_json: string }>("SELECT rule_json FROM filters WHERE auto = 1 ORDER BY id DESC LIMIT 1")!;
      expect(JSON.parse(made.rule_json).conditions).toContainEqual(expect.objectContaining({ field: "subject", op: "matches" }));
      // the default isn't offered again; everything from the sender is the first line
      await openOffers(page);
      await expect(snack.getByTestId("snackbar-subject")).toHaveCount(0);
      await expect(snack.getByTestId("snackbar-offers").locator("kbd").first()).toHaveText("1");
      await expect(snack.getByTestId("snackbar-only")).toHaveText(/No, only move this email/);
      // axe-clean in both schemes, the countdown held while it reads
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await snack.hover();
        expect((await new AxeBuilder({ page }).setLegacyMode().include("[data-testid=snack-dock]").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations, scheme).toEqual([]);
      }

      await focusList(page);
      await page.keyboard.press("0");
      await expect(snack.getByTestId("snackbar-title")).toHaveText("Moved only this email to Facturas");
      await expect.poll(g.inCategory).toEqual([...before, target].sort((a, b) => a - b));
      await expect.poll(g.autoFilters).toBe(autoBefore);
      // z now takes back the drag itself
      await page.keyboard.press("z");
      await expect.poll(g.inCategory).toEqual(before);
    });
    await scenario("Undo after the default takes back everything: the group, the filter and the drag", async () => {
      await fresh(page);
      const facturas = catId(server, "Facturas");
      const g = group(server, facturas);
      const autoBefore = g.autoFilters();
      const before = g.inCategory();
      await selectThread(page, g.target, `from:${g.email}`);
      await drop(page, page.locator(`[data-testid=thread-row][data-thread-id="${g.target}"]`), page.getByTestId(`nav-category-${facturas}`));
      const snack = page.getByTestId("category-snackbar");
      await expect(snack).toHaveAttribute("data-default", "done");
      await snack.getByTestId("snackbar-undo").click();
      await expect.poll(g.inCategory).toEqual(before);
      await expect.poll(g.autoFilters).toBe(autoBefore);
    });
    await scenario("a person's mail moves alone, with the same sender and subject offered first", async () => {
      await fresh(page);
      const facturas = catId(server, "Facturas");
      const db = sqlDb(server.backend.store);
      const person = db.get<{ id: number; email: string }>(
        `SELECT t.id, t.last_from_email AS email FROM threads t WHERE t.in_inbox = 1 AND t.person = 1 AND t.in_trash = 0
         AND NOT EXISTS (SELECT 1 FROM thread_categories c WHERE c.thread_id = t.id) ORDER BY t.last_date DESC LIMIT 1`,
      )!;
      const filtersBefore = db.get<{ c: number }>("SELECT count(*) c FROM filters")!.c;
      await selectThread(page, person.id, `from:${person.email}`);
      await drop(page, page.locator(`[data-testid=thread-row][data-thread-id="${person.id}"]`), page.getByTestId(`nav-category-${facturas}`));
      const snack = page.getByTestId("category-snackbar");
      await expect(snack.getByTestId("snackbar-title")).toHaveText("Moved to Facturas");
      await expect(snack).not.toHaveAttribute("data-default");
      await openOffers(page);
      await expect(snack.getByTestId("snackbar-sender")).toBeVisible();
      await expect(snack.getByTestId("snackbar-only")).toHaveCount(0);
      expect(db.get<{ c: number }>("SELECT count(*) c FROM filters")!.c).toBe(filtersBefore);
    });
  });

  test("spam marks everything from the sender with a filter; 0 marks only this one; the menu lists the same lines in the same order", async ({ app: page, server }) => {
    const facturas = catId(server, "Facturas");
    const g = group(server, facturas);
    const db = g.db;
    const spam = () => db.get<{ c: number }>("SELECT count(*) c FROM threads t WHERE t.in_spam = 1 AND EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.from_email = ?)", g.email)!.c;
    await selectThread(page, g.target, `in:inbox from:${g.email}`);
    // the menu first: Only this email, then the offers in the snackbar's order
    await page.locator(`[data-testid=thread-row][data-thread-id="${g.target}"]`).click({ button: "right" });
    await menuPath(page, "menu-more");
    await page.getByTestId("menu-spam-similar").click();
    const list = page.getByTestId("menu-spam-similar-list");
    await expect(list.getByTestId("menu-similar-only")).toHaveText("Only this email");
    await expect(list.getByTestId("menu-similar-sender")).toBeVisible();
    const menuOrder = await list.locator("[data-testid^=menu-similar-]:not([data-testid=menu-similar-only])").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
    expect(menuOrder[0]).toBe("menu-similar-subject");
    expect(menuOrder[1]).toBe("menu-similar-sender");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    await focusList(page);
    await page.keyboard.press("!");
    const snack = page.getByTestId("similar-snackbar");
    await openOffers(page);
    await expect(snack).toHaveAttribute("data-default", "done");
    await expect(snack.getByTestId("snack-message")).toHaveText(/^Marked \d+ emails? from .+ as spam$/);
    await expect.poll(spam).toBeGreaterThan(1);
    // the sender is the default: not offered again; the same sender and subject comes first
    await expect(snack.getByTestId("similar-sender")).toHaveCount(0);
    await expect(snack.getByTestId("similar-subject")).toBeVisible();
    await page.keyboard.press("0");
    await expect(snack.getByTestId("snack-message")).toHaveText("Marked only this email as spam");
    // no filter catches their new mail any more: nothing says it does
    await expect(snack.getByTestId("similar-future")).toHaveCount(0);
    await expect.poll(spam).toBe(1);
    await page.keyboard.press("z");
    await expect.poll(spam).toBe(0);
  });

  test("Codex review: a default whose filter can't be saved says new mail isn't covered; a move out of a category Terno's filter fills offers to stop it", async ({ app: page, server }) => {
    const facturas = catId(server, "Facturas");
    const lecturas = catId(server, "Lecturas");
    const g = group(server, facturas);
    g.db.exec("CREATE TRIGGER e2e_no_filters BEFORE INSERT ON filters BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    await selectThread(page, g.target, `from:${g.email}`);
    await drop(page, page.locator(`[data-testid=thread-row][data-thread-id="${g.target}"]`), page.getByTestId(`nav-category-${facturas}`));
    const snack = page.getByTestId("category-snackbar");
    await expect(snack).toHaveAttribute("data-default", "done");
    await expect(snack.getByTestId("snackbar-note")).toHaveText("Couldn’t save the rule for new mail: only the mail you have now changed.");
    g.db.exec("DROP TRIGGER e2e_no_filters");
    await page.keyboard.press("Escape");

    // a person's thread in Lecturas, which a filter of Terno's fills; moved to Facturas (no default: a person)
    const person = g.db.get<{ id: number; email: string }>(
      `SELECT t.id, t.last_from_email AS email FROM threads t WHERE t.in_inbox = 1 AND t.person = 1 AND t.in_trash = 0 AND t.message_count = 1
       AND NOT EXISTS (SELECT 1 FROM thread_categories c WHERE c.thread_id = t.id) ORDER BY t.last_date DESC LIMIT 1`,
    )!;
    await server.backend.server.invoke("categorize.apply", { categoryId: lecturas, scope: { kind: "sender", email: person.email }, always: true, filterName: "Them → Lecturas" }, { clientId: "t", origin: "dev" });
    const enabled = () => g.db.get<{ enabled: number }>("SELECT enabled FROM filters WHERE name = 'Them → Lecturas'")!.enabled;
    await selectThread(page, person.id, `from:${person.email}`);
    await drop(page, page.locator(`[data-testid=thread-row][data-thread-id="${person.id}"]`), page.getByTestId(`nav-category-${facturas}`));
    await openOffers(page);
    const stop = snack.getByTestId("snackbar-stop");
    await expect(stop).toHaveText("Stop filing mail like this into Lecturas");
    await stop.click();
    await expect.poll(enabled).toBe(0);
  });

  test("low resource use: a drag's default costs a fixed handful of requests, and nothing runs once the snackbar is gone", async ({ app: page, server }) => {
    const facturas = catId(server, "Facturas");
    const g = group(server, facturas);
    // every request the renderer sends, by method, from now on
    const sent: { at: number; method: string }[] = [];
    page.on("websocket", (ws) =>
      ws.on("framesent", ({ payload }) => {
        try {
          const frame = JSON.parse(String(payload)) as { t?: string; m?: string };
          if (frame.t === "req" && frame.m) sent.push({ at: Date.now(), method: frame.m });
        } catch {
          // not a JSON frame
        }
      }),
    );
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await selectThread(page, g.target, `from:${g.email}`);
    const from = Date.now();
    await drop(page, page.locator(`[data-testid=thread-row][data-thread-id="${g.target}"]`), page.getByTestId(`nav-category-${facturas}`));
    const snack = page.getByTestId("category-snackbar");
    await expect(snack).toHaveAttribute("data-default", "done");
    await openOffers(page);
    await expect(snack.getByTestId("snackbar-offers").locator("[data-testid=snackbar-count-loading]")).toHaveCount(0);
    const ours = (since: number) => sent.filter((r) => r.at >= since && /^(offers|categorize|filters|similar)\./.test(r.method)).map((r) => r.method);
    const count = (list: string[], m: string) => list.filter((x) => x === m).length;
    const during = ours(from);
    // the offers (once, then once more after the default), the words, the default's move, the words' count, the stop-filing check
    expect(count(during, "offers.forAction")).toBe(2);
    expect(count(during, "categorize.quickActions")).toBe(1);
    expect(count(during, "categorize.apply")).toBe(1);
    expect(count(during, "categorize.count")).toBeLessThanOrEqual(1);
    expect(count(during, "filters.autoFor")).toBeLessThanOrEqual(3);
    expect(during.length, during.join(", ")).toBeLessThanOrEqual(8);
    // toggling a word recounts once (debounced), not per keystroke or render
    const toggles = Date.now();
    const words = snack.getByTestId("snackbar-term");
    if (await words.count()) {
      await words.first().click();
      await words.first().click();
      await words.first().click();
      // past the debounce, on the page's clock
      await page.clock.runFor(500);
      await page.evaluate(() => new Promise((r) => setTimeout(r)));
      expect(count(ours(toggles), "categorize.count"), ours(toggles).join(", ")).toBeLessThanOrEqual(2);
    }
    // gone: idle means idle (no polling, no recount, no retries)
    await page.keyboard.press("Escape");
    await expect(snack).toHaveCount(0);
    const after = Date.now();
    // a minute on the page's clock: any polling, recount or retry would have fired, many times over
    await page.clock.runFor(60_000);
    await page.evaluate(() => new Promise((r) => setTimeout(r)));
    expect(ours(after), ours(after).join(", ")).toEqual([]);
  });

  test("Codex review: after a move, More… moves what it finds too (out of its other category)", async ({ app: page, server }) => {
    const facturas = catId(server, "Facturas");
    const lecturas = catId(server, "Lecturas");
    const db = sqlDb(server.backend.store);
    // a person with two conversations, both in Lecturas; one is dragged to Facturas (no default: a person)
    const email = db.get<{ email: string }>(
      `SELECT t.last_from_email AS email FROM threads t WHERE t.in_inbox = 1 AND t.person = 1 AND t.in_trash = 0 AND t.message_count = 1
       GROUP BY t.last_from_email HAVING count(*) >= 2 ORDER BY count(*) DESC LIMIT 1`,
    )!.email;
    const [a, b] = db.all<{ id: number }>("SELECT id FROM threads WHERE last_from_email = ? AND in_inbox = 1 AND in_trash = 0 ORDER BY last_date DESC LIMIT 2", email).map((r) => r.id);
    const cats = (t: number) => db.all<{ category_id: number }>("SELECT category_id FROM thread_categories WHERE thread_id = ? ORDER BY category_id", t).map((r) => r.category_id);
    db.run("DELETE FROM thread_categories WHERE thread_id IN (?, ?)", a!, b!);
    await server.backend.server.invoke("categories.addThreads", { categoryId: lecturas, threadIds: [a!, b!], source: "picker" }, { clientId: "t", origin: "dev" });
    await selectThread(page, a!, `from:${email}`);
    await drop(page, page.locator(`[data-testid=thread-row][data-thread-id="${a}"]`), page.getByTestId(`nav-category-${facturas}`));
    const snack = page.getByTestId("category-snackbar");
    await expect(snack.getByTestId("snackbar-title")).toHaveText("Moved to Facturas");
    await openOffers(page);
    await snack.getByTestId("snackbar-more").click();
    await snack.getByTestId("snackbar-query").fill(`from:${email}`);
    // Enter right away, while the count may still be loading: it runs
    await snack.getByTestId("snackbar-query").press("Enter");
    await expect(snack).toHaveCount(0);
    await expect.poll(() => cats(b!)).toEqual([facturas]);
  });
});

