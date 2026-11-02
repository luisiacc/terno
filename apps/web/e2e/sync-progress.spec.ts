import AxeBuilder from "@axe-core/playwright";
import type { Account } from "@terno/core";
import { expect, test } from "./fixtures";

const ctx = { clientId: "setup", origin: "dev" as const };
const DAY = 86_400_000;

// Plan 103: the sync card opens to each account's progress: what's left, a thin bar each.
for (const theme of ["light", "dark"] as const) {
  test(`the sync card opens to each account's progress and closes again, ${theme}`, async ({ app: page, server }, info) => {
    await server.backend.server.invoke("settings.update", { theme }, ctx);
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    const all = await server.backend.store.accounts.list();
    const byName = (n: string) => all.find((a) => a.displayName === n)!;
    const personal = byName("Personal"), acme = byName("Acme Studio"), freelance = byName("Freelance");
    const now = Date.now();
    // Gmail's estimate; IMAP's folders; a backfill that can only say how far back it is
    await server.backend.store.accounts.update(freelance.id, { syncWindowDays: 365, backfill: { merge: { since: now - 365 * DAY, until: now - 180 * DAY } } });
    const progress: Record<number, Partial<Account["syncState"]>> = {
      [personal.id]: { status: "syncing", lastSyncAt: null, progress: { done: 1200, total: 5521, unit: "messages", reachedAt: now - 40 * DAY } },
      [acme.id]: { status: "syncing", lastSyncAt: null, progress: { done: 4, total: 7, unit: "folders" } },
      [freelance.id]: { progress: { reachedAt: now - 300 * DAY } },
    };
    // runs in progress are the status owner's (w05, 80d812de), not a stored state: the card is fed the accounts event
    // a backend mid-sync would send
    const views = await server.backend.accountViews(await server.backend.store.accounts.list());
    server.backend.server.emit("accounts", views.map((a) => ({ ...a, syncState: { ...a.syncState, ...progress[a.id] } })));

    const card = page.getByTestId("first-sync-pill");
    const toggle = page.getByTestId("first-sync-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    // closed, its bars' light is paused (nothing animates out of sight); e2e runs with motion reduced, which turns every
    // animation off anyway, so the pause is checked as the card sets it
    await expect(card.locator(".sync-sheen").first()).toHaveClass(/animation-play-state:paused/);
    // the caret shows on hover
    const caret = toggle.locator("svg").last();
    await expect(caret).toHaveCSS("opacity", "0");
    await toggle.hover();
    await expect(caret).toHaveCSS("opacity", "1");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(card.locator(".sync-sheen").first()).not.toHaveClass(/animation-play-state:paused/);
    const row = (id: number) => card.getByTestId(`first-sync-account-${id}`);
    await expect(row(personal.id)).toContainText("Personal");
    await expect(row(personal.id)).toContainText("~4,321 left");
    await expect(row(personal.id).getByRole("progressbar")).toHaveAttribute("aria-valuetext", "About 4,321 messages left");
    await expect(row(personal.id).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "22");
    await expect(row(acme.id)).toContainText("3 folders left");
    // it reached 300 days back of a year: 65 days to go
    await expect(row(freelance.id)).toContainText("65 days left");
    expect((await new AxeBuilder({ page }).include('[data-testid="first-sync-pill"]').analyze()).violations).toEqual([]);
    await page.mouse.move(600, 300);
    await page.waitForTimeout(300);
    await page.getByTestId("sidebar").screenshot({ path: info.outputPath(`sync-progress-${theme}.png`) });
    await card.screenshot({ path: `/tmp/terno-p99/sync-progress-${theme}.png` });
    // live progress (its own event) moves the row without an accounts event
    server.backend.server.emit("syncProgress", { accountId: acme.id, progress: { done: 6, total: 7, unit: "folders" } });
    await expect(row(acme.id)).toContainText("1 folder left");
    // and closes again
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    // collapsed: no height (the list is clipped by its row), and out of reach of Tab and screen readers
    await expect.poll(async () => (await page.locator("#" + (await toggle.getAttribute("aria-controls"))!.replace(/:/g, "\\:")).boundingBox())?.height ?? 0).toBeLessThan(1);
  });
}
