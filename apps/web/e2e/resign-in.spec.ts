/**
 * Plan 25 in the window: an account that needs you to sign in again says so quietly (a key on its
 * row, one line at the foot of the sidebar), never in the way: mail stays readable, "Later" puts it
 * off, and signing in right there (Google, or the password) clears it at once. Every design.
 */
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { Account } from "@terno/core";
import { sqlDb } from "../../backend-dev/src/server";
import { expect, openRow, rows, SIGN_IN_PASSWORD, stabilize, test, type DevServerFixture } from "./fixtures";

test.use({ backendOptions: { network: true } });

const ctx = { clientId: "setup", origin: "dev" as const };

/** the seeded accounts: Personal and Acme Studio are Gmail, Freelance and iCloud IMAP */
async function accounts(server: DevServerFixture): Promise<{ personal: Account; freelance: Account }> {
  const all = await server.backend.store.accounts.list();
  return { personal: all.find((a) => a.kind === "gmail")!, freelance: all.find((a) => a.kind === "imap")! };
}

/** the server stops accepting the account's saved sign-in, and a sync finds out */
async function refuse(server: DevServerFixture, ...list: Account[]): Promise<void> {
  for (const a of list) {
    server.net.refused.add(a.email);
    await server.backend.syncAccount(a.id);
  }
}

const notice = (page: Page) => page.getByTestId("sign-in-notice");
const marker = (page: Page, a: Account) => page.getByTestId(`sign-in-marker-${a.id}`);
const popover = (page: Page) => page.getByTestId("sign-in-popover");

test.beforeEach(async ({ server }) => {
  // Google's sign-in needs the user's client ID (the fake Google answers for it)
  await server.backend.server.invoke("settings.update", { gmailClientId: "e2e.apps.googleusercontent.com" }, ctx);
});

test.describe("signing in again", { tag: "@design" }, () => {
  test("one Gmail account: a key on its row and one calm line; mail stays readable; Continue with Google clears both", async ({ app: page, server }) => {
    const { personal } = await accounts(server);
    await refuse(server, personal);
    await expect(marker(page, personal)).toBeVisible();
    await expect(marker(page, personal)).toHaveAccessibleName(`Sign in to keep ${personal.email} up to date`);
    await expect(notice(page)).toBeVisible();
    await expect(page.getByTestId("sign-in-title")).toHaveText(`${personal.displayName} needs a sign-in`);
    await expect(notice(page).getByRole("status")).toHaveText(`${personal.displayName} needs a sign-in`);
    await expect(notice(page)).toContainText("Sign in to catch up");
    // nothing is in the way: the list and a conversation work as ever
    await openRow(page, 0);
    await expect(page.getByTestId("reader-subject")).toBeVisible();

    await page.getByTestId("sign-in-open").click();
    await expect(popover(page)).toBeVisible();
    await expect(popover(page)).toContainText(`Sign in to ${personal.displayName}`);
    await expect(popover(page)).toContainText("Your mail stays here.");
    await popover(page).getByRole("button", { name: "Continue with Google" }).click();
    await expect(page.getByTestId("snack-message").getByText(`${personal.email} is connected again`)).toBeVisible();
    await expect(marker(page, personal)).toHaveCount(0);
    await expect(notice(page)).toHaveCount(0);
    // focus was in what went away: it lands on the account's row, not the page
    await expect(page.getByTestId(`nav-account-${personal.id}`)).toBeFocused();
    await expect.poll(async () => (await server.backend.store.accounts.get(personal.id))!.syncState).toMatchObject({ authRequired: false, status: "idle" });
  });

  test("another Google account picked: it says which one was expected, inline; still asking", async ({ app: page, server }) => {
    const { personal } = await accounts(server);
    await refuse(server, personal);
    server.net.google = "someone-else@gmail.com";
    await marker(page, personal).click();
    await popover(page).getByRole("button", { name: "Continue with Google" }).click();
    await expect(popover(page).getByRole("alert")).toHaveText(`Google connected someone-else@gmail.com, not ${personal.email}. Choose that account in the Google window.`);
    await expect(marker(page, personal)).toBeVisible();
    // the right account this time
    server.net.google = null;
    await popover(page).getByRole("button", { name: "Continue with Google" }).click();
    await expect(marker(page, personal)).toHaveCount(0);
  });

  test("two accounts: one line for both; a wrong password says so in place; the right one leaves the other", async ({ app: page, server }) => {
    const { personal, freelance } = await accounts(server);
    await refuse(server, personal, freelance);
    await expect(page.getByTestId("sign-in-title")).toHaveText("2 accounts need a sign-in");
    await page.getByTestId("sign-in-open").click();
    await expect(popover(page).getByTestId("sign-in-section")).toHaveCount(2);
    const section = popover(page).locator(`[data-testid=sign-in-section][data-account-id="${freelance.id}"]`);
    await section.getByRole("button", { name: "Enter password" }).click();
    const field = section.getByLabel(`Password for ${freelance.email}`);
    await expect(field).toBeFocused();
    await field.fill("not-it");
    await field.press("Enter");
    await expect(section.getByRole("alert")).toContainText("That password didn’t work. Check it, or create a new app password.");
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("not-it");
    await field.fill(SIGN_IN_PASSWORD);
    await expect(section.getByRole("alert")).toHaveCount(0);
    await field.press("Enter");
    await expect(page.getByTestId("snack-message").getByText(`${freelance.email} is connected again`)).toBeVisible();
    // one is left: the panel is that account's now, and focus went to its action
    await expect(page.getByTestId("sign-in-title")).toHaveText(`${personal.displayName} needs a sign-in`);
    await expect(popover(page).getByRole("button", { name: "Continue with Google" })).toBeFocused();
    await expect(marker(page, freelance)).toHaveCount(0);
    await expect(marker(page, personal)).toBeVisible();
  });

  test("Codex code review #3: another account failing or coming back while you type a password keeps what you typed", async ({ app: page, server }) => {
    const { personal, freelance } = await accounts(server);
    await refuse(server, freelance);
    await page.getByTestId("sign-in-open").click();
    const field = popover(page).getByLabel(`Password for ${freelance.email}`);
    await field.fill("half-typ");
    // one account becomes two: the panel lists both, and the field is the same field
    await refuse(server, personal);
    await expect(popover(page).getByTestId("sign-in-section")).toHaveCount(2);
    await expect(field).toHaveValue("half-typ");
    await expect(field).toBeFocused();
    // and back to one
    server.net.refused.delete(personal.email);
    await server.backend.syncAccount(personal.id);
    await expect(popover(page).getByTestId("sign-in-section")).toHaveCount(1);
    await expect(field).toHaveValue("half-typ");
    await expect(field).toBeFocused();
  });

  test("Codex code review 2: two, then one (its field appears), type, then two again: the field and what was typed stay", async ({ app: page, server }) => {
    const { personal, freelance } = await accounts(server);
    await refuse(server, personal, freelance);
    await page.getByTestId("sign-in-open").click();
    await expect(popover(page).getByTestId("sign-in-section")).toHaveCount(2);
    server.net.refused.delete(personal.email);
    await server.backend.syncAccount(personal.id);
    const field = popover(page).getByLabel(`Password for ${freelance.email}`);
    await expect(field).toBeVisible();
    await field.fill("half-typ");
    await refuse(server, personal);
    await expect(popover(page).getByTestId("sign-in-section")).toHaveCount(2);
    await expect(field).toHaveValue("half-typ");
    await expect(field).toBeFocused();
  });

  test("Later puts the line off, never the row's key; the account working and failing again brings it back", async ({ app: page, server }) => {
    const { freelance } = await accounts(server);
    await refuse(server, freelance);
    await page.getByTestId("sign-in-dismiss").click();
    await expect(notice(page)).toHaveCount(0);
    await expect(marker(page, freelance)).toBeVisible();
    // its server takes the saved password again (it was a glitch): nothing to say any more
    server.net.refused.delete(freelance.email);
    await server.backend.syncAccount(freelance.id);
    await expect(marker(page, freelance)).toHaveCount(0);
    // a new refusal is news again
    await refuse(server, freelance);
    await expect(notice(page)).toBeVisible();
  });

  test("a send while it needs a sign-in: it says the message will go out once you sign in, and Sign in is right there", async ({ app: page, server }) => {
    const { freelance } = await accounts(server);
    await refuse(server, freelance);
    await page.getByTestId("sign-in-dismiss").click();
    const sent = await server.backend.server.invoke("compose.send", { accountId: freelance.id, to: [{ name: "Ana", email: "ana@example.com" }], subject: "Propuesta", bodyText: "Hola Ana" }, ctx);
    const snackMessage = page.getByTestId("snack-message").getByText(`Your message will go out once you sign in to ${freelance.email}`);
    await expect(snackMessage).toBeVisible();
    await page.getByTestId("snack-dock").getByRole("button", { name: "Sign in" }).click();
    // the panel opens even after Later
    await expect(popover(page)).toBeVisible();
    await popover(page).getByLabel(`Password for ${freelance.email}`).fill(SIGN_IN_PASSWORD);
    await popover(page).getByRole("button", { name: "Sign in" }).click();
    await expect.poll(() => sqlDb(server.backend.store).get<{ state: string }>("SELECT state FROM ops WHERE id = ?", sent.opId)?.state).toBe("succeeded");
  });

  test("keyboard: Tab reaches the key after its row; Enter opens the panel with focus in it; Escape gives it back", async ({ app: page, server }) => {
    const { freelance } = await accounts(server);
    await refuse(server, freelance);
    await page.getByTestId(`nav-account-${freelance.id}`).focus();
    await page.keyboard.press("Tab");
    await expect(marker(page, freelance)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(popover(page).getByLabel(`Password for ${freelance.email}`)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(popover(page)).toHaveCount(0);
    await expect(marker(page, freelance)).toBeFocused();
  });

  for (const theme of ["light", "dark"] as const) {
    test(`axe and a look: the line, the key and the open panel (${theme})`, async ({ app: page, server }, testInfo) => {
      await server.backend.server.invoke("settings.update", { theme }, ctx);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await rows(page).first().waitFor();
      const { personal, freelance } = await accounts(server);
      await refuse(server, freelance);
      await expect(notice(page)).toBeVisible();
      const wcag = (selector: string) => new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).include(selector);
      const violations = async (selector: string) => (await wcag(selector).analyze()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 140)).join(", ")}`);
      expect(await violations("[data-testid=sign-in-notice]")).toEqual([]);
      expect(await violations(`[data-testid=sign-in-marker-${freelance.id}]`)).toEqual([]);
      await stabilize(page);
      const sidebar = page.getByTestId("sidebar");
      await expect(sidebar).toHaveScreenshot(`sidebar-one-${theme}.png`);
      const shots = process.env.SIGN_IN_SHOTS;
      const design = (await page.locator("html").getAttribute("data-design")) ?? testInfo.project.name;
      if (shots) await page.screenshot({ path: join(shots, `${design}-${theme}-one.png`) });
      await page.getByTestId("sign-in-open").click();
      await expect(popover(page).getByLabel(`Password for ${freelance.email}`)).toBeFocused();
      expect(await violations("[data-testid=sign-in-popover]")).toEqual([]);
      if (shots) await page.screenshot({ path: join(shots, `${design}-${theme}-one-open.png`) });
      await page.keyboard.press("Escape");
      // two: the line counts them, the panel lists them
      await refuse(server, personal);
      await expect(page.getByTestId("sign-in-title")).toHaveText("2 accounts need a sign-in");
      await page.mouse.move(0, 0);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await expect(sidebar).toHaveScreenshot(`sidebar-two-${theme}.png`);
      await page.getByTestId("sign-in-open").click();
      await expect(popover(page).getByTestId("sign-in-section")).toHaveCount(2);
      expect(await violations("[data-testid=sign-in-popover]")).toEqual([]);
      if (shots) await page.screenshot({ path: join(shots, `${design}-${theme}-two-open.png`) });
    });
  }
});

test("Settings says it calmly (not in the error ink) and signs in from there; a healthy account's wrong password shows its error", async ({ app: page, server }) => {
  const { personal, freelance } = await accounts(server);
  await refuse(server, personal);
  await page.getByTestId("open-settings").click();
  await page.getByTestId("tab-accounts").click();
  const item = page.locator(`[data-testid=settings-account][data-account-id="${personal.id}"]`);
  const line = item.getByTestId("account-toggle").locator("span span").nth(1);
  await expect(line).toContainText("Needs you to sign in again");
  await expect(line).not.toHaveClass(/text-destructive-ink/);
  await item.getByTestId("account-toggle").click();
  await item.getByRole("button", { name: "Sign in again", exact: true }).click();
  await expect(page.getByTestId("snack-message").getByText(`${personal.email} is connected again`)).toBeVisible();
  await expect(line).toContainText("Up to date");
  // Codex review #8: a password change on an account that works says what went wrong, in place
  const other = page.locator(`[data-testid=settings-account][data-account-id="${freelance.id}"]`);
  await other.getByTestId("account-toggle").click();
  await other.getByTestId("account-reconnect").click();
  await other.getByLabel(`Password for ${freelance.email}`).fill("not-it");
  await other.getByTestId("account-reconnect-submit").click();
  await expect(other.getByTestId("account-reconnect-error")).toContainText("That password didn’t work.");
});

test("Spanish: the line, the key and the panel speak it", async ({ app: page, server }) => {
  await server.backend.server.invoke("settings.update", { language: "es" }, ctx);
  await page.reload();
  await page.locator("[data-ready]").waitFor();
  const { freelance } = await accounts(server);
  await refuse(server, freelance);
  await expect(page.getByTestId("sign-in-title")).toHaveText(`${freelance.displayName} pide iniciar sesión`);
  await expect(notice(page)).toContainText("Inicia sesión y ponte al día");
  await expect(marker(page, freelance)).toHaveAccessibleName(`Inicia sesión para mantener ${freelance.email} al día`);
  await expect(page.getByTestId("sign-in-dismiss")).toHaveAccessibleName("Más tarde");
  await page.getByTestId("sign-in-open").click();
  await expect(popover(page)).toContainText(`Inicia sesión en ${freelance.displayName}`);
  await expect(popover(page).getByRole("button", { name: "Iniciar sesión" })).toBeVisible();
});
