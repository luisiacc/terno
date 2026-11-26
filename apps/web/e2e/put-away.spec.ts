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
      await expect(line).toContainText("Mail from Javier Ortiz, who you’ve written to, was put away.");
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
      // a click shows it as well (the QA panel clicked it)
      await page.mouse.move(0, 0);
      await expect(page.locator("[data-slot=tooltip-content]")).toHaveCount(0);
      await page.getByTestId("put-away-help").click();
      await expect(page.locator("[data-slot=tooltip-content]")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("put-away-look-label")).toHaveText("Needs a lookfrom people you’ve written to");
      await expect(page.getByTestId("put-away-day-label")).toContainText("Today");
      await expect(rows(page)).toHaveCount(2);
      await expect(rows(page).nth(0).getByTestId("row-put-away")).toHaveText("Needs a look: Archived · Terno’s rule");
      await expect(rows(page).nth(1).getByTestId("row-put-away")).toContainText("Archived · your rule “Xataka”");
      // the demo's Gmail keeps its tabs apart: said once, under the last row
      await expect(page.getByTestId("put-away-footer")).toContainText("Spam isn’t listed here.");
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
      // from the keyboard: focus goes to the list afterwards, never the toolbar's Archive (the UI rating)
      await box.getByTestId("put-away-back").focus();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("snack-message")).toHaveText("Back in the Inbox");
      await expect(page.locator("[role=listbox]")).toBeFocused();
      // the owner: it stays open and in its place (nothing opens and reads the next one); the box goes, and its row says so
      await expect(box).toHaveCount(0);
      await expect(page.getByTestId("reader-subject")).toHaveText("291 gadgets para tu escritorio");
      await expect(rows(page)).toHaveCount(2);
      await expect(rows(page).nth(1)).toHaveAttribute("data-cursor", "true");
      await expect(rows(page).nth(1).getByTestId("row-put-away")).toHaveText("Today: Back in the Inbox");
      await expect(page.getByTestId("put-away-day-label")).toContainText("Today");
      // it stays, saying so, while you're in Put away (the owner, after the third rating: one or several alike)
      await rows(page).nth(0).click();
      await expect(rows(page)).toHaveCount(2);
      await expect(rows(page).nth(1).getByTestId("row-put-away")).toHaveText("Today: Back in the Inbox");
      await page.keyboard.press("z");
      await expect(rows(page)).toHaveCount(2);
      await rows(page).filter({ hasText: "291 gadgets" }).click();
      await expect(page.getByTestId("put-away-box")).toBeVisible();
      // the rule turned off elsewhere (Rules, another window): the open box says so at once (the third rating)
      const xatakaRule = (await store.filters.list()).find((f) => f.name === "Xataka")!;
      await server.backend.server.invoke("filters.setEnabled", { ids: [xatakaRule.id], enabled: false }, { clientId: "elsewhere", origin: "dev" as const });
      await expect(page.getByTestId("put-away-why")).toContainText("That rule is off now.");
      await server.backend.server.invoke("filters.setEnabled", { ids: [xatakaRule.id], enabled: true }, { clientId: "elsewhere", origin: "dev" as const });
      await expect(page.getByTestId("put-away-why")).not.toContainText("That rule is off now.");
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
      await expect(box.getByTestId("put-away-why")).toContainText("That rule is off now.");
      await expect(box.getByTestId("put-away-stop")).toHaveCount(0);
      await expect.poll(async () => (await store.filters.list()).find((f) => f.name === "Archive mail from Acme")?.enabled).toBe(false);
    });

    await scenario("search from Put away, and Esc comes back to it", async () => {
      await page.keyboard.press("/");
      await page.keyboard.type("gadgets");
      await expect(page.getByTestId("list-title")).not.toHaveText("Put away");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("list-title")).toHaveText("Put away");
    });

    await scenario("several back at once from the selection, with one Undo; the row menu offers it too", async () => {
      await expect(rows(page)).toHaveCount(2);
      await rows(page).nth(0).click({ button: "right" });
      await expect(page.getByTestId("menu-inbox")).toHaveText(/Back to Inbox/);
      await page.keyboard.press("Escape");
      await rows(page).nth(0).click({ modifiers: ["Meta"] });
      await rows(page).nth(1).click({ modifiers: ["Meta"] });
      await page.getByTestId("bar-inbox").click();
      await expect(page.getByTestId("snack-message")).toHaveText("2 back in the Inbox");
      // several brought back stay as one does, each saying so
      await expect(rows(page)).toHaveCount(2);
      await expect(page.locator("[data-testid=row-put-away][data-returned]")).toHaveCount(2);
      await page.keyboard.press("z");
      await expect(rows(page)).toHaveCount(2);
      await expect(page.locator("[data-testid=row-put-away][data-returned]")).toHaveCount(0);
    });

    await scenario("a rule that's off: Bring back all it put away, with one Undo", async () => {
      await arrive(server, "xataka-2", xataka, "Los mejores móviles", E2E_NOW - 50_000);
      const f = (await store.filters.list()).find((x) => x.name === "Xataka")!;
      await store.filters.save({ id: f.id, name: f.name, enabled: false, source: f.source, rule: f.rule }, E2E_NOW);
      await fresh(page);
      // More stays as it was left (open)
      if (!(await page.getByTestId("nav-put-away").isVisible())) await page.getByTestId("nav-more").click();
      await page.getByTestId("nav-put-away").click();
      await expect(page.getByTestId("list-title")).toHaveText("Put away");
      await expect(rows(page)).toHaveCount(3);
      await rows(page).filter({ hasText: "291 gadgets" }).click();
      const box = page.getByTestId("put-away-box");
      await expect(box.getByTestId("put-away-why")).toHaveText("Your rule “Xataka” archived this. That rule is off now.");
      await box.getByTestId("put-away-bring-back").click();
      await expect(page.getByTestId("snack-message")).toHaveText("2 back in the Inbox");
      // both stay, saying so
      await expect(rows(page)).toHaveCount(3);
      await expect(page.locator("[data-testid=row-put-away][data-returned]")).toHaveCount(2);
      await page.keyboard.press("z");
      await expect(page.locator("[data-testid=row-put-away][data-returned]")).toHaveCount(0);
    });
  });
});
