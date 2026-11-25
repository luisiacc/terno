/**
 * Plan 276: Add account offers three ways in (Google and Microsoft in their own colors, Other mail account), and the IMAP
 * form is a step of its own: chosen, it comes in with one short move and takes the caret; Choose another way goes back
 * with what was typed kept and focus on Other mail account, no ring. Opening the dialog runs no step move.
 */
import type { Page } from "@playwright/test";
import { axeBothModes, expect, imapForm, test, waysIn } from "./fixtures";

/** from here on, each animation that starts on the steps' container: its name and duration (ms) */
async function recordMoves(page: Page) {
  await page.evaluate(() => {
    const w = window as Window & { __moves?: { name: string; ms: number }[] };
    w.__moves = [];
    document.addEventListener("animationstart", (e) => {
      const el = e.target as HTMLElement;
      if (el.dataset.testid === "add-account-way") w.__moves!.push({ name: e.animationName, ms: parseFloat(getComputedStyle(el).animationDuration) * 1000 });
    }, true);
  });
}
const moves = (page: Page) => page.evaluate(() => (window as Window & { __moves?: { name: string; ms: number }[] }).__moves!.splice(0));

async function shot(page: Page, name: string, path: (n: string) => string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator("html")).toHaveClass(scheme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
    await page.getByTestId("add-account-dialog").screenshot({ path: path(`${name}-${scheme}.png`), animations: "disabled" });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

// the suite reduces motion; the moves are what's under test here (Codex code review #5)
test.use({ reducedMotion: "no-preference" });

test("Add account: three ways in, then the IMAP form as a step of its own (plan 276)", async ({ app: page }, info) => {
  await recordMoves(page);
  await page.getByTestId("sidebar").getByRole("button", { name: "Add account", exact: true }).click();
  const dialog = page.getByTestId("add-account-dialog");
  const way = dialog.getByTestId("add-account-way");
  await expect(way).toHaveAttribute("data-way", "choose");
  await expect(dialog).toHaveAttribute("data-open", "");
  await expect.poll(() => dialog.evaluate((el) => el.getAnimations({ subtree: true }).filter((x) => x.playState === "running").length)).toBe(0);
  // opened, the step is simply there: no move of its own (the dialog's own entrance is enough)
  expect(await moves(page)).toEqual([]);
  await expect(dialog.getByTestId("imap-email")).toHaveCount(0);

  // one column of equal buttons, each provider in its own mark
  const google = dialog.getByTestId("connect-gmail");
  const microsoft = dialog.getByTestId("connect-microsoft");
  const other = dialog.getByTestId("connect-imap");
  await expect(google).toHaveAccessibleName("Continue with Google");
  await expect(microsoft).toHaveAccessibleName("Continue with Microsoft");
  await expect(other).toHaveAccessibleName("Other mail account IMAP/SMTP");
  await expect(google.locator("[data-provider-mark=Google]")).toBeVisible();
  await expect(microsoft.locator("[data-provider-mark=Microsoft]")).toBeVisible();
  const boxes = await Promise.all([google, microsoft, other].map(async (b) => (await b.boundingBox())!));
  for (const b of boxes.slice(1)) expect([b.x, b.width, b.height]).toEqual([boxes[0]!.x, boxes[0]!.width, boxes[0]!.height]);
  await axeBothModes(page, "[data-testid=add-account-dialog]");
  await shot(page, "ways", (n) => info.outputPath(n));

  // chosen: one move in, within the motion cap, from the right; the caret in Email
  await other.click();
  await expect(way).toHaveAttribute("data-way", "imap");
  await expect(way).toHaveClass(/slide-in-from-right/);
  await expect.poll(() => page.evaluate(() => (window as Window & { __moves?: unknown[] }).__moves!.length)).toBe(1);
  const [into] = await moves(page);
  expect(into!.ms).toBeGreaterThan(0);
  expect(into!.ms).toBeLessThanOrEqual(100);
  await expect(dialog.getByTestId("imap-email")).toBeFocused();
  await expect.poll(() => way.evaluate((el) => el.getAnimations().filter((a) => a.playState === "running").length)).toBe(0);
  await dialog.getByTestId("imap-email").fill("ana@icloud.com");
  await dialog.locator("#acc-name").fill("Ana");
  await expect(dialog.getByTestId("imap-host")).toHaveValue("imap.mail.me.com");
  await axeBothModes(page, "[data-testid=add-account-dialog]");
  await shot(page, "imap", (n) => info.outputPath(n));

  // back by keyboard: focus on Other mail account, no ring (the app moved it), what was typed kept
  await dialog.getByTestId("imap-back").focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByTestId("imap-back")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(way).toHaveAttribute("data-way", "choose");
  await expect(way).toHaveClass(/slide-in-from-left/);
  await expect.poll(() => page.evaluate(() => (window as Window & { __moves?: unknown[] }).__moves!.length)).toBe(1);
  expect((await moves(page))[0]!.ms).toBeLessThanOrEqual(100);
  await expect(other).toBeFocused();
  await expect(page.locator("html")).not.toHaveAttribute("data-focus-ring");
  await imapForm(dialog);
  await expect(dialog.getByTestId("imap-email")).toHaveValue("ana@icloud.com");
  await expect(dialog.locator("#acc-name")).toHaveValue("Ana");
  await waysIn(dialog);

  // closed and opened again: the ways in, with nothing kept
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.getByTestId("sidebar").getByRole("button", { name: "Add account", exact: true }).click();
  await expect(way).toHaveAttribute("data-way", "choose");
  await imapForm(dialog);
  await expect(dialog.getByTestId("imap-email")).toHaveValue("");
});

for (const off of ["the system's reduced motion", "Terno's motion setting at 0"] as const) {
  test.describe(`with ${off}`, () => {
    test.use({ reducedMotion: off === "the system's reduced motion" ? "reduce" : "no-preference" });
    test("a step is cut in, nothing moving (plan 276)", async ({ app: page, server }) => {
      if (off === "Terno's motion setting at 0") {
        await server.backend.server.invoke("settings.update", { motionMs: 0 }, { clientId: "setup", origin: "dev" as const });
        await page.reload();
        await page.locator("[data-ready]").waitFor();
        await expect(page.locator("html")).toHaveAttribute("data-motion", "off");
      }
      await recordMoves(page);
      await page.getByTestId("sidebar").getByRole("button", { name: "Add account", exact: true }).click();
      const dialog = page.getByTestId("add-account-dialog");
      await dialog.getByTestId("connect-imap").click();
      await expect(dialog.getByTestId("imap-email")).toBeFocused();
      await dialog.getByTestId("imap-back").click();
      await expect(dialog.getByTestId("connect-imap")).toBeFocused();
      expect(await moves(page)).toEqual([]);
    });
  });
}
