import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { L, loadLocale, t } from "@terno/i18n";
import { createDemoProvider, demoRegistry, ProviderAuthError } from "@terno/mail";
import { startDevServer, type DevServer } from "../../backend-dev/src/server";

const ctx = { clientId: "synthetic", origin: "dev" as const };
const password = "synthetic-partial-password";
const detail = [
  "[AUTHENTICATIONFAILED] Synthetic provider refusal — 認証・é・🔑.",
  ...Array.from({ length: 12 }, (_, i) => `Diagnostic ${i + 1}: check the password or create an app password. Comprueba la contraseña de aplicación.`),
  `Correlation: ${"A9Z".repeat(500)}`,
  "END OF SYNTHETIC PROVIDER DETAIL",
].join("\n");
const copy = {
  en: { add: "Add account", title: "Add account", close: "Close", cancel: "Cancel", verify: "Verify and save", connect: "Connect account", password: "Password for", summary: "That password didn’t work. Check it, or create a new app password." },
  es: { add: "Añadir cuenta", title: "Añadir cuenta", close: "Cerrar", cancel: "Cancelar", verify: "Verificar y guardar", connect: "Conectar cuenta", password: "Contraseña de", summary: "Esa contraseña no funcionó. Revísala o crea una contraseña de aplicación nueva." },
};

async function tabTo(page: Page, target: Locator, key = "Tab") {
  for (let i = 0; i < 30; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press(key);
  }
  await expect(target).toBeFocused();
}
async function inViewport(page: Page, element: Locator) {
  const box = await element.boundingBox();
  expect(box).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
}

for (const design of ["macos", "lumen"] as const) for (const language of ["en", "es"] as const) for (const theme of ["light", "dark"] as const) for (const surface of ["settings", "add"] as const) {
  test(`long account refusal (${design}, ${language}, ${theme}, ${surface}) @design`, async ({ page }, info) => {
    await page.setViewportSize(surface === "add" ? { width: 420, height: 560 } : design === "lumen" ? { width: 800, height: 650 } : { width: 1280, height: 800 });
    const dir = mkdtempSync(join(tmpdir(), "terno-account-errors-"));
    let server: DevServer | undefined;
    const calls: string[] = [];
    const external: string[] = [];
    const verifications: string[] = [];
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (["127.0.0.1", "localhost"].includes(url.hostname)) await route.continue();
      else { external.push(url.origin); await route.abort(); }
    });
    try {
      server = await startDevServer({
        port: 0, dataDir: dir, token: "synthetic", threads: 400, accounts: 4, autoSync: false, iconTransport: null, openExternal: async (url) => { external.push(url); },
        providers: {
          ...demoRegistry,
          create(context) {
            const demo = createDemoProvider(context, 0);
            return { ...demo, async sync(sink) { calls.push("sync"); return demo.sync(sink); }, async execute(op) { calls.push(op.kind); return demo.execute(op); } };
          },
          async verifyImap(_config, value) {
            verifications.push(value);
            await held;
            throw new ProviderAuthError(L("errors.imap.loginFailed", { detail }));
          },
        },
      });
      await loadLocale(language);
      const backend = server.backend;
      const accounts = await backend.store.accounts.list();
      const account = accounts.find((a) => a.kind === "imap")!;
      await backend.store.accounts.setSyncState(account.id, { status: "error", authRequired: true });
      await backend.server.invoke("settings.update", { design, layout: "list", language, theme, senderIcons: false }, ctx);
      await page.addInitScript((language) => localStorage.setItem("terno:language", language), language);
      await page.goto(`/?backend=${encodeURIComponent(server.url)}&token=synthetic`);
      await page.locator("[data-ready]").waitFor();
      await expect(page.locator("html")).toHaveAttribute("data-design", design);
      await expect(page.locator("html")).toHaveAttribute("lang", new RegExp(`^${language}(?:-|$)`));
      await expect(page.locator("html")).toHaveClass(theme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
      await page.getByTestId("thread-row").first().waitFor();
      const list = page.locator('[data-keep-scroll="list"]');
      const listNode = await list.elementHandle();
      await expect.poll(() => list.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(300);
      await list.evaluate((el) => new Promise<void>((resolve) => {
        el.addEventListener("scroll", () => requestAnimationFrame(() => resolve()), { once: true });
        el.scrollTop = 300;
      }));
      await page.getByTestId("compose-button").click();
      await page.getByTestId("compose-to").fill("synthetic@example.test");
      await page.getByTestId("compose-to").press("Enter");
      await page.getByTestId("compose-subject").fill("Synthetic account recovery draft");
      const body = page.getByTestId("compose-body");
      await body.fill("Keep this authored message — mañana 認証.");
      await expect.poll(async () => (await backend.store.drafts.list())[0]?.body_text).toBe("Keep this authored message — mañana 認証.");
      const draft = (await backend.store.drafts.list())[0]!;
      const bodyNode = await body.elementHandle();
      const bodyHtml = await body.innerHTML();
      const scroll = await list.evaluate((el) => el.scrollTop);
      const trigger = surface === "settings" ? page.getByTestId("open-settings") : page.getByTestId("sidebar").getByRole("button", { name: copy[language].add, exact: true });
      await trigger.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByTestId(surface === "settings" ? "settings-dialog" : "add-account-dialog");
      await inViewport(page, dialog);
      await expect(dialog).toHaveAccessibleName(surface === "settings" ? (language === "en" ? "Settings" : "Ajustes") : copy[language].title);
      let field: Locator;
      let submit: Locator;
      if (surface === "settings") {
        await page.getByTestId("tab-accounts").click();
        const accountItem = page.locator(`[data-testid="settings-account"][data-account-id="${account.id}"]`);
        await accountItem.getByTestId("account-toggle").click();
        await accountItem.getByTestId("account-reconnect").click();
        field = accountItem.getByTestId("account-reconnect-password");
        submit = accountItem.getByTestId("account-reconnect-submit");
        await expect(field).toHaveAccessibleName(`${copy[language].password} ${account.email}`);
        await expect(submit).toHaveAccessibleName(copy[language].verify);
      } else {
        await expect(dialog).toHaveAccessibleName(copy[language].title);
        await page.getByTestId("imap-email").fill("synthetic@icloud.com");
        await expect(page.getByTestId("imap-host")).toHaveValue("imap.mail.me.com");
        await expect(page.getByTestId("smtp-host")).toHaveValue("smtp.mail.me.com");
        await dialog.locator("#acc-name").fill("Synthetic account author");
        field = page.getByTestId("imap-password");
        submit = page.getByTestId("imap-submit");
        await expect(submit).toHaveAccessibleName(copy[language].connect);
      }
      expect(calls).toEqual([]);
      expect(verifications).toEqual([]);
      await field.fill(password);
      const fieldNode = await field.elementHandle();
      await field.evaluate((el) => (el as HTMLInputElement).setSelectionRange(3, 9, "backward"));
      await page.keyboard.press("Enter");
      await expect.poll(() => verifications.length).toBe(1);
      await expect(field).toBeFocused();
      await inViewport(page, dialog);
      expect(await field.evaluate((el, saved) => el === saved, fieldNode)).toBe(true);
      expect(await field.evaluate((el) => { const input = el as HTMLInputElement; return [input.selectionStart, input.selectionEnd, input.selectionDirection]; })).toEqual([3, 9, "backward"]);
      release!();
      const error = dialog.getByRole("alert").filter({ hasText: "END OF SYNTHETIC PROVIDER DETAIL" });
      await expect(error).toBeVisible();
      await expect(error).toContainText(copy[language].summary);
      expect(await error.locator("p").last().textContent()).toBe(t("errors.imap.loginFailed", { detail }));
      expect(await error.ariaSnapshot()).toContain("END OF SYNTHETIC PROVIDER DETAIL");
      await expect(field).toHaveValue(password);
      await expect(field).toBeFocused();
      expect(await field.evaluate((el, saved) => el === saved, fieldNode)).toBe(true);
      expect(await field.evaluate((el) => { const input = el as HTMLInputElement; return [input.selectionStart, input.selectionEnd, input.selectionDirection]; })).toEqual([3, 9, "backward"]);
      const shots = process.env.ACCOUNT_ERROR_SHOTS;
      if (shots) await page.screenshot({ path: join(shots, `${design}-${language}-${theme}-${surface}-error.png`) });
      await inViewport(page, dialog);
      expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await error.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await error.locator("p").last().evaluate((el) => getComputedStyle(el).whiteSpace)).toBe("pre-wrap");
      // PageDown reads the complete detail without moving the underlying mail.
      const last = error.locator("p").last();
      const scrollport = surface === "add" ? dialog : dialog.locator("div.overflow-y-auto");
      const before = await scrollport.evaluate((el) => el.scrollTop);
      const endVisible = () => last.evaluate((el) => {
        const text = el.firstChild!;
        const range = document.createRange();
        range.setStart(text, text.textContent!.indexOf("END OF SYNTHETIC"));
        range.setEnd(text, text.textContent!.length);
        const rect = range.getBoundingClientRect();
        let port = el.parentElement!;
        while (getComputedStyle(port).overflowY !== "auto") port = port.parentElement!;
        const clip = port.getBoundingClientRect();
        return rect.top >= clip.top && rect.bottom <= clip.bottom;
      });
      for (let i = 0; i < 20 && !await endVisible(); i++) await page.keyboard.press("PageDown");
      await expect.poll(endVisible).toBe(true);
      expect(await scrollport.evaluate((el) => el.scrollTop)).toBeGreaterThan(before);
      expect(await list.evaluate((el) => el.scrollTop)).toBe(scroll);
      if (shots) await page.screenshot({ path: join(shots, `${design}-${language}-${theme}-${surface}-detail.png`) });
      await field.focus();
      await tabTo(page, submit);
      await inViewport(page, submit);
      await expect(page.locator("html")).toHaveAttribute("data-focus-ring", "");
      await page.keyboard.press("Enter");
      await expect.poll(() => verifications.length).toBe(2);
      await expect(error).toBeVisible();
      expect(verifications).toEqual([password, password]);
      await expect(submit).toBeFocused();
      const close = dialog.getByRole("button", { name: copy[language].close, exact: true });
      await tabTo(page, close);
      await inViewport(page, close);
      expect((await new AxeBuilder({ page }).include(`[data-testid="${surface === "settings" ? "settings-dialog" : "add-account-dialog"}"]`).analyze()).violations).toEqual([]);
      if (shots) await page.screenshot({ path: join(shots, `${design}-${language}-${theme}-${surface}-close.png`) });
      await page.keyboard.press(theme === "light" ? "Escape" : "Enter");
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      expect(await body.innerHTML()).toBe(bodyHtml);
      expect(await body.evaluate((el, saved) => el === saved, bodyNode)).toBe(true);
      await expect(page.getByTestId("compose-subject")).toHaveValue(draft.subject);
      expect(await backend.store.drafts.list()).toEqual([draft]);
      expect(await list.evaluate((el, saved) => el === saved, listNode)).toBe(true);
      expect(await list.evaluate((el) => el.scrollTop)).toBe(scroll);
      expect(await backend.store.accounts.list()).toHaveLength(accounts.length);
      expect(calls).toEqual([]);
      expect(external).toEqual([]);
      await info.attach("provider-actions", { body: JSON.stringify({ calls, verifications: verifications.length, external }), contentType: "application/json" });
    } finally {
      release?.();
      try { await server?.close(); } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });
}

for (const language of ["en", "es"] as const) for (const theme of ["light", "dark"] as const) {
  test(`account recovery controls (${language}, ${theme}) @design`, async ({ page }) => {
    const dir = mkdtempSync(join(tmpdir(), "terno-account-controls-"));
    const external: string[] = [];
    const googleCalls: (string | undefined)[] = [];
    const verified: string[] = [];
    let server: DevServer | undefined;
    let refuse = true;
    await loadLocale(language);
    await page.setViewportSize({ width: 800, height: 650 });
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (["127.0.0.1", "localhost"].includes(url.hostname)) await route.continue();
      else { external.push(url.origin); await route.abort(); }
    });
    try {
      server = await startDevServer({
        port: 0, dataDir: dir, token: "synthetic", threads: 40, accounts: 4, autoSync: false, iconTransport: null, openExternal: async (url) => { external.push(url); },
        providers: {
          ...demoRegistry,
          async verifyImap(_config, value) {
            verified.push(value);
            if (refuse) throw new ProviderAuthError(L("errors.imap.loginFailed", { detail: "Synthetic short refusal" }));
          },
          async connectGmail(options) {
            googleCalls.push(options.loginHint);
            throw new ProviderAuthError(L("errors.couldNotConnect", { detail }));
          },
        },
      });
      const backend = server.backend;
      const accounts = await backend.store.accounts.list();
      const imap = accounts.find((a) => a.kind === "imap")!;
      const gmail = accounts.find((a) => a.kind === "gmail")!;
      await backend.store.accounts.setSyncState(imap.id, { status: "error", authRequired: false, lastError: detail });
      await backend.server.invoke("settings.update", { language, theme, senderIcons: false, gmailClientId: "synthetic.apps.googleusercontent.com" }, ctx);
      await page.addInitScript((language) => localStorage.setItem("terno:language", language), language);
      await page.goto(`/?backend=${encodeURIComponent(server.url)}&token=synthetic`);
      await page.getByTestId("thread-row").first().waitFor();
      await expect(page.locator("html")).toHaveAttribute("lang", new RegExp(`^${language}(?:-|$)`));
      await page.getByTestId("open-settings").click();
      await page.getByTestId("tab-accounts").click();
      const settings = page.getByTestId("settings-dialog");
      const item = page.locator(`[data-testid="settings-account"][data-account-id="${imap.id}"]`);
      await item.getByTestId("account-toggle").click();
      const shots = process.env.ACCOUNT_ERROR_SHOTS;
      if (shots) await page.screenshot({ path: join(shots, `controls-${language}-${theme}-status-error.png`) });
      expect(await settings.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      const status = item.getByText(t("account.status.error", { error: detail }), { exact: true });
      await expect(status).toHaveCount(1);
      expect(await status.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      if (shots) await page.screenshot({ path: join(shots, `controls-${language}-${theme}-status-error.png`) });
      await item.getByTestId("account-reconnect").click();
      const field = item.getByTestId("account-reconnect-password");
      await field.fill(password);
      await field.press("Enter");
      await expect(item.getByTestId("account-reconnect-error")).toContainText("Synthetic short refusal");
      await expect(field).toBeFocused();
      const cancel = item.getByRole("button", { name: copy[language].cancel, exact: true });
      await tabTo(page, cancel);
      await page.keyboard.press("Enter");
      await expect(field).toHaveCount(0);
      await expect(item.getByTestId("account-reconnect-error")).toHaveCount(0);
      expect((await backend.store.accounts.get(imap.id))!.syncState.authRequired).toBeFalsy();
      // Reconnect publishes a fixed safe Google failure; it must not reintroduce raw provider details.
      const googleItem = page.locator(`[data-testid="settings-account"][data-account-id="${gmail.id}"]`);
      await googleItem.getByTestId("account-toggle").click();
      await googleItem.getByTestId("account-reconnect").click();
      await expect(googleItem.getByTestId("account-reconnect-error")).toHaveText(t("errors.google.invalidResponse"));
      expect(googleCalls).toEqual([gmail.email]);
      expect((await new AxeBuilder({ page }).include('[data-testid="settings-dialog"]').analyze()).violations).toEqual([]);
      await settings.getByRole("button", { name: copy[language].close, exact: true }).click();
      const trigger = page.getByTestId("sidebar").getByRole("button", { name: copy[language].add, exact: true });
      await trigger.click();
      const dialog = page.getByTestId("add-account-dialog");
      await page.getByTestId("imap-email").fill("synthetic@icloud.com");
      await dialog.locator("#acc-name").fill("Synthetic author");
      await page.getByTestId("imap-password").fill(password);
      const nameNode = await dialog.locator("#acc-name").elementHandle();
      await dialog.getByTestId("connect-gmail").focus();
      await page.keyboard.press("Enter");
      const error = dialog.getByRole("alert");
      await expect(error).toHaveText(t("errors.couldNotConnect", { detail }));
      await expect(dialog.getByTestId("connect-gmail")).toBeFocused();
      expect(await error.ariaSnapshot()).toContain("END OF SYNTHETIC PROVIDER DETAIL");
      expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await dialog.getByTestId("connect-gmail").focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => googleCalls.length).toBe(3);
      await expect(error).toHaveText(t("errors.couldNotConnect", { detail }));
      await expect(dialog.getByTestId("connect-gmail")).toBeFocused();
      await expect(dialog.locator("#acc-name")).toHaveValue("Synthetic author");
      await expect(page.getByTestId("imap-password")).toHaveValue(password);
      expect(await dialog.locator("#acc-name").evaluate((el, saved) => el === saved, nameNode)).toBe(true);
      expect((await new AxeBuilder({ page }).include('[data-testid="add-account-dialog"]').analyze()).violations).toEqual([]);
      if (shots) await page.screenshot({ path: join(shots, `controls-${language}-${theme}-google-error.png`) });
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await trigger.click();
      await expect(dialog.getByRole("alert")).toHaveCount(0);
      await expect(page.getByTestId("imap-email")).toHaveValue("");
      // Preserve the existing missing-client-ID navigation and snack.
      await backend.server.invoke("settings.update", { gmailClientId: "" }, ctx);
      await dialog.getByTestId("connect-gmail").click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId("tab-accounts")).toHaveAttribute("aria-selected", "true");
      await expect(page.getByTestId("snack-message")).toHaveText(t("errors.gmailClientIdMissing"));
      expect(googleCalls).toHaveLength(3);
      await page.keyboard.press("Escape");
      await trigger.click();
      // The normal preset/required-field/success flow still uses the same consumer controls.
      refuse = false;
      await page.getByTestId("imap-email").fill("synthetic@icloud.com");
      await expect(page.getByTestId("imap-host")).toHaveValue("imap.mail.me.com");
      await expect(page.getByTestId("smtp-host")).toHaveValue("smtp.mail.me.com");
      await page.getByTestId("imap-submit").click();
      await expect(dialog).toBeVisible();
      expect(verified).toEqual([password]);
      await page.getByTestId("imap-password").fill(password);
      await page.getByTestId("imap-submit").click();
      await expect(dialog).toHaveCount(0);
      expect(verified).toEqual([password, password]);
      await expect.poll(async () => (await backend.store.accounts.list()).map((a) => a.email)).toContain("synthetic@icloud.com");
      expect(external).toEqual([]);
    } finally {
      try { await server?.close(); } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });
}
