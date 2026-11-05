import { axeBothModes, expect, test } from "./fixtures";

// Plan 101: an account whose wider window is downloading its older mail says so, quietly; it goes once done.
test(`the sidebar says older mail is downloading`, async ({ app: page, server }) => {
  const personal = (await server.backend.store.accounts.list()).find((a) => a.displayName === "Personal")!;
  await expect(page.getByTestId("first-sync-pill")).toHaveCount(0);
  const now = Date.now();
  await server.backend.store.accounts.update(personal.id, { syncWindowDays: 365, backfill: { merge: { since: now - 365 * 86_400_000, until: now - 180 * 86_400_000 } } });
  await server.backend.emitAccounts();
  const pill = page.getByTestId("first-sync-pill");
  await expect(pill.getByRole("status")).toHaveText("Downloading older mail");
  await expect(pill.getByTestId("first-sync-detail")).toHaveText("The last year, newest first");
  await axeBothModes(page, '[data-testid="first-sync-pill"]');
  // done (or cancelled): it goes
  await server.backend.store.accounts.update(personal.id, { backfill: null });
  await server.backend.emitAccounts();
  await expect(pill).toHaveCount(0);
});
