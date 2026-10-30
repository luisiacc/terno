import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { expect, rows, searchBox, selectedRow, test } from "./fixtures";
import { E2E_NOW } from "./constants";

const copy = {
  en: { name: "Conversations", search: "No results", inbox: "Inbox is empty", other: "Nothing here", filter: "No unread results", clear: "Clear filter" },
  es: { name: "Conversaciones", search: "Sin resultados", inbox: "Bandeja vacía", other: "Nada por aquí", filter: "Sin resultados sin leer", clear: "Quitar filtro" },
};

const scrollerOf = (page: Page) => page.locator('[data-testid=thread-list] [data-keep-scroll=list]');
const axe = async (page: Page) => expect((await new AxeBuilder({ page }).include("[data-testid=thread-list]").analyze()).violations).toEqual([]);

async function empty(page: Page, state: Locator, title: string, name: string) {
  await expect(state).toBeVisible();
  await expect(state).toContainText(title);
  await axe(page);
  const scroller = scrollerOf(page);
  await expect(scroller).toHaveRole("group");
  await expect(scroller).toHaveAccessibleName(name);
  await expect(scroller).toHaveAttribute("tabindex", "-1");
  await expect(scroller).not.toHaveAttribute("aria-multiselectable");
  await expect(scroller).not.toHaveAttribute("aria-activedescendant");
  await expect(rows(page)).toHaveCount(0);
  expect(await state.ariaSnapshot()).toContain(title);
  await expect(state.locator('[aria-live], [role=status], [role=alert]')).toHaveCount(0);
}

for (const design of ["macos", "lumen"] as const) {
  test.describe(`${design} empty list`, () => {
    test.use({ design, layout: design === "macos" ? "split" : "list" });
    for (const language of ["en", "es"] as const) for (const theme of ["light", "dark"] as const) {
      test(`empty and populated semantics (${language}, ${theme}) @design`, async ({ page, server, layout }, info) => {
        const ctx = { clientId: "setup", origin: "dev" as const };
        await server.backend.server.invoke("settings.update", { design, layout: layout!, language, theme }, ctx);
        // A real account with no messages gives ordinary empty Inbox and Trash views.
        const { account } = await server.backend.store.accounts.create({ kind: "gmail", email: "empty@example.test", displayName: "Empty account", color: "indigo", now: E2E_NOW });
        await page.goto(`/?backend=${encodeURIComponent(server.url)}&token=e2e`);
        await page.locator("[data-ready]").waitFor();
        await rows(page).first().waitFor();
        const scroller = scrollerOf(page);
        const node = await scroller.elementHandle();
        const input = await searchBox(page);
        const field = await input.elementHandle();
        await scroller.evaluate((el) => new Promise<void>((resolve) => {
          el.addEventListener("scroll", () => requestAnimationFrame(() => resolve()), { once: true });
          el.scrollTop = 180;
        }));
        const top = await scroller.evaluate((el) => el.scrollTop);
        const selected = await selectedRow(page).getAttribute("data-thread-id");
        await input.focus();
        await input.press("Tab");
        expect(await scroller.evaluate((el) => el.scrollTop)).toBe(top);
        await expect(selectedRow(page)).toHaveAttribute("data-thread-id", selected!);
        await input.fill("zzqx-no-such-mail");
        await empty(page, page.getByTestId("list-empty"), copy[language].search, copy[language].name);
        await expect(page.getByTestId("search-coverage")).toBeVisible();
        await expect(input).toHaveAccessibleDescription(await page.getByTestId("search-coverage").innerText());
        await page.screenshot({ path: info.outputPath(`empty-search-${design}-${language}-${theme}.png`) });
        await page.getByTestId("nav-inbox").focus();
        for (let step = 0; step < 24; step++) {
          await page.keyboard.press("Tab");
          await expect(scroller).not.toBeFocused();
        }
        await scroller.evaluate((el) => el.focus());
        await expect(page.getByTestId("nav-inbox")).toBeFocused();
        await input.fill("");
        await rows(page).first().waitFor();
        await expect(scroller).toHaveRole("listbox");
        await expect(scroller).toHaveAttribute("aria-multiselectable", "true");
        expect(await node!.evaluate((el) => el === document.querySelector('[data-keep-scroll=list]'))).toBe(true);
        expect(await field!.evaluate((el) => el === document.querySelector('[data-testid=search-input]'))).toBe(true);
        await scroller.focus();
        await page.keyboard.press("ArrowDown");
        await expect(scroller).toBeFocused();
        await expect.poll(() => scroller.evaluate((el) => {
          const id = el.getAttribute("aria-activedescendant");
          const row = id && document.getElementById(id);
          return !!row && el.contains(row) && row.getAttribute("aria-selected") === "true";
        })).toBe(true);
        await axe(page);
        await input.fill("zzqx-no-such-mail");
        await page.keyboard.press("ControlOrMeta+l");
        const filtered = page.getByTestId("unread-empty");
        await empty(page, filtered, copy[language].filter, copy[language].name);
        await scroller.evaluate((el) => el.focus());
        await expect(page.getByTestId("unread-empty-clear")).toBeFocused();
        await expect(page.getByTestId("unread-empty-clear")).toHaveAccessibleName(copy[language].clear);
        await page.screenshot({ path: info.outputPath(`empty-filter-${design}-${language}-${theme}.png`) });
        await page.getByTestId("unread-empty-clear").click();
        await expect(filtered).toHaveCount(0);
        await expect(page.locator('[data-testid=unread-filter], [data-testid=quick-filter-all]').filter({ visible: true }).first()).toBeFocused();
        await page.getByTestId(`nav-account-${account.id}`).click();
        await empty(page, page.getByTestId("list-empty"), copy[language].inbox, copy[language].name);
        await page.getByTestId(`nav-folder-${account.id}-trash`).click();
        await empty(page, page.getByTestId("list-empty"), copy[language].other, copy[language].name);
        // Empty list in List layout: a page opened from outside it must return to a visible control.
        if (layout === "list") {
          await page.getByTestId("nav-inbox").focus();
          await page.keyboard.press("c");
          await expect(page.getByTestId("compose-to")).toBeVisible();
          await page.getByTestId("compose-to").evaluate((el) => el.blur());
          await page.keyboard.press("ControlOrMeta+[");
          await expect(page.getByTestId("compose-to")).toHaveCount(0);
          await expect(page.getByTestId(`nav-folder-${account.id}-trash`)).toBeFocused();
        }
      });
    }
  });
}

for (const populated of [false, true]) {
  test(`zero-row loading keeps focus until its ${populated ? "populated" : "empty"} answer @design`, async ({ app: page, server }) => {
    const input = await searchBox(page);
    await input.fill("zzqx-no-such-mail");
    await expect(page.getByTestId("list-empty")).toBeVisible();
    const handlers = (server.backend.server as unknown as { handlers: Record<string, (...args: unknown[]) => unknown> }).handlers;
    const original = handlers["threads.search"]!;
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const requested = new Promise<void>((resolve) => { started = resolve; });
    handlers["threads.search"] = async (...args) => { started(); await gate; return original(...args); };
    try {
      await input.fill(populated ? "in:inbox 291 gadgets" : "zzqx-still-no-mail");
      await requested;
      const scroller = scrollerOf(page);
      await expect(scroller).toHaveRole("group");
      await expect(scroller).toHaveAttribute("tabindex", "-1");
      await expect(scroller).not.toHaveAttribute("aria-activedescendant");
      await expect(scroller).not.toHaveAttribute("aria-multiselectable");
      await scroller.evaluate((el) => el.focus());
      await expect(scroller).toBeFocused();
      await axe(page);
      release();
      if (populated) {
        await expect(rows(page)).toHaveCount(1);
        await expect(scroller).toHaveRole("listbox");
        await expect(scroller).toBeFocused();
        await page.keyboard.press("ArrowDown");
        await expect(scroller).toHaveAttribute("aria-activedescendant", `thread-${await rows(page).first().getAttribute("data-thread-id")}`);
      } else {
        await expect(page.getByTestId("list-empty")).toBeVisible();
        await expect(page.getByTestId("nav-inbox")).toBeFocused();
      }
      await axe(page);
    } finally { release(); handlers["threads.search"] = original; }
  });
}
