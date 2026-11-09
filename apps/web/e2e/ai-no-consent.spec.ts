/**
 * Plan 131, the owner's decision (2026-11-08): no per-use consent. On a cloud provider (OpenAI, pointed at the model stub
 * on this machine: nothing here reaches a real provider) every AI surface runs on the first ask, with nothing to agree
 * to; Settings → AI is where the user is told which provider receives mail, and what goes there.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { E2E_NOW } from "./constants";
import { expect, focusList, fresh, ingestConversation, scenario, test, type DevServerFixture } from "./fixtures";
import { startOllamaStub } from "./ollama-stub";

test.use({ backendOptions: { network: true } });

const dev = { clientId: "setup", origin: "dev" as const };
const SHOTS = process.env.NO_CONSENT_SHOTS;
/** what each removed prompt was: none of them may come back */
const PROMPTS = "[data-testid=summary-consent], [data-testid=summary-continue], [data-testid=ai-telling], [data-testid=ask-consent], [data-testid=action-consent], [data-testid=style-study-consent]";

async function openThread(page: Page, subject: string) {
  await page.getByTestId("thread-row").filter({ hasText: subject }).first().click();
  await expect(page.getByTestId("reader-subject")).toHaveText(subject);
}

async function closeSettings(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toHaveCount(0);
}

/** A wait the worker found on the thread, written as it would be (followups.spec's `tracked`). */
async function awaiting(server: DevServerFixture, subject: string) {
  await ingestConversation(server, { subject, count: 2, now: E2E_NOW });
  const store = server.backend.store;
  const { items } = await store.threads.searchText({ query: `subject:"${subject}"`, limit: 1, now: E2E_NOW });
  const threadId = items[0]!.id;
  const message = (await store.threads.get(threadId))!.messages.at(-1)!;
  await store.followups.marks.queueScan([message.id], E2E_NOW);
  await store.followups.finish({ messageId: message.id, threadId, fromScan: false, rows: [{ kind: "awaiting", item: 100, text: "send the contract", quote: null, personName: "Tom Reed", personEmail: "tom.reed@example.com", dueAt: E2E_NOW - 1000, dated: false }], kept: [], now: E2E_NOW, model: "demo", provider: "fake", promptVersion: 1, clearGeneration: store.followups.clearGeneration() });
  await server.backend.followups.look();
}

async function ask(page: Page, text: string) {
  await focusList(page);
  await page.keyboard.press("ControlOrMeta+Shift+k");
  await expect(page.getByRole("dialog")).toBeVisible();
  // Ask comes back to the last conversation: a new question starts from New question
  if (await page.getByTestId("ask-new").isVisible()) await page.getByTestId("ask-new").click();
  await expect(page.getByTestId("palette-input")).toBeFocused();
  await page.getByTestId("palette-input").fill(text);
  await page.getByTestId("ask-submit").waitFor();
  await page.keyboard.press("Enter");
}

test("on a cloud provider every AI surface runs on the first ask; Settings → AI says where mail goes (plan 131)", async ({ app: page, server }) => {
  const stub = await startOllamaStub();
  try {
    // the newest mail, so its row is at the top
    await ingestConversation(server, { subject: "Quokka policy", count: 3, now: E2E_NOW + 3_540_000 });
    await awaiting(server, "Are you in");
    await server.backend.server.invoke("settings.update", { ai: { provider: "openai", baseURL: `${stub.url}/v1`, model: "gpt-6-luna" }, followups: { enabled: true, scanAnswered: false } }, dev);
    await server.backend.server.invoke("ai.setKey", { provider: "openai", value: "sk-openai-e2e-not-a-real-key" }, dev);
    await fresh(page);
    const ran = (task: string) => expect.poll(() => stub.tasks.includes(task), { message: `the stub got ${task}` }).toBe(true);

    await scenario("Settings → AI names the provider that receives mail, and what goes there", async () => {
      await page.getByTestId("open-settings").click();
      await page.getByTestId("tab-ai").click();
      const note = page.getByTestId("ai-privacy");
      await expect(note).toContainText("OpenAI receives a conversation’s text when you use an AI feature on it, and mail as it comes in or goes out for the background features you turn on below.");
      expect((await new AxeBuilder({ page }).setLegacyMode().include("[data-testid=ai-privacy]").analyze()).violations).toEqual([]);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/settings-ai-light.png` });
      await closeSettings(page);
    });

    await scenario("a summary: straight to the summary", async () => {
      await openThread(page, "Quokka policy");
      await page.getByTestId("action-summarize").click();
      await expect(page.getByTestId("summary-block")).toHaveAttribute("data-state", "ready");
      expect(stub.summaries).toHaveLength(1);
    });

    await scenario("⌘J: the first draft is written at once", async () => {
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("ControlOrMeta+j");
      await expect(page.getByTestId("ai-row-input")).toBeFocused();
      await page.getByTestId("ai-row-input").fill("say yes");
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("ai-strip")).toBeVisible();
      await ran("compose");
      await page.getByTestId("compose-discard").click();
      await expect(page.getByTestId("composer")).toHaveCount(0);
    });

    await scenario("Write a follow-up: the reminder is drafted at once", async () => {
      const composes = stub.tasks.filter((t) => t === "compose").length;
      await openThread(page, "Are you in");
      await page.getByTestId("followup-nudge").click();
      await expect(page.getByTestId("composer")).toBeVisible();
      await expect(page.getByTestId("ai-strip")).toBeVisible();
      expect(stub.tasks.filter((t) => t === "compose").length).toBeGreaterThan(composes);
      await page.getByTestId("compose-discard").click();
      await expect(page.getByTestId("composer")).toHaveCount(0);
    });

    await scenario("Ask: the first question is answered", async () => {
      await ask(page, "what does the quokka policy say?");
      await expect(page.getByTestId("ask-answer")).toBeVisible();
      await ran("answer");
      await page.getByTestId("ask-close").click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });

    await scenario("an action in plain English: its check runs without asking", async () => {
      await ask(page, "Archive shipping notices older than a month");
      await expect(page.getByTestId("action-preview")).toBeVisible();
      await ran("action_check");
      await expect(page.getByTestId("action-apply")).toBeEnabled();
      await page.getByTestId("action-cancel").click();
      await expect(page.getByTestId("action-preview")).toHaveCount(0);
    });

    await scenario("Study my style starts on the click", async () => {
      await page.getByTestId("open-settings").click();
      await page.getByTestId("tab-ai").click();
      await page.getByTestId("ai-drafting-style-open").click();
      await expect(page.getByTestId("writing-style")).toBeVisible();
      await expect(page.getByTestId("style-study-start")).toHaveText("Study my style");
      await page.getByTestId("style-study-start").click();
      await ran("voice_judgment");
      await expect(page.getByTestId("style-study-done")).toBeVisible({ timeout: 30_000 });
    });

    expect(await page.locator(PROMPTS).count()).toBe(0);
  } finally {
    await stub.close();
  }
});
