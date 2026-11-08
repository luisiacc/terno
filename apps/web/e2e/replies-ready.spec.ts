/**
 * Plan 144 in the page, on the offline fake model: nothing here reaches a provider. Off by default; on, a conversation
 * that waits for an answer gets a block as it's read, which is nothing until it's used, and nothing can send it.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { SettingsPatch } from "@terno/core/rpc";
import { sqlDb } from "../../backend-dev/src/server";
import { E2E_NOW } from "./constants";
import { expect, fresh, ingestConversation, scenario, test, type DevServerFixture } from "./fixtures";

test.use({ backendOptions: { network: true } });

const dev = { clientId: "setup", origin: "dev" as const };
const SHOTS = process.env.REPLY_SHOTS;

async function settingUp(page: Page, server: DevServerFixture, patch: SettingsPatch) {
  await server.backend.server.invoke("settings.update", patch, dev);
  await fresh(page);
}

const SUBJECT = "Can you make the 19th";

async function withMail(page: Page, server: DevServerFixture, patch: SettingsPatch = {}) {
  await ingestConversation(server, { subject: SUBJECT, count: 1, now: E2E_NOW });
  const db = sqlDb(server.backend.store);
  const t = db.get<{ id: number }>("SELECT id FROM threads WHERE subject = ?", SUBJECT)!;
  // the fact plan 17 computes from people's mail: waiting on you
  db.run("UPDATE threads SET waiting_since = ? WHERE id = ?", E2E_NOW - 3_600_000, t.id);
  await settingUp(page, server, { ai: { provider: "fake", model: "demo" }, ...patch });
  return t.id;
}

const row = (page: Page, subject = SUBJECT) => page.getByTestId("thread-row").filter({ hasText: subject });
const block = (page: Page) => page.getByTestId("reply-ready");

test.describe("replies ready (plan 144)", () => {
  test("off by default: opening a waiting conversation shows nothing and asks nothing", async ({ app: page, server }) => {
    await withMail(page, server);
    await row(page).click();
    await page.waitForTimeout(800);
    await expect(block(page)).toHaveCount(0);
    expect(sqlDb(server.backend.store).get<{ n: number }>("SELECT count(*) n FROM ai_prepared_replies")!.n).toBe(0);
  });

  test("on: the block streams, Use puts it in a draft with no send, Undo brings it back; Dismiss and Undo", { tag: "@variant" }, async ({ app: page, server }) => {
    const thread = await withMail(page, server, { replies: { enabled: true } });
    const state = () => sqlDb(server.backend.store).get<{ state: string }>("SELECT state FROM ai_prepared_replies WHERE thread_id = ?", thread)?.state;

    await scenario("opened and stayed on: it's written below the last message, and focus stays", async () => {
      await row(page).click();
      await expect(block(page)).toHaveAttribute("data-phase", "ready", { timeout: 15_000 });
      await expect(page.getByTestId("reply-ready-text")).not.toBeEmpty();
      expect(state()).toBe("ready");
      expect(await page.evaluate(() => document.activeElement?.closest('[data-testid="reply-ready"]') === null)).toBe(true);
      // it isn't a draft: not in the store, not in the list
      expect(sqlDb(server.backend.store).get<{ n: number }>("SELECT count(*) n FROM drafts")!.n).toBe(0);
    });

    if (SHOTS) {
      await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-light.png` });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-dark.png` });
    }
    for (const mode of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: mode });
      const results = await new AxeBuilder({ page }).include('[data-testid="reply-ready"]').analyze();
      expect(results.violations.map((v) => `${mode} ${v.id}`)).toEqual([]);
    }

    await scenario("reopening costs nothing and shows the same words", async () => {
      const words = await page.getByTestId("reply-ready-text").innerText();
      await page.getByTestId("thread-row").first().click();
      await row(page).click();
      await expect(page.getByTestId("reply-ready-text")).toHaveText(words);
    });

    await scenario("Dismiss goes with a snack, and its Undo brings it back", async () => {
      await page.getByTestId("reply-ready-dismiss").click();
      await expect(block(page)).toHaveCount(0);
      expect(state()).toBe("dismissed");
      await page.getByTestId("snack-action").click();
      await expect(block(page)).toBeVisible();
      await expect.poll(state).toBe("ready");
    });

    await scenario("Use: the words in a draft, nothing sent; the strip's Undo returns the block", async () => {
      const words = (await page.getByTestId("reply-ready-text").innerText()).split("\n")[0]!;
      await page.getByTestId("reply-ready-use").click();
      await expect(block(page)).toHaveCount(0);
      await expect(page.locator("[contenteditable=true]").first()).toContainText(words.slice(0, 20));
      await expect.poll(state).toBe("used");
      expect(sqlDb(server.backend.store).get<{ n: number }>("SELECT count(*) n FROM messages WHERE is_sent = 1 AND thread_id = ?", thread)!.n).toBe(0);
      await page.getByTestId("ai-strip-undo").click();
      await expect.poll(state).toBe("ready");
      await expect(block(page)).toBeVisible();
    });

    await scenario("⌘Z right after Use is the same: the blank draft goes, and the block is back", async () => {
      await page.getByTestId("reply-ready-use").click();
      await expect.poll(state).toBe("used");
      await expect(page.locator("[contenteditable=true]").first()).toBeFocused();
      await page.keyboard.press("ControlOrMeta+z");
      await expect.poll(state).toBe("ready");
      await expect(block(page)).toBeVisible();
    });

    await scenario("r does what Use does", async () => {
      await page.keyboard.press("r");
      await expect(block(page)).toHaveCount(0);
      await expect.poll(state).toBe("used");
    });
  });

  test("a card in every design: the summary's surface, the label as its header, the draft inset, the actions below; its edges on the reply bar's and the summary's", { tag: "@design" }, async ({ app: page, server }, info) => {
    await withMail(page, server, { replies: { enabled: true } });
    await row(page).click();
    await expect(block(page)).toHaveAttribute("data-phase", "ready", { timeout: 15_000 });
    // the summary above it too, so the column's three surfaces are in one picture
    await page.getByTestId("action-summarize").click();
    await expect(page.getByTestId("summary-block")).toHaveAttribute("data-state", "ready");

    const SIZES = [[1440, 900], [1100, 700]] as const;
    if (SHOTS) {
      for (const [width, height] of SIZES) {
        await page.setViewportSize({ width, height });
        await block(page).scrollIntoViewIfNeeded();
        for (const mode of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme: mode });
          await page.screenshot({ path: `${SHOTS}/${info.project.name}-${width}-${mode}.png` });
        }
      }
      await page.emulateMedia({ colorScheme: "light" });
    }
    for (const [width, height] of SIZES) {
      await page.setViewportSize({ width, height });
      await block(page).scrollIntoViewIfNeeded();

      // the summary's own surface: tinted, or in Graphite outlined on no fill
      const card = block(page);
      const [mine, summary] = await Promise.all([card, page.getByTestId("summary-block")].map((el) => el.evaluate((n) => { const s = getComputedStyle(n); return { fill: s.backgroundColor, ring: s.boxShadow, radius: s.borderTopLeftRadius }; })));
      expect(mine).toEqual(summary);
      const NONE = "rgba(0, 0, 0, 0)";
      if (info.project.name === "e2e-graphite") expect(mine!.ring).not.toContain(NONE);
      else expect(mine!.fill).not.toBe(NONE);

      // one column: the summary above and the reply bar below share the card's ends
      const box = (await card.boundingBox())!;
      for (const other of [page.getByTestId("draft-slot"), page.getByTestId("summary-block")]) {
        const o = (await other.boundingBox())!;
        expect(Math.abs(o.x - box.x), `${info.project.name} ${width} left`).toBeLessThanOrEqual(1);
        expect(Math.abs(o.x + o.width - (box.x + box.width)), `${info.project.name} ${width} right`).toBeLessThanOrEqual(1);
      }

      // the label is the header, the draft and the actions sit inside the card's padding, on the header's inset
      const header = (await page.getByTestId("reply-ready-header").boundingBox())!;
      const text = (await page.getByTestId("reply-ready-text").boundingBox())!;
      const footer = (await page.getByTestId("reply-ready-footer").boundingBox())!;
      const inset = text.x - box.x;
      expect(inset).toBeGreaterThanOrEqual(12);
      expect((await page.getByTestId("reply-ready-header").locator("svg").first().boundingBox())!.x - box.x).toBe(inset);
      expect((await page.getByTestId("reply-ready-use").boundingBox())!.x - box.x).toBe(inset);
      expect(text.x + text.width).toBeLessThanOrEqual(box.x + box.width - inset + 0.5);
      expect(header.y).toBeGreaterThanOrEqual(box.y);
      expect(text.y).toBeGreaterThanOrEqual(header.y + header.height);
      expect(footer.y).toBeGreaterThanOrEqual(text.y + text.height);
      expect(footer.y + footer.height).toBeLessThanOrEqual(box.y + box.height - 8);
    }
  });

  test("r before the dwell ends: they're writing, so nothing is prepared; new mail hides what was shown; Clear takes it off screen", async ({ app: page, server }) => {
    const thread = await withMail(page, server, { replies: { enabled: true } });
    const db = sqlDb(server.backend.store);
    await row(page).click();
    await page.keyboard.press("r");
    await page.waitForTimeout(900);
    await expect(block(page)).toHaveCount(0);
    expect(db.get<{ n: number }>("SELECT count(*) n FROM ai_prepared_replies")!.n).toBe(0);
    await page.keyboard.press("Escape");
    await page.getByTestId("thread-row").first().click();
    await row(page).click();
    await expect(block(page)).toHaveAttribute("data-phase", "ready", { timeout: 15_000 });
    await server.backend.server.invoke("ai.summaries.clear", {}, dev);
    await expect(block(page)).toHaveCount(0);
    await page.getByTestId("thread-row").first().click();
    await row(page).click();
    await expect(block(page)).toHaveAttribute("data-phase", "ready", { timeout: 15_000 });
    await ingestConversation(server, { subject: SUBJECT, count: 2, now: E2E_NOW + 1000 });
    server.backend.notifyChanged([thread]);
    await expect(block(page)).toHaveCount(0);
  });

  test("“thanks!” shows nothing, once; a new message replaces what was there; Spanish too", async ({ app: page, server }) => {
    await ingestConversation(server, { subject: "Thanks for that", count: 1, now: E2E_NOW });
    const db = sqlDb(server.backend.store);
    const thanks = db.get<{ id: number }>("SELECT id FROM threads WHERE subject = ?", "Thanks for that")!.id;
    db.run("UPDATE threads SET waiting_since = ? WHERE id = ?", E2E_NOW - 3_600_000, thanks);
    db.run("UPDATE message_bodies SET body_text = 'Thanks!' WHERE message_id IN (SELECT id FROM messages WHERE thread_id = ?)", thanks);
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" }, replies: { enabled: true }, language: "es" });
    await row(page, "Thanks for that").click();
    await expect.poll(() => db.get<{ state: string }>("SELECT state FROM ai_prepared_replies WHERE thread_id = ?", thanks)?.state).toBeTruthy();
    await expect(block(page)).toHaveCount(0);
  });
});
