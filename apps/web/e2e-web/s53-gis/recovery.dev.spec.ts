import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { loadLocale, t } from "@terno/i18n";

const email = "synthetic@example.test";
const longEmail = `${"other".repeat(12)}@example.test`;
const secret = "rawprovidersecret";

type Control = Window & { gis: { outcome: string; count: number; release?: () => void }; authCalls: number };
async function tabTo(page: Page, target: Locator) {
  for (let i = 0; i < 60; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

for (const language of ["en", "es"] as const) for (const theme of ["light", "dark"] as const) {
  test(`Web consent recovery ${language} ${theme}`, async ({ page, context }) => {
    await loadLocale(language);
    const unexpected: string[] = [];
    let identity = email;
    await context.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      if (url.origin === new URL(test.info().project.use.baseURL!).origin) return route.continue();
      const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };
      const endpoint = url.origin + url.pathname;
      const allowed = ["https://openidconnect.googleapis.com/v1/userinfo", "https://gmail.googleapis.com/gmail/v1/users/me/profile", "https://gmail.googleapis.com/gmail/v1/users/me/labels", "https://gmail.googleapis.com/gmail/v1/users/me/messages", "https://gmail.googleapis.com/gmail/v1/users/me/history"];
      if (allowed.includes(endpoint) && (method === "GET" || method === "OPTIONS")) {
        if (method === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
        const data = endpoint.endsWith("/userinfo") ? { sub: identity, email: identity, email_verified: true } : endpoint.endsWith("/profile") ? { emailAddress: identity, historyId: "10" } : endpoint.endsWith("/labels") ? { labels: [] } : endpoint.endsWith("/history") ? { historyId: "10" } : { messages: [] };
        return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify(data) });
      }
      // Fresh-account onboarding probes local AI; block these too, without contacting the host.
      if (method === "GET" && ["http://127.0.0.1:11434/api/tags", "http://127.0.0.1:11434/api/ps", "http://127.0.0.1:1234/api/v0/models"].includes(endpoint)) return route.abort();
      unexpected.push(`${method} ${endpoint}`);
      return route.abort();
    });
    await page.addInitScript(({ language, secret }) => {
      localStorage.setItem("terno:language", language);
      const w = window as Control;
      w.gis = { outcome: "valid", count: 0 };
      w.google = { accounts: { oauth2: { initTokenClient: (config) => ({ requestAccessToken: () => {
        w.gis.count++;
        w.gis.release = () => {
          const outcome = w.gis.outcome;
          if (outcome.startsWith("popup_")) config.error_callback?.({ type: outcome });
          else if (outcome === "valid") config.callback({ access_token: "synthetic-token", expires_in: 3600, scope: "openid email profile https://www.googleapis.com/auth/gmail.modify" });
          else config.callback({ error: outcome, error_description: secret });
        };
      } }) } } };
    }, { language, secret });
    await page.goto(`/?demo=0&mailbox=s53-${language}-${theme}`);
    await expect.poll(() => page.evaluate(() => window.__ternoWeb?.storage)).toBe("opfs-sqlite");
    await page.evaluate(async ({ language, theme }) => {
      await window.__ternoWeb!.client.call("settings.update", { language, theme, gmailClientId: "123-synthetic.apps.googleusercontent.com" });
    }, { language, theme });
    const account = await page.evaluate(() => window.__ternoWeb!.client.call("accounts.connectGmailToken", { accessToken: "synthetic-token", expiresIn: 3600 }));
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", new RegExp(`^${language}`));
    await expect(page.locator("html")).toHaveClass(theme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
    await expect(page.getByTestId("sign-in-notice")).toBeVisible({ timeout: 60_000 });
    await page.evaluate(() => {
      const w = window as Control, client = window.__ternoWeb!.client, call = client.call.bind(client);
      w.authCalls = 0;
      Object.defineProperty(client, "call", { value: (...args: Parameters<typeof call>) => { if (args[0] === "accounts.connectGmailToken") w.authCalls++; return call(...args); } });
    });
    const release = async (outcome: string) => page.evaluate((outcome) => { const w = window as Control; w.gis.outcome = outcome; w.gis.release!(); }, outcome);
    const attempt = async (button: Locator, error: Locator, outcome: string, key: Parameters<typeof t>[0]) => {
      await expect(button).not.toHaveAttribute("aria-disabled", "true");
      await button.focus();
      const count = await page.evaluate(() => (window as Control).gis.count);
      await page.keyboard.press("Enter");
      await expect.poll(() => page.evaluate(() => (window as Control).gis.count)).toBe(count + 1);
      await expect(button).toHaveAttribute("aria-disabled", "true");
      await page.keyboard.press("Enter"); await page.keyboard.press("Space");
      expect(await page.evaluate(() => (window as Control).gis.count)).toBe(count + 1);
      await release(outcome);
      await expect(error).toHaveText(t(key));
      await expect(button).toBeFocused();
      await expect(error).not.toContainText(secret);
      expect(await page.evaluate(() => (window as Control).authCalls)).toBe(0);
    };
    const trigger = page.getByTestId("sign-in-open");
    await trigger.focus(); await page.keyboard.press("Enter");
    const pop = page.getByTestId("sign-in-popover"), signIn = pop.getByTestId("sign-in-google");
    await expect(signIn).toHaveAccessibleName(t("signIn.google"));
    await tabTo(page, signIn);
    const outcomes = [["popup_closed", "web.google.popupClosed"], ["popup_failed_to_open", "web.google.popupBlocked"], [secret, "errors.google.unavailable"], ["access_denied", "errors.google.denied"], ["admin_policy_enforced", "errors.google.adminPolicy"]] as const;
    for (const [outcome, key] of outcomes) await attempt(signIn, pop.getByTestId("sign-in-error"), outcome, key);
    expect((await new AxeBuilder({ page }).include('[data-testid="sign-in-popover"]').analyze()).violations).toEqual([]);
    await page.screenshot({ path: `/tmp/terno-w12-s53/${language}-${theme}-sidebar.png` });
    await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
    const marker = page.getByTestId(`sign-in-marker-${account.id}`);
    await tabTo(page, marker); await page.keyboard.press("Enter");
    await attempt(signIn, pop.getByTestId("sign-in-error"), "popup_closed", "web.google.popupClosed");
    await page.keyboard.press("Escape"); await expect(marker).toBeFocused();
    await page.getByTestId("open-settings").click(); await page.getByTestId("tab-accounts").click();
    const settings = page.getByTestId("settings-dialog"), item = page.locator(`[data-testid="settings-account"][data-account-id="${account.id}"]`);
    await item.getByTestId("account-toggle").click();
    const reconnect = item.getByTestId("account-reconnect");
    await tabTo(page, reconnect);
    for (const [outcome, key] of outcomes) await attempt(reconnect, item.getByTestId("account-reconnect-error"), outcome, key);
    expect((await new AxeBuilder({ page }).include('[data-testid="settings-dialog"]').analyze()).violations).toEqual([]);
    await page.screenshot({ path: `/tmp/terno-w12-s53/${language}-${theme}-settings.png` });
    await page.keyboard.press("Escape"); await expect(settings).toHaveCount(0);
    const add = page.getByTestId("sidebar").getByRole("button", { name: t("sidebar.addAccount"), exact: true });
    await add.focus(); await page.keyboard.press("Enter");
    const dialog = page.getByTestId("add-account-dialog"), connect = dialog.getByTestId("connect-gmail");
    await tabTo(page, connect);
    for (const [outcome, key] of outcomes) await attempt(connect, dialog.getByTestId("add-account-error"), outcome, key);
    expect((await new AxeBuilder({ page }).include('[data-testid="add-account-dialog"]').analyze()).violations).toEqual([]);
    await page.screenshot({ path: `/tmp/terno-w12-s53/${language}-${theme}-add.png` });
    await page.keyboard.press("Escape"); await expect(add).toBeFocused();
    await trigger.click(); await expect(signIn).not.toHaveAttribute("aria-disabled", "true");
    identity = longEmail;
    await signIn.click(); await release("valid");
    await expect(pop.getByTestId("sign-in-error")).toHaveText(t("errors.googleConnectedOther", { got: longEmail, expected: email }));
    await page.screenshot({ path: `/tmp/terno-w12-s53/${language}-${theme}-long.png` });
    expect(await page.evaluate(() => (window as Control).authCalls)).toBe(1);
    identity = email;
    await signIn.click(); await release("valid");
    await expect(page.getByTestId("sign-in-notice")).toHaveCount(0);
    await expect(page.getByTestId(`nav-account-${account.id}`)).toBeFocused();
    expect(await page.evaluate(() => (window as Control).authCalls)).toBe(2);
    const accounts = await page.evaluate(() => window.__ternoWeb!.client.call("app.bootstrap", {}));
    expect(accounts.accounts.map(({ id, email }) => ({ id, email }))).toEqual([{ id: account.id, email }]);
    expect(unexpected).toEqual([]);
  });
}
