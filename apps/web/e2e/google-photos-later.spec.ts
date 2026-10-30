/** Plan 71: Photos from Google switch on with no Google window; they wait for the account's next sign-in. */
import AxeBuilder from "@axe-core/playwright";
import { expect, stabilize, test } from "./fixtures";

const ctx = { clientId: "setup", origin: "dev" as const };

for (const theme of ["light", "dark"] as const) {
  test(`switching photos on waits for the next sign-in, with "Sign in now" beside it (${theme})`, { tag: "@design" }, async ({ app: page, server }, testInfo) => {
    const gmail = (await server.backend.store.accounts.list()).find((a) => a.kind === "gmail")!;
    await server.backend.server.invoke("settings.update", { theme }, ctx);
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    // no Google: nothing may open a window or call Google
    const popups: string[] = [];
    page.on("popup", (p) => popups.push(p.url()));
    page.on("request", (r) => /google(apis)?\.com|accounts\.google/.test(r.url()) && popups.push(r.url()));
    await page.keyboard.press("Meta+Comma");
    await page.getByTestId("general-tab").waitFor();
    await page.getByTestId("tab-appearance").click();
    const row = page.getByTestId(`google-photos-${gmail.id}`);
    await row.scrollIntoViewIfNeeded();
    const sw = page.getByTestId(`google-photos-switch-${gmail.id}`);
    await expect(sw).not.toBeChecked();
    await expect(row).toContainText("Google asks you the next time this account signs in");
    await sw.click();
    await expect(sw).toBeChecked();
    await expect(row).toContainText(`On for ${gmail.email}: the photos come with this account’s next sign-in with Google`);
    await expect(page.getByTestId(`google-photos-now-${gmail.id}`)).toHaveText("Sign in now");
    expect(popups).toEqual([]);
    expect((await server.backend.server.invoke("settings.update", {}, ctx)).googlePhotosPending).toEqual([gmail.id]);
    await page.mouse.move(0, 0);
    await stabilize(page);
    await row.screenshot({ path: testInfo.outputPath(`pending-${theme}.png`) });
    const axe = await new AxeBuilder({ page }).include(`[data-testid=google-photos-${gmail.id}]`).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(axe.violations.map((v) => v.id)).toEqual([]);
    // off: it no longer waits
    await sw.click();
    await expect(sw).not.toBeChecked();
    await expect(page.getByTestId(`google-photos-now-${gmail.id}`)).toHaveCount(0);
    expect((await server.backend.server.invoke("settings.update", {}, ctx)).googlePhotosPending).toEqual([]);
  });
}
