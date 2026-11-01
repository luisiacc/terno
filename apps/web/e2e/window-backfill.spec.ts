import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures";

const ctx = { clientId: "setup", origin: "dev" as const };

// Plan 101: an account whose wider window is downloading its older mail says so, quietly; it goes once done.
for (const theme of ["light", "dark"] as const) {
  test(`the sidebar says older mail is downloading, ${theme}`, async ({ app: page, server }, info) => {
    await server.backend.server.invoke("settings.update", { theme }, ctx);
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    const personal = (await server.backend.store.accounts.list()).find((a) => a.displayName === "Personal")!;
    await expect(page.getByTestId("first-sync-pill")).toHaveCount(0);
    const now = Date.now();
    await server.backend.store.accounts.update(personal.id, { syncWindowDays: 365, backfill: { merge: { since: now - 365 * 86_400_000, until: now - 180 * 86_400_000 } } });
    await server.backend.emitAccounts();
    const pill = page.getByTestId("first-sync-pill");
    await expect(pill.getByRole("status")).toHaveText("Downloading older mail");
    await expect(pill.getByTestId("first-sync-detail")).toHaveText("The last year, newest first");
    expect((await new AxeBuilder({ page }).include('[data-testid="first-sync-pill"]').analyze()).violations).toEqual([]);
    await page.getByTestId("sidebar").screenshot({ path: info.outputPath(`backfill-pill-${theme}.png`) });
    await page.getByTestId("sidebar").screenshot({ path: `/tmp/terno-p99/backfill-pill-${theme}.png` });
    // done (or cancelled): it goes
    await server.backend.store.accounts.update(personal.id, { backfill: null });
    await server.backend.emitAccounts();
    await expect(pill).toHaveCount(0);
  });
}
