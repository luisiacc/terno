/**
 * Plan 17: the People filter, everywhere the quick filters are (Lumen's
 * chips, the "Filtered by" menu of macOS and Atelier, the palette), and
 * Lumen's "· M waiting for your reply", which filters to those conversations.
 * The People flow is @design: it holds in every design.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { waitingCutoff, type DesignId, type ListFilter } from "@terno/core";
import type { DevServer } from "../../backend-dev/src/server";
import { sqlDb } from "../../backend-dev/src/server";
import { E2E_NOW } from "./constants";
import { expect, focusList, selectedRow, test } from "./fixtures";

const ctx = { clientId: "setup", origin: "dev" as const };
const db = (server: DevServer) => sqlDb(server.backend.store);
const ids = (server: DevServer, where: string, ...params: number[]) => db(server).all<{ id: number }>(`SELECT id FROM threads WHERE ${where}`, ...params).map((r) => r.id);
const loadedIds = (page: Page) => page.evaluate(() => (window as unknown as { __terno: { loadedIds(): number[] } }).__terno.loadedIds());
const showing = (page: Page, filter: string | null) => expect(page.getByTestId("thread-list")).toHaveAttribute("data-results-for", new RegExp(`,${filter ? `"${filter}"` : "null"},"[^"]*"\\]$`));
const cutoff = waitingCutoff(E2E_NOW);
const waitingInInbox = (server: DevServer, accountId?: number) => ids(server, `in_inbox = 1 AND waiting_since >= ?${accountId === undefined ? "" : ` AND account_id = ${accountId}`}`, cutoff);

/** A quick filter through the design's own control: Lumen's chips, the others' "Filtered by" menu. */
async function chooseFilter(page: Page, design: DesignId | null, filter: ListFilter): Promise<void> {
  if (design === "lumen" || design === null) {
    await page.getByTestId(`quick-filter-${filter}`).click();
    return;
  }
  if ((await page.getByTestId("unread-filter").getAttribute("aria-pressed")) !== "true") await page.getByTestId("unread-filter").click();
  await page.getByTestId("filter-criterion").click();
  await page.getByTestId(`filter-option-${filter}`).click();
}

test.describe("the People filter", { tag: "@design" }, () => {
  test("keeps the conversations whose newest inbound mail is from a person; the open one stays until the selection moves", async ({ app: page, server, design }) => {
    await chooseFilter(page, design, "people");
    await showing(page, "people");
    const people = new Set(ids(server, "person = 1"));
    const shown = await loadedIds(page);
    expect(shown.length).toBeGreaterThan(5);
    expect(shown.every((id) => people.has(id))).toBe(true);
    // newsletters and notifications are left out, people's conversations are in
    const newsletters = ids(server, "in_inbox = 1 AND id IN (SELECT thread_id FROM messages WHERE list_id IS NOT NULL)");
    expect(newsletters.length).toBeGreaterThan(0);
    expect(shown.some((id) => newsletters.includes(id))).toBe(false);
    // the open thread stays put while it is open: a no-reply notice lands in it (its newest inbound mail is a machine's now)
    const first = page.locator("[data-testid=thread-row]").first();
    const id = Number(await first.getAttribute("data-thread-id"));
    await first.dispatchEvent("mousedown");
    await expect(selectedRow(page)).toHaveAttribute("data-thread-id", String(id));
    const last = db(server).get<{ account_id: number; rfc_message_id: string }>(`SELECT account_id, rfc_message_id FROM messages WHERE thread_id = ${id} ORDER BY date DESC, id DESC LIMIT 1`)!;
    await server.backend.store.sync.ingest(
      [
        {
          accountId: last.account_id,
          providerMsgId: "e2e-noreply",
          providerThreadId: db(server).get<{ p: string | null }>(`SELECT provider_thread_id AS p FROM threads WHERE id = ${id}`)!.p,
          rfcMessageId: "e2e-noreply@shop.test",
          inReplyTo: last.rfc_message_id,
          references: [last.rfc_message_id],
          from: { name: "Shop", email: "noreply@shop.test" },
          to: [{ name: "", email: "someone@example.com" }],
          cc: [],
          bcc: [],
          subject: "Re: your order",
          date: E2E_NOW - 60_000,
          snippet: "",
          bodyText: "Your order shipped.",
          bodyHtml: null,
          bodyState: "full",
          listId: null,
          isRead: true,
          isStarred: false,
          inInbox: true,
          isSent: false,
          isDraft: false,
          isTrash: false,
          isSpam: false,
          hasAttachments: false,
          size: 100,
        },
      ],
      { applyFilters: false, now: E2E_NOW, classifier: null },
    );
    server.backend.notifyChanged([id]);
    await expect.poll(() => db(server).get<{ p: number }>(`SELECT person AS p FROM threads WHERE id = ${id}`)!.p).toBe(0);
    await expect(page.locator(`[data-thread-id="${id}"]`)).toBeVisible();
    // once the selection moves on, the row goes
    await focusList(page);
    await page.keyboard.press("j");
    await expect(page.locator(`[data-thread-id="${id}"]`)).toHaveCount(0);
    if (design === "lumen" || design === null) await expect(page.getByTestId("quick-filter-people")).toHaveAttribute("aria-pressed", "true");
    else await expect(page.getByTestId("filter-criterion")).toContainText("People");
  });

  test("the palette offers People and Waiting, and Show all turns them off", async ({ app: page }) => {
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("palette-filter-people").click();
    await showing(page, "people");
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByTestId("palette-filter-people")).toHaveCount(0);
    await page.getByTestId("palette-filter-waiting").click();
    await showing(page, "waiting");
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("palette-filter-all").click();
    await showing(page, null);
  });
});

test.describe("macOS: the menu", () => {
  test("Filtered by → People, then Waiting for reply; the empty Waiting list says what it would hold", async ({ app: page, server }) => {
    await chooseFilter(page, "macos", "people");
    await showing(page, "people");
    await expect(page.getByTestId("filter-criterion")).toContainText("People");
    await chooseFilter(page, "macos", "waiting");
    await showing(page, "waiting");
    await expect(page.getByTestId("filter-criterion")).toContainText("Waiting for reply");
    const waiting = new Set(ids(server, "waiting_since >= ?", cutoff));
    expect((await loadedIds(page)).every((id) => waiting.has(id))).toBe(true);
    // a new, empty category: the empty state says what the filter would hold
    const c = (await server.backend.server.invoke("categories.create", { name: "Pendientes", color: "violet" }, ctx)) as { id: number };
    await page.locator(`[data-drop-target="${c.id}"]`).click();
    await chooseFilter(page, "macos", "waiting");
    await expect(page.getByTestId("unread-empty")).toHaveAttribute("data-filter", "waiting");
    await expect(page.getByTestId("unread-empty")).toContainText("Nothing is waiting for your reply");
  });
});

test.describe("Lumen: waiting for your reply", () => {
  test.use({ design: "lumen" });

  test("the greeting counts the inbox's conversations waiting for you; the count filters to them, with its chip, and clears", async ({ app: page, server }) => {
    const n = waitingInInbox(server).length;
    expect(n).toBeGreaterThan(0);
    const count = page.getByTestId("waiting-count");
    await expect(count).toHaveText(`${n} waiting for your reply`);
    await expect(page.getByTestId("list-subtitle")).toContainText(" unread · ");
    await expect(page.getByTestId("quick-filter-waiting")).toHaveCount(0);
    await count.click();
    await showing(page, "waiting");
    await expect(count).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("quick-filter-waiting")).toHaveAttribute("aria-pressed", "true");
    const waiting = new Set(waitingInInbox(server));
    const shown = await loadedIds(page);
    expect(shown.length).toBe(Math.min(n, shown.length));
    expect(shown.every((id) => waiting.has(id))).toBe(true);
    const results = await new AxeBuilder({ page }).include("[data-testid=list-header]").analyze();
    expect(results.violations).toEqual([]);
    await count.click();
    await showing(page, null);
    await expect(page.getByTestId("quick-filter-waiting")).toHaveCount(0);
    // the keyboard reaches it, and Enter toggles it like a click
    await count.focus();
    await page.keyboard.press("Enter");
    await showing(page, "waiting");
  });

  test("an account's inbox counts its own; answering one drops the count", async ({ app: page, server }) => {
    const account = db(server).get<{ account_id: number }>("SELECT account_id FROM threads WHERE in_inbox = 1 AND waiting_since >= ? GROUP BY account_id ORDER BY count(*) DESC LIMIT 1", cutoff)!.account_id;
    await page.getByTestId(`nav-account-${account}`).click();
    const mine = waitingInInbox(server, account);
    await expect(page.getByTestId("waiting-count")).toHaveText(`${mine.length} waiting for your reply`);
    // reply to the newest of them
    const target = db(server).get<{ id: number; from_email: string }>(`SELECT m.id, m.from_email FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.id = ${mine[0]} ORDER BY m.date DESC LIMIT 1`)!;
    await server.backend.server.invoke("compose.send", { accountId: account, to: [{ name: "", email: target.from_email }], subject: "Re: hola", bodyText: "Te respondo.", inReplyToMessageId: target.id }, ctx);
    await expect(page.getByTestId("waiting-count")).toHaveText(`${mine.length - 1} waiting for your reply`);
  });

  test("while the store doesn't know yet (its backfill), there is no count, never a wrong one", async ({ app: page, server }) => {
    const store = server.backend.store;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const real = store.facts.backfill.bind(store.facts);
    store.facts.backfill = async (o) => {
      await held;
      return real(o);
    };
    await store.debug.resetFacts();
    server.backend.notifyChanged([]);
    await expect(page.getByTestId("waiting-count")).toHaveCount(0);
    await expect(page.getByTestId("list-subtitle")).toContainText("unread");
    release();
    await expect.poll(() => store.facts.idle()).toBe(true);
    await expect(page.getByTestId("waiting-count")).toHaveText(`${waitingInInbox(server).length} waiting for your reply`);
  });

  test("in Spanish: the chips and the count", async ({ app: page, server }) => {
    await server.backend.server.invoke("settings.update", { language: "es" }, ctx);
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await expect(page.getByTestId("quick-filter-people")).toHaveText("Personas");
    const n = waitingInInbox(server).length;
    await expect(page.getByTestId("waiting-count")).toHaveText(`${n} ${n === 1 ? "espera" : "esperan"} tu respuesta`);
  });
});
