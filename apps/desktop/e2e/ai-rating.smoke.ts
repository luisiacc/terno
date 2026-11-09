/**
 * Plan 161: the UI rating's harness with AI on. Its first launch sets AI up through Settings, as a person would (the
 * backend's own settings.update), and what's rated is the second: the AI entry points are there, and every backend
 * request went where it may. On the stub, nothing left the machine. On real models (`TERNO_RATING_REAL=1` only, since it
 * spends money: never in CI or test:all), Dev mode's Pro AI runs on the owner's .env keys and only their providers are
 * reached. Without `ai`, the same demo shows no AI at all. Runs the dev build (apps/desktop/dist), as the harness does.
 */
import { expect, test } from "@playwright/test";
import { launch } from "../../../scripts/ui-rating/harness.mjs";

test.describe.configure({ mode: "serial" });

test("launch({ ai: \"stub\" }): settings survive the relaunch, the AI entry points show, nothing but the stub is reached", async () => {
  const { page, close, network, stub } = await launch({ ai: "stub" });
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

test("launch({ ai: true }): Pro's real models on the .env keys, only their providers reached, no key left behind", async () => {
  test.skip(process.env.TERNO_RATING_REAL !== "1", "real models spend money: TERNO_RATING_REAL=1 runs it");
  test.setTimeout(10 * 60_000);
  const { page, close, network, stub, models, usage } = await launch({ ai: true });
  try {
    expect(stub).toBeNull();
    expect(models).toMatchObject({ mode: "real", hosts: expect.arrayContaining(["api.anthropic.com", "api.openai.com"]) });
    expect(await page.evaluate(() => new Date().toISOString())).toBe("2026-10-22T16:00:00.000Z");
    await expect(page.getByTestId("nav-today")).toBeVisible();
    // the digest prepared on its own, on a real model
    await page.getByTestId("nav-today").click();
    await expect(page.getByTestId("digest-row").filter({ hasText: /\d+ newsletters? · today/ }).first()).toBeVisible({ timeout: 5 * 60_000 });
    await page.keyboard.press("Meta+Shift+k");
    await expect(page.getByRole("dialog", { name: "Ask your mail" })).toBeVisible();
    await page.keyboard.press("Escape");
    const net = network();
    expect(net.problems).toEqual([]);
    expect(net.ai).toBeGreaterThan(0);
    expect(net.hosts.length).toBeGreaterThan(0);
    expect(usage().total.requests).toBeGreaterThan(0);
  } finally {
    // close() fails the test if anything the app wrote in its profile held a key
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
