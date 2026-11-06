/** Plan 146: Settings → Dev mode, on a local build, with invented keys (the rules behind it: dev-ai.test.ts). */
import { expect, test } from "./fixtures";

test.use({ backendOptions: { devAi: { anthropic: "invented-anthropic-key", jev: "invented-jev-key" } } });

test("names its variables, and Pro AI turns the AI features on and gives the saved setup back", async ({ app: page }) => {
  await page.keyboard.press("Meta+k");
  await page.getByTestId("palette-input").fill("settings dev mode");
  await expect(page.getByRole("option", { selected: true })).toHaveAttribute("data-testid", "palette-settings-dev");
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("dev-env-anthropic")).toContainText("ANTHROPIC_API_KEY");
  await expect(page.getByTestId("dev-env-anthropic")).toContainText("Set");
  await expect(page.getByTestId("dev-env-openai")).toContainText("OPENAI_API_KEY");
  await expect(page.getByTestId("dev-env-openai")).toContainText("Missing");
  await expect(page.getByTestId("dev-env-jev")).toContainText("JEV_API_KEY");
  await expect(page.getByTestId("dev-ai-on")).toHaveCount(0);

  await page.getByTestId("tab-ai").click();
  await expect(page.getByTestId("ai-provider")).toBeVisible();

  await page.getByTestId("tab-dev").click();
  await page.getByTestId("dev-ai-switch").click();
  await expect(page.getByTestId("dev-ai-on")).toBeVisible();

  // what would write settings the overlay hides says so; the features below stay
  await page.getByTestId("tab-ai").click();
  await expect(page.getByTestId("ai-dev-note")).toBeVisible();
  await expect(page.getByTestId("ai-provider")).toHaveCount(0);
  await expect(page.getByTestId("ai-summaries-add-key")).toHaveCount(0);
  await page.getByTestId("tab-categories").click();
  await expect(page.getByTestId("ai-categorize-switch")).toBeEnabled();
  await expect(page.getByTestId("jev-key-row")).toHaveCount(0);

  await page.getByTestId("tab-ai").click();
  await page.getByTestId("ai-dev-open").click();
  await page.getByTestId("dev-ai-switch").click();
  await page.getByTestId("tab-ai").click();
  await expect(page.getByTestId("ai-provider")).toBeVisible();
});

test("Plan 147: the switch off, no AI feature shows, whatever the profile has saved; on, they're all there", async ({ app: page, server }) => {
  const dev = { origin: "dev", clientId: "e2e" } as const;
  const openFirst = async () => {
    await page.getByTestId("thread-row").first().click();
    await expect(page.getByTestId("message").first()).toBeVisible();
  };
  const palette = async (query: string) => {
    await page.keyboard.press("Meta+k");
    await page.getByTestId("palette-input").fill(query);
  };
  const hidden = async () => {
    await expect(page.getByTestId("action-reply")).toBeVisible();
    await expect(page.getByTestId("action-summarize")).toHaveCount(0);
    await expect(page.getByTestId("quick-ai")).toHaveCount(0);
    await expect(page.getByTestId("summary-block")).toHaveCount(0);
    await palette("summarize");
    await expect(page.getByTestId("palette-summarize")).toHaveCount(0);
    await page.getByTestId("palette-input").fill("ask");
    await expect(page.getByTestId("palette-ask")).toHaveCount(0);
    await expect(page.getByTestId("palette-ask-row")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Meta+j");
    await page.keyboard.press("Meta+Shift+k");
    await page.waitForTimeout(100);
    await expect(page.getByTestId("ai-row-input")).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  };
  const toggle = async () => {
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-dev").click();
    await page.getByTestId("dev-ai-switch").click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  };

  // the demo model is saved here, and can run: it's the switch that says no
  const { settings } = await server.backend.server.invoke("app.bootstrap", {}, dev) as { settings: { ai: { provider: string } } };
  expect(settings.ai.provider).toBe("fake");
  await openFirst();
  // a summary is stored for this conversation, as from before the switch went off
  const threadId = Number(await page.getByTestId("thread-row").first().getAttribute("data-thread-id"));
  await server.backend.server.invoke("ai.summarize", { threadId, requestId: "stored" }, dev);
  await page.reload();
  await page.locator("[data-ready]").waitFor();
  await openFirst();
  await hidden();

  await toggle();
  await expect(page.getByTestId("summary-block")).toHaveAttribute("data-state", "ready");
  await expect(page.getByTestId("action-summarize")).toBeVisible();
  await expect(page.getByTestId("quick-ai")).toBeVisible();
  await palette("summarize");
  await expect(page.getByTestId("palette-summarize")).toBeVisible();
  await page.getByTestId("palette-input").fill("ask");
  await expect(page.getByTestId("palette-ask")).toBeVisible();
  await page.keyboard.press("Escape");

  await toggle();
  await hidden();
});

test.describe("without a local build", () => {
  test.use({ backendOptions: {} });

  test("there is no section, in Settings or the palette", async ({ app: page }) => {
    await page.keyboard.press("Meta+k");
    await page.getByTestId("palette-input").fill("settings dev mode");
    await expect(page.getByTestId("palette-settings-dev")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("palette-input")).toHaveCount(0);
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("tab-general")).toBeVisible();
    await expect(page.getByTestId("tab-dev")).toHaveCount(0);
  });
});
