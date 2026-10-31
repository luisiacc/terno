import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { loadLocale, t } from "@terno/i18n";

declare global {
  interface Window { b41: { popups: number; release?: () => void; rpc: number } }
}

for (const language of ["en", "es"] as const) for (const theme of ["light", "dark"] as const) {
  test(`Add Account quota recovery ${language} ${theme}`, async ({ page, context }) => {
    await loadLocale(language);
    const unexpected: string[] = [], provider: string[] = [];
    let quota = false;
    const profile = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
    const userinfo = "https://openidconnect.googleapis.com/v1/userinfo";
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url()), method = route.request().method();
      if (url.origin === new URL(test.info().project.use.baseURL!).origin) return route.continue();
      const endpoint = url.origin + url.pathname;
      const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, OPTIONS" };
      if ([profile, userinfo, "https://gmail.googleapis.com/gmail/v1/users/me/labels", "https://gmail.googleapis.com/gmail/v1/users/me/messages", "https://gmail.googleapis.com/gmail/v1/users/me/history"].includes(endpoint) && ["GET", "OPTIONS"].includes(method)) {
        if (method === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
        provider.push(endpoint);
        if (quota && endpoint === profile) return route.fulfill({ status: 429, headers: { ...cors, "retry-after": "120" }, body: '{"error":{"message":"PRIVATE_provider_marker"}}' });
        const email = "b41@example.test";
        return route.fulfill({ headers: cors, contentType: "application/json", body: JSON.stringify(endpoint === profile ? { emailAddress: email, historyId: "10" } : endpoint === userinfo ? { email, sub: "b41-subject", email_verified: true } : endpoint.endsWith("/labels") ? { labels: [] } : endpoint.endsWith("/history") ? { historyId: "10" } : { messages: [] }) });
      }
      if (method === "GET" && ["http://127.0.0.1:11434/api/tags", "http://127.0.0.1:11434/api/ps", "http://127.0.0.1:1234/api/v0/models"].includes(endpoint)) return route.abort();
      unexpected.push(`${method} ${endpoint}`); return route.abort();
    });
    await page.addInitScript((language) => {
      localStorage.setItem("terno:language", language);
      window.b41 = { popups: 0, rpc: 0 };
      window.google = { accounts: { oauth2: { initTokenClient: (config) => ({ requestAccessToken: () => {
        window.b41.popups++;
        window.b41.release = () => config.callback({ access_token: "synthetic-b41-token", expires_in: 3600, scope: "openid email profile https://www.googleapis.com/auth/gmail.modify" });
      } }) } } };
    }, language);
    await page.goto(`/?demo=0&mailbox=b41-${language}-${theme}`);
    await expect.poll(() => page.evaluate(() => window.__ternoWeb?.storage)).toBe("opfs-sqlite");
    const account = await page.evaluate(async ({ language, theme }) => {
      const client = window.__ternoWeb!.client;
      await client.call("settings.update", { language, theme, gmailClientId: "123-synthetic.apps.googleusercontent.com" });
      return client.call("accounts.connectGmailToken", { accessToken: "synthetic-seed", expiresIn: 3600 });
    }, { language, theme });
    await page.reload();
    await expect(page.getByTestId("sign-in-notice")).toBeVisible();
    const before = await page.evaluate(async (id) => {
      const client = window.__ternoWeb!.client;
      const draft = await client.call("drafts.save", { accountId: id, subject: "B41 preserved", bodyText: "Exact existing draft", bodyHtml: "<p>Exact existing draft</p>" });
      const app = await client.call("app.bootstrap", {});
      const call = client.call.bind(client);
      Object.defineProperty(client, "call", { value: (...args: Parameters<typeof call>) => { if (args[0] === "accounts.connectGmailToken") window.b41.rpc++; return call(...args); } });
      return { draft, accounts: app.accounts, owner: app.owner, settings: app.settings };
    }, account.id);
    await expect(page.locator("html")).toHaveAttribute("lang", new RegExp(`^${language}`));
    await expect(page.locator("html")).toHaveClass(theme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
    const add = page.getByTestId("sidebar").getByRole("button", { name: t("sidebar.addAccount"), exact: true });
    await add.focus(); await page.keyboard.press("Enter");
    const dialog = page.getByTestId("add-account-dialog"), button = dialog.getByTestId("connect-gmail");
    for (let i = 0; i < 30 && !(await button.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
    await expect(button).toBeFocused();
    quota = true;
    const start = provider.length;
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => window.b41.popups)).toBe(1);
    await expect(button).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Enter"); await page.keyboard.press("Space");
    expect(await page.evaluate(() => window.b41.popups)).toBe(1);
    await page.evaluate(() => window.b41.release!());
    const error = dialog.getByTestId("add-account-error");
    await expect(error).toHaveText(t("errors.google.quota"));
    await expect(button).not.toHaveAttribute("aria-disabled", "true");
    await expect(button).toBeFocused();
    expect(provider.slice(start)).toEqual([profile]);
    expect(await page.evaluate(() => window.b41.rpc)).toBe(1);
    await page.screenshot({ path: `/tmp/terno-w05-b41/production/${language}-${theme}-first-quota.png` });
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => window.b41.popups)).toBe(2);
    await page.evaluate(() => window.b41.release!());
    await expect(error).toHaveText(t("errors.gmail.paused"));
    await expect(button).not.toHaveAttribute("aria-disabled", "true");
    expect(provider.slice(start)).toEqual([profile]);
    expect(await page.evaluate(() => window.b41.rpc)).toBe(2);
    await expect(error).not.toContainText("PRIVATE_provider_marker");
    expect((await new AxeBuilder({ page }).include('[data-testid="add-account-dialog"]').analyze()).violations).toEqual([]);
    await page.screenshot({ path: `/tmp/terno-w05-b41/production/${language}-${theme}-quota.png` });
    await page.keyboard.press("Escape"); await expect(add).toBeFocused();
    const after = await page.evaluate(async () => ({ app: await window.__ternoWeb!.client.call("app.bootstrap", {}), drafts: await window.__ternoWeb!.client.call("drafts.list", {}) }));
    expect(after.app.accounts).toEqual(before.accounts); expect(after.app.owner).toEqual(before.owner); expect(after.app.settings).toEqual(before.settings);
    expect(after.drafts).toEqual([before.draft]);
    expect(unexpected).toEqual([]);
  });
}
