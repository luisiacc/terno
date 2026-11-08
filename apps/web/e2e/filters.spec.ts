import { inEveryLook, wheelsTo } from "./helpers/looks";
import { unclipped } from "./helpers/unclipped";
import { expect, rows, search, test, scenario, freshStart } from "./fixtures";
import { sqlDb } from "../../backend-dev/src/server";

test.describe("AI filters and learned filters", () => {
  test("plan 162: the AI rule's provenance is whole, and the form's end reaches the wheel, in every design, light and dark, 1440 and 1100", { tag: "@design" }, async ({ app: page }) => {
    await freshStart(page);
    await page.getByTestId("open-filters").click();
    await page.getByTestId("ai-prompt").fill("archiva los correos de uber.com y ponlos en Facturas");
    await page.getByTestId("ai-generate").click();
    await expect(page.getByTestId("ai-explanation")).toBeVisible();
    await expect(page.getByTestId("filter-preview")).toHaveAttribute("data-ready", "true");
    await inEveryLook(page, async (where) => {
      await page.getByTestId("ai-provenance").click();
      const popover = page.getByTestId("ai-provenance-popover");
      await expect(popover, where).toBeVisible();
      expect(await unclipped(popover), where).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(popover, where).toHaveCount(0);
      await expect(page.getByTestId("filters-dialog"), where).toBeVisible();
      expect(await wheelsTo(page, page.getByTestId("filter-preview"), page.getByTestId("filter-preview").locator("li").last()), where).toBe(true);
    });
  });

  test("AI filters and learned filters", async ({ app: page, server }) => {
    await scenario("builds a filter from a Spanish prompt, previews it live and applies it", async () => {
      const db = sqlDb(server.backend.store);
      const inboxUber = () => db.get<{ c: number }>("SELECT count(*) c FROM threads WHERE in_inbox = 1 AND last_from_email = 'uber.receipts@uber.com'")!.c;
      expect(inboxUber()).toBeGreaterThan(0);

      await page.getByTestId("open-filters").click();
      await page.getByTestId("ai-prompt").fill("archiva los correos de uber.com y ponlos en Facturas");
      await page.getByTestId("ai-generate").click();
      await expect(page.getByTestId("ai-explanation")).toBeVisible();
      await expect(page.getByTestId("condition-value")).toHaveValue("uber.com");
      await expect(page.getByTestId("action-toggle-archive")).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("action-category-select")).toContainText("Facturas");
      // plan 161: the line says what the rule does, from its fields; the chosen action shows a check
      await expect(page.getByTestId("ai-explanation")).toHaveText("Domain is “uber.com” → archive and file in Facturas.");
      await expect(page.getByTestId("ai-unclear")).toHaveCount(0);
      await expect(page.getByTestId("action-toggle-archive").getByTestId("action-chosen")).toBeVisible();

      const preview = page.getByTestId("preview-count");
      await expect(preview).toHaveText(/^[1-9]\d*$/);
      const uberCount = Number(await preview.textContent());
      expect(await page.getByTestId("filter-preview").locator("li").count()).toBeGreaterThan(0);
      // pass 3: at 1100x700 the count and at least three matches are above the footer, unscrolled
      await page.setViewportSize({ width: 1100, height: 700 });
      const footer = (await page.getByTestId("filter-save-apply").boundingBox())!.y;
      const third = (await page.getByTestId("filter-preview").locator("li").nth(2).boundingBox())!;
      // the footer band starts 12 px above its button (py-3)
      expect(third.y + third.height).toBeLessThanOrEqual(footer - 12);
      await page.setViewportSize({ width: 1440, height: 900 });

      // live preview: editing the condition changes the matches
      await page.getByTestId("condition-value").fill("rappi.com");
      await expect(preview).not.toHaveText(String(uberCount));
      await page.getByTestId("condition-value").fill("uber.com");
      await expect(preview).toHaveText(String(uberCount));

      // plan 161, pass 2: the preview shows no timing, and Save and apply repeats the count it will touch
      await expect(page.getByTestId("filter-preview")).not.toContainText(/\d\s?ms\b/);
      await expect(page.getByTestId("filter-preview")).toHaveAttribute("data-ready", "true");
      await expect(page.getByTestId("filter-save-apply")).toHaveText(`Save and apply to ${uberCount} conversations`);
      // plan 162: Save is the primary; what also changes the mail already there is the secondary before it, and the
      // sample says it's a sample; the request is quoted above the rule it made
      await expect(page.getByTestId("filter-save")).not.toHaveCSS("background-image", "none");
      await expect(page.getByTestId("filter-save-apply")).toHaveCSS("background-image", "none");
      expect((await page.getByTestId("filter-save-apply").boundingBox())!.x).toBeLessThan((await page.getByTestId("filter-save").boundingBox())!.x);
      if (uberCount > 6) await expect(page.getByTestId("preview-shown")).toHaveText(" · the newest 6 shown");
      await expect(page.getByTestId("ai-request")).toHaveText("From your request“archiva los correos de uber.com y ponlos en Facturas”");
      await page.getByTestId("filter-save-apply").click();
      await expect(page.locator("[data-testid=snack]").filter({ hasText: /Rule applied to \d+ conversations/ })).toBeVisible();
      await expect(page.getByTestId("filter-item")).toContainText(["AI"]);
      await expect.poll(inboxUber).toBe(0);
      await page.keyboard.press("Escape");
      // nothing of theirs is left in the Inbox (a search everywhere still finds them, where the filter put them)
      await search(page, "in:inbox from:uber.receipts@uber.com");
      await expect(page.getByTestId("list-empty")).toBeVisible();
    });
    await scenario("plan 161: a rule that misses its request says so; the operator holds the not; closing keeps an unsaved AI rule", async () => {
      await freshStart(page);
      await page.getByTestId("open-filters").click();
      await page.getByTestId("ai-prompt").fill("make my inbox nicer");
      await page.getByTestId("ai-generate").click();
      await expect(page.getByTestId("ai-explanation")).toHaveText("Subject contains “nicer” → archive.");
      await expect(page.getByTestId("ai-unclear")).toHaveText("I couldn't turn this into a clear rule — check it below.");
      // pass 3: focus on what was built (its line, a heading), not left on the dialog
      await expect(page.getByTestId("ai-explanation")).toBeFocused();
      await expect(page.getByRole("heading", { name: /Subject contains “nicer”/ })).toBeVisible();
      // built, the box is a line: the matches are in view in a small window
      await page.setViewportSize({ width: 1100, height: 700 });
      await expect(page.getByTestId("ai-prompt")).toHaveCount(0);
      await expect(page.getByTestId("filter-preview")).toBeInViewport({ ratio: 0.3 });

      // "not" is an operator, in words; the line follows the edit
      await page.getByTestId("condition-op").click();
      await page.getByRole("option", { name: "doesn’t contain" }).click();
      await expect(page.getByTestId("ai-explanation")).toContainText("Subject doesn’t contain “nicer”");
      await expect(page.getByTestId("condition-row").getByRole("button", { name: /^(yes|not)$/ })).toHaveCount(0);
      // pass 2: the card says who wrote it once. Plan 162: as every AI surface does, the one control at its line's end,
      // opening what it did and how to check it, closed by its own Esc; Edit request puts the caret in the request
      await expect(page.getByTestId("ai-provenance-label")).toHaveText("Written with AI");
      await page.getByTestId("ai-provenance").click();
      await expect(page.getByTestId("ai-provenance-popover")).toContainText("Check the conditions and the matches before you save.");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("ai-provenance-popover")).toHaveCount(0);
      await expect(page.getByTestId("filters-dialog")).toBeVisible();
      await page.getByTestId("ai-edit-request").click();
      await expect(page.getByTestId("ai-prompt")).toBeFocused();
      // pass 3: Esc steps back a level first: the request folds back to the rule, focus on Edit request, Rules open
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("filters-dialog")).toBeVisible();
      await expect(page.getByTestId("ai-box")).toHaveAttribute("data-folded", "true");
      await expect(page.getByTestId("ai-edit-request")).toBeFocused();
      // the caret in one of the rule's fields: Esc goes to its row in the list, and the next one closes
      await page.getByTestId("filter-name").click();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("filters-dialog")).toBeVisible();
      await expect(page.getByTestId("filter-unsaved").getByRole("button").first()).toBeFocused();
      // Esc doesn't lose it: Rules opens on it again, shown as an unsaved row, with its request
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("filters-dialog")).toHaveCount(0);
      await page.getByTestId("open-filters").click();
      await expect(page.getByTestId("filter-unsaved")).toContainText("Not saved · made with AI");
      await expect(page.getByTestId("filter-unsaved")).toHaveAttribute("data-open", "true");
      await expect(page.getByTestId("ai-explanation")).toContainText("doesn’t contain “nicer”");
      await page.getByTestId("ai-edit-request").click();
      await expect(page.getByTestId("ai-prompt")).toHaveValue("make my inbox nicer");
      // New starts another beside it: the unsaved row stays, and opens it again
      await page.getByTestId("new-filter").click();
      await expect(page.getByTestId("ai-explanation")).toHaveCount(0);
      await expect(page.getByTestId("filter-unsaved")).not.toHaveAttribute("data-open");
      await page.getByTestId("filter-unsaved").getByRole("button").first().click();
      await expect(page.getByTestId("ai-explanation")).toContainText("doesn’t contain “nicer”");
      // Codex review: another rule built from New is a second row; the first isn't replaced
      await page.getByTestId("new-filter").click();
      await page.getByTestId("ai-prompt").fill("archiva los correos de uber.com y ponlos en Facturas");
      await page.getByTestId("ai-generate").click();
      await expect(page.getByTestId("ai-explanation")).toContainText("uber.com");
      await expect(page.getByTestId("filter-unsaved")).toHaveCount(2);
      await page.keyboard.press("Escape");
      await page.getByTestId("open-filters").click();
      await expect(page.getByTestId("filter-unsaved")).toHaveCount(2);
      await expect(page.getByTestId("filter-unsaved").nth(1)).toHaveAttribute("data-open", "true");
      // discarding is a choice of its own, a row at a time; then closing keeps nothing
      await page.getByTestId("filter-unsaved").nth(1).getByTestId("filter-unsaved-discard").click();
      await expect(page.getByTestId("ai-explanation")).toHaveCount(0);
      await page.getByTestId("filter-unsaved-discard").click();
      await expect(page.getByTestId("filter-unsaved")).toHaveCount(0);
      await expect(page.getByTestId("ai-explanation")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await page.getByTestId("open-filters").click();
      await expect(page.getByTestId("ai-prompt")).toHaveValue("");
      await expect(page.getByTestId("filter-unsaved")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await page.setViewportSize({ width: 1440, height: 900 });
    });
    await scenario("with AI off there is no AI box: rules are built by hand", async () => {
      await freshStart(page);
      await server.backend.server.invoke("settings.update", { ai: { provider: "none" } }, { clientId: "setup", origin: "dev" });
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await page.getByTestId("open-filters").click();
      await expect(page.getByTestId("condition-value")).toBeVisible();
      await expect(page.getByTestId("ai-prompt")).toHaveCount(0);
      await expect(page.getByTestId("ai-generate")).toHaveCount(0);
    });
    await scenario("the AI box and its palette command wait for an AI that can run: a cloud provider without its key offers neither", async () => {
      await freshStart(page);
      const ctx = { clientId: "setup", origin: "dev" } as const;
      const aiCommand = async (count: number) => {
        await page.keyboard.press("ControlOrMeta+k");
        await page.getByTestId("palette-input").fill("Create rule with AI");
        // the search row always answers, so a 0 isn't a palette not yet drawn
        const results = page.getByRole("listbox", { name: "Results" });
        await expect(results.getByRole("option", { name: "Search mail for “Create rule with AI”" })).toBeVisible();
        await expect(results.getByRole("option", { name: "Create rule with AI", exact: true })).toHaveCount(count);
        await page.keyboard.press("Escape");
      };
      await server.backend.server.invoke("settings.update", { ai: { provider: "anthropic" } }, ctx);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await aiCommand(0);
      await page.getByTestId("open-filters").click();
      await expect(page.getByTestId("condition-value")).toBeVisible();
      await expect(page.getByTestId("ai-prompt")).toHaveCount(0);
      await page.keyboard.press("Escape");

      // its key saved: now it can run
      await server.backend.server.invoke("ai.setKey", { provider: "anthropic", value: "sk-ant-e2e-0123456789" }, ctx);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await aiCommand(1);
      await page.getByTestId("open-filters").click();
      await expect(page.getByTestId("ai-prompt")).toBeVisible();
    });
    await scenario("an invalid rule can't be saved, and says why only once you try: a new one is simply not written yet", async () => {
      await freshStart(page);
      await page.getByTestId("open-filters").click();
      await expect(page.getByTestId("condition-value")).toHaveValue("");
      await expect(page.getByTestId("filter-invalid")).toHaveCount(0);
      const saved = await page.getByTestId("filter-item").count();
      await page.getByTestId("filter-save").click();
      await expect(page.getByTestId("filter-invalid")).toBeVisible();
      await expect(page.getByTestId("filter-item")).toHaveCount(saved);
      await page.getByTestId("condition-value").fill("news@tienda.com");
      await expect(page.getByTestId("filter-invalid")).toHaveCount(0);
      await page.getByTestId("action-toggle-archive").click(); // remove the only action
      await expect(page.getByTestId("filter-invalid")).toBeVisible();
      // another rule starts clean
      await page.getByTestId("new-filter").click();
      await expect(page.getByTestId("filter-invalid")).toHaveCount(0);
    });
    await scenario("plan 154: a rule on the start of mail is a pattern, with no \"not\"", async () => {
      await freshStart(page);
      await page.getByTestId("open-filters").click();
      await page.getByTestId("condition-field").click();
      await page.getByRole("option", { name: "Subject and first lines" }).click();
      // its whole name shows in the closed field (plan 161, pass 2: the name says what it covers)
      await expect(page.getByTestId("condition-field")).toHaveText("Subject and first lines");
      expect(await page.getByTestId("condition-field").locator("[data-slot=select-value]").evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= el.parentElement!.getBoundingClientRect().right)).toBe(true);
      await expect(page.getByTestId("condition-pattern-help")).toBeVisible();
      await page.getByTestId("condition-value").fill("uber|receipt");
      await expect(page.getByTestId("preview-count")).toHaveText(/^[1-9]\d*$/);
      await expect(page.getByTestId("filter-save")).toBeEnabled();
      if (process.env.ACTION_SHOTS) {
        for (const scheme of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme: scheme });
          await page.screenshot({ path: `${process.env.ACTION_SHOTS}/opening-${scheme}.png` });
        }
        await page.emulateMedia({ colorScheme: "light" });
      }
    });
    await scenario("plan 89: a pattern is checked as it's typed, saved, and applied in the background", async () => {
      await freshStart(page);
      const db = sqlDb(server.backend.store);
      const read = () => db.get<{ c: number }>("SELECT count(*) c FROM threads WHERE unread_count = 0 AND last_from_email = 'uber.receipts@uber.com'")!.c;
      await page.getByTestId("open-filters").click();
      await page.getByTestId("condition-field").click();
      await page.getByRole("option", { name: "Sender", exact: true }).click();
      await page.getByTestId("condition-op").click();
      await page.getByRole("option", { name: "matches pattern" }).click();
      const value = page.getByTestId("condition-value");
      const help = page.getByTestId("condition-pattern-help");
      await expect(help).toContainText("[0-9]+ is any number");
      // a lookahead isn't supported: said under the field, and the rule can't be saved
      await value.fill("(?=uber)");
      await expect(value).toHaveAttribute("aria-invalid", "true");
      await expect(help).toHaveText("Patterns can’t look around (?=, ?!) or refer back to a group (\\1).");
      await page.getByTestId("filter-save").click();
      await expect(page.getByTestId("filter-invalid")).toBeVisible();
      await value.fill("^uber\\.receipts@uber\\.(com|mx)$");
      await expect(value).not.toHaveAttribute("aria-invalid");
      await expect(page.getByTestId("preview-count")).toHaveText(/^[1-9]\d*$/);
      await page.getByTestId("action-toggle-archive").click();
      await page.getByTestId("action-toggle-markRead").click();
      await page.getByTestId("filter-save-apply").click();
      // the dialog is free at once; the snack follows the job to its end
      await expect(page.getByTestId("filter-save")).toBeEnabled();
      await expect(page.locator("[data-testid=snack]").filter({ hasText: /Rule applied to \d+ conversations?/ })).toBeVisible();
      await expect.poll(read).toBeGreaterThan(0);
      await expect(page.getByTestId("filter-item").first()).toBeVisible();
    });
    await scenario("the learned suggestion becomes a rule in one click", async () => {
      await freshStart(page);
      const banner = page.getByTestId("learned-banner");
      await expect(banner).toContainText("daily.morningbrew.com");
      await page.getByTestId("learned-accept").click();
      await expect(banner).toHaveCount(0);
      await page.getByTestId("open-filters").click();
      await expect(page.getByTestId("filter-item").filter({ hasText: "Learned" })).toContainText("daily.morningbrew.com");
      await expect(rows(page).first()).toBeVisible();
    });
  });

});
