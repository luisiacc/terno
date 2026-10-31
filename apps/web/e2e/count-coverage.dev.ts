import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createDemoProvider, demoRegistry, type ProviderRegistry } from "@terno/mail";
import { sqlDb, startDevServer } from "../../backend-dev/src/server";
import { msg } from "../../../packages/store/src/conformance/fixtures";
import { E2E_NOW } from "./constants";

// the coverage disclaimer the counts used to carry (removed: it told the user nothing)
const gone = { en: "Coverage may be incomplete", es: "La cobertura puede estar incompleta" };
// a category's row says its own numbers: unread, then suggestions (the ✨ badge)
const categoryCopy = {
  en: { both: "11 unread, 4 suggested for this category", one: "1 suggested for this category" },
  es: { both: "11 sin leer, 4 sugerencias para esta categoría", one: "1 sugerencia para esta categoría" },
};
for (const language of ["en", "es"] as const) for (const theme of ["light", "dark"] as const) {
  test(`count coverage ${language} ${theme}`, async ({ page }) => {
    const dir = mkdtempSync(join(tmpdir(), "terno-count-coverage-"));
    const calls: string[] = [];
    const providers: ProviderRegistry = { ...demoRegistry, create(ctx) { const demo = createDemoProvider({ ...ctx, fetch: async () => { calls.push("fetch"); throw new Error("unexpected provider fetch"); }, google: ctx.google ? { ...ctx.google, request: async () => { calls.push("google.request"); throw new Error("unexpected managed Google request"); } } : undefined }, 0); return { ...demo, async sync(sink) { calls.push("sync"); return demo.sync(sink); }, async execute(op) { calls.push("execute"); return demo.execute(op); } }; } };
    const server = await startDevServer({ port: 0, dataDir: dir, token: "synthetic", fresh: true, threads: 180, accounts: 2, autoSync: false, providers, iconTransport: null, now: () => E2E_NOW });
    const external: string[] = [];
    await page.route("**/*", async (route) => { const url = new URL(route.request().url()); if (url.hostname === "127.0.0.1") await route.continue(); else { external.push(url.origin); await route.abort(); } });
    try {
      await server.backend.server.invoke("settings.update", { language, theme, senderIcons: false }, { clientId: "setup", origin: "dev" });
      const account = sqlDb(server.backend.store).get<{ id: number }>("SELECT id FROM accounts WHERE display_name = ?", "Acme Studio")!.id;
      const original = (await server.backend.store.folders.list()).filter((f) => f.accountId === account).map(({ key, path, selectable }) => ({ key, path, selectable }));
      await server.backend.store.folders.replace(account, [...original, { key: "Label_empty", path: ["Empty synthetic"], selectable: true }, { key: "Label_partial", path: ["Partial synthetic"], selectable: true }, { key: "Group", path: ["Group synthetic"], selectable: false }]);
      await server.backend.store.accounts.update(account, { syncWindowDays: 30 });
      await server.backend.store.sync.ingest([msg({ accountId: account, providerMsgId: "old-header", providerThreadId: "old-header", date: E2E_NOW - 400 * 86400000, bodyState: "none", bodyText: null, inInbox: false, gmailLabels: ["Label_partial"] })], { applyFilters: false, now: E2E_NOW, classifier: null });
      expect((await server.backend.store.threads.counts(E2E_NOW)).folderUnread?.[`${account}:Label_partial`]).toBe(1);
      await page.goto(`/?backend=${encodeURIComponent(server.url)}&token=synthetic`);
      await page.locator("[data-ready]").waitFor();
      // the counts carry no coverage disclaimer: the Inbox's tooltip is just its shortcut
      const inbox = page.getByTestId("nav-inbox");
      await expect(inbox).toHaveAccessibleDescription("");
      await expect(inbox).toHaveAccessibleName(/Inbox|Entrada/);
      await inbox.hover();
      const tooltip = page.locator("[data-slot=tooltip-content][data-open]");
      await expect(tooltip).toContainText("G");
      await expect(tooltip).not.toContainText(gone[language]);
      const accountRow = page.getByTestId(`nav-account-${account}`);
      await expect(accountRow).toHaveAccessibleDescription("");
      await accountRow.focus();
      await page.keyboard.press("Enter");
      await expect(accountRow).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(page.getByTestId(`nav-folder-${account}-inbox`)).toBeFocused();
      await expect(page.getByTestId(`nav-folder-${account}-inbox`)).toHaveAccessibleDescription("");
      const partial = page.getByTestId(`nav-own-${account}-Label_partial`);
      await expect(partial.locator("[data-slot=nav-count]")).toHaveText("1");
      await expect(partial).toHaveAccessibleDescription("");
      const category = page.locator('[data-testid^="nav-category-"]').first();
      const categoryId = Number((await category.getAttribute("data-testid"))!.slice("nav-category-".length));
      await page.evaluate(async (id) => {
        const path = "/src/state/app.ts";
        const state = await import(/* @vite-ignore */ path);
        state.setApp({ counts: { ...state.getApp().counts, categoryUnread: { [id]: 11 }, categorySuggestions: { [id]: 4 } } });
      }, categoryId);
      await expect(category).toHaveAccessibleDescription(categoryCopy[language].both);
      await category.hover();
      await expect(page.locator("[data-slot=tooltip-content][data-open]")).toHaveText(categoryCopy[language].both);
      await page.mouse.move(900, 50);
      await page.evaluate(async (id) => {
        const path = "/src/state/app.ts";
        const state = await import(/* @vite-ignore */ path);
        state.setApp({ counts: { ...state.getApp().counts, categoryUnread: {}, categorySuggestions: { [id]: 1 } } });
      }, categoryId);
      await expect(category).toHaveAccessibleDescription(categoryCopy[language].one);
      await expect(page.getByTestId(`nav-review-${categoryId}`)).not.toHaveAttribute("aria-describedby", /sidebar-count/);
      await page.mouse.move(900, 50);
      await category.hover();
      await expect(tooltip).toHaveText(categoryCopy[language].one);
      expect((await new AxeBuilder({ page }).include("#app-sidebar").include("[data-slot=tooltip-content][data-open]").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations).toEqual([]);
      mkdirSync("/tmp/terno-a13/screenshots", { recursive: true });
      await page.screenshot({ path: `/tmp/terno-a13/screenshots/count-${language}-${theme}.png` });
      expect(calls).toEqual([]);
      expect(external).toEqual([]);
    } finally { await server.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test("single account rows carry no coverage description", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "terno-count-single-"));
  const calls: string[] = [];
  const providers: ProviderRegistry = { ...demoRegistry, create(ctx) {
    const demo = createDemoProvider({ ...ctx, fetch: async () => { calls.push("fetch"); throw new Error("unexpected provider fetch"); }, google: ctx.google ? { ...ctx.google, request: async () => { calls.push("google.request"); throw new Error("unexpected managed Google request"); } } : undefined }, 0);
    return { ...demo, async sync(sink) { calls.push("sync"); return demo.sync(sink); }, async execute(op) { calls.push("execute"); return demo.execute(op); } };
  } };
  const server = await startDevServer({ port: 0, dataDir: dir, token: "synthetic", fresh: true, threads: 60, accounts: 1, autoSync: false, providers, iconTransport: null, now: () => E2E_NOW });
  try {
    const account = sqlDb(server.backend.store).get<{ id: number }>("SELECT id FROM accounts LIMIT 1")!.id;
    await server.backend.store.folders.replace(account, [{ key: "Label_single", path: ["Single"], selectable: true }]);
    await page.goto(`/?backend=${encodeURIComponent(server.url)}&token=synthetic`);
    await page.locator("[data-ready]").waitFor();
    const row = page.getByTestId(`nav-account-${account}`);
    await expect(row).toHaveAccessibleDescription("");
    await expect(row).toHaveAttribute("aria-expanded", "false");
    await row.click();
    await expect(row).toHaveAttribute("aria-expanded", "true");
    await expect(row).toHaveAccessibleDescription("");
    await expect(page.getByTestId(`nav-own-${account}-Label_single`)).toHaveAccessibleDescription("");
    expect(calls).toEqual([]);
  } finally { await server.close(); rmSync(dir, { recursive: true, force: true }); }
});
