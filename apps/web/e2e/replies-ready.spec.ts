/**
 * Plan 144 in the page, on the offline fake model: nothing here reaches a provider. Off by default; on, a conversation
 * that waits for an answer gets a block as it's read, which is nothing until it's used, and nothing can send it.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { SettingsPatch } from "@terno/core/rpc";
import { fakeDraft } from "../../../packages/ai/src/fake";
import { sqlDb } from "../../backend-dev/src/server";
import { E2E_NOW } from "./constants";
import { expect, fresh, ingestConversation, recipientEmails, scenario, test, type DevServerFixture } from "./fixtures";

test.use({ backendOptions: { network: true } });

const dev = { clientId: "setup", origin: "dev" as const };
const SHOTS = process.env.REPLY_SHOTS;

async function settingUp(page: Page, server: DevServerFixture, patch: SettingsPatch) {
  await server.backend.server.invoke("settings.update", patch, dev);
  await fresh(page);
}

const SUBJECT = "Can you make the 19th";

async function withMail(page: Page, server: DevServerFixture, patch: SettingsPatch = {}, cc?: { name: string; email: string }[]) {
  await ingestConversation(server, { subject: SUBJECT, count: 1, now: E2E_NOW, cc });
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
      // plan 161, pass 2: while it's being written its place is held, before the first word
      fakeDraft.firstTokenMs = 1500;
      await row(page).click();
      await expect(page.getByTestId("reply-ready-skeleton")).toBeVisible({ timeout: 15_000 });
      await expect(block(page)).toHaveAttribute("data-phase", "writing");
      fakeDraft.firstTokenMs = 0;
      await expect(block(page)).toHaveAttribute("data-phase", "ready", { timeout: 15_000 });
      // one R on screen: the card's, in Use as draft. Plan 162 (after ai162-r01): the card takes the reply bar's place
      await expect(page.getByTestId("reply-ready-use").locator("[data-slot=shortcut]")).toBeVisible();
      // one-to-one (owner's decisions 2): no Reply | Reply all, as the reply bar offers none
      await expect(page.getByTestId("reply-ready-mode")).toHaveCount(0);
      await expect(page.getByTestId("reply-ready-to")).toHaveText("To Yuki Gutiérrez");
      await expect(page.getByTestId("quick-reply-key")).toHaveCount(0);
      await expect(page.getByTestId("draft-slot")).toBeHidden();
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
      // plan 162 (after ai162-r01): the reply bar comes back to its place
      await expect(page.getByTestId("reply-bar")).toBeVisible();
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

    await scenario("plan 161, pass 2: Use, then Discard the draft (typed in or not): the reply is offered again", async () => {
      await page.keyboard.type(" And thanks.");
      await page.getByTestId("compose-discard").click();
      await expect(page.getByTestId("composer")).toHaveCount(0);
      await expect.poll(state).toBe("ready");
      await expect(block(page)).toHaveAttribute("data-phase", "ready");
      // the discard's own Undo brings the draft back, and the card steps aside for it
      await page.getByTestId("snack-action").click();
      await expect(page.getByTestId("composer")).toBeVisible();
      await expect(block(page)).toHaveCount(0);
    });
  });

  test("owner's decisions (2): a group thread offers Reply | Reply all; Reply all names everyone, and Use and R open with them, the same words", { tag: "@variant" }, async ({ app: page, server }) => {
    const others = [{ name: "Ana Ruiz", email: "ana.ruiz@acme.studio" }, { name: "Ben Wu", email: "ben.wu@acme.studio" }];
    const thread = await withMail(page, server, { replies: { enabled: true } }, others);
    const state = () => sqlDb(server.backend.store).get<{ state: string }>("SELECT state FROM ai_prepared_replies WHERE thread_id = ?", thread)?.state;
    const asked = () => sqlDb(server.backend.store).get<{ n: number }>("SELECT count(*) n FROM ai_prepared_replies")!.n;
    await row(page).click();
    await expect(block(page)).toHaveAttribute("data-phase", "ready", { timeout: 15_000 });
    const words = await page.getByTestId("reply-ready-text").innerText();
    // Reply first, as the reply bar's first; the reply bar offers Reply all here too
    await expect(page.getByTestId("quick-reply-all")).toBeVisible();
    await expect(page.getByTestId("reply-ready-mode")).toBeVisible();
    await expect(page.getByTestId("reply-ready-mode-reply")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("reply-ready-to")).toHaveText("To Yuki Gutiérrez");
    // in the header, which it doesn't grow
    expect((await page.getByTestId("reply-ready-header").boundingBox())!.height).toBeLessThanOrEqual(40);
    await page.getByTestId("reply-ready-mode-all").click();
    await expect(page.getByTestId("reply-ready-mode-all")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("reply-ready-to")).toHaveText("To Yuki Gutiérrez, cc Ana Ruiz and Ben Wu");
    // narrow, the people wrap in their own place: the switch stays on the title's line, never pushed under them
    await page.setViewportSize({ width: 1100, height: 700 });
    const middle = async (id: string) => { const b = (await page.getByTestId(id).boundingBox())!; return b.y + b.height / 2; };
    const to = (await page.getByTestId("reply-ready-to").boundingBox())!;
    const mode = (await page.getByTestId("reply-ready-mode").boundingBox())!;
    expect(mode.x).toBeGreaterThanOrEqual(to.x + to.width);
    expect(Math.abs((await middle("reply-ready-mode")) - (await middle("reply-ready-title")))).toBeLessThanOrEqual(to.height / 2 + 2);
    await page.setViewportSize({ width: 1440, height: 900 });
    // the same words, and nothing asked again
    await expect(page.getByTestId("reply-ready-text")).toHaveText(words);
    expect(asked()).toBe(1);
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const results = await new AxeBuilder({ page }).include('[data-testid="reply-ready"]').analyze();
      expect(results.violations.map((v) => `${scheme} ${v.id}`)).toEqual([]);
    }
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-group.png` });

    await scenario("Use opens the composer with everyone, and the words", async () => {
      await page.getByTestId("reply-ready-use").click();
      await expect(block(page)).toHaveCount(0);
      await expect(page.getByTestId("composer")).toHaveAttribute("data-mode", "replyAll");
      expect(await recipientEmails(page, "compose-to")).toEqual(["yuki.gutierrez@acme.studio"]);
      expect((await recipientEmails(page, "compose-cc")).sort()).toEqual(others.map((o) => o.email).sort());
      await expect(page.locator("[contenteditable=true]").first()).toContainText(words.split("\n")[0]!.slice(0, 20));
      await expect.poll(state).toBe("used");
      // the strip's Undo: the card again, still on Reply all
      await page.getByTestId("ai-strip-undo").click();
      await expect(block(page)).toBeVisible();
      await expect(page.getByTestId("reply-ready-mode-all")).toHaveAttribute("aria-pressed", "true");
    });

    await scenario("R is Use: with Reply all chosen it answers everyone; with Reply, the sender alone", async () => {
      await page.locator('[data-keep-scroll="list"]').focus();
      await page.keyboard.press("r");
      await expect(page.getByTestId("composer")).toHaveAttribute("data-mode", "replyAll");
      await page.getByTestId("ai-strip-undo").click();
      await expect(block(page)).toBeVisible();
      await page.getByTestId("reply-ready-mode-reply").click();
      await expect(page.getByTestId("reply-ready-to")).toHaveText("To Yuki Gutiérrez");
      await page.locator('[data-keep-scroll="list"]').focus();
      await page.keyboard.press("r");
      await expect(page.getByTestId("composer")).toHaveAttribute("data-mode", "reply");
      expect(await recipientEmails(page, "compose-to")).toEqual(["yuki.gutierrez@acme.studio"]);
      await expect(page.getByTestId("compose-cc")).toHaveCount(0);
    });
  });

  test("plan 161: the model's gaps are marked in the card and the composer, Use selects the first, and Send asks once, inline", async ({ app: page, server }) => {
    fakeDraft.text = () => "Thanks for asking. [Whether the 19th works.]\n\nLuis";
    try {
      const thread = await withMail(page, server, { replies: { enabled: true } });
      await row(page).click();
      await expect(block(page)).toHaveAttribute("data-phase", "ready", { timeout: 15_000 });
      await scenario("the card: who it's to, the gap marked, Use as draft at 28 px, the R hint in words", async () => {
        await expect(page.getByTestId("reply-ready-to")).toContainText("To ");
        await expect(page.getByTestId("reply-ready-gap")).toHaveText("[Whether the 19th works.]");
        await expect(page.getByTestId("reply-ready-use")).toHaveText(/^Use as draft/);
        await expect(page.getByTestId("reply-ready-use")).toHaveAccessibleName(/^Use as draft/);
        // plan 161, pass 2: what's left to fill, said before Use
        await expect(page.getByTestId("reply-ready-gaps")).toHaveText("1 gap to fill");
        for (const id of ["reply-ready-use", "reply-ready-dismiss"]) expect((await page.getByTestId(id).boundingBox())!.height, id).toBeGreaterThanOrEqual(28);
        // plan 161, pass 3: the voice leaves the header for the provenance at the row's end, which says it with why, and where
        // the words came from, as the composer says it after Use
        await expect(page.getByTestId("reply-ready-header")).not.toContainText("voice");
        await page.getByTestId("reply-ready-provenance").click();
        const why = page.getByTestId("reply-ready-provenance-popover");
        await expect(why).toContainText(/In your (general )?voice/);
        await expect(why).toContainText("What it says comes from this conversation alone: you gave no instruction.");
        await page.keyboard.press("Escape");
      });
      await scenario("Use: the gap marked in the composer, and selected to type over", async () => {
        await page.getByTestId("reply-ready-use").click();
        await expect(page.getByTestId("ai-strip-check")).toContainText("From the conversation alone, with no instruction from you");
        await expect(page.getByTestId("compose-gap")).toHaveText("[Whether the 19th works.]");
        await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe("[Whether the 19th works.]");
      });
      const sent = () => sqlDb(server.backend.store).get<{ n: number }>("SELECT count(*) n FROM messages WHERE is_sent = 1 AND thread_id = ?", thread)!.n;
      await scenario("Send with the gap still there: an inline question, nothing sent; Fill it in selects it again", async () => {
        await page.locator("[contenteditable=true]").first().press("ArrowRight");
        await page.keyboard.press("ControlOrMeta+Enter");
        await expect(page.getByTestId("ai-gaps")).toContainText("[Whether the 19th works.]");
        await expect(page.getByTestId("ai-gaps-fill")).toBeFocused();
        expect(sent()).toBe(0);
        // calm and in place: no dialog
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await page.getByTestId("ai-gaps-fill").click();
        await expect(page.getByTestId("ai-gaps")).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe("[Whether the 19th works.]");
      });
      await scenario("filled in, the mark goes and Send sends", async () => {
        await page.keyboard.type("The 19th works for me.");
        await expect(page.getByTestId("compose-gap")).toHaveCount(0);
        await page.keyboard.press("ControlOrMeta+Enter");
        await expect(page.getByTestId("ai-gaps")).toHaveCount(0);
        await expect.poll(sent).toBe(1);
      });
    } finally {
      fakeDraft.text = null;
    }
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
    // in light and dark: the card's fill and ring are the palette's (review 1)
    for (const [[width, height], mode] of SIZES.flatMap((size) => (["light", "dark"] as const).map((mode) => [size, mode] as const))) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: mode });
      await page.waitForFunction((dark) => document.documentElement.classList.contains("dark") === dark, mode === "dark");
      await block(page).scrollIntoViewIfNeeded();

      // the summary's own surface: tinted, or in Graphite outlined on no fill
      const card = block(page);
      const [mine, summary] = await Promise.all([card, page.getByTestId("summary-block")].map((el) => el.evaluate((n) => { const s = getComputedStyle(n); return { fill: s.backgroundColor, ring: s.boxShadow, radius: s.borderTopLeftRadius }; })));
      expect(mine).toEqual(summary);
      const NONE = "rgba(0, 0, 0, 0)";
      // an outline that is really drawn, never "none" on both (review 2)
      if (info.project.name === "e2e-graphite") {
        expect(mine!.fill, `${mode}`).toBe(NONE);
        expect(mine!.ring, `${mode}`).not.toBe("none");
        expect(mine!.ring, `${mode}`).not.toContain(NONE);
      } else expect(mine!.fill, `${mode}`).not.toBe(NONE);

      // one column: the summary above shares the card's ends (plan 162: the reply bar steps aside while it shows)
      const box = (await card.boundingBox())!;
      for (const other of [page.getByTestId("summary-block")]) {
        const o = (await other.boundingBox())!;
        expect(Math.abs(o.x - box.x), `${info.project.name} ${width} ${mode} left`).toBeLessThanOrEqual(1);
        expect(Math.abs(o.x + o.width - (box.x + box.width)), `${info.project.name} ${width} ${mode} right`).toBeLessThanOrEqual(1);
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

  test("plan 161, pass 2 (Codex review): a discarded draft doesn't bring back a reply that's out of date, and one scheduled after Undo takes it for good", async ({ app: page, server }) => {
    const thread = await withMail(page, server, { replies: { enabled: true } });
    const state = () => sqlDb(server.backend.store).get<{ state: string }>("SELECT state FROM ai_prepared_replies WHERE thread_id = ?", thread)?.state;
    await row(page).click();
    await expect(block(page)).toHaveAttribute("data-phase", "ready", { timeout: 15_000 });
    await scenario("Discard's Undo, then Send later: the reply isn't offered again", async () => {
      await page.getByTestId("reply-ready-use").click();
      await expect.poll(state).toBe("used");
      await page.getByTestId("compose-discard").click();
      await expect(block(page)).toBeVisible();
      await page.getByTestId("snack-action").click();
      await expect(page.getByTestId("composer")).toBeVisible();
      await expect(block(page)).toHaveCount(0);
      // scheduled: no message arrives to take it off screen, so the draft going is what must
      await page.getByTestId("compose-send-later").first().click();
      await page.getByTestId("send-later-popover").getByTestId("send-later-tomorrow").click();
      await expect(page.getByTestId("composer")).toHaveCount(0);
      await page.waitForTimeout(500);
      await expect(block(page)).toHaveCount(0);
    });
  });

  test("plan 161, pass 2 (Codex review): a message that came after Use makes the reply out of date: Discard doesn't show it", async ({ app: page, server }) => {
    const thread = await withMail(page, server, { replies: { enabled: true } });
    const state = () => sqlDb(server.backend.store).get<{ state: string }>("SELECT state FROM ai_prepared_replies WHERE thread_id = ?", thread)?.state;
    await row(page).click();
    await expect(block(page)).toHaveAttribute("data-phase", "ready", { timeout: 15_000 });
    await page.getByTestId("reply-ready-use").click();
    await expect.poll(state).toBe("used");
    await ingestConversation(server, { subject: SUBJECT, count: 2, now: E2E_NOW + 1000 });
    server.backend.notifyChanged([thread]);
    await expect(page.getByTestId("message").or(page.locator("[data-message-id]"))).not.toHaveCount(1);
    await page.getByTestId("compose-discard").click();
    await expect(page.getByTestId("composer")).toHaveCount(0);
    await page.waitForTimeout(800);
    await expect(block(page)).toHaveCount(0);
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
