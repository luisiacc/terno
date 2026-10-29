/**
 * Plan 65: an account's own folders (Gmail labels, IMAP folders) under its standard ones, on the seeded demo
 * mailbox: Acme Studio's labels ("Proyectos" › "Rediseño web", "Equipo"), Freelance's IMAP folders with a group
 * that's only a parent ("Facturación" › "2026").
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { sqlDb, type DevServer } from "../../backend-dev/src/server";
import { expect, test } from "./fixtures";

const ctx = { clientId: "setup", origin: "dev" as const };
const accountOf = (server: DevServer, name: string) => sqlDb(server.backend.store).get<{ id: number }>("SELECT id FROM accounts WHERE display_name = ?", name)!.id;
const membersOf = (server: DevServer, accountId: number, folder: string) =>
  sqlDb(server.backend.store).all<{ thread_id: number }>("SELECT thread_id FROM thread_folders WHERE account_id = ? AND folder = ?", accountId, folder).map((r) => r.thread_id);
const own = (page: Page, accountId: number, key: string) => page.getByTestId(`nav-own-${accountId}-${key}`);
const listFor = (page: Page) => page.getByTestId("thread-list").getAttribute("data-results-for").then((k) => JSON.parse(k!) as unknown[]);
const rowIds = (page: Page) => page.locator("[data-testid=thread-row]").evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-thread-id"))));

test.describe("an account's own folders", { tag: "@design" }, () => {
  test("an open account lists its own folders under its standard ones, nested, with unread counts; one lists its threads", async ({ app: page, server }) => {
    const acme = accountOf(server, "Acme Studio");
    await page.getByTestId(`nav-account-${acme}`).click();
    const group = page.locator(`#account-folders-${acme}`);
    // standard ones, a hairline, then its own, by name (Equipo, Proyectos › Rediseño web)
    const order = await group.locator("[data-testid^=nav-folder-], [role=separator], [data-testid^=nav-own-]").evaluateAll((els) => els.map((el) => el.getAttribute("data-testid") ?? "separator"));
    expect(order).toEqual([...["inbox", "sent", "archive", "spam", "trash"].map((v) => `nav-folder-${acme}-${v}`), "separator", `nav-own-${acme}-Label_23`, `nav-own-${acme}-Label_21`, `nav-own-${acme}-Label_22`]);
    // nested: Rediseño web sits one step further in than Proyectos
    const indent = async (key: string) => own(page, acme, key).evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
    expect(await indent("Label_22")).toBeGreaterThan(await indent("Label_21"));
    const unread = sqlDb(server.backend.store).get<{ c: number }>("SELECT count(*) AS c FROM thread_folders WHERE account_id = ? AND folder = 'Label_21' AND unread = 1", acme)!.c;
    expect(unread).toBeGreaterThan(0);
    await expect(own(page, acme, "Label_21").locator("[data-slot=nav-count]")).toHaveText(String(unread));

    await own(page, acme, "Label_21").click();
    await expect.poll(() => listFor(page)).toEqual(["all", acme, null, null, null, "Label_21", ""]);
    await expect(own(page, acme, "Label_21")).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#app-sidebar [aria-current=page]")).toHaveCount(1);
    await expect(page.getByTestId("thread-list")).toContainText("Proyectos");
    // the rows on screen (the list is virtualized) are all the folder's
    const members = new Set(membersOf(server, acme, "Label_21"));
    await expect.poll(async () => (await rowIds(page)).length).toBeGreaterThan(5);
    expect((await rowIds(page)).every((id) => members.has(id))).toBe(true);
  });

  test("reading a thread in a folder drops its count; select all is the folder's threads", async ({ app: page, server }) => {
    const acme = accountOf(server, "Acme Studio");
    await page.getByTestId(`nav-account-${acme}`).click();
    await own(page, acme, "Label_21").click();
    const count = own(page, acme, "Label_21").locator("[data-slot=nav-count]");
    const before = Number(await count.textContent());
    await page.locator("[data-testid=thread-row][data-unread]").first().click();
    await expect.poll(async () => Number((await count.textContent().catch(() => "0")) || 0)).toBe(before - 1);
    await page.getByRole("listbox").focus();
    await page.keyboard.press("ControlOrMeta+a");
    // every thread of the folder (one page of it), never more
    await expect(page.getByTestId("selection-count")).toHaveText(String(membersOf(server, acme, "Label_21").length));
  });

  test("a parent that only groups (IMAP \\Noselect) isn't a place to go; its child is", async ({ app: page, server }) => {
    const freelance = accountOf(server, "Freelance");
    await page.getByTestId(`nav-account-${freelance}`).click();
    const group = page.locator(`#account-folders-${freelance}`).getByTestId("nav-own-group");
    await expect(group).toHaveText("Facturación");
    expect(await group.evaluate((el) => el.tagName)).toBe("DIV");
    await own(page, freelance, "Facturación/2026").click();
    await expect.poll(() => listFor(page)).toEqual(["all", freelance, null, null, null, "Facturación/2026", ""]);
  });

  test("a folder that's gone (deleted on the server) sends you to its account's Inbox", async ({ app: page, server }) => {
    const acme = accountOf(server, "Acme Studio");
    await page.getByTestId(`nav-account-${acme}`).click();
    await own(page, acme, "Label_23").click();
    await expect.poll(() => listFor(page)).toEqual(["all", acme, null, null, null, "Label_23", ""]);
    const left = (await server.backend.store.folders.list()).filter((f) => f.accountId === acme && f.key !== "Label_23").map(({ key, path, selectable }) => ({ key, path, selectable }));
    await server.backend.store.folders.replace(acme, left);
    server.backend.server.emit("folders", await server.backend.store.folders.list());
    await expect.poll(() => listFor(page)).toEqual(["inbox", acme, null, null, null, ""]);
    await expect(own(page, acme, "Label_23")).toHaveCount(0);
  });

  test("keyboard: Tab reaches its folders, Enter goes to one", async ({ app: page, server }) => {
    const acme = accountOf(server, "Acme Studio");
    await page.getByTestId(`nav-account-${acme}`).click();
    await page.getByTestId(`nav-folder-${acme}-trash`).focus();
    await page.keyboard.press("Tab");
    await expect(own(page, acme, "Label_23")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => listFor(page)).toEqual(["all", acme, null, null, null, "Label_23", ""]);
  });

  for (const mode of ["light", "dark"] as const) {
    test(`axe with an account's folders open, ${mode}`, async ({ app: page, server }) => {
      await server.backend.server.invoke("settings.update", { theme: mode }, ctx);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      const freelance = accountOf(server, "Freelance");
      await page.getByTestId(`nav-account-${freelance}`).click();
      await own(page, freelance, "Facturación/2026").click();
      await own(page, freelance, "Clientes antiguos").hover();
      const r = await new AxeBuilder({ page }).include("#app-sidebar").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 120)).join(", ")}`)).toEqual([]);
    });
  }
});

test("Codex R1: an account with 2,000 folders mounts 250 of them; more come 250 at a time", async ({ app: page, server }) => {
  const acme = accountOf(server, "Acme Studio");
  const many = Array.from({ length: 2000 }, (_, i) => ({ key: `Label_m${i}`, path: [`Folder ${String(i).padStart(4, "0")}`], selectable: true }));
  await server.backend.store.folders.replace(acme, many);
  server.backend.server.emit("folders", await server.backend.store.folders.list());
  await page.getByTestId(`nav-account-${acme}`).click();
  const rows = page.locator(`#account-folders-${acme} [data-testid^="nav-own-${acme}-"]`);
  await expect(rows).toHaveCount(250);
  const more = page.getByTestId(`nav-own-more-${acme}`);
  await expect(more).toHaveText("1,750 more folders");
  await more.click();
  await expect(rows).toHaveCount(500);
  await expect(more).toHaveText("1,500 more folders");
});

test("Codex R7: the folder you're in, renamed to sort last among 2,000, is drawn alone after the rows shown, never with every row before it", async ({ app: page, server }) => {
  const acme = accountOf(server, "Acme Studio");
  const many = Array.from({ length: 2000 }, (_, i) => ({ key: `Label_m${i}`, path: [`Folder ${String(i).padStart(4, "0")}`], selectable: true }));
  await server.backend.store.folders.replace(acme, many);
  server.backend.server.emit("folders", await server.backend.store.folders.list());
  await page.getByTestId(`nav-account-${acme}`).click();
  await own(page, acme, "Label_m3").click();
  await server.backend.store.folders.replace(acme, many.map((f) => (f.key === "Label_m3" ? { ...f, path: ["Zzz renamed"] } : f)));
  server.backend.server.emit("folders", await server.backend.store.folders.list());
  await expect(own(page, acme, "Label_m3")).toHaveText("Zzz renamed");
  await expect(own(page, acme, "Label_m3")).toHaveAttribute("aria-current", "page");
  await expect(page.locator(`#account-folders-${acme} [data-testid^="nav-own-${acme}-"]`)).toHaveCount(251);
});

test("Codex R9: a focused label renamed on Gmail keeps the focus (the same row, by its label)", async ({ app: page, server }) => {
  const acme = accountOf(server, "Acme Studio");
  await page.getByTestId(`nav-account-${acme}`).click();
  await own(page, acme, "Label_23").focus();
  const renamed = (await server.backend.store.folders.list()).filter((f) => f.accountId === acme).map(({ key, path, selectable }) => ({ key, path: key === "Label_23" ? ["Equipo de diseño"] : path, selectable }));
  await server.backend.store.folders.replace(acme, renamed);
  server.backend.server.emit("folders", await server.backend.store.folders.list());
  await expect(own(page, acme, "Label_23")).toHaveText("Equipo de diseño");
  await expect(own(page, acme, "Label_23")).toBeFocused();
});

test("with one account, its row opens onto its own folders alone (its standard ones are the top ones)", async ({ app: page, server }) => {
  const acme = accountOf(server, "Acme Studio");
  for (const a of await server.backend.store.accounts.list()) if (a.id !== acme) await server.backend.server.invoke("accounts.remove", { id: a.id }, ctx);
  const row = page.getByTestId(`nav-account-${acme}`);
  await expect(page.locator('[data-testid^="nav-account-"]')).toHaveCount(1);
  await expect(row).toHaveAttribute("aria-expanded", "false");
  await row.click();
  await expect(row).toHaveAttribute("aria-expanded", "true");
  // where you are stays: the top Inbox
  await expect.poll(() => listFor(page)).toEqual(["inbox", null, null, null, null, ""]);
  await expect(page.locator(`[data-testid^="nav-folder-${acme}-"]`)).toHaveCount(0);
  await expect(own(page, acme, "Label_21")).toBeVisible();
  await own(page, acme, "Label_22").click();
  await expect.poll(() => listFor(page)).toEqual(["all", acme, null, null, null, "Label_22", ""]);
  await expect(own(page, acme, "Label_22")).toHaveAttribute("aria-current", "page");
});
