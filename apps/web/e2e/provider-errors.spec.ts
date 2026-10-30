import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { L } from "@terno/i18n";
import { createDemoProvider, demoRegistry, ProviderAuthError } from "@terno/mail";
import { startDevServer, type DevServer } from "../../backend-dev/src/server";

const ctx = { clientId: "synthetic", origin: "dev" as const };
const password = "synthetic-partial-password";
const detail = [
  "[AUTHENTICATIONFAILED] Synthetic provider refused this password — 認証・é・🔑.",
  ...Array.from({ length: 12 }, (_, i) => `Diagnostic ${i + 1}: synthetic mailbox access refused; check the password or create an app password. Comprueba la contraseña de aplicación.`),
  `Correlation: ${"A9Z".repeat(500)}`,
  "END OF SYNTHETIC PROVIDER DETAIL",
].join("\n");
const copy = {
  en: { title: "Sign in to Freelance", submit: "Sign in", later: "Later", password: "Password for", summary: "That password didn’t work. Check it, or create a new app password." },
  es: { title: "Inicia sesión en Freelance", submit: "Iniciar sesión", later: "Más tarde", password: "Contraseña de", summary: "Esa contraseña no funcionó. Revísala o crea una contraseña de aplicación nueva." },
};

async function tabTo(page: Page, target: Locator) {
  for (let i = 0; i < 12; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press("Tab");
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

for (const design of ["macos", "lumen"] as const) for (const language of ["en", "es"] as const) for (const theme of ["light", "dark"] as const) for (const entry of ["notice", "marker"] as const) {
  test(`long provider refusal (${design}, ${language}, ${theme}, ${entry}) @design`, async ({ page }, info) => {
    await page.setViewportSize(design === "lumen" ? { width: 420, height: 560 } : { width: 1280, height: 800 });
    const dir = mkdtempSync(join(tmpdir(), "terno-provider-errors-"));
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
      const backend = server.backend;
      const account = (await backend.store.accounts.list()).find((a) => a.kind === "imap")!;
      await backend.store.accounts.setSyncState(account.id, { status: "error", authRequired: true });
      await backend.server.invoke("settings.update", { design, layout: design === "lumen" ? "list" : "split", language, theme, senderIcons: false }, ctx);
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
      await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      await page.getByTestId("compose-button").click();
      await page.getByTestId("compose-to").fill("synthetic@example.test");
      await page.getByTestId("compose-to").press("Enter");
      await page.getByTestId("compose-subject").fill("Synthetic recovery draft");
      const body = page.getByTestId("compose-body");
      await body.fill("Keep this authored message — mañana 認証.");
      await expect.poll(async () => (await backend.store.drafts.list())[0]?.body_text).toBe("Keep this authored message — mañana 認証.");
      const draft = (await backend.store.drafts.list())[0]!;
      const bodyNode = await body.elementHandle();
      const bodyHtml = await body.innerHTML();
      const scroll = await list.evaluate((el) => el.scrollTop);
      const trigger = entry === "notice" ? page.getByTestId("sign-in-open") : page.getByTestId(`sign-in-marker-${account.id}`);
      await expect(trigger).toHaveAccessibleName(entry === "notice" ? (language === "en" ? /needs a sign-in/ : /pide iniciar sesión/) : (language === "en" ? /Sign in to keep/ : /Inicia sesión para mantener/));
      expect(calls).toEqual([]);
      expect(verifications).toEqual([]);
      await trigger.focus();
      await page.keyboard.press("Enter");
      const popup = page.getByTestId("sign-in-popover");
      const field = popup.getByTestId("sign-in-password");
      const submit = popup.getByRole("button", { name: copy[language].submit, exact: true });
      const later = popup.getByRole("button", { name: copy[language].later, exact: true });
      await expect(popup).toHaveAccessibleName(copy[language].title);
      await expect(popup).toHaveAccessibleDescription(language === "en" ? /Your mail stays here/ : /Tu correo sigue aquí/);
      await expect(field).toHaveAccessibleName(`${copy[language].password} ${account.email}`);
      await expect(field).toBeFocused();
      await field.fill(password);
      const fieldNode = await field.elementHandle();
      await field.evaluate((el) => (el as HTMLInputElement).setSelectionRange(3, 9, "backward"));
      await page.keyboard.press("Enter");
      await expect.poll(() => verifications.length).toBe(1);
      release!();
      const error = popup.getByRole("alert");
      await expect(error).toContainText(copy[language].summary);
      expect(await error.textContent()).toContain(detail);
      await expect(field).toHaveAttribute("aria-invalid", "true");
      await expect(field).toHaveValue(password);
      await expect(field).toBeFocused();
      expect(await field.evaluate((el, saved) => el === saved, fieldNode)).toBe(true);
      expect(await field.evaluate((el) => { const input = el as HTMLInputElement; return [input.selectionStart, input.selectionEnd, input.selectionDirection]; })).toEqual([3, 9, "backward"]);
      const shots = process.env.PROVIDER_ERROR_SHOTS;
      if (shots) await page.screenshot({ path: join(shots, `${design}-${language}-${theme}-${entry}-error.png`) });
      await inViewport(page, popup);
      expect(await popup.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await error.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await error.ariaSnapshot()).toContain("END OF SYNTHETIC PROVIDER DETAIL");
      expect(await error.locator("p").last().evaluate((el) => getComputedStyle(el).whiteSpace)).toBe("pre-wrap");
      await page.keyboard.press("Tab");
      await expect(submit).toBeFocused();
      await inViewport(page, submit);
      await expect(page.locator("html")).toHaveAttribute("data-focus-ring", "");
      await page.keyboard.press("Enter");
      await expect.poll(() => verifications.length).toBe(2);
      await expect(error).toContainText(copy[language].summary);
      expect(verifications).toEqual([password, password]);
      const popupTop = await popup.evaluate((el) => el.scrollTop);
      await page.keyboard.press("PageDown");
      await expect.poll(() => popup.evaluate((el) => el.scrollTop)).toBeGreaterThan(popupTop);
      expect(await list.evaluate((el) => el.scrollTop)).toBe(scroll);
      await tabTo(page, later);
      await inViewport(page, later);
      expect(await error.locator("p").last().evaluate((el) => {
        const text = el.firstChild!;
        const range = document.createRange();
        range.setStart(text, text.textContent!.indexOf("END OF SYNTHETIC"));
        range.setEnd(text, text.textContent!.length);
        const end = range.getBoundingClientRect();
        const popup = el.closest('[data-testid="sign-in-popover"]')!.getBoundingClientRect();
        return end.top >= popup.top && end.bottom <= popup.bottom;
      })).toBe(true);
      if (shots) await page.screenshot({ path: join(shots, `${design}-${language}-${theme}-${entry}-later.png`) });
      expect((await new AxeBuilder({ page }).include('[data-testid="sign-in-popover"]').analyze()).violations).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(popup).toHaveCount(0);
      await expect(trigger).toBeFocused();
      // Reopening starts clean, while the real account still needs its sign-in.
      await page.keyboard.press("Enter");
      await expect(popup.getByRole("alert")).toHaveCount(0);
      await tabTo(page, later);
      await page.keyboard.press("Enter");
      await expect(popup).toHaveCount(0);
      await expect(page.getByTestId(`sign-in-marker-${account.id}`)).toBeVisible();
      expect((await backend.store.accounts.get(account.id))!.syncState.authRequired).toBe(true);
      expect(await body.innerHTML()).toBe(bodyHtml);
      expect(await body.evaluate((el, saved) => el === saved, bodyNode)).toBe(true);
      await expect(page.getByTestId("compose-subject")).toHaveValue(draft.subject);
      expect(await backend.store.drafts.list()).toEqual([draft]);
      expect(await list.evaluate((el, saved) => el === saved, listNode)).toBe(true);
      expect(await list.evaluate((el) => el.scrollTop)).toBe(scroll);
      expect(calls).toEqual([]);
      expect(external).toEqual([]);
      await info.attach("provider-actions", { body: JSON.stringify({ calls, verifications: verifications.length, external }), contentType: "application/json" });
    } finally {
      release?.();
      try { await server?.close(); } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });
}
