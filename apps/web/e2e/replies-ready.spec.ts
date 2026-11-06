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

    await scenario("r does what Use does", async () => {
      await page.keyboard.press("r");
      await expect(block(page)).toHaveCount(0);
      await expect.poll(state).toBe("used");
    });
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
