/**
 * Plan 134 in the page, on the offline fake model and an in-process calibrated fake: nothing here reaches a provider,
 * JEV included (its Test is stubbed). New mail comes through a real sync pass.
 */
import { mkdirSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { CategorizerModel } from "@terno/core";
import type { SettingsPatch } from "@terno/core/rpc";
import { sqlDb } from "../../backend-dev/src/server";
import type { IncomingMessage } from "@terno/store";
import { E2E_NOW } from "./constants";
import { expect, focusList, rows, stabilize, test, type DevServerFixture } from "./fixtures";
import { englishLeaks } from "./i18n-leaks";

const SHOTS = "/tmp/terno-scratch/smart-categorization";

test.use({ backendOptions: { network: true } });

const dev = { clientId: "setup", origin: "dev" as const };

function incoming(accountId: number, subject: string, over: Partial<IncomingMessage> = {}): IncomingMessage {
  const key = subject.replace(/\W/g, "");
  return {
    accountId, providerMsgId: `smart-${key}`, providerThreadId: null, rfcMessageId: `${key}@smart.test`, inReplyTo: null, references: [],
    from: { name: `Someone ${key}`, email: `${key.toLowerCase()}@${key.toLowerCase()}.example` }, to: [{ name: "Me", email: "me@example.com" }], cc: [], bcc: [],
    subject, date: E2E_NOW - 60_000, snippet: subject, bodyText: `${subject}. Nothing the engine has seen before.`, bodyHtml: null, bodyState: "full", listId: null,
    isRead: false, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 500, gmailLabels: ["INBOX", "UNREAD"],
    ...over,
  };
}

async function firstAccount(server: DevServerFixture): Promise<number> {
  const { accounts } = (await server.backend.server.invoke("app.bootstrap", {}, dev)) as { accounts: { id: number }[] };
  return accounts[0]!.id;
}

async function category(server: DevServerFixture, name: string): Promise<number> {
  return ((await server.backend.server.invoke("categories.create", { name, color: "amber", showInInbox: true }, dev)) as { id: number }).id;
}

/**
 * The app again, with what the setup just saved. The demo mailbox's engine has an opinion on nearly anything, and a
 * thread it suggested for isn't the AI's to look at: here it has none, as for a sender it has never seen.
 */
async function settingUp(page: Page, server: DevServerFixture, patch: SettingsPatch) {
  Reflect.set(server.backend.categorizer, "current", new CategorizerModel({ decayRef: E2E_NOW }));
  await server.backend.server.invoke("settings.update", patch, dev);
  await page.reload();
  await page.locator("[data-ready]").waitFor();
  await rows(page).first().waitFor();
}

async function deliver(page: Page, server: DevServerFixture, m: IncomingMessage) {
  server.net.incoming.push(m);
  await server.backend.syncAccount(m.accountId);
  await expect(page.getByTestId("thread-row").filter({ hasText: m.subject }).first()).toBeVisible();
}

async function openSubject(page: Page, subject: string) {
  await page.getByTestId("thread-row").filter({ hasText: subject }).first().dispatchEvent("mousedown");
  await expect(page.getByTestId("reader-subject")).toHaveText(subject);
}

async function openCategoriesTab(page: Page) {
  await page.getByTestId("open-settings").click();
  await page.getByTestId("tab-categories").click();
  await expect(page.getByTestId("categories-tab")).toBeVisible();
}

async function shots(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveClass(theme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
    await stabilize(page);
    await page.screenshot({ path: `${SHOTS}/${name}-${theme}.png` });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test.describe("smart categorization (plan 134)", () => {
  test("new mail from an unknown sender shows a suggestion: y files and trains, n stays out", async ({ app: page, server }) => {
    const id = await category(server, "Quartz");
    await settingUp(page, server, { aiCategorize: true, ai: { provider: "fake" } });
    const accountId = await firstAccount(server);

    await deliver(page, server, incoming(accountId, "Quartz walk on Sunday"));
    await openSubject(page, "Quartz walk on Sunday");
    const chip = page.getByTestId("reader").getByTestId("suggestion-chip");
    await expect(chip).toContainText("Quartz");
    const examples = () => sqlDb(server.backend.store).all("SELECT label, source FROM cls_examples WHERE category_id = ?", id);
    expect(examples()).toEqual([]);
    await focusList(page);
    await page.keyboard.press("y");
    await expect(page.getByTestId("reader").getByTestId("category-chip").filter({ hasText: "Quartz" })).toBeVisible();
    await expect(chip).toHaveCount(0);
    await expect.poll(examples).toEqual([{ label: 1, source: "suggestion" }]);

    await deliver(page, server, incoming(accountId, "Quartz picnic in June"));
    await openSubject(page, "Quartz picnic in June");
    await expect(chip).toContainText("Quartz");
    await focusList(page);
    await page.keyboard.press("n");
    await expect(chip).toHaveCount(0);
    await expect(page.getByTestId("reader").getByTestId("category-chip").filter({ hasText: "Quartz" })).toHaveCount(0);
  });

  test("a calibrated model files what it's sure of, and removal takes it back; forwarding and hidden categories only get a suggestion", async ({ app: page, server }) => {
    const id = await category(server, "Certain");
    const hidden = ((await server.backend.server.invoke("categories.create", { name: "Hushed", color: "cyan" }, dev)) as { id: number }).id;
    const { items } = (await server.backend.server.invoke("threads.list", { view: "archive", limit: 20 }, dev)) as { items: { id: number }[] };
    await server.backend.server.invoke("categories.addThreads", { categoryId: id, threadIds: items.slice(0, 5).map((t) => t.id) }, dev);
    await server.backend.server.invoke("categories.addThreads", { categoryId: hidden, threadIds: items.slice(5, 10).map((t) => t.id) }, dev);
    await settingUp(page, server, { aiCategorize: true, ai: { provider: "fake" } });
    const accountId = await firstAccount(server);
    // the filing path against a fake: calibrated is the only thing that differs
    server.backend.ai = async () =>
      ({
        providerId: "jev",
        local: false,
        model: "fake",
        calibrated: true,
        contextTokens: null,
        endpoint: null,
        classify: async (input: { items: { id: string; text: string }[] }) => input.items.map((i) => ({ id: i.id, label: `c${i.text.includes("Hushed") ? hidden : id}`, confidence: 0.99 })),
      }) as never;

    await deliver(page, server, incoming(accountId, "Certain picnic"));
    await openSubject(page, "Certain picnic");
    const chips = page.getByTestId("reader").getByTestId("category-chip");
    await expect(chips.filter({ hasText: "Certain" }).getByTestId("auto-mark")).toBeVisible();
    await expect(page.getByTestId("reader").getByTestId("suggestion-chip")).toHaveCount(0);
    await chips.filter({ hasText: "Certain" }).getByRole("button", { name: /Certain/ }).last().click();
    await expect(chips.filter({ hasText: "Certain" })).toHaveCount(0);

    await deliver(page, server, incoming(accountId, "Hushed picnic"));
    await openSubject(page, "Hushed picnic");
    await expect(page.getByTestId("reader").getByTestId("suggestion-chip")).toContainText("Hushed");
    await expect(chips.filter({ hasText: "Hushed" })).toHaveCount(0);
  });

  test("Settings → Categories: the switch says what it sends, the JEV key saves, tests and goes", async ({ app: page, server }) => {
    await settingUp(page, server, { ai: { provider: "fake" } });
    await openCategoriesTab(page);
    const tab = page.getByTestId("categories-tab");
    await expect(tab).toContainText("with a few sender names and subjects from your categories");
    const row = page.getByTestId("jev-key-row");
    await expect(row).toContainText("TypeSafe AI");
    await expect(page.getByTestId("jev-key")).toHaveValue("");
    await expect(page.getByTestId("jev-key")).toHaveAttribute("type", "password");
    await shots(page, "settings-empty");
    expect((await new AxeBuilder({ page }).include("[data-testid=categories-tab]").analyze()).violations).toEqual([]);

    await page.getByTestId("jev-key").fill("jev-synthetic-key-9876");
    await page.getByTestId("jev-key-save").click();
    await expect(page.getByTestId("jev-key-saved")).toContainText("9876");
    await expect(page.getByTestId("jev-key")).toHaveCount(0);
    // the switch now names where it goes
    await expect(tab).toContainText("Sends each one to JEV");

    // Test lists models at TypeSafe AI: stubbed, nothing leaves this machine
    const tests: { provider: string; model?: string }[] = [];
    server.backend.aiService.test = (async (target: { provider: string; model?: string }) => {
      tests.push(target);
      return { ok: tests.length === 1, latencyMs: 12, ...(tests.length === 1 ? { capabilities: { output: "json_schema", contextTokens: null, embeddings: false, probedAt: E2E_NOW } } : { error: { kind: "auth", message: "That key was refused. Check it and save it again." } }) };
    }) as never;
    await page.getByTestId("jev-key-test").click();
    await expect(page.getByTestId("jev-key-test-result")).toBeVisible();
    expect(tests[0]).toMatchObject({ provider: "jev", model: "jev-latest" });
    await shots(page, "settings-saved");
    expect((await new AxeBuilder({ page }).include("[data-testid=categories-tab]").analyze()).violations).toEqual([]);
    await page.getByTestId("jev-key-test").click();
    await expect(page.getByTestId("jev-key-test-error")).toContainText("refused");

    await page.getByTestId("jev-key-remove").click();
    await expect(page.getByTestId("jev-key")).toHaveValue("");
    await expect(page.getByTestId("jev-key-saved")).toHaveCount(0);
  });

  test("the line about the reset shows once", async ({ app: page, server }) => {
    await settingUp(page, server, { ai: { provider: "fake" }, aiCategorizeWidened: true });
    await openCategoriesTab(page);
    await expect(page.getByTestId("ai-categorize-widened")).toContainText("This is now off");
    await shots(page, "settings-widened");
    await expect.poll(async () => ((await server.backend.server.invoke("app.bootstrap", {}, dev)) as { settings: { aiCategorizeWidened: boolean } }).settings.aiCategorizeWidened).toBe(false);
    // it says "this is now off": not once it's on again
    await page.getByTestId("ai-categorize-switch").click();
    await expect(page.getByTestId("ai-categorize-widened")).toHaveCount(0);
    await page.getByTestId("ai-categorize-switch").click();
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await openCategoriesTab(page);
    await expect(page.getByTestId("ai-categorize-switch")).toBeVisible();
    await expect(page.getByTestId("ai-categorize-widened")).toHaveCount(0);
  });

  test("en and es: every word of it in the app's language", async ({ app: page, server }) => {
    await category(server, "Quartz");
    await settingUp(page, server, { aiCategorize: true, ai: { provider: "fake" }, language: "es" });
    await deliver(page, server, incoming(await firstAccount(server), "Quartz excursión al lago"));
    await openSubject(page, "Quartz excursión al lago");
    await expect(page.getByTestId("reader").getByTestId("suggestion-chip")).toContainText("¿Quartz?");
    await settingUp(page, server, { aiCategorize: false, aiCategorizeWidened: true });
    await openCategoriesTab(page);
    await expect(page.getByTestId("jev-key-row")).toContainText("TypeSafe AI");
    await expect(page.getByTestId("ai-categorize-widened")).toContainText("desactivado");
    await shots(page, "settings-es");
    expect(await englishLeaks(page)).toEqual([]);
  });
});
