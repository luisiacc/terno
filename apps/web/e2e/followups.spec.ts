/**
 * Plan 142 in the page, on the offline fake model and the demo's provider: nothing here reaches a real provider. A promise
 * is sent, comes due on the Inbox's top, is opened, done and undone; a wait is nudged without anything being sent.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { SettingsPatch } from "@terno/core/rpc";
import { expect, fresh, focusList, ingestConversation, rows, scenario, test, type DevServerFixture } from "./fixtures";
import { E2E_NOW } from "./constants";

test.use({ backendOptions: { network: true } });

const dev = { clientId: "setup", origin: "dev" as const };
const SHOTS = process.env.FOLLOWUP_SHOTS;

async function settingUp(page: Page, server: DevServerFixture, patch: SettingsPatch) {
  await server.backend.server.invoke("settings.update", patch, dev);
  await fresh(page);
}

/** What the worker found, written as it would be: the same store path, with no wait for the fake's timing. */
async function tracked(server: DevServerFixture, subject: string, kind: "promise" | "awaiting", due: boolean) {
  await ingestConversation(server, { subject, count: 2, now: E2E_NOW });
  const store = server.backend.store;
  const { items } = await store.threads.searchText({ query: `subject:"${subject}"`, limit: 1, now: E2E_NOW });
  const threadId = items[0]!.id;
  const thread = await store.threads.get(threadId);
  const message = thread!.messages.at(-1)!;
  await store.followups.marks.queueScan([message.id], E2E_NOW);
  // a live one, as far as the top goes: not from a check
  await store.followups.finish({ messageId: message.id, threadId, fromScan: false, rows: [{ kind, item: kind === "promise" ? 0 : 100, text: "send the contract", quote: kind === "promise" ? "I'll send the contract" : null, personName: "Tom Reed", personEmail: "tom.reed@example.com", dueAt: due ? E2E_NOW - 1000 : E2E_NOW + 86_400_000, dated: false }], kept: [], now: E2E_NOW, model: "demo", provider: "fake", promptVersion: 1, clearGeneration: store.followups.clearGeneration() });
  await server.backend.followups.look();
  return threadId;
}

test.describe("follow-ups (plan 142)", () => {
  test("a due promise: on the Inbox's top with its line, opening ends the row and the list keeps it, Done and Undo, the thread's line", async ({ app: page, server }) => {
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" }, followups: { enabled: true, scanAnswered: true } });
    await tracked(server, "The contract", "promise", true);
    await fresh(page);

    await scenario("on top, under the heading, saying what's owed", async () => {
      await expect(page.getByTestId("inbox-reminders-label")).toBeVisible();
      await expect(rows(page).first()).toContainText("You told Tom Reed you’d send the contract");
      // a reminder set for next month on the same thread doesn't speak for it: what brought it here does
      const id = Number(await rows(page).first().getAttribute("data-thread-id"));
      await server.backend.server.invoke("reminders.set", { threadIds: [id], dueAt: E2E_NOW + 30 * 86_400_000, kind: "always" }, dev);
      await expect(rows(page).first().getByTestId("row-date")).toHaveAttribute("data-due-at", /\d+/);
      await expect(rows(page).first().getByTestId("row-reminder")).toHaveCount(0);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-top-light.png` });
    });

    await scenario("the thread's line: its quote, → and its actions", async () => {
      await rows(page).first().click();
      const line = page.getByTestId("followup-line");
      await expect(line).toBeVisible();
      await expect(page.getByTestId("followup-due")).toContainText("Due");
      const left = async (id: string) => (await page.getByTestId(id).first().boundingBox())!.x;
      expect(Math.abs((await left("followup-text")) - (await left("reader-subject")))).toBeLessThanOrEqual(1);
      await page.getByTestId("followup-go").hover();
      await expect(page.getByTestId("followup-quote")).toContainText("I'll send the contract");
      await page.mouse.move(0, 0);
      if (SHOTS) {
        await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-thread-light.png` });
        await page.emulateMedia({ colorScheme: "dark" });
        await expect(page.locator("html")).toHaveClass(/\bdark\b/);
        await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-thread-dark.png` });
        await page.emulateMedia({ colorScheme: "light" });
      }
      expect((await new AxeBuilder({ page }).setLegacyMode().include("[data-testid=thread-followups]").analyze()).violations).toEqual([]);
    });

    await scenario("opening ended the top; Follow-ups keeps it", async () => {
      await expect.poll(async () => (await server.backend.store.followups.active())[0]!.inboxState).toBe("seen");
      await page.getByTestId("palette-go-followups").or(page.getByTestId("nav-followups")).first().click();
      await expect(rows(page)).toHaveCount(1);
      await expect(rows(page).first()).toContainText("You told Tom Reed");
    });

    await scenario("Done, with Undo that puts the row back", async () => {
      await rows(page).first().click();
      await page.getByTestId("followup-done").click();
      await expect(page.getByTestId("thread-followups")).toHaveCount(0);
      await page.locator("[data-testid=snack]").getByRole("button", { name: /undo/i }).click();
      await expect(page.getByTestId("followup-line")).toBeVisible();
    });
  });

  test("a wait: its line says how long, Nudge opens a draft on the thread and sends nothing", async ({ app: page, server }) => {
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" }, followups: { enabled: true, scanAnswered: true } });
    await tracked(server, "Are you in", "awaiting", true);
    await fresh(page);
    await rows(page).first().click();
    // sent moments ago in this conversation: "yet", never "in 1 day" (plan 161; whole days are a unit test)
    await expect(page.getByTestId("followup-text")).toHaveText("Tom Reed hasn’t replied yet");
    const sends = (await server.backend.store.debug.snapshot()).messages.filter((m) => m.isSent).length;
    await expect(page.getByTestId("followup-nudge")).toHaveText("Draft a nudge");
    await page.getByTestId("followup-nudge").click();
    await expect(page.getByTestId("composer")).toBeVisible();
    await expect(page.getByTestId("composer")).toContainText("Tom Reed");
    expect((await server.backend.store.debug.snapshot()).messages.filter((m) => m.isSent).length).toBe(sends);
  });

  test.describe("plan 161: the line's anatomy", () => {
    test.use({ tips: true });
    test("a fresh wait: when it comes back and what does, buttons at 28 px, Open message named, and a tip for a wait under the line", async ({ app: page, server }) => {
      await settingUp(page, server, { ai: { provider: "fake", model: "demo" }, followups: { enabled: true, scanAnswered: true } });
      const threadId = await tracked(server, "Coffee next week", "awaiting", false);
      await fresh(page);
      await page.locator(`[data-thread-id="${threadId}"]`).first().click();
      await expect(page.getByTestId("followup-header")).toContainText("Follow-up");
      await expect(page.getByTestId("followup-due")).toContainText("back on top of your Inbox");
      await expect(page.getByTestId("followup-due")).toContainText("if Tom doesn’t reply");
      await expect(page.getByTestId("followup-nudge")).toHaveText("Draft a nudge");
      await expect(page.getByTestId("followup-go")).toHaveText(/Open message/);
      for (const id of ["followup-nudge", "followup-later", "followup-dismiss", "followup-go"]) {
        expect((await page.getByTestId(id).boundingBox())!.height, id).toBeGreaterThanOrEqual(28);
      }
      // the tip teaches this kind (no Done on a wait) and sits under the line, not over the list
      const tip = page.getByTestId("tip-followups-first");
      await expect(tip).toBeVisible();
      await expect(tip).toContainText("Terno watches for replies");
      await expect(tip).toContainText("Draft a nudge");
      await expect(tip).not.toContainText("Done");
      const line = (await page.getByTestId("followup-line").boundingBox())!;
      const box = (await tip.boundingBox())!;
      expect(box.y).toBeGreaterThan(line.y);
      expect(box.x).toBeGreaterThanOrEqual(line.x - 24);
      await page.getByTestId("tip-done").click();
      // one hairline under the section at most: the message's own
      expect(await page.getByTestId("thread-followups").evaluate((el) => getComputedStyle(el).borderBottomWidth)).toBe("0px");
    });
  });

  test("on: Settings offers the last 30 days once; Not now sends nothing; off hides the row, the list and the lines", async ({ app: page, server }) => {
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" } });
    await expect(page.getByTestId("nav-followups")).toHaveCount(0);
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-ai").click();
    const group = page.getByTestId("ai-followups");
    await group.scrollIntoViewIfNeeded();
    await expect(group).toContainText("Sends the text of each message you send, and the message it answers, to Offline demo.");
    await page.getByTestId("ai-followups-switch").click();
    // the Nudge row comes with the switch; the offer once its count is in
    await page.getByTestId("ai-followups-notnow").click();
    await expect(page.getByTestId("ai-followups-offer")).toHaveCount(0);
    expect(await server.backend.store.followups.marks.count()).toBe(0);
    expect((await new AxeBuilder({ page }).setLegacyMode().include("[data-testid=ai-followups]").analyze()).violations).toEqual([]);
    await page.keyboard.press("Escape");
    await focusList(page);
    await tracked(server, "Hidden when off", "promise", true);
    await server.backend.server.invoke("settings.update", { followups: { enabled: false } }, dev);
    await fresh(page);
    await expect(page.getByTestId("nav-followups")).toHaveCount(0);
    await expect(rows(page).first()).not.toContainText("You told");
  });

  test("the wide list says what's owed too, and when; turning it off leaves the list", async ({ app: page, server }) => {
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" }, layout: "list", followups: { enabled: true, scanAnswered: true } });
    await tracked(server, "The contract", "promise", true);
    await fresh(page);
    await expect(rows(page).first()).toContainText("You told Tom Reed you’d send the contract");
    await page.getByTestId("nav-followups").click();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first().getByTestId("row-date")).toHaveAttribute("data-due-at", /\d+/);
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-ai").click();
    await page.getByTestId("ai-followups-switch").click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("nav-followups")).toHaveCount(0);
    await expect(page.getByTestId("list-title")).toHaveText("Inbox");
    await expect(rows(page).first()).not.toContainText("You told");
  });

  test("Spanish: the list and the line in Spanish", async ({ app: page, server }) => {
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" }, language: "es", followups: { enabled: true, scanAnswered: true } });
    await tracked(server, "El contrato", "promise", true);
    await fresh(page);
    await expect(rows(page).first()).toContainText("Le dijiste a Tom Reed que ibas a send the contract");
    await expect(page.getByTestId("nav-followups")).toContainText("Seguimientos");
  });

  test("the line beside its neighbours in every design", { tag: "@design" }, async ({ app: page, server }) => {
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" }, followups: { enabled: true, scanAnswered: true } });
    await tracked(server, "The contract", "promise", true);
    await fresh(page);
    await rows(page).first().click();
    await expect(page.getByTestId("followup-line")).toBeVisible();
    if (SHOTS) {
      await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-light.png` });
      await page.emulateMedia({ colorScheme: "dark" });
      await expect(page.locator("html")).toHaveClass(/\bdark\b/);
      await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-dark.png` });
    }
    expect((await new AxeBuilder({ page }).setLegacyMode().include("[data-testid=thread-followups]").analyze()).violations).toEqual([]);
  });
});
