import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, rows, selectedRow, test } from "./fixtures";

for (const layout of ["list", "split"] as const) {
  test.describe(`${layout} keyboard entry`, () => {
    test.use({ layout });
    // plan 139: a layout in each mode: the highlight and contrast are the mode's, what Tab does is the layout's
    for (const theme of [layout === "list" ? "light" : "dark"] as const) {
      test(`Tab reaches the conversation list (${theme})`, { tag: "@variant" }, async ({ app: page, server }, info) => {
        await server.backend.server.invoke("settings.update", { theme }, { clientId: "setup", origin: "dev" });
        await page.reload();
        await page.locator("[data-ready]").waitFor();
        await rows(page).first().waitFor();
        if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
        else await expect(page.locator("html")).not.toHaveClass(/dark/);
        const list = page.getByRole("listbox", { name: "Conversations", exact: true });
        const inbox = page.getByTestId("nav-inbox");
        await inbox.focus();
        await expect(inbox).toBeFocused();
        let reached = false;
        const path: string[] = [];
        for (let step = 0; step < 60; step++) {
          await page.keyboard.press("Tab");
          if (await list.evaluate((node) => node === document.activeElement)) { reached = true; break; }
          path.push(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid ?? ""));
        }
        expect(reached).toBe(true);
        await expect(list).toBeFocused();
        // plan 158: sidebar, then the list's header, then the list: never a pane's edge or the reader on the way
        expect(path.filter((id) => id.startsWith("pane-handle-") || id.startsWith("action-"))).toEqual([]);
        // the focus is the highlighted row, never a ring around the whole list (plan 52)
        expect(await list.evaluate((node) => [getComputedStyle(node).outlineStyle, getComputedStyle(node).boxShadow])).toEqual(["none", "none"]);
        const active = page.locator(`[id="${await list.getAttribute("aria-activedescendant")}"]`);
        expect(await active.evaluate((e) => getComputedStyle(e, "::before").backgroundColor)).not.toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/);
        if (layout === "list") {
          const before = await list.getAttribute("aria-activedescendant");
          const next = rows(page).nth(1);
          const nextId = await next.getAttribute("data-thread-id");
          await page.keyboard.press("ArrowDown");
          await expect(list).not.toHaveAttribute("aria-activedescendant", before!);
          await expect(selectedRow(page)).toHaveAttribute("data-thread-id", nextId!);
          await expect(next).toHaveAttribute("aria-selected", "true");
          await expect(list).toHaveAttribute("aria-activedescendant", `thread-${nextId}`);
          await expect(list).toBeFocused();
          await expect(page.getByTestId("list-page")).toHaveCount(0);
        }
        expect((await new AxeBuilder({ page }).setLegacyMode().withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations.map((v) => v.id)).toEqual([]);
        const shots = process.env.LIST_KEYBOARD_SHOTS;
        if (shots) await page.screenshot({ path: join(shots, `${info.project.name}-${layout}-${theme}-list-focus.png`) });
        await page.keyboard.press("Tab");
        await expect(list).not.toBeFocused();
        expect(await list.evaluate((node) => node.contains(document.activeElement))).toBe(false);
      });
      if (layout === "split") test("the first Tab offers a way past the sidebar; the panes' edges come after the reader", async ({ app: page }) => {
        const list = page.getByRole("listbox", { name: "Conversations", exact: true });
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.keyboard.press("Tab");
        const skip = page.getByTestId("skip-to-list");
        await expect(skip).toBeFocused();
        await expect(skip).toHaveAccessibleName("Skip to conversations");
        expect(await skip.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
        await page.keyboard.press("Enter");
        await expect(list).toBeFocused();
        const after: string[] = [];
        for (let step = 0; step < 40 && !after.includes("pane-handle-list"); step++) {
          await page.keyboard.press("Tab");
          after.push(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid ?? ""));
        }
        const handle = after.indexOf("pane-handle-sidebar");
        expect(handle).toBeGreaterThan(0);
        expect(after.indexOf("action-archive")).toBeGreaterThanOrEqual(0);
        expect(after.indexOf("action-archive")).toBeLessThan(handle);
        expect(after[handle + 1]).toBe("pane-handle-list");
      });
      if (layout === "list") test("the skip link is there only while the list shows; on an empty list it lands in the list's header", async ({ app: page, server }) => {
        const skip = page.getByTestId("skip-to-list");
        await expect(skip).toHaveCount(1);
        await rows(page).first().click();
        await expect(page.getByTestId("list-page")).toBeVisible();
        await expect(skip).toHaveCount(0);
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("list-page")).toHaveCount(0);
        const c = (await server.backend.server.invoke("categories.create", { name: "Vacía", color: "violet" }, { clientId: "setup", origin: "dev" })) as { id: number };
        await page.locator(`[data-drop-target="${c.id}"]`).first().click();
        await expect(page.getByTestId("list-empty")).toBeVisible();
        await skip.focus();
        await page.keyboard.press("Enter");
        expect(await page.evaluate(() => document.activeElement?.closest("[data-testid=list-header]") !== null)).toBe(true);
      });
      if (layout === "list") test(`Tab preserves a scrolled list without a missing active descendant (${theme})`, async ({ app: page, server }) => {
        await server.backend.server.invoke("settings.update", { theme }, { clientId: "setup", origin: "dev" });
        await page.reload(); await page.locator("[data-ready]").waitFor(); await rows(page).first().waitFor();
        if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
        else await expect(page.locator("html")).not.toHaveClass(/dark/);
        const list = page.getByRole("listbox", { name: "Conversations", exact: true });
        const id = await selectedRow(page).getAttribute("data-thread-id");
        expect(id).not.toBeNull();
        await list.evaluate((node) => { node.scrollTop = 5000; });
        await expect(page.locator(`[id="thread-${id}"]`)).toHaveCount(0);
        const top = await list.evaluate((node) => node.scrollTop);
        expect(top).toBeGreaterThan(0);
        await expect(list).not.toHaveAttribute("aria-activedescendant");
        await page.getByTestId("nav-inbox").focus();
        let reached = false;
        for (let step = 0; step < 60; step++) {
          await page.keyboard.press("Tab");
          if (await list.evaluate((node) => node === document.activeElement)) { reached = true; break; }
        }
        expect(reached).toBe(true);
        expect(await list.evaluate((node) => node.scrollTop)).toBe(top);
        const selected = await page.evaluate(() => (window as unknown as { __terno: { getApp(): { selectedId: number } } }).__terno.getApp().selectedId);
        expect(String(selected)).toBe(id);
        await page.keyboard.press("ArrowDown");
        await expect(selectedRow(page)).toHaveAttribute("aria-selected", "true");
        await expect.poll(() => list.evaluate((node) => {
          const active = node.getAttribute("aria-activedescendant");
          return active !== null && node.contains(document.getElementById(active));
        })).toBe(true);
        await expect(list).toBeFocused();
      });
    }
  });
}
