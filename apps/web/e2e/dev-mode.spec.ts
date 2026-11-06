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
  // the key values stay in the backend
  await expect(page.getByTestId("dev-tab")).not.toContainText("invented");

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
