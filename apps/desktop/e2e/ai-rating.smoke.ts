/**
 * Plan 161: the UI rating's harness with AI on. Its first launch sets AI up through Settings, as a person would (the
 * backend's own settings.update), and what's rated is the second: the AI entry points are there, every backend request
 * went to the local stub, and nothing left the machine. Without `ai`, the same demo shows no AI at all.
 * Runs the dev build (apps/desktop/dist), as the harness does.
 */
import { expect, test } from "@playwright/test";
import { launch } from "../../../scripts/ui-rating/harness.mjs";

test.describe.configure({ mode: "serial" });

test("launch({ ai: true }): settings survive the relaunch, the AI entry points show, nothing but the stub is reached", async () => {
  const { page, close, network, stub } = await launch({ ai: true });
  try {
    // the window and the backend read the demo's own instant
    expect(await page.evaluate(() => new Date().toISOString())).toBe("2026-10-22T16:00:00.000Z");
    await expect(page.getByTestId("nav-today")).toBeVisible();
    await page.getByTestId("thread-row").filter({ hasText: "departamento en la Roma" }).first().click();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Meta+j");
    await expect(page.getByTestId("ai-row-input")).toBeVisible();
    await page.getByTestId("compose-discard").click();
    await expect(page.getByTestId("composer")).toHaveCount(0);
    await page.keyboard.press("Meta+Shift+k");
    // plan 161, pass 3: Ask's page names its dialog (its chip became "‹ All commands")
    await expect(page.getByRole("dialog", { name: "Ask your mail" })).toBeVisible();
    await page.keyboard.press("Escape");
    const net = network();
    expect(net.problems).toEqual([]);
    expect(net.ai).toBeGreaterThan(0);
    expect(stub!.tasks).toContain("newsletter_digest");
    expect(stub!.unknown).toEqual([]);
  } finally {
    await close();
  }
});

test("launch() without it: the same demo, AI off", async () => {
  const { page, close, stub } = await launch();
  try {
    expect(stub).toBeNull();
    await page.getByTestId("thread-row").first().click();
    await expect(page.getByTestId("reader-subject")).toBeVisible();
    await expect(page.getByTestId("nav-today")).toHaveCount(0);
    await expect(page.getByTestId("action-summarize")).toHaveCount(0);
  } finally {
    await close();
  }
});
