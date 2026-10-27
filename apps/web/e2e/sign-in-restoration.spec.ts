import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, rows, test } from "./fixtures";

test.use({ backendOptions: { network: true } });
const ctx = { clientId: "setup", origin: "dev" as const };

for (const theme of ["light", "dark"] as const) {
  test(`deferred popup restoration preserves the password and later focus (${theme}) @design`, async ({ app: page, server }, info) => {
    await server.backend.server.invoke("settings.update", { theme, gmailClientId: "e2e.apps.googleusercontent.com" }, ctx);
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await rows(page).first().waitFor();
    const accounts = await server.backend.store.accounts.list();
    const google = accounts.find((a) => a.kind === "gmail")!;
    const imap = accounts.find((a) => a.kind === "imap")!;
    server.net.refused.add(google.email); server.net.refused.add(imap.email);
    await server.backend.syncAccount(google.id); await server.backend.syncAccount(imap.id);
    await page.getByTestId("sign-in-open").click();
    const popup = page.getByTestId("sign-in-popover");
    await expect(popup.getByTestId("sign-in-section")).toHaveCount(2);
    server.net.refused.delete(google.email);
    await server.backend.syncAccount(google.id);
    const field = popup.getByLabel(`Password for ${imap.email}`);
    await expect(field).toBeVisible();
    await field.fill("synthetic-partial");
    const original = await field.elementHandle();
    expect(original).not.toBeNull();
    await field.evaluate((node) => (node as HTMLInputElement).setSelectionRange(2, 7, "backward"));
    await expect(field).toBeFocused();
    server.net.refused.add(google.email);
    await server.backend.syncAccount(google.id);
    await expect(popup.getByTestId("sign-in-section")).toHaveCount(2);
    // Check after the deferred restoration window, as well as immediately after account changes.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("synthetic-partial");
    expect(await field.evaluate((node, saved) => node === saved, original)).toBe(true);
    expect(await field.evaluate((node) => {
      const input = node as HTMLInputElement;
      return [input.selectionStart, input.selectionEnd, input.selectionDirection];
    })).toEqual([2, 7, "backward"]);
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations.map((v) => v.id)).toEqual([]);
    const shots = process.env.SIGN_IN_RESTORATION_SHOTS;
    if (shots) await page.screenshot({ path: join(shots, `${info.project.name}-${theme}-surviving-password.png`) });
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    await expect(page.getByTestId("sign-in-open")).toBeFocused();
  });
}
