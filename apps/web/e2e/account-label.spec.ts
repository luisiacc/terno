/**
 * Plan 23: in views across accounts, each row names the account its mail came to (Apple Mail's
 * All Inboxes). Tagged @design: every flow runs in macOS, Lumen and Atelier, in both densities.
 */
import type { Page } from "@playwright/test";
import { DESIGNS } from "../../../packages/ui/src/designs/index";
import { sqlDb, type DevServer } from "../../backend-dev/src/server";
import { expect, rows, search, test } from "./fixtures";

const ctx = { clientId: "setup", origin: "dev" as const };
const labels = (page: Page) => page.getByTestId("account-label");

async function design(page: Page) {
  const id = await page.locator("html").getAttribute("data-design");
  return DESIGNS.find((d) => d.id === id)!;
}

async function setDensity(page: Page, server: DevServer, density: "comfortable" | "compact") {
  await server.backend.server.invoke("settings.update", { density }, ctx);
  await page.reload();
  await page.locator("[data-ready]").waitFor();
  await rows(page).first().waitFor();
}

/** Every visible row's label is its own thread's account (as the backend has it). */
async function expectLabelsMatch(page: Page, server: DevServer, name: (a: { display_name: string; email: string }) => string = (a) => a.display_name) {
  const db = sqlDb(server.backend.store);
  const shown = await rows(page).evaluateAll((els) => els.slice(0, 20).map((e) => [Number(e.getAttribute("data-thread-id")), e.querySelector("[data-testid=account-label]")?.textContent ?? null] as const));
  expect(shown.length).toBeGreaterThan(5);
  for (const [id, text] of shown) {
    const a = db.get<{ display_name: string; email: string }>("SELECT a.display_name, a.email FROM threads t JOIN accounts a ON a.id = t.account_id WHERE t.id = ?", id)!;
    expect(text, `thread ${id}`).toBe(name(a));
  }
}

/** Nothing a row draws leaves its box (a fixed-height row hides overflow from the height checks); what an ancestor clips doesn't count. */
async function expectContained(page: Page) {
  const escaped = await rows(page).evaluateAll((els) => {
    const out: string[] = [];
    for (const row of els.slice(0, 20)) {
      const r = row.getBoundingClientRect();
      for (const el of row.querySelectorAll<HTMLElement>("*")) {
        if (el.closest(".sr-only")) continue;
        const b = el.getBoundingClientRect();
        let [left, right, top, bottom] = [b.left, b.right, b.top, b.bottom];
        for (let p = el.parentElement; p && p !== row; p = p.parentElement) {
          const s = getComputedStyle(p);
          if (s.overflowX === "visible" && s.overflowY === "visible") continue;
          const c = p.getBoundingClientRect();
          [left, right, top, bottom] = [Math.max(left, c.left), Math.min(right, c.right), Math.max(top, c.top), Math.min(bottom, c.bottom)];
        }
        if (right - left <= 0 || bottom - top <= 0) continue;
        if (left < r.left - 0.5 || right > r.right + 0.5 || top < r.top - 0.5 || bottom > r.bottom + 0.5) out.push(`${row.getAttribute("data-thread-id")}: ${el.dataset.testid ?? el.tagName}`);
      }
    }
    return out;
  });
  expect(escaped).toEqual([]);
}

test.describe("the receiving account on rows", { tag: "@design" }, () => {
  test("the unified inbox names each row's account under the date (before it in compact), muted, within the row, and read out once at the end", async ({ app: page, server }) => {
    const d = await design(page);
    for (const density of ["comfortable", "compact"] as const) {
      if (density === "compact") await setDensity(page, server, "compact");
      await expect(rows(page).first()).toHaveCSS("height", `${d.rows[density]}px`);
      await expect(labels(page).first()).toBeVisible();
      await expectLabelsMatch(page, server);
      await expectContained(page);
      const row = rows(page).first();
      const label = (await row.getByTestId("account-label").boundingBox())!;
      const date = (await row.getByTestId("row-date").boundingBox())!;
      if (density === "comfortable") {
        // its own line, under the date, ending where the date ends
        expect(label.y).toBeGreaterThan(date.y + date.height / 2);
        expect(Math.abs(label.x + label.width - (date.x + date.width))).toBeLessThanOrEqual(1.5);
      } else {
        expect(label.x + label.width).toBeLessThanOrEqual(date.x);
        expect(Math.abs(label.y + label.height / 2 - (date.y + date.height / 2))).toBeLessThanOrEqual(2);
      }
      // the visible label is hidden from assistive tech; the row's name ends with it, once
      await expect(row.getByTestId("account-label")).toHaveAttribute("aria-hidden", "true");
      const name = await row.getByTestId("account-label").textContent();
      await expect(row).toHaveAccessibleName(new RegExp(`, to ${name}$`));
      // muted text (the snippet's color), never the strong foreground
      const [labelColor, snippetColor] = await row.evaluate((r) => [getComputedStyle(r.querySelector("[data-testid=account-label]")!).color, getComputedStyle(r.querySelector(".text-muted-foreground")!).color]);
      expect(labelColor).toBe(snippetColor);
    }
    await setDensity(page, server, "comfortable");
  });

  test("an account's own mailbox shows none, and neither does a single account", async ({ app: page, server }) => {
    await expect(labels(page).first()).toBeVisible();
    const accounts = await server.backend.store.accounts.list();
    await page.getByTestId(`nav-account-${accounts[0]!.id}`).click();
    // the list shows that account's inbox ([view, account, …])
    await expect(page.getByTestId("thread-list")).toHaveAttribute("data-results-for", new RegExp(`^\\["inbox",${accounts[0]!.id},`));
    await expect(rows(page).first()).toBeVisible();
    await expect(labels(page)).toHaveCount(0);
    for (const a of accounts.slice(1)) await server.backend.server.invoke("accounts.remove", { id: a.id }, ctx);
    // the top folders are all accounts (plan 64)
    await page.getByTestId("nav-inbox").click();
    await expect(rows(page).first()).toBeVisible();
    await expect(labels(page)).toHaveCount(0);
  });

  test("a name shared by two accounts falls back to their addresses, which keep their domain; a long name truncates inside the row", async ({ app: page, server }) => {
    const [personal, acme, freelance] = await server.backend.store.accounts.list();
    await server.backend.server.invoke("accounts.update", { id: personal!.id, displayName: "Luis Cordero" }, ctx);
    await server.backend.server.invoke("accounts.update", { id: acme!.id, displayName: "luis cordero" }, ctx);
    await server.backend.server.invoke("accounts.update", { id: freelance!.id, displayName: "Freelance work for the studio downtown and its clients" }, ctx);
    const dup = new Set([personal!.id, acme!.id]);
    const ids = new Map((await server.backend.store.accounts.list()).map((a) => [a.email, a.id]));
    for (const density of ["comfortable", "compact"] as const) {
      if (density === "compact") await setDensity(page, server, "compact");
      await expect(page.getByTestId("account-label").filter({ hasText: "@gmail.com" }).first()).toBeVisible();
      await expectLabelsMatch(page, server, (a) => (dup.has(ids.get(a.email)!) ? a.email : a.display_name));
      await expectContained(page);
      // the domain is never what gets cut (the long name is)
      const domains = page.locator("[data-testid=account-label] > span:last-child", { hasText: /^@/ });
      expect(await domains.count()).toBeGreaterThan(0);
      expect(await domains.evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth).map((e) => e.textContent))).toEqual([]);
      const long = page.locator("[data-testid=account-label] > span:last-child", { hasText: /^Freelance/ }).first();
      expect(await long.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
    }
    await setDensity(page, server, "comfortable");
  });

  test("an address whose domain alone is wider than the label truncates inside it, in both densities (Codex review)", async ({ app: page, server }) => {
    const [personal, acme] = await server.backend.store.accounts.list();
    sqlDb(server.backend.store).run("UPDATE accounts SET email = ? WHERE id = ?", "ana@this-is-a-very-long-corporate-domain.example.com", acme!.id);
    await server.backend.server.invoke("accounts.update", { id: personal!.id, displayName: "Shared" }, ctx);
    await server.backend.server.invoke("accounts.update", { id: acme!.id, displayName: "Shared" }, ctx);
    for (const density of ["comfortable", "compact"] as const) {
      await setDensity(page, server, density);
      const long = page.locator("[data-testid=account-label]", { hasText: "corporate-domain" }).first();
      await expect(long).toBeVisible();
      await expectContained(page);
      // the label itself holds its parts (the domain ends in an ellipsis, it doesn't spill)
      expect(await long.evaluate((el) => [...el.children].every((c) => c.getBoundingClientRect().right <= el.getBoundingClientRect().right + 0.5))).toBe(true);
    }
    await setDensity(page, server, "comfortable");
  });

  test("search results and a category across accounts name each row's account too", async ({ app: page, server }) => {
    await search(page, "in:all factura");
    await expectLabelsMatch(page, server);
    await page.getByTestId("sidebar").getByText("Lecturas", { exact: true }).click();
    await expect(page.getByTestId("list-title")).toHaveText("Lecturas");
    await expectLabelsMatch(page, server);
  });

  test("account updates that don't change a label re-render no row; a rename re-renders only that account's rows", async ({ app: page, server }) => {
    await expect(labels(page).first()).toBeVisible();
    const renders = () => page.evaluate(() => (window as unknown as { __renders: Record<string, number> }).__renders.ThreadRow ?? 0);
    const before = await renders();
    expect(before).toBeGreaterThan(0);
    // sync-state churn: the accounts event with the same names and colors
    const accounts = await server.backend.store.accounts.list();
    for (let i = 0; i < 5; i++) {
      await server.backend.store.accounts.setSyncState(accounts[0]!.id, { status: i % 2 ? "idle" : "syncing" });
      await server.backend.emitAccounts();
    }
    await page.waitForTimeout(300);
    expect(await renders()).toBe(before);
    const renamed = accounts[1]!;
    const shown = await rows(page).evaluateAll((els) => els.map((e) => e.querySelector("[data-testid=account-label]")?.textContent));
    const theirs = shown.filter((t) => t === renamed.displayName).length;
    await server.backend.server.invoke("accounts.update", { id: renamed.id, displayName: "Estudio" }, ctx);
    await expect(labels(page).filter({ hasText: "Estudio" }).first()).toBeVisible();
    expect(await renders()).toBe(before + theirs);
  });
});
