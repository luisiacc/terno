/**
 * Plan 282 in the page: a rule on new mail puts it away; the Inbox's one line when it's from someone you've written to;
 * Put away, the last row under More, with its help, its sections and each row's why; the reader's box and Back to Inbox
 * with its Undo; Stop this rule for one of Terno's rules; axe in light and dark.
 */
import type { FilterRule } from "@terno/core";
import { msg } from "@terno/store/conformance";
import { axeBothModes, expect, fresh, rows, scenario, test, type DevServerFixture } from "./fixtures";
import { E2E_NOW } from "./constants";

const SHOTS = process.env.PUT_AWAY_SHOTS;
const xataka = { name: "Xataka", email: "news@xataka.test" };
const javier = { name: "Javier Ortiz", email: "javier.ortiz@acme.studio" };
const from = (email: string, actions: FilterRule["actions"]): FilterRule => ({ match: "all", conditions: [{ field: "from", op: "equals", value: email }], actions });

async function arrive(server: DevServerFixture, id: string, who: { name: string; email: string }, subject: string, at = E2E_NOW - 60_000) {
  const store = server.backend.store;
  const [account] = await store.accounts.list();
  await store.sync.ingest([msg({ accountId: account!.id, providerMsgId: id, from: who, subject, snippet: `${subject} …`, bodyText: `${subject}.`, date: at })], { applyFilters: true, now: E2E_NOW, classifier: null });
}

test.describe("Put away (plan 282)", () => {
  test("a rule's archive is put away and said why; Needs a look's Inbox line; Back to Inbox and its Undo; Stop this rule", async ({ app: page, server }) => {
    const store = server.backend.store;
    await store.filters.save({ name: "Xataka", enabled: true, source: "manual", rule: from(xataka.email, [{ type: "archive" }]) }, E2E_NOW - 86_400_000);
    await store.filters.save({ name: "Archive mail from Acme", enabled: true, source: "manual", auto: true, rule: from(javier.email, [{ type: "archive" }]) }, E2E_NOW - 10 * 86_400_000);
    const [account] = await store.accounts.list();
    // you've written to Javier
    await store.sync.ingest([msg({ accountId: account!.id, providerMsgId: "to-javier", from: { name: "Luis Cordero", email: account!.email }, to: [javier], isSent: true, inInbox: false, subject: "Presupuesto", date: E2E_NOW - 5 * 86_400_000 })], { applyFilters: false, now: E2E_NOW, classifier: null });
    await arrive(server, "xataka-1", xataka, "291 gadgets para tu escritorio");
    await arrive(server, "javier-1", javier, "Reunión de seguimiento — API de pagos", E2E_NOW - 30_000);
    await fresh(page);

    await scenario("the Inbox's line: who you've written to, Review opens Put away", async () => {
      const line = page.getByTestId("put-away-notice");
      await expect(line).toContainText("Terno put away mail from Javier Ortiz, who you’ve written to.");
      await page.getByTestId("put-away-review").click();
      await expect(page.getByTestId("list-title")).toHaveText("Put away");
      // seen: back in the Inbox, the line is gone
      await page.getByTestId("nav-inbox").click();
      await expect(line).toHaveCount(0);
      await page.getByTestId("nav-more").click();
      await page.getByTestId("nav-put-away").click();
    });

    await scenario("Put away: the last row under More, its help, Needs a look then today, each row's why", async () => {
      const slots = page.locator("#sidebar-more-folders [data-more-slot]");
      await expect(slots.last()).toHaveAttribute("data-more-slot", "putAway");
      await expect(page.getByTestId("put-away-help")).toHaveAccessibleName("About Put away");
      await page.getByTestId("put-away-help").hover();
      await expect(page.locator("[data-slot=tooltip-content]")).toContainText("What Terno and your rules moved out of the Inbox in the last 7 days");
      await expect(page.getByTestId("put-away-look-label")).toContainText("Needs a look");
      await expect(page.getByTestId("put-away-day-label")).toContainText("Today");
      await expect(rows(page)).toHaveCount(2);
      await expect(rows(page).nth(0).getByTestId("row-put-away")).toContainText("Archived by a rule Terno made on Oct 12 · you’ve written to them");
      await expect(rows(page).nth(1).getByTestId("row-put-away")).toContainText("Archived by your rule “Xataka”");
      if (SHOTS) {
        await rows(page).nth(1).click();
        await expect(page.getByTestId("put-away-box")).toBeVisible();
        for (const scheme of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme: scheme });
          await page.screenshot({ path: `${SHOTS}/put-away-${scheme}.png` });
        }
        await page.emulateMedia({ colorScheme: "light" });
      }
      await axeBothModes(page, "[data-testid=list-header]", "[role=listbox]");
    });

    await scenario("the box says why, Back to Inbox takes it back, and Undo puts it away again", async () => {
      await rows(page).filter({ hasText: "291 gadgets" }).click();
      const box = page.getByTestId("put-away-box");
      await expect(box.getByTestId("put-away-why")).toHaveText("Your rule “Xataka” archived this.");
      await expect(box.getByTestId("put-away-edit")).toBeVisible();
      await axeBothModes(page, "[data-testid=put-away-box]");
      await box.getByTestId("put-away-back").click();
      await expect(page.getByTestId("snack-message")).toHaveText("Back in the Inbox");
      await expect(rows(page)).toHaveCount(1);
      await page.keyboard.press("z");
      await expect(rows(page)).toHaveCount(2);
    });

    await scenario("Terno's own rule: Stop this rule turns it off", async () => {
      await rows(page).filter({ hasText: "Reunión de seguimiento" }).click();
      const box = page.getByTestId("put-away-box");
      await expect(box.getByTestId("put-away-why")).toHaveText("Archived by “Archive mail from Acme”, a rule Terno made on Oct 12 when you archived similar mail. You’ve written to Javier Ortiz before.");
      if (SHOTS) {
        for (const scheme of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme: scheme });
          await page.screenshot({ path: `${SHOTS}/put-away-look-${scheme}.png` });
        }
        await page.emulateMedia({ colorScheme: "light" });
      }
      await box.getByTestId("put-away-stop").click();
      await expect(page.getByTestId("snack-message")).toHaveText("The rule “Archive mail from Acme” is off");
      await expect.poll(async () => (await store.filters.list()).find((f) => f.name === "Archive mail from Acme")?.enabled).toBe(false);
    });
  });
});
