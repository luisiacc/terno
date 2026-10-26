/**
 * Plan 20 in the window: a calm, honest word when an account can't reach its server. Nothing for
 * a blip; "… is offline", "Retrying in 1 min" after a second failure; "Reconnecting…" while a retry
 * runs; "Retry now"; gone once it works. Settings says the same.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures";

test.use({ backendOptions: { network: true } });

const ctx = { clientId: "setup", origin: "dev" as const };

test.describe("connection pill", { tag: "@design" }, () => {
  test("a blip shows nothing; a second failure shows the account offline with its retry; Retry now brings it back", async ({ app: page, server }) => {
    const [account] = await server.backend.store.accounts.list();
    const pill = page.getByTestId("connection-pill");
    server.net.down = true;
    await server.backend.syncAccount(account!.id);
    // the first failure is retried quietly in a second: no pill meanwhile
    await expect(pill).toHaveCount(0);
    // the retry fails too: one account of several is that account's server
    await expect(pill).toBeVisible({ timeout: 5000 });
    await expect(pill).toHaveAttribute("data-state", "offline");
    await expect(page.getByTestId("connection-label")).toHaveText(`${account!.displayName} is offline`);
    await expect(page.getByTestId("connection-when")).toHaveText(/^Retrying in (\d+ sec|1 min)$/);
    // (the minute is ±20 %: accounts that lost the same server don't come back in lockstep)
    await expect(pill.getByRole("status")).toHaveText(`${account!.displayName} is offline`);
    await expect(page.getByTestId("connection-retry")).toHaveAccessibleName("Retry now");
    // Settings says the same
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-accounts").click();
    await expect(page.locator(`[data-testid=settings-account][data-account-id="${account!.id}"]`)).toContainText(/Offline, retrying in (\d+ sec|1 min)/);
    await page.keyboard.press("Escape");
    // the network is back; the user doesn't wait for the minute
    server.net.down = false;
    // from the keyboard (closing Settings left the gear's tooltip over the pill)
    await page.getByTestId("connection-retry").focus();
    await page.keyboard.press("Enter");
    await expect(pill).toHaveCount(0);
  });

  test("the device offline: every account, at once; Reconnecting… while the retry runs (the button keeps focus); online clears it", async ({ app: page, server }) => {
    const pill = page.getByTestId("connection-pill");
    server.net.down = true;
    server.backend.networkChanged(false, "offline");
    await expect(page.getByTestId("connection-label")).toHaveText("Offline");
    await expect(page.getByTestId("connection-when")).toHaveText("Retrying in 5 min");
    await expect(pill.getByRole("status")).toHaveText("Offline");
    // a slow retry: the pill stays, says so, and its button keeps the focus
    let release!: () => void;
    server.net.hold = new Promise((r) => (release = r));
    server.net.down = false;
    const retry = page.getByTestId("connection-retry");
    await retry.focus();
    await page.keyboard.press("Enter");
    await expect(pill).toHaveAttribute("data-state", "reconnecting");
    await expect(page.getByTestId("connection-label")).toHaveText("Reconnecting…");
    await expect(page.getByTestId("connection-when")).toHaveCount(0);
    await expect(retry).toBeFocused();
    await expect(retry).toHaveAttribute("aria-disabled", "true");
    server.net.hold = null;
    release();
    // the probe worked: the host was wrong about offline, everything syncs again
    await expect(pill).toHaveCount(0, { timeout: 8000 });
  });

  for (const theme of ["light", "dark"] as const) {
    test(`axe: the pill offline and reconnecting (${theme})`, async ({ app: page, server }) => {
      await server.backend.server.invoke("settings.update", { theme }, ctx);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      server.net.down = true;
      server.backend.networkChanged(false, "offline");
      const pill = page.getByTestId("connection-pill");
      await expect(pill).toBeVisible();
      const wcag = () => new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).include("[data-testid=connection-pill]");
      expect((await wcag().analyze()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 140)).join(", ")}`)).toEqual([]);
      let release!: () => void;
      server.net.hold = new Promise((r) => (release = r));
      await page.getByTestId("connection-retry").click();
      await expect(pill).toHaveAttribute("data-state", "reconnecting");
      expect((await wcag().analyze()).violations.map((v) => v.id)).toEqual([]);
      server.net.hold = null;
      release();
    });
  }
});

test("Spanish: the pill and Settings speak it", async ({ app: page, server }) => {
  await server.backend.server.invoke("settings.update", { language: "es" }, ctx);
  await page.reload();
  await page.locator("[data-ready]").waitFor();
  server.net.down = true;
  server.backend.networkChanged(false, "offline");
  await expect(page.getByTestId("connection-label")).toHaveText("Sin conexión");
  await expect(page.getByTestId("connection-when")).toHaveText("Reintentando en 5 min");
  await expect(page.getByTestId("connection-retry")).toHaveAccessibleName("Reintentar ahora");
});

test("a window coming back to the front retries an offline account at once", async ({ app: page, server }) => {
  const [account] = await server.backend.store.accounts.list();
  server.net.down = true;
  await server.backend.syncAccount(account!.id);
  await expect(page.getByTestId("connection-pill")).toBeVisible({ timeout: 5000 });
  server.net.down = false;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByTestId("connection-pill")).toHaveCount(0);
});
