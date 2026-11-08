/**
 * Plan 139: axe per structure, light and dark, once per surface: macOS here, then the designs holding a variant macOS lacks
 * (@variant: Lumen, Atelier). Names and roles change only with a variant, and Luma adds none. Colors don't need it:
 * contrast.test.ts holds every pair in every palette. Each surface a flow checks in macOS is reached here too, in a sweep rather
 * than a flow per design. A failure names the surface and the mode, and the rest still run. A new surface: a line here.
 *
 * Names, roles and structure can't change between light and dark; only contrast does. So each surface, once reached, is read
 * whole in light, then the OS turns dark (the app follows it live, as it does for a user on System) for `color-contrast` alone.
 */
import AxeBuilder from "@axe-core/playwright";
import type { MailboxGate } from "@terno/core/mailbox";
import type { Page } from "@playwright/test";
import { msg } from "@terno/store/conformance";
import { sqlDb } from "../../backend-dev/src/server";
import { E2E_NOW } from "./constants";
import { addRecipients, expect, focusList, navTo, openRow, rows, search, selectedRow, test, type DevServerFixture, openReview } from "./fixtures";
import { BACKUP, base, failed, fakeMain, gate, release, upd } from "./helpers/fake-main";

// the format bar's controls are what this drives (plan 158: closed by default)
test.use({ formatBar: true });

const ctx = { clientId: "setup", origin: "dev" as const };
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/** What's on screen now, or one part of it. The list is a listbox driven by the window's keys (j/k, aria-activedescendant), so its scroller isn't a tab stop. */
async function clean(page: Page, surface: string, scope?: string | string[], outside?: string) {
  // a popover still fading in would be read at partial opacity (a loop never ends, and doesn't change what it paints)
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running" && a.effect?.getTiming().iterations !== Infinity && a.id !== "snack-countdown").length), { message: `${surface}: settled` }).toBe(0);
  const scopes = [scope ?? []].flat();
  for (const s of scopes) await expect(page.locator(s).first(), `${surface} is on screen`).toBeAttached();
  // legacy: every scope leaves frames out, and the default mode opens a blank page per call to merge what frames found
  const read = async (axe: AxeBuilder, mode: string) => {
    for (const s of scopes) axe = axe.include(s);
    const { violations } = await axe.exclude(outside ?? "iframe").setLegacyMode().analyze();
    expect.soft(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 160)).join(", ")}`), `${surface}, ${mode}`).toEqual([]);
  };
  await read(new AxeBuilder({ page }).withTags(TAGS).disableRules(["scrollable-region-focusable"]), "light");
  await osMode(page, "dark");
  await read(new AxeBuilder({ page }).withRules(["color-contrast"]), "dark");
  await osMode(page, "light");
}

/** The OS's appearance: the app is on System (`start`) and repaints from its change event. */
async function osMode(page: Page, mode: "light" | "dark") {
  await page.emulateMedia({ colorScheme: mode });
  await page.waitForFunction((dark) => document.documentElement.classList.contains("dark") === dark, mode === "dark");
}

async function start(page: Page, server: DevServerFixture, patch: object = {}) {
  await server.backend.server.invoke("settings.update", { theme: "system", ...patch }, ctx);
  await page.reload();
  await page.locator("[data-ready]").waitFor();
  await rows(page).first().waitFor();
}

const id = (server: DevServerFixture, table: "categories" | "accounts", column: "name" | "display_name", value: string) => sqlDb(server.backend.store).get<{ id: number }>(`SELECT id FROM ${table} WHERE ${column} = ?`, value)!.id;
const closeAll = async (page: Page) => {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
};

test.describe("axe", { tag: "@variant" }, () => {
  test.setTimeout(120_000);
  // the sweep's rare surfaces: a provider behind a network it can switch off, an offline model, a tip
  test.use({ backendOptions: { network: true }, actionTimeout: 30_000, tips: true });

  test("the list and the reader, and what opens from them", async ({ app: page, server }) => {
    const [account] = await server.backend.store.accounts.list();
    const ingest = (place: "inbox" | "archive" | "spam" | "trash") => msg({ accountId: account!.id, providerMsgId: `sweep-${place}`, subject: "Pepinillo quarter", date: E2E_NOW - 3_600_000, from: { name: `Sender ${place}`, email: `hello@${place}.test` }, inInbox: place === "inbox", isSpam: place === "spam", isTrash: place === "trash", isRead: true, bodyText: "Numbers.", hasAttachments: place === "inbox", attachments: place === "inbox" ? [{ filename: "report.pdf", mime: "application/pdf", size: 1024 }] : [] });
    await server.backend.store.sync.ingest((["inbox", "archive", "spam", "trash"] as const).map(ingest), { applyFilters: false, now: E2E_NOW, classifier: null });
    await server.backend.store.sync.ingest([msg({ accountId: account!.id, providerMsgId: "sweep-match", subject: "With a match", date: E2E_NOW - 3_600_000, bodyText: "It says zzhallazgoaxe here." })], { applyFilters: false, now: E2E_NOW, classifier: null });
    const db = sqlDb(server.backend.store);
    const facturas = id(server, "categories", "name", "Facturas");
    const threads = db.all<{ id: number }>("SELECT t.id FROM threads t WHERE t.in_inbox = 1 AND NOT EXISTS (SELECT 1 FROM thread_categories WHERE thread_id = t.id) ORDER BY t.last_date DESC LIMIT 2");
    for (const t of threads) db.run("INSERT OR REPLACE INTO cls_decisions (thread_id, category_id, kind, p, explain_json, at) VALUES (?, ?, 'suggest', 0.91, '[]', ?)", t.id, facturas, E2E_NOW);
    await start(page, server, { ai: { provider: "fake" } });

    await openRow(page, 2);
    await expect(page.getByTestId("message").first()).toBeVisible();
    await clean(page, "the window, a conversation open");

    await page.getByTestId("action-summarize").click();
    await expect(page.getByTestId("summary-block")).toHaveAttribute("data-state", "ready");
    await clean(page, "a summary", "[data-testid=summary-block]");

    await page.getByTestId("action-remind").click();
    await page.getByTestId("remind-pick").click();
    await clean(page, "the reminder's picker", "[data-testid=remind-popover]");
    await closeAll(page);
    await selectedRow(page).click({ button: "right" });
    await clean(page, "a row's menu", "[data-testid=thread-menu]");
    await page.getByTestId("menu-remind-always").hover();
    await expect(page.getByTestId("menu-remind-always-list")).toBeVisible();
    await clean(page, "its submenu", "[data-testid=menu-remind-always-list]");
    await closeAll(page);

    await page.keyboard.press("ControlOrMeta+p");
    await page.getByTestId("print-sheet").waitFor();
    await expect(page.getByTestId("print-preview")).toHaveAttribute("data-ready", "true");
    await clean(page, "the print sheet", "[data-testid=print-sheet]", "[data-testid=print-preview]");
    await page.keyboard.press("Escape");

    await focusList(page);
    await page.keyboard.press("ControlOrMeta+k");
    await clean(page, "the palette", "[role=dialog]");
    await page.keyboard.press("Escape");
    await focusList(page);
    await page.keyboard.press("?");
    await clean(page, "the shortcuts", "[data-testid=shortcuts-dialog]");
    await page.keyboard.press("Escape");

    await page.getByTestId("open-settings").click();
    for (const tab of ["general", "appearance", "accounts", "categories", "filters", "ai", "agents", "data"]) {
      await page.getByTestId(`tab-${tab}`).click();
      await page.getByTestId(`${tab}-tab`).waitFor();
      await clean(page, `Settings, ${tab}`, "[data-testid=settings-dialog]");
    }
    await page.keyboard.press("Escape");
    await page.getByTestId("sidebar").getByRole("button", { name: "Add account", exact: true }).click();
    await clean(page, "add account", "[data-testid=add-account-dialog]");
    await page.keyboard.press("Escape");

    // the snack: plain, then an error
    await openRow(page, 3);
    await focusList(page);
    await page.keyboard.press("e");
    await expect(page.getByTestId("snack")).toContainText("Archived");
    await clean(page, "a snack", "[data-testid=snack-dock]");
    const handlers = (server.backend.server as unknown as { handlers: Record<string, (...a: unknown[]) => unknown> }).handlers;
    const act = handlers["threads.act"]!;
    handlers["threads.act"] = async () => {
      throw new Error("no connection");
    };
    await openRow(page, 3);
    await focusList(page);
    await page.keyboard.press("e");
    await expect(page.getByTestId("snack")).toHaveAttribute("data-tone", "error");
    await clean(page, "a snack with an error", "[data-testid=snack-dock]");
    handlers["threads.act"] = act;
    // the categorization snack, with its offers
    await page.locator(`[data-testid=thread-row]:not(:has([data-cat-dot="${facturas}"]))`).first().dispatchEvent("mousedown");
    await focusList(page);
    await page.keyboard.press("l");
    await page.getByTestId(`pick-category-${facturas}`).click();
    await expect(page.getByTestId("category-snackbar")).toBeVisible();
    await page.getByTestId("snackbar-similar").click();
    await expect(page.getByTestId("snackbar-offers")).toBeVisible();
    await clean(page, "the categorization snack", "[data-testid=snack-dock]");
    await page.keyboard.press("Escape");

    // plan 158: what search understands, before there's a search
    await focusList(page);
    await page.keyboard.press("/");
    await expect(page.getByTestId("search-help-panel")).toBeVisible();
    await clean(page, "what search understands", "[data-testid=search-help-panel]");
    await page.keyboard.press("Escape");
    // a search with each place's tag, then one with nothing
    await search(page, "pepinillo");
    await expect(rows(page)).toHaveCount(4);
    await clean(page, "search results", "[data-testid=thread-list]");
    expect.soft(await page.locator("[data-testid=thread-row] [data-testid=row-place]").count(), "a row's place shows").toBeGreaterThan(0);
    await rows(page).filter({ hasText: "Sender inbox" }).dispatchEvent("mousedown");
    await page.getByTestId("attachment").first().waitFor();
    await clean(page, "a message's attachment", "[data-testid=attachment]");
    // plan 158: a result open at its match, its steps; and the reader with nothing to show
    await search(page, "zzhallazgoaxe");
    await rows(page).first().click();
    await expect(page.getByTestId("reader-matches")).toBeVisible();
    await clean(page, "a result's matches", "[data-testid=reader]");
    await search(page, "zzz-nothing-here");
    await clean(page, "the reader with no results", "[data-testid=reader-search-empty]");
    await clean(page, "an empty list", "[data-testid=thread-list]");
    await page.getByTestId("search-input").fill("");

    // a category's Review, with a row's answers open
    await openReview(page, facturas);
    await rows(page).first().waitFor();
    await rows(page).first().hover();
    await page.locator(`[data-testid=row-review-always][data-thread-id="${await rows(page).first().getAttribute("data-thread-id")}"]`).click();
    await expect(page.getByTestId("review-always-subject-count")).toBeVisible();
    await clean(page, "Review, a row's answers", ["[data-testid=review-always-menu]", "[data-testid=thread-list]"]);
    await page.keyboard.press("Escape");
  });

  test("the sidebar: its places, menus and fields", async ({ app: page, server }) => {
    await start(page, server);
    const more = page.getByTestId("nav-more");
    await more.click();
    await expect(page.getByTestId("nav-trash")).toBeVisible();
    await clean(page, "the sidebar, More open", "[data-testid=sidebar]");
    await more.click();
    await navTo(page, "inbox");

    const acme = id(server, "accounts", "display_name", "Acme Studio");
    const freelance = id(server, "accounts", "display_name", "Freelance");
    await page.getByTestId(`nav-account-${freelance}`).click();
    await page.getByTestId(`nav-own-${freelance}-Facturación/2026`).click();
    await page.getByTestId(`nav-own-${freelance}-Clientes antiguos`).hover();
    await clean(page, "an account open, its folders", "#app-sidebar");
    await page.getByTestId(`nav-folder-${freelance}-sent`).hover();
    await clean(page, "an account's Sent, under the pointer", "#app-sidebar");

    await page.getByTestId(`nav-account-${acme}`).click();
    await page.getByTestId(`nav-own-${acme}-Label_21`).click({ button: "right" });
    await page.getByTestId("folder-menu-favorite").click();
    await page.getByTestId(`nav-own-${acme}-Label_21`).click({ button: "right" });
    await clean(page, "a folder's menu", `[data-testid=folder-menu-${acme}-Label_21]`);
    await page.keyboard.press("Escape");
    await page.getByTestId(`nav-own-${acme}-Label_21`).hover();
    await page.getByTestId(`folder-add-${acme}-Label_21`).click();
    await page.getByTestId(`folder-new-${acme}`).fill("Rediseño web");
    await page.getByTestId(`folder-new-${acme}`).press("Enter");
    await expect(page.getByTestId(`folder-new-${acme}-error`)).toBeVisible();
    await clean(page, "a folder's name, refused, and a favorite", "#app-sidebar");
    await page.keyboard.press("Escape");

    await page.getByTestId(`nav-account-${acme}`).click({ button: "right" });
    await page.getByTestId("account-menu-color").hover();
    await expect(page.getByTestId(`account-menu-colors-${acme}`)).toBeVisible();
    await clean(page, "an account's menu and its colors", `[data-testid=account-menu-${acme}]`);
    await closeAll(page);
    await page.getByTestId(`nav-account-${acme}`).click({ button: "right" });
    await page.getByTestId("account-menu-rename").click();
    await expect(page.getByTestId(`account-rename-input-${acme}`)).toBeFocused();
    await clean(page, "an account's name, in place", "#app-sidebar");
    await page.keyboard.press("Escape");
    await page.getByTestId(`nav-account-${acme}`).click({ button: "right" });
    await page.getByTestId("account-menu-focus").click();
    await expect(page.getByTestId("solo-back")).toBeVisible();
    await page.getByTestId("solo-title").hover();
    await clean(page, "focused on one account", "#app-sidebar");
    await page.getByTestId("solo-back").click();

    // a category: its menu, forwarding set up, its mark and the line in the reader
    const facturas = id(server, "categories", "name", "Facturas");
    await server.backend.server.invoke("filters.save", { name: "Facturas", enabled: true, source: "manual", rule: { match: "all", conditions: [{ field: "subject", op: "contains", value: "Factura" }], actions: [{ type: "addCategory", categoryId: facturas }] } }, ctx);
    await page.getByTestId(`nav-category-${facturas}`).click({ button: "right" });
    await page.getByTestId("category-menu-delete").hover();
    await clean(page, "a category's menu", `[data-testid=category-menu-${facturas}]`);
    await page.getByTestId("category-menu-forward").click();
    const dialog = page.getByTestId("category-forward-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("category-forward-to").pressSequentially("Ana <ana@books.test>, luis@books.test, ");
    await clean(page, "forwarding a category", "[data-testid=category-forward-dialog]");
    await dialog.getByTestId("category-forward-save").click();
    await expect(dialog).toBeHidden();
    const [account] = await server.backend.store.accounts.list();
    server.net.incoming.push(msg({ accountId: account!.id, providerMsgId: "sweep-factura", subject: "Factura 0099", from: { name: "Tienda", email: "facturas@shop.test" }, date: E2E_NOW - 60_000, bodyText: "Total: 10" }));
    await server.backend.syncAccount(account!.id);
    await page.getByTestId(`nav-category-${facturas}`).click();
    await rows(page).filter({ hasText: "Factura 0099" }).click();
    await expect(page.getByTestId("forward-line-item")).toHaveAttribute("data-status", "waiting");
    await clean(page, "a forward waiting: its line and the sidebar's mark", ["[data-testid=forward-line]", `[data-testid=nav-category-${facturas}]`]);
  });

  test("the composer, and what opens from it", async ({ app: page, server }) => {
    const [account] = await server.backend.store.accounts.list();
    await server.backend.ingestSliced([msg({ accountId: account!.id, from: { name: "Zuleika Ñúñez", email: "zuleika.nunez@acme.studio" }, to: [{ name: "Luis Cordero", email: account!.email }], date: E2E_NOW - 7 * 86_400_000, isRead: true })]);
    await start(page, server, { ai: { provider: "fake" } });

    await openRow(page, 0);
    await focusList(page);
    await page.keyboard.press("r");
    const body = page.getByTestId("compose-body").first();
    await expect(body).toBeFocused();
    await page.keyboard.type("Thanks for the update.");
    await clean(page, "a reply");
    await page.keyboard.press("ControlOrMeta+a");
    await page.getByTestId("format-bold").click();
    await page.getByTestId("format-color").click();
    await expect(page.getByTestId("format-color-popover")).toBeVisible();
    await clean(page, "its bar, the color popover");
    await page.getByTestId("format-color").click();
    await expect(page.getByTestId("format-color-popover")).toHaveCount(0);
    await body.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("ControlOrMeta+l");
    await expect(page.getByTestId("link-popover")).toBeVisible();
    await clean(page, "the link popover");
    await page.keyboard.press("Escape");

    await page.getByTestId("attachment-input").first().setInputFiles({ name: "notes.bin", mimeType: "application/octet-stream", buffer: Buffer.from([1, 2, 3]) });
    await expect(page.getByTestId("composer").first().getByText("notes.bin")).toBeVisible();
    await clean(page, "a draft with a file", "[data-testid=composer]");
    await page.getByTestId("compose-send-later").first().click();
    await expect(page.getByTestId("send-later-popover")).toBeVisible();
    await clean(page, "Send later", "[data-testid=send-later-popover]");
    await page.keyboard.press("Escape");
    await page.getByTestId("reader").getByTestId("compose-pin").click();
    await expect(page.getByTestId("pinned-draft")).toBeVisible();
    await clean(page, "a pinned draft", "[data-testid=pinned-draft]");
    await page.getByTestId("pinned-draft").getByTestId("compose-unpin").click();
    await expect(page.getByTestId("pinned-draft")).toHaveCount(0);

    // ⌘J: the row, then the model writing into the draft (kept going long enough to read)
    await openRow(page, 1);
    await page.keyboard.press("ControlOrMeta+j");
    await expect(page.getByTestId("ai-row-input")).toBeFocused();
    await clean(page, "⌘J's row", "[data-testid=composer]");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("ai-strip")).toBeVisible();
    await clean(page, "what the model wrote, and its strip", "[data-testid=composer]");

    // a new message: chips (an invalid one, a selected one), the list of suggestions, many collapsed
    await focusList(page);
    await page.keyboard.press("c");
    await expect(page.getByTestId("compose-to")).toBeFocused();
    await page.keyboard.type("zul");
    await expect(page.locator("[data-testid=recipient-suggestions]:not([hidden])").getByTestId("recipient-suggestion").first()).toBeVisible();
    await clean(page, "a new message, suggestions open");
    await page.getByTestId("compose-to").fill("");
    await addRecipients(page, "compose-to", "Björn Peña <bjorn.pena@acme.studio>, no-reply@shop.com, bjorn@acme");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await clean(page, "chips: an invalid one, a selected one");
    await page.getByTestId("compose-to").focus();
    await addRecipients(page, "compose-to", Array.from({ length: 12 }, (_, i) => `Persona ${i} <p${i}@example.com>`).join(", "));
    await page.getByTestId("compose-subject").fill("Sweep");
    await expect(page.getByTestId("recipient-more")).toBeVisible();
    await clean(page, "chips, collapsed");

    // a message scheduled: the strip's popover
    await focusList(page);
    await page.keyboard.press("c");
    await addRecipients(page, "compose-to", "ana@example.com");
    // (something written: a message with none asks first, plan 158)
    await page.getByTestId("compose-body").fill("Mañana.");
    await page.getByTestId("compose-send-later").click();
    await page.getByTestId("send-later-popover").getByTestId("send-later-tomorrow").click();
    await page.getByTestId("strip-scheduled").click();
    await expect(page.getByTestId("scheduled-popover")).toBeVisible();
    await clean(page, "a scheduled message", "[data-testid=scheduled-popover]");
    await page.keyboard.press("Escape");
  });

  test("what covers or sits over the window: pills, a tip, the mailbox's screens", async ({ app: page, server }) => {
    await start(page, server);
    // (before going offline: a sync's own accounts event would take this card away)
    const [account, second, third] = await server.backend.store.accounts.list();
    const views = await server.backend.accountViews(await server.backend.store.accounts.list());
    const progress: Record<number, object> = { [account!.id]: { status: "syncing", lastSyncAt: null, progress: { done: 1200, total: 5521, unit: "messages" } }, [second!.id]: { status: "syncing", lastSyncAt: null, progress: { done: 4, total: 7, unit: "folders" } }, [third!.id]: {} };
    server.backend.server.emit("accounts", views.map((a) => ({ ...a, syncState: { ...a.syncState, ...progress[a.id] } })));
    await expect(page.getByTestId("first-sync-pill")).toBeVisible();
    await clean(page, "a first sync", "[data-testid=first-sync-pill]");
    server.backend.server.emit("accounts", views);
    await expect(page.getByTestId("first-sync-pill")).toHaveCount(0);


    server.net.down = true;
    server.backend.networkChanged(false, "offline");
    const connection = page.getByTestId("connection-pill");
    await expect(connection).toBeVisible();
    await clean(page, "offline", "[data-testid=connection-pill]");
    let back!: () => void;
    server.net.hold = new Promise((r) => (back = r));
    await page.getByTestId("connection-retry").click();
    await expect(connection).toHaveAttribute("data-state", "reconnecting");
    await clean(page, "reconnecting", "[data-testid=connection-pill]");
    server.net.down = false;
    server.net.hold = null;
    back();
    server.backend.networkChanged(true, "online");
    await expect(connection).toHaveCount(0);

    await fakeMain(page);
    await upd(page, { status: "available", available: release, mode: "manual" });
    const pill = page.getByTestId("update-pill");
    await expect(pill).toBeVisible();
    await clean(page, "an update offered", "[data-testid=update-pill]");
    await upd(page, { status: "downloading", available: release, percent: 64 });
    await clean(page, "an update downloading", "[data-testid=update-pill]");
    await upd(page, { status: "available", available: release, error: { stage: "download", kind: "offline", canRetry: true } });
    await clean(page, "an update that failed", "[data-testid=update-pill]");
    await upd(page, { status: "ready", available: release, ready: release, percent: 100 });
    await clean(page, "an update ready", "[data-testid=update-pill]");
    await pill.click();
    await expect(page.getByTestId("update-popover")).toBeVisible();
    await clean(page, "the update's popover", "[data-testid=update-popover]");
    await page.keyboard.press("Escape");
    await upd(page, base);

    for (const [name, g] of [["upgrading", { kind: "upgrading", phase: "backup", from: 37, to: 38 }], ["no-room", { kind: "no-room", stage: "backup", needBytes: 3 * 2 ** 30, freeBytes: 2 * 2 ** 30, canSkipBackup: true }], ["migration", failed("migration")], ["unwritable", failed("unwritable")], ["backup", failed("backup")], ["corrupt", failed("corrupt", { backup: BACKUP, restoreFailed: "failed" })], ["newer", { kind: "newer", schema: 40, supported: 38 }], ["restoring", { kind: "restoring" }]] as const) {
      await gate(page, g as MailboxGate);
      await expect(page.getByTestId("mailbox-gate")).toHaveAttribute("data-kind", name);
      await clean(page, `the mailbox gate, ${name}`, "[data-testid=mailbox-gate]");
    }
    await gate(page, { kind: "open", restoredFrom: null });
    await upd(page, { required: "0.2.0", status: "available", available: release });
    await expect(page.getByTestId("required-update")).toBeVisible();
    await clean(page, "a required update", "[data-testid=required-update]");
    await upd(page, base);
    await expect(page.getByTestId("required-update")).toHaveCount(0);

    await page.getByTestId("new-category").click();
    await page.getByTestId("new-category-input").fill("LinkedIn");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("sidebar").getByText("LinkedIn", { exact: true })).toBeVisible();
    await expect(page.getByTestId("tip-category-inbox")).toBeVisible();
    await clean(page, "the first new category's tip", "[data-testid=tip-category-inbox]");
  });
});
