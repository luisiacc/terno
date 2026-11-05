/**
 * Plan 107: an open account's and a folder's hover "+" (a new folder, a subfolder), and a folder's right-click menu:
 * rename in place, favorites below Starred, export and delete. On the seeded demo mailbox: Acme Studio's labels
 * (Gmail-like keys, "Proyectos" › "Rediseño web", "Equipo") and Freelance's IMAP-like folders.
 */
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

test.describe("folder actions", () => {
  test("the \"+\" shows on hover of an open account and of a folder, and the count steps aside", async ({ app: page, server }) => {
    const acme = accountOf(server, "Acme Studio");
    const add = page.getByTestId(`account-add-folder-${acme}`);
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
    await expect(page.getByTestId(`folder-add-${acme}-Label_21`)).toHaveCSS("opacity", "1");
    await expect(count).toBeHidden();
  });

  test("a new folder at the top: Enter creates it on the server, the row takes the focus; Esc and an empty blur cancel", async ({ app: page, server }) => {
    const acme = accountOf(server, "Acme Studio");
    await openAccount(page, acme);
    await page.getByTestId(`nav-account-${acme}`).hover();
    await page.getByTestId(`account-add-folder-${acme}`).click();
    const field = page.getByTestId(`folder-new-${acme}`);
    await expect(field).toBeFocused();
    await field.press("Escape");
    await expect(field).toHaveCount(0);
    await expect(page.getByTestId(`nav-account-${acme}`)).toBeFocused();

    await page.getByTestId(`nav-account-${acme}`).hover();
    await page.getByTestId(`account-add-folder-${acme}`).click();
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
    await page.getByTestId(`folder-add-${acme}-Label_21`).click();
    const field = page.getByTestId(`folder-new-${acme}`);
    await expect(field).toBeFocused();
    // one step further in than its parent
    const indent = async (l: ReturnType<Page["getByTestId"]>) => l.evaluate((el) => el.getBoundingClientRect().left);
    expect(await indent(field)).toBeGreaterThan(await indent(own(page, acme, "Label_21")));
    // "Rediseño web" is already there (case aside)
    await field.fill("rediseño WEB");
    await field.press("Enter");
    await expect(page.getByTestId(`folder-new-${acme}-error`)).toHaveText("There’s already a folder called “rediseño WEB” here.");
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

  test("an empty new-folder field left with a click elsewhere: it goes, the focus stays where the click put it (Codex code review #6)", async ({ app: page, server }) => {
    const acme = accountOf(server, "Acme Studio");
    await openAccount(page, acme);
    await page.getByTestId(`nav-account-${acme}`).hover();
    await page.getByTestId(`account-add-folder-${acme}`).click();
    await expect(page.getByTestId(`folder-new-${acme}`)).toBeFocused();
    await page.getByTestId("nav-starred").click();
    await expect(page.getByTestId(`folder-new-${acme}`)).toHaveCount(0);
    await page.waitForTimeout(100);
    await expect(page.getByTestId("nav-starred")).toBeFocused();
  });

  test("a folder created past the first 250 is mounted and focused (Codex code review #5)", async ({ app: page, server }) => {
    const acme = accountOf(server, "Acme Studio");
    const mine = (await server.backend.store.folders.list()).filter((f) => f.accountId === acme).map(({ key, path, selectable }) => ({ key, path, selectable }));
    const many = Array.from({ length: 300 }, (_, i) => ({ key: `Label_9${String(i).padStart(3, "0")}`, path: [`Carpeta ${String(i).padStart(3, "0")}`], selectable: true }));
    await server.backend.store.folders.replace(acme, [...mine, ...many]);
    server.backend.server.emit("folders", await server.backend.store.folders.list());
    await openAccount(page, acme);
    await expect(page.getByTestId(`nav-own-more-${acme}`)).toBeVisible();
    await page.getByTestId(`nav-account-${acme}`).hover();
    await page.getByTestId(`account-add-folder-${acme}`).click();
    // sorts after every "Carpeta …": past the first batch
    await page.getByTestId(`folder-new-${acme}`).fill("Zeta");
    await page.getByTestId(`folder-new-${acme}`).press("Enter");
    await expect.poll(() => keyOf(server, acme, "Zeta")).toBeTruthy();
    const key = (await keyOf(server, acme, "Zeta"))!;
    await expect(own(page, acme, key)).toBeFocused();
    await page.waitForTimeout(200);
    await expect(own(page, acme, key)).toBeFocused();
  });

  test("a refused create keeps the text in the field and says why", async ({ app: page, server }) => {
    const acme = accountOf(server, "Acme Studio");
    const handlers = (server.backend.server as unknown as { handlers: Handlers }).handlers;
    handlers["folders.create"] = async () => {
      throw new Error("You're offline. Try again when you're connected.");
    };
    await openAccount(page, acme);
    await page.getByTestId(`nav-account-${acme}`).hover();
    await page.getByTestId(`account-add-folder-${acme}`).click();
    const field = page.getByTestId(`folder-new-${acme}`);
    await field.fill("Viajes");
    await field.press("Enter");
    await expect(page.getByTestId(`folder-new-${acme}-error`)).toContainText("You're offline");
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
    const field = page.getByTestId(`folder-rename-${acme}-Label_23`);
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
    await page.getByTestId(`folder-rename-${freelance}-${from.key}`).fill("Renombrada");
    await page.getByTestId(`folder-rename-${freelance}-${from.key}`).press("Enter");
    await expect.poll(() => keyOf(server, freelance, "Renombrada")).toBeTruthy();
    const to = (await keyOf(server, freelance, "Renombrada"))!;
    expect(to).not.toBe(from.key);
    await expect.poll(() => listFor(page)).toContain(to);
    // a favorite: it's the current row (its copy under the account isn't too)
    await expect(page.getByTestId(`nav-fav-${freelance}-${to}`)).toHaveAttribute("aria-current", "page");
    await expect(own(page, freelance, to)).toBeVisible();
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
    // the one current row: not its copy under the account too (Codex code review round 3 #6)
    await expect(page.locator("#app-sidebar [aria-current=page]")).toHaveCount(1);
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

  test("a rename beside a parent that only groups checks its own siblings (Codex code review round 2 #10)", async ({ app: page, server }) => {
    const acme = accountOf(server, "Acme Studio");
    const mine = (await server.backend.store.folders.list()).filter((f) => f.accountId === acme).map(({ key, path, selectable }) => ({ key, path, selectable }));
    // "Grupo" isn't a label of its own: "Grupo/Cliente" is; "Archivo" is a top one
    await server.backend.store.folders.replace(acme, [...mine, { key: "Label_801", path: ["Grupo", "Cliente"], selectable: true }, { key: "Label_802", path: ["Archivo"], selectable: true }]);
    server.backend.server.emit("folders", await server.backend.store.folders.list());
    await openAccount(page, acme);
    await own(page, acme, "Label_801").click({ button: "right" });
    await page.getByTestId("folder-menu-rename").click();
    const field = page.getByTestId(`folder-rename-${acme}-Label_801`);
    await field.fill("Archivo");
    await field.press("Enter");
    await expect(page.getByTestId(`folder-rename-${acme}-Label_801-error`)).toHaveCount(0);
    await expect.poll(async () => (await server.backend.store.folders.list()).find((f) => f.accountId === acme && f.key === "Label_801")?.path).toEqual(["Grupo", "Archivo"]);
  });

  test("a deleted favorite stays gone when a folder of that name comes back (Codex code review round 2 #11)", async ({ app: page, server }) => {
    const freelance = accountOf(server, "Freelance");
    await openAccount(page, freelance);
    await page.getByTestId(`nav-account-${freelance}`).hover();
    await page.getByTestId(`account-add-folder-${freelance}`).click();
    await page.getByTestId(`folder-new-${freelance}`).fill("Temporal");
    await page.getByTestId(`folder-new-${freelance}`).press("Enter");
    await expect.poll(() => keyOf(server, freelance, "Temporal")).toBeTruthy();
    const key = (await keyOf(server, freelance, "Temporal"))!;
    await own(page, freelance, key).click({ button: "right" });
    await page.getByTestId("folder-menu-favorite").click();
    await expect(page.getByTestId(`nav-fav-${freelance}-${key}`)).toBeVisible();
    await own(page, freelance, key).click({ button: "right" });
    await page.getByTestId("folder-menu-delete").click();
    await page.getByTestId("folder-delete-dialog-confirm").click();
    await expect(own(page, freelance, key)).toHaveCount(0);
    // the same path again (an IMAP key is its path)
    await page.getByTestId(`nav-account-${freelance}`).hover();
    await page.getByTestId(`account-add-folder-${freelance}`).click();
    await page.getByTestId(`folder-new-${freelance}`).fill("Temporal");
    await page.getByTestId(`folder-new-${freelance}`).press("Enter");
    await expect(own(page, freelance, key)).toBeVisible();
    await expect(page.getByTestId(`nav-fav-${freelance}-${key}`)).toHaveCount(0);
  });

  test("a field whose row closes while the server answers: a failure is said, and the text is there when it opens again (Codex code review round 2 #3)", async ({ app: page, server }) => {
    const acme = accountOf(server, "Acme Studio");
    const handlers = (server.backend.server as unknown as { handlers: Handlers }).handlers;
    handlers["folders.create"] = async () => {
      await new Promise((r) => setTimeout(r, 800));
      throw new Error("the server said no");
    };
    await openAccount(page, acme);
    await page.getByTestId(`nav-account-${acme}`).hover();
    await page.getByTestId(`account-add-folder-${acme}`).click();
    await page.getByTestId(`folder-new-${acme}`).fill("Pendiente");
    // another account: the blur submits, this one closes
    const other = (await server.backend.store.accounts.list()).find((a) => a.id !== acme)!.id;
    await page.getByTestId(`nav-account-${other}`).click();
    await expect(page.getByTestId("snack").filter({ hasText: "Couldn’t save the folder “Pendiente”: the server said no" })).toBeVisible();
    await openAccount(page, acme);
    await expect(page.getByTestId(`folder-new-${acme}`)).toHaveValue("Pendiente");
    await expect(page.getByTestId(`folder-new-${acme}-error`)).toContainText("the server said no");
  });

  test("an IMAP rename of the folder you're reading in: the conversation stays open and the rows stay (Codex code review round 2 #4, #5)", async ({ app: page, server }) => {
    const freelance = accountOf(server, "Freelance");
    await server.backend.server.invoke("settings.update", { layout: "list" }, ctx);
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await openAccount(page, freelance);
    const from = (await server.backend.store.folders.list()).find((f) => f.accountId === freelance && f.selectable && sqlDb(server.backend.store).get("SELECT 1 FROM thread_folders WHERE account_id = ? AND folder = ?", freelance, f.key))!;
    await own(page, freelance, from.key).click();
    const rows = page.getByTestId("thread-row");
    await rows.first().waitFor();
    const members = (key: string) => sqlDb(server.backend.store).get<{ c: number }>("SELECT count(*) AS c FROM thread_folders WHERE account_id = ? AND folder = ?", freelance, key)!.c;
    const before = members(from.key);
    await rows.first().click();
    await expect(page.getByTestId("reader")).toBeVisible();
    await server.backend.server.invoke("folders.rename", { accountId: freelance, key: from.key, name: "Renombrada" }, { clientId: "other", origin: "dev" });
    await expect.poll(() => keyOf(server, freelance, "Renombrada")).toBeTruthy();
    await page.waitForTimeout(300);
    await expect(page.getByTestId("reader")).toBeVisible();
    // its threads under the new key at once, before any pass has read the server again
    const to = (await keyOf(server, freelance, "Renombrada"))!;
    expect(members(to)).toBe(before);
    await page.keyboard.press("Escape");
    await expect(rows.first()).toBeVisible();
  });

  test("the delete confirmation says what's inside goes too, even when counting fails (Codex code review round 3 #3)", async ({ app: page, server }) => {
    const freelance = accountOf(server, "Freelance");
    const handlers = (server.backend.server as unknown as { handlers: Handlers }).handlers;
    handlers["folders.count"] = async () => {
      throw new Error("busy");
    };
    await openAccount(page, freelance);
    const folder = (await server.backend.store.folders.list()).find((f) => f.accountId === freelance && f.selectable)!;
    await own(page, freelance, folder.key).click({ button: "right" });
    await page.getByTestId("folder-menu-delete").click();
    await expect(page.getByTestId("folder-delete-dialog")).toContainText("Any folders inside it go too, with their mail.");
  });

  test("a field reopened while its answer is on the way waits, and can't send it twice (Codex code review round 3 #4)", async ({ app: page, server }) => {
    const acme = accountOf(server, "Acme Studio");
    const handlers = (server.backend.server as unknown as { handlers: Handlers }).handlers;
    const create = handlers["folders.create"]!;
    let calls = 0;
    handlers["folders.create"] = async (...a) => (calls++, await new Promise((r) => setTimeout(r, 1500)), create(...a));
    await openAccount(page, acme);
    await page.getByTestId(`nav-account-${acme}`).hover();
    await page.getByTestId(`account-add-folder-${acme}`).click();
    const field = page.getByTestId(`folder-new-${acme}`);
    await field.fill("Lenta");
    await field.press("Enter");
    // close the account (its rows go after the slide) and open it again before the answer
    await page.getByTestId(`nav-account-${acme}`).click();
    await expect(field).toHaveCount(0);
    await page.getByTestId(`nav-account-${acme}`).click();
    await expect(field).toHaveValue("Lenta");
    await expect(field).toHaveAttribute("aria-busy", "true");
    await field.press("Enter");
    await expect.poll(() => keyOf(server, acme, "Lenta")).toBeTruthy();
    expect(calls).toBe(1);
  });

  test("a favorite taken away from its own menu by keyboard: the next favorite has the focus (Codex code review round 4 #4)", async ({ app: page, server }) => {
    const acme = accountOf(server, "Acme Studio");
    await openAccount(page, acme);
    for (const key of ["Label_22", "Label_23"]) {
      await own(page, acme, key).click({ button: "right" });
      // this folder's menu: the one before may still be closing (an exit animation)
      await page.getByTestId(`folder-menu-${acme}-${key}`).getByTestId("folder-menu-favorite").click();
    }
    const first = page.getByTestId(`nav-fav-${acme}-Label_22`);
    // the menus that added them have closed (and handed their rows the focus back)
    await expect(page.locator("[role=menu]")).toHaveCount(0);
    await first.focus();
    await page.keyboard.press("Shift+F10");
    await expect(page.getByTestId(`folder-menu-${acme}-Label_22`)).toBeVisible();
    const item = page.getByTestId(`folder-menu-${acme}-Label_22`).getByTestId("folder-menu-favorite");
    await expect(item).toHaveText("Remove from favorites");
    await item.focus();
    await page.keyboard.press("Enter");
    await expect(first).toHaveCount(0);
    await expect(page.getByTestId(`nav-fav-${acme}-Label_23`)).toBeFocused();
  });

  test("taking a favorite away: a failure keeps the focus on its row; from the account's copy the focus stays there; a quote in a key is fine (Codex code review round 5 #6, #7)", async ({ app: page, server }) => {
    const freelance = accountOf(server, "Freelance");
    const mine = (await server.backend.store.folders.list()).filter((f) => f.accountId === freelance).map(({ key, path, selectable }) => ({ key, path, selectable }));
    await server.backend.store.folders.replace(freelance, [...mine, { key: "Uno", path: ["Uno"], selectable: true }, { key: 'A"B', path: ['A"B'], selectable: true }]);
    server.backend.server.emit("folders", await server.backend.store.folders.list());
    await openAccount(page, freelance);
    for (const key of ["Uno", 'A"B']) {
      await own(page, freelance, key).click({ button: "right" });
      await page.getByTestId("folder-menu-favorite").click();
      await expect(page.locator("[role=menu]")).toHaveCount(0);
    }
    const fav = (key: string) => page.getByTestId(`nav-fav-${freelance}-${key}`);
    const handlers = (server.backend.server as unknown as { handlers: Handlers }).handlers;
    const favorite = handlers["folders.favorite"]!;
    // a failure: the row stays, and so does the focus
    handlers["folders.favorite"] = async () => {
      throw new Error("busy");
    };
    await fav("Uno").focus();
    await page.keyboard.press("Shift+F10");
    await page.getByTestId(`folder-menu-${freelance}-Uno`).getByTestId("folder-menu-favorite").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("snack").filter({ hasText: "busy" })).toBeVisible();
    await expect(fav("Uno")).toBeFocused();
    handlers["folders.favorite"] = favorite;
    // from its own row, with a quoted key next: the next favorite has the focus
    await page.keyboard.press("Shift+F10");
    await page.getByTestId(`folder-menu-${freelance}-Uno`).getByTestId("folder-menu-favorite").focus();
    await page.keyboard.press("Enter");
    await expect(fav("Uno")).toHaveCount(0);
    await expect(fav('A"B')).toBeFocused();
    // from the account's copy: the focus stays on that row
    await own(page, freelance, 'A"B').focus();
    await page.keyboard.press("Shift+F10");
    await page.getByTestId(`folder-menu-${freelance}-A"B`).getByTestId("folder-menu-favorite").focus();
    await page.keyboard.press("Enter");
    await expect(fav('A"B')).toHaveCount(0);
    await expect(own(page, freelance, 'A"B')).toBeFocused();
  });

  test("a slow IMAP rename whose new row arrives after the user went elsewhere doesn't take the focus back (Codex code review round 6 #3)", async ({ app: page, server }) => {
    const freelance = accountOf(server, "Freelance");
    const handlers = (server.backend.server as unknown as { handlers: Handlers }).handlers;
    const rename = handlers["folders.rename"]!;
    handlers["folders.rename"] = async (...a) => (await new Promise((r) => setTimeout(r, 800)), rename(...a));
    await openAccount(page, freelance);
    const from = (await server.backend.store.folders.list()).find((f) => f.accountId === freelance && f.selectable && f.path.length === 1)!;
    await own(page, freelance, from.key).click({ button: "right" });
    await page.getByTestId("folder-menu-rename").click();
    const field = page.getByTestId(`folder-rename-${freelance}-${from.key}`);
    await field.fill("Despacio");
    await field.press("Enter");
    await page.getByTestId("search-input").or(page.getByTestId("nav-starred")).first().click();
    const elsewhere = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
    expect(elsewhere).toBeTruthy();
    await expect.poll(() => keyOf(server, freelance, "Despacio")).toBeTruthy();
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe(elsewhere);
  });

  test("a second rename started while the first is on its way works on its own (Codex code review round 9 #2)", async ({ app: page, server }) => {
    const acme = accountOf(server, "Acme Studio");
    const handlers = (server.backend.server as unknown as { handlers: Handlers }).handlers;
    const rename = handlers["folders.rename"]!;
    handlers["folders.rename"] = async (...a) => (await new Promise((r) => setTimeout(r, 600)), rename(...a));
    await openAccount(page, acme);
    await own(page, acme, "Label_23").click({ button: "right" });
    await page.getByTestId("folder-menu-favorite").click();
    await expect(page.locator("[role=menu]")).toHaveCount(0);
    await own(page, acme, "Label_23").click({ button: "right" });
    await page.getByTestId("folder-menu-rename").click();
    const field = page.getByTestId(`folder-rename-${acme}-Label_23`);
    await field.fill("Primero");
    await field.press("Enter");
    // from the favorite, before the answer
    await page.getByTestId(`nav-fav-${acme}-Label_23`).click({ button: "right" });
    await page.getByTestId(`folder-menu-${acme}-Label_23`).getByTestId("folder-menu-rename").click();
    await expect(field).toBeFocused();
    await page.waitForTimeout(800);
    await field.fill("Segundo");
    await field.press("Enter");
    await expect.poll(async () => (await server.backend.store.folders.list()).find((f) => f.accountId === acme && f.key === "Label_23")?.path).toEqual(["Segundo"]);
  });

  test("renaming a folder deeper than the sidebar nests starts from its own name, not the path shown (Codex code review round 10 #5)", async ({ app: page, server }) => {
    const acme = accountOf(server, "Acme Studio");
    const mine = (await server.backend.store.folders.list()).filter((f) => f.accountId === acme).map(({ key, path, selectable }) => ({ key, path, selectable }));
    const path = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
    await server.backend.store.folders.replace(acme, [...mine, ...path.map((_, i) => ({ key: `Label_9${i}`, path: path.slice(0, i + 1), selectable: true }))]);
    server.backend.server.emit("folders", await server.backend.store.folders.list());
    await openAccount(page, acme);
    await own(page, acme, "Label_99").click({ button: "right" });
    await page.getByTestId("folder-menu-rename").click();
    const field = page.getByTestId(`folder-rename-${acme}-Label_99`);
    await expect(field).toHaveValue("J");
    await field.fill("Jota");
    await field.press("Enter");
    await expect.poll(async () => (await server.backend.store.folders.list()).find((f) => f.accountId === acme && f.key === "Label_99")?.path.at(-1)).toBe("Jota");
  });

  test("a late delete answer never takes away a favorite another window made since (Codex code review round 13 #3)", async ({ app: page, server }) => {
    const freelance = accountOf(server, "Freelance");
    const other = { clientId: "other-window", origin: "dev" as const };
    const made = await server.backend.server.invoke("folders.create", { accountId: freelance, parent: null, name: "Efimera" }, other) as { key: string };
    await openAccount(page, freelance);
    const handlers = (server.backend.server as unknown as { handlers: Handlers }).handlers;
    const remove = handlers["folders.delete"]!;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    handlers["folders.delete"] = async (...a) => {
      const r = await remove(...a);
      await held;
      return r;
    };
    await own(page, freelance, made.key).click({ button: "right" });
    await page.getByTestId("folder-menu-delete").click();
    await page.getByTestId("folder-delete-dialog-confirm").click();
    await expect(own(page, freelance, made.key)).toHaveCount(0);
    // meanwhile another window makes it again and favorites it
    const again = await server.backend.server.invoke("folders.create", { accountId: freelance, parent: null, name: "Efimera" }, other) as { key: string };
    await server.backend.server.invoke("folders.favorite", { accountId: freelance, folder: again.key, view: null, on: true }, other);
    await expect(page.getByTestId(`nav-fav-${freelance}-${again.key}`)).toBeVisible();
    release();
    await expect(page.getByTestId("snack").filter({ hasText: "deleted" })).toBeVisible();
    await page.waitForTimeout(200);
    await expect(page.getByTestId(`nav-fav-${freelance}-${again.key}`)).toBeVisible();
  });

  test("Esc on a rename of a folder past the first 250 gives it the focus back (Codex code review round 24 #4)", async ({ app: page, server }) => {
    const acme = accountOf(server, "Acme Studio");
    const mine = (await server.backend.store.folders.list()).filter((f) => f.accountId === acme).map(({ key, path, selectable }) => ({ key, path, selectable }));
    const many = Array.from({ length: 300 }, (_, i) => ({ key: `Label_8${String(i).padStart(3, "0")}`, path: [`Carpeta ${String(i).padStart(3, "0")}`], selectable: true }));
    await server.backend.store.folders.replace(acme, [...mine, ...many, { key: "Label_7999", path: ["Zeta"], selectable: true }]);
    server.backend.server.emit("folders", await server.backend.store.folders.list());
    await openAccount(page, acme);
    // favorited, renamed from the favorite while the folder sits past the first batch
    await server.backend.server.invoke("folders.favorite", { accountId: acme, folder: "Label_7999", view: null, on: true }, ctx);
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await openAccount(page, acme);
    await page.getByTestId(`nav-fav-${acme}-Label_7999`).click({ button: "right" });
    await page.getByTestId(`folder-menu-${acme}-Label_7999`).getByTestId("folder-menu-rename").click();
    const field = page.getByTestId(`folder-rename-${acme}-Label_7999`);
    await expect(field).toBeFocused();
    await field.press("Escape");
    await expect(own(page, acme, "Label_7999")).toBeFocused();
  });

  test("a focused favorite renamed or removed in another window: the keyboard keeps its place (Codex code review round 25 #4)", async ({ app: page, server }) => {
    const freelance = accountOf(server, "Freelance");
    const other = { clientId: "other-window", origin: "dev" as const };
    const a = (await server.backend.server.invoke("folders.create", { accountId: freelance, parent: null, name: "Uno" }, other)) as { key: string };
    const b = (await server.backend.server.invoke("folders.create", { accountId: freelance, parent: null, name: "Dos" }, other)) as { key: string };
    for (const key of [a.key, b.key]) await server.backend.server.invoke("folders.favorite", { accountId: freelance, folder: key, view: null, on: true }, other);
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    // renamed elsewhere: the same favorite under its new key keeps the focus
    await page.getByTestId(`nav-fav-${freelance}-${a.key}`).focus();
    const { renamed } = (await server.backend.server.invoke("folders.rename", { accountId: freelance, key: a.key, name: "Uno nuevo" }, other)) as { renamed: { to: string }[] };
    const to = renamed[0]!.to;
    await expect(page.getByTestId(`nav-fav-${freelance}-${to}`)).toBeFocused();
    // removed elsewhere: the next one takes it
    await server.backend.server.invoke("folders.favorite", { accountId: freelance, folder: to, view: null, on: false }, other);
    await expect(page.getByTestId(`nav-fav-${freelance}-${b.key}`)).toBeFocused();
  });
});
