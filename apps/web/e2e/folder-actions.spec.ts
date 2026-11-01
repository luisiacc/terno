/**
 * Plan 107: an open account's and a folder's hover "+" (a new folder, a subfolder), and a folder's right-click menu:
 * rename in place, favorites below Starred, export and delete. On the seeded demo mailbox: Acme Studio's labels
 * (Gmail-like keys, "Proyectos" › "Rediseño web", "Equipo") and Freelance's IMAP-like folders.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { sqlDb, type DevServer } from "../../backend-dev/src/server";
import { expect, test } from "./fixtures";

const ctx = { clientId: "setup", origin: "dev" as const };
type Handlers = Record<string, (...a: unknown[]) => Promise<unknown>>;
const accountOf = (server: DevServer, name: string) => sqlDb(server.backend.store).get<{ id: number }>("SELECT id FROM accounts WHERE display_name = ?", name)!.id;
const own = (page: Page, accountId: number, key: string) => page.getByTestId(`nav-own-${accountId}-${key}`);
const keyOf = async (server: DevServer, accountId: number, ...path: string[]) =>
  (await server.backend.store.folders.list()).find((f) => f.accountId === accountId && f.path.join("/") === path.join("/"))?.key;
const listFor = (page: Page) => page.getByTestId("thread-list").getAttribute("data-results-for").then((k) => JSON.parse(k!) as unknown[]);

async function openAccount(page: Page, id: number) {
  const row = page.getByTestId(`nav-account-${id}`);
  if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
  await expect(row).toHaveAttribute("aria-expanded", "true");
}

test.describe("folder actions", { tag: "@design" }, () => {
  test("the \"+\" shows on hover of an open account and of a folder, and the count steps aside", async ({ app: page, server }) => {
    const acme = accountOf(server, "Acme Studio");
    const add = page.getByTestId(`nav-account-add-${acme}`);
    // closed: no "+"
    await expect(add).toHaveCount(0);
    await openAccount(page, acme);
    await page.getByTestId("nav-inbox").hover();
    await expect(add).toHaveCSS("opacity", "0");
    await page.getByTestId(`nav-account-${acme}`).hover();
    await expect(add).toHaveCSS("opacity", "1");
    await expect(add).toHaveAccessibleName("New folder in Acme Studio");
    // a folder with unread mail: its count hides while its "+" shows
    const folder = own(page, acme, "Label_21");
    const count = folder.locator("[data-slot=nav-count]");
    await expect(count).toBeVisible();
    await folder.hover();
    await expect(page.getByTestId(`nav-own-add-${acme}-Label_21`)).toHaveCSS("opacity", "1");
    await expect(count).toBeHidden();
  });

  test("a new folder at the top: Enter creates it on the server, the row takes the focus; Esc and an empty blur cancel", async ({ app: page, server }) => {
    const acme = accountOf(server, "Acme Studio");
    await openAccount(page, acme);
    await page.getByTestId(`nav-account-${acme}`).hover();
    await page.getByTestId(`nav-account-add-${acme}`).click();
    const field = page.getByTestId(`nav-own-new-${acme}`);
    await expect(field).toBeFocused();
    await field.press("Escape");
    await expect(field).toHaveCount(0);
    await expect(page.getByTestId(`nav-account-${acme}`)).toBeFocused();

    await page.getByTestId(`nav-account-${acme}`).hover();
    await page.getByTestId(`nav-account-add-${acme}`).click();
    await field.fill("Facturas 2026");
    await field.press("Enter");
    await expect(field).toHaveCount(0);
    await expect.poll(() => keyOf(server, acme, "Facturas 2026")).toBeTruthy();
    const key = (await keyOf(server, acme, "Facturas 2026"))!;
    await expect(own(page, acme, key)).toBeFocused();
    await expect(own(page, acme, key)).toHaveText(/Facturas 2026/);
  });

  test("a subfolder from a folder's \"+\" and from its menu; a name taken stays in the field with what's wrong", async ({ app: page, server }) => {
    const acme = accountOf(server, "Acme Studio");
    await openAccount(page, acme);
    await own(page, acme, "Label_21").hover();
    await page.getByTestId(`nav-own-add-${acme}-Label_21`).click();
    const field = page.getByTestId(`nav-own-new-${acme}`);
    await expect(field).toBeFocused();
    // one step further in than its parent
    const indent = async (l: ReturnType<Page["getByTestId"]>) => l.evaluate((el) => el.getBoundingClientRect().left);
    expect(await indent(field)).toBeGreaterThan(await indent(own(page, acme, "Label_21")));
    // "Rediseño web" is already there (case aside)
    await field.fill("rediseño WEB");
    await field.press("Enter");
    await expect(page.getByTestId(`nav-own-new-${acme}-error`)).toHaveText("There’s already a folder called “rediseño WEB” here.");
    await expect(field).toHaveValue("rediseño WEB");
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await field.fill("Presupuestos");
    await field.press("Enter");
    await expect.poll(() => keyOf(server, acme, "Proyectos", "Presupuestos")).toBeTruthy();

    // the menu's New subfolder…, by keyboard
    await own(page, acme, "Label_23").focus();
    await page.keyboard.press("Shift+F10");
    await expect(page.getByTestId(`folder-menu-${acme}-Label_23`)).toBeVisible();
    await page.getByTestId("folder-menu-new").click();
    await expect(field).toBeFocused();
    await field.fill("Diseño");
    await field.press("Enter");
    await expect.poll(() => keyOf(server, acme, "Equipo", "Diseño")).toBeTruthy();
  });

  test("a refused create keeps the text in the field and says why", async ({ app: page, server }) => {
    const acme = accountOf(server, "Acme Studio");
    const handlers = (server.backend.server as unknown as { handlers: Handlers }).handlers;
    handlers["folders.create"] = async () => {
      throw new Error("You're offline. Try again when you're connected.");
    };
    await openAccount(page, acme);
    await page.getByTestId(`nav-account-${acme}`).hover();
    await page.getByTestId(`nav-account-add-${acme}`).click();
    const field = page.getByTestId(`nav-own-new-${acme}`);
    await field.fill("Viajes");
    await field.press("Enter");
    await expect(page.getByTestId(`nav-own-new-${acme}-error`)).toContainText("You're offline");
    await expect(field).toHaveValue("Viajes");
    await expect(field).toBeFocused();
  });

  test("Rename in place: the field sits where the name was; Enter renames on the server, Esc keeps it", async ({ app: page, server }) => {
    const acme = accountOf(server, "Acme Studio");
    await openAccount(page, acme);
    const row = own(page, acme, "Label_23");
    const label = row.locator("span.truncate").first();
    const labelBox = (await label.boundingBox())!;
    await row.click({ button: "right" });
    await page.getByTestId("folder-menu-rename").click();
    const field = page.getByTestId(`nav-own-rename-${acme}-Label_23`);
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("Equipo");
    const textLeft = await field.evaluate((el) => el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft));
    expect(Math.abs(textLeft - labelBox.x)).toBeLessThanOrEqual(1);
    await field.press("Escape");
    await expect(row).toBeFocused();
    await expect(row).toHaveText(/Equipo/);

    await row.click({ button: "right" });
    await page.getByTestId("folder-menu-rename").click();
    await field.fill("Equipo de diseño");
    await field.press("Enter");
    await expect(row).toHaveText(/Equipo de diseño/);
    await expect(row).toBeFocused();
    await expect.poll(async () => (await server.backend.store.folders.list()).find((f) => f.accountId === acme && f.key === "Label_23")?.path).toEqual(["Equipo de diseño"]);
  });

  test("an IMAP rename gives the folder a new key: the list you're in and its favorite follow it", async ({ app: page, server }) => {
    const freelance = accountOf(server, "Freelance");
    await openAccount(page, freelance);
    const folders = (await server.backend.store.folders.list()).filter((f) => f.accountId === freelance && f.selectable && f.path.length === 1);
    const from = folders[0]!;
    await own(page, freelance, from.key).click();
    await expect.poll(() => listFor(page)).toContain(from.key);
    await own(page, freelance, from.key).click({ button: "right" });
    await page.getByTestId("folder-menu-favorite").click();
    await expect(page.getByTestId(`nav-fav-${freelance}-${from.key}`)).toBeVisible();

    await own(page, freelance, from.key).click({ button: "right" });
    await page.getByTestId("folder-menu-rename").click();
    await page.getByTestId(`nav-own-rename-${freelance}-${from.key}`).fill("Renombrada");
    await page.getByTestId(`nav-own-rename-${freelance}-${from.key}`).press("Enter");
    await expect.poll(() => keyOf(server, freelance, "Renombrada")).toBeTruthy();
    const to = (await keyOf(server, freelance, "Renombrada"))!;
    expect(to).not.toBe(from.key);
    await expect.poll(() => listFor(page)).toContain(to);
    await expect(own(page, freelance, to)).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId(`nav-fav-${freelance}-${to}`)).toBeVisible();
  });

  test("favorites: below Starred, with whose they are; a standard row too; open one; take it away", async ({ app: page, server }) => {
    const acme = accountOf(server, "Acme Studio");
    await openAccount(page, acme);
    await own(page, acme, "Label_22").click({ button: "right" });
    await expect(page.getByTestId("folder-menu-favorite")).toHaveText("Add to favorites");
    await page.getByTestId("folder-menu-favorite").click();
    const fav = page.getByTestId(`nav-fav-${acme}-Label_22`);
    await expect(fav).toBeVisible();
    await expect(fav).toContainText("Rediseño web");
    await expect(fav).toContainText("Acme Studio");
    // right below Starred
    const order = await page.locator("#app-sidebar nav button[data-testid^=nav-]").evaluateAll((els) => els.slice(0, 4).map((el) => el.getAttribute("data-testid")));
    expect(order.slice(0, 3)).toEqual(["nav-inbox", "nav-starred", `nav-fav-${acme}-Label_22`]);
    // the account's Sent row, from its menu
    await page.getByTestId(`nav-folder-${acme}-sent`).click({ button: "right" });
    await page.getByTestId("folder-menu-favorite").click();
    await expect(page.getByTestId(`nav-fav-${acme}-sent`)).toBeVisible();
    // kept by the backend
    expect(((await server.backend.server.invoke("app.bootstrap", {}, ctx)) as { settings: { favoriteFolders: unknown[] } }).settings.favoriteFolders).toEqual([
      { accountId: acme, folder: "Label_22", view: null },
      { accountId: acme, folder: null, view: "sent" },
    ]);
    // it stays under its account too; a favorite opens its list
    await expect(own(page, acme, "Label_22")).toBeVisible();
    await fav.click();
    await expect.poll(() => listFor(page)).toContain("Label_22");
    await expect(fav).toHaveAttribute("aria-current", "page");
    // its own menu takes it away
    await fav.click({ button: "right" });
    await expect(page.getByTestId("folder-menu-favorite")).toHaveText("Remove from favorites");
    await page.getByTestId("folder-menu-favorite").click();
    await expect(fav).toHaveCount(0);
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await expect(page.getByTestId(`nav-fav-${acme}-sent`)).toBeVisible();
    await expect(page.getByTestId(`nav-fav-${acme}-Label_22`)).toHaveCount(0);
  });

  test("Delete folder…: Gmail says the mail stays; Cancel keeps it; Delete takes it and its favorite, and the list you're in", async ({ app: page, server }) => {
    const acme = accountOf(server, "Acme Studio");
    await openAccount(page, acme);
    await own(page, acme, "Label_21").click({ button: "right" });
    await page.getByTestId("folder-menu-favorite").click();
    await own(page, acme, "Label_21").click();
    await own(page, acme, "Label_21").click({ button: "right" });
    await page.getByTestId("folder-menu-delete").click();
    const dialog = page.getByTestId("folder-delete-dialog");
    await expect(dialog).toContainText("Delete the label “Proyectos”?");
    await expect(dialog).toContainText("Its sublabel goes too. The mail stays in All Mail and in its other labels.");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(own(page, acme, "Label_21")).toBeFocused();

    await own(page, acme, "Label_21").click({ button: "right" });
    await page.getByTestId("folder-menu-delete").click();
    await page.getByTestId("folder-delete-dialog-confirm").click();
    await expect(page.getByTestId("snack").filter({ hasText: "“Proyectos” deleted" })).toBeVisible();
    await expect(own(page, acme, "Label_21")).toHaveCount(0);
    await expect(own(page, acme, "Label_22")).toHaveCount(0);
    await expect(page.getByTestId(`nav-fav-${acme}-Label_21`)).toHaveCount(0);
    await expect.poll(() => listFor(page)).toEqual(["inbox", acme, null, null, null, ""]);
  });

  test("Delete folder… on IMAP says how much mail goes with it, on the server", async ({ app: page, server }) => {
    const freelance = accountOf(server, "Freelance");
    await openAccount(page, freelance);
    const folder = (await server.backend.store.folders.list()).find((f) => f.accountId === freelance && f.selectable)!;
    await own(page, freelance, folder.key).click({ button: "right" });
    await page.getByTestId("folder-menu-delete").click();
    const dialog = page.getByTestId("folder-delete-dialog");
    await expect(dialog).toContainText(`Delete “${folder.path.at(-1)}” and its mail?`);
    await expect(dialog).toContainText(/It holds \d+ messages?\./);
    await expect(dialog).toContainText("deleted on the server");
  });

  test("Export mailbox…: an .mbox of the folder's messages from this computer, with progress and a summary", async ({ app: page, server }) => {
    const acme = accountOf(server, "Acme Studio");
    // the download path (Chromium's file picker would open a native dialog)
    await page.evaluate(() => { (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined; });
    await openAccount(page, acme);
    await own(page, acme, "Label_22").click({ button: "right" });
    const download = page.waitForEvent("download");
    await page.getByTestId("folder-menu-export").click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("Rediseño web.mbox");
    const text = await (await import("node:fs/promises")).readFile((await file.path())!, "utf8");
    const messages = sqlDb(server.backend.store).get<{ c: number }>("SELECT count(*) AS c FROM messages WHERE account_id = ? AND instr(gmail_labels, '\"Label_22\"') > 0 AND is_trash = 0 AND is_spam = 0 AND is_draft = 0", acme)!.c;
    expect(messages).toBeGreaterThan(0);
    expect(text.match(/^From - /gm)?.length).toBe(messages);
    await expect(page.getByTestId("snack").filter({ hasText: /Exported/ })).toBeVisible();
  });

  for (const mode of ["light", "dark"] as const) {
    test(`the folder menu, the name field and favorites are axe-clean, ${mode}`, async ({ app: page, server }) => {
      await server.backend.server.invoke("settings.update", { theme: mode }, ctx);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      const acme = accountOf(server, "Acme Studio");
      await openAccount(page, acme);
      await own(page, acme, "Label_21").click({ button: "right" });
      await page.getByTestId("folder-menu-favorite").click();
      await own(page, acme, "Label_21").click({ button: "right" });
      const menu = page.getByTestId(`folder-menu-${acme}-Label_21`);
      await expect(menu).toBeVisible();
      if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/folder-menu-${mode}.png` });
      const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
      const fmt = (r: Awaited<ReturnType<AxeBuilder["analyze"]>>) => r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 120)).join(", ")}`);
      expect(fmt(await new AxeBuilder({ page }).include(`[data-testid=folder-menu-${acme}-Label_21]`).withTags(tags).analyze())).toEqual([]);
      await page.keyboard.press("Escape");
      await own(page, acme, "Label_21").hover();
      await page.getByTestId(`nav-own-add-${acme}-Label_21`).click();
      await page.getByTestId(`nav-own-new-${acme}`).fill("Rediseño web");
      await page.getByTestId(`nav-own-new-${acme}`).press("Enter");
      await expect(page.getByTestId(`nav-own-new-${acme}-error`)).toBeVisible();
      if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/field-${mode}.png` });
      expect(fmt(await new AxeBuilder({ page }).include("#app-sidebar").withTags(tags).analyze())).toEqual([]);
    });
  }
});
