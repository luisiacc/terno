import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { loadLocale, t } from "@terno/i18n";

const email = "authored@example.test";
const bodyText = "The exact authored recovery message.";
const bytes = Buffer.from([0, 255, 128, 13, 10, 42, 17, 0, 99]);

declare global {
  interface Window { w12: { outcome: string; count: number; release?: () => void; calls: number; accountIds: (number | undefined)[] } }
}

for (const language of ["en", "es"] as const) for (const theme of ["light", "dark"] as const) for (const placement of ["selection", "list"] as const) {
  test(`authored Web recovery ${language} ${theme} ${placement}`, async ({ page, context }) => {
    await loadLocale(language);
    const unexpected: string[] = [];
    await context.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      if (url.origin === new URL(test.info().project.use.baseURL!).origin) return route.continue();
      const endpoint = url.origin + url.pathname;
      const allowed = ["https://openidconnect.googleapis.com/v1/userinfo", "https://gmail.googleapis.com/gmail/v1/users/me/profile", "https://gmail.googleapis.com/gmail/v1/users/me/labels", "https://gmail.googleapis.com/gmail/v1/users/me/messages", "https://gmail.googleapis.com/gmail/v1/users/me/history"];
      const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };
      if (allowed.includes(endpoint) && (method === "GET" || method === "OPTIONS")) {
        if (method === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
        const data = endpoint.endsWith("/userinfo") ? { sub: email, email, email_verified: true } : endpoint.endsWith("/profile") ? { emailAddress: email, historyId: "10" } : endpoint.endsWith("/labels") ? { labels: [] } : endpoint.endsWith("/history") ? { historyId: "10" } : { messages: [] };
        return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify(data) });
      }
      if (method === "GET" && ["http://127.0.0.1:11434/api/tags", "http://127.0.0.1:11434/api/ps", "http://127.0.0.1:1234/api/v0/models"].includes(endpoint)) return route.abort();
      unexpected.push(`${method} ${endpoint}`); return route.abort();
    });
    await page.addInitScript(({ language }) => {
      localStorage.setItem("terno:language", language);
      window.w12 = { outcome: "valid", count: 0, calls: 0, accountIds: [] };
      window.google = { accounts: { oauth2: { initTokenClient: (config) => ({ requestAccessToken: () => {
        window.w12.count++;
        window.w12.release = () => {
          if (window.w12.outcome === "popup_closed") config.error_callback?.({ type: "popup_closed" });
          else if (window.w12.outcome === "access_denied") config.callback({ error: "access_denied" });
          else config.callback({ access_token: "synthetic-token", expires_in: 3600, scope: "openid email profile https://www.googleapis.com/auth/gmail.modify" });
        };
      } }) } } };
    }, { language });
    await page.goto(`/?demo=200&mailbox=w12-authored-${language}-${theme}-${placement}`);
    await expect.poll(() => page.evaluate(() => window.__ternoWeb?.storage)).toBe("opfs-sqlite");
    await page.evaluate(async ({ language, theme }) => window.__ternoWeb!.client.call("settings.update", { language, theme, gmailClientId: "123-synthetic.apps.googleusercontent.com" }), { language, theme });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", new RegExp(`^${language}`));
    await expect.poll(() => page.evaluate(() => window.__ternoWeb?.storage)).toBe("opfs-sqlite");
    const account = await page.evaluate(() => window.__ternoWeb!.client.call("accounts.connectGmailToken", { accessToken: "synthetic-token", expiresIn: 3600 }));
    await page.getByTestId("compose-button").click();
    await page.getByTestId("compose-from").click();
    await page.getByRole("option").filter({ hasText: email }).click();
    await page.getByTestId("compose-to").fill("recipient@example.test"); await page.getByTestId("compose-to").press("Enter");
    await page.getByTestId("compose-subject").fill("Browser recovery subject");
    await page.getByTestId("attachment-input").setInputFiles({ name: "recovery.bin", mimeType: "application/octet-stream", buffer: bytes });
    await page.getByTestId("compose-body").fill(bodyText);
    await expect.poll(async () => (await page.evaluate(() => window.__ternoWeb!.client.call("drafts.list", {})))[0]?.bodyText).toBe(bodyText);
    await expect(page.getByTestId("draft-status")).toHaveText(t("compose.status.saved"));
    const initial = (await page.evaluate(() => window.__ternoWeb!.client.call("drafts.list", {})))[0]!;
    expect(initial.accountId).toBe(account.id); expect(initial.attachments).toHaveLength(1);
    expect(initial.subject).toBe("Browser recovery subject");
    expect(initial.to).toEqual([expect.objectContaining({ email: "recipient@example.test" })]);
    const readBytes = () => page.evaluate((d) => window.__ternoWeb!.client.call("attachments.read", { accountId: d.accountId, assetId: d.attachments![0]!.assetId, index: 0 }), initial);
    expect(await readBytes()).toEqual({ dataBase64: bytes.toString("base64") });
    await page.reload();
    await expect(page.getByTestId("sign-in-notice")).toBeVisible({ timeout: 60_000 });
    expect((await page.evaluate(() => window.__ternoWeb!.client.call("drafts.list", {})))[0]).toEqual(initial);
    await page.getByTestId("strip-item").first().click();
    const body = page.getByTestId("compose-body"); await expect(body).toHaveText(bodyText);
    await body.click(); await body.press("End"); await body.press("ArrowLeft");
    for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowLeft");
    const selection = () => page.evaluate(() => ({ anchor: getSelection()!.anchorOffset, focus: getSelection()!.focusOffset, text: getSelection()!.toString() }));
    const nodes = await page.evaluateHandle(() => ({ body: document.querySelector('[data-testid="compose-body"]'), anchor: getSelection()!.anchorNode, focus: getSelection()!.focusNode }));
    const before = await selection(); expect(before.anchor).toBeGreaterThan(before.focus); expect(before.text).toHaveLength(5);
    await page.evaluate(() => { const client = window.__ternoWeb!.client, call = client.call.bind(client); Object.defineProperty(client, "call", { value: (...args: Parameters<typeof call>) => { if (args[0] === "accounts.connectGmailToken") { window.w12.calls++; window.w12.accountIds.push((args[1] as { accountId?: number }).accountId); } return call(...args); } }); });
    const identities = (await page.evaluate(() => window.__ternoWeb!.client.call("app.bootstrap", {}))).accounts.map(({ id, email }) => ({ id, email }));
    await page.getByTestId("sign-in-open").click();
    const pop = page.getByTestId("sign-in-popover"), signIn = pop.getByTestId("sign-in-google");
    for (const [outcome, key] of [["popup_closed", "web.google.popupClosed"], ["access_denied", "errors.google.denied"]] as const) {
      await page.evaluate((outcome) => { window.w12.outcome = outcome; }, outcome);
      await signIn.click(); await expect(signIn).toHaveAttribute("aria-disabled", "true");
      await page.evaluate(() => window.w12.release!());
      await expect(pop.getByTestId("sign-in-error")).toHaveText(t(key));
      expect(await page.evaluate(() => window.w12.calls)).toBe(0);
      expect(await selection()).toEqual(before);
      expect((await page.evaluate(() => window.__ternoWeb!.client.call("drafts.list", {})))[0]).toEqual(initial);
      expect(await readBytes()).toEqual({ dataBase64: bytes.toString("base64") });
    }
    await page.evaluate(() => { window.w12.outcome = "valid"; });
    await signIn.click();
    const list = page.locator('[data-keep-scroll="list"]');
    let listBefore: { scroll: number; cursor: string | null; anchor: string | undefined } | undefined;
    if (placement === "list") {
      await list.hover(); await page.mouse.wheel(0, 700);
      await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      await page.getByTestId("strip-item").first().focus(); await page.keyboard.press("Tab");
      await expect(list).toBeFocused();
      listBefore = await list.evaluate((el) => ({ scroll: el.scrollTop, cursor: el.getAttribute("aria-activedescendant"), anchor: [...el.querySelectorAll<HTMLElement>('[data-testid="thread-row"]')].find((row) => row.getBoundingClientRect().bottom > el.getBoundingClientRect().top)?.dataset.threadId }));
      expect(listBefore.cursor).toBeTruthy(); expect(listBefore.anchor).toBeTruthy();
    }
    await page.evaluate(() => window.w12.release!());
    await expect(page.getByTestId("sign-in-notice")).toHaveCount(0);
    expect(await page.evaluate(() => window.w12.calls)).toBe(1);
    expect(await page.evaluate(() => window.w12.accountIds)).toEqual([account.id]);
    const accounts = (await page.evaluate(() => window.__ternoWeb!.client.call("app.bootstrap", {}))).accounts;
    expect(accounts.map(({ id, email }) => ({ id, email }))).toEqual(identities);
    expect(accounts.find((a) => a.id === account.id)?.syncState.authRequired).not.toBe(true);
    if (placement === "selection") expect(await selection()).toEqual(before);
    else {
      await expect(list).toBeFocused();
      expect(await list.evaluate((el) => ({ scroll: el.scrollTop, cursor: el.getAttribute("aria-activedescendant"), anchor: [...el.querySelectorAll<HTMLElement>('[data-testid="thread-row"]')].find((row) => row.getBoundingClientRect().bottom > el.getBoundingClientRect().top)?.dataset.threadId }))).toEqual(listBefore);
      await expect(list).toHaveCSS("outline-style", "none"); await expect(list).toHaveCSS("box-shadow", "none");
    }
    expect(await page.evaluate((old) => old.body === document.querySelector('[data-testid="compose-body"]'), nodes)).toBe(true);
    if (placement === "selection") expect(await page.evaluate((old) => old.anchor === getSelection()!.anchorNode && old.focus === getSelection()!.focusNode, nodes)).toBe(true);
    await nodes.dispose();
    expect((await new AxeBuilder({ page }).include('[data-testid="composer"]').include('[data-testid="thread-list"]').analyze()).violations).toEqual([]);
    await page.screenshot({ path: `/tmp/terno-w12-browser-authored/${language}-${theme}-${placement}.png` });
    if (placement === "list") {
      await page.keyboard.press("ArrowDown");
      expect(await list.getAttribute("aria-activedescendant")).not.toBe(listBefore!.cursor);
      expect((await page.evaluate(() => window.__ternoWeb!.client.call("drafts.list", {})))[0]).toEqual(initial);
      await page.reload(); await expect.poll(() => page.evaluate(() => window.__ternoWeb?.storage)).toBe("opfs-sqlite");
      expect((await page.evaluate(() => window.__ternoWeb!.client.call("drafts.list", {})))[0]).toEqual(initial);
      expect(await readBytes()).toEqual({ dataBase64: bytes.toString("base64") });
      expect(unexpected).toEqual([]);
      return;
    }
    await body.focus();
    await page.keyboard.type("X");
    const edited = bodyText.slice(0, -6) + "X" + bodyText.slice(-1);
    await expect(body).toHaveText(edited);
    await expect.poll(async () => (await page.evaluate(() => window.__ternoWeb!.client.call("drafts.list", {})))[0]?.bodyText).toBe(edited);
    await expect(page.getByTestId("draft-status")).toHaveText(t("compose.status.saved"));
    const durable = (await page.evaluate(() => window.__ternoWeb!.client.call("drafts.list", {})))[0]!;
    expect({ ...durable, bodyText: initial.bodyText, bodyHtml: initial.bodyHtml, revision: initial.revision, updatedAt: initial.updatedAt }).toEqual(initial);
    expect(initial.bodyHtml).toContain(bodyText);
    expect(durable.bodyHtml).toBe(initial.bodyHtml.replace(bodyText, edited));
    expect(durable.revision).toBe(initial.revision + 1);
    expect(await readBytes()).toEqual({ dataBase64: bytes.toString("base64") });
    await page.reload(); await expect.poll(() => page.evaluate(() => window.__ternoWeb?.storage)).toBe("opfs-sqlite");
    expect((await page.evaluate(() => window.__ternoWeb!.client.call("drafts.list", {})))[0]).toEqual(durable);
    expect(await readBytes()).toEqual({ dataBase64: bytes.toString("base64") });
    await page.getByTestId("strip-item").first().click(); await expect(page.getByTestId("compose-body")).toHaveText(edited);
    expect(unexpected).toEqual([]);
  });
}
