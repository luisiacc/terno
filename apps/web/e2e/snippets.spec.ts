/**
 * Plan 93: snippets. Written in Settings → Snippets with the composer's own
 * editor (autosaved), inserted with ⌘; or from ⌘K at the caret (variables
 * filled, the unfilled one selected, one undo step), filling only empty
 * fields, a new message from one, a draft saved as one, delete with Undo.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { chipsOf, expect, focusList, openRow, test, type DevServerFixture, scenario, fresh } from "./fixtures";

const input = (page: Page) => page.getByTestId("palette-input");
const selected = (page: Page) => page.getByRole("option", { selected: true });
const snackWith = (page: Page, text: string | RegExp) => page.locator("[data-testid=snack]").filter({ hasText: text });
const body = (page: Page) => page.getByTestId("compose-body");

const blank = { name: "", bodyHtml: "", bodyText: "", subject: "", to: "", cc: "", bcc: "" };
async function seed(server: DevServerFixture, s: Partial<typeof blank> & { id: string }) {
  await server.backend.server.invoke("snippets.save", { ...blank, ...s, base: null }, { clientId: "setup", origin: "dev" as const });
}
const intro = { id: "s_intro0001", name: "Intro call", bodyHtml: "<p>Thanks, <b>{first_name}</b>! Let’s talk this week.</p>", bodyText: "Thanks, {first_name}! Let’s talk this week." };

async function reply(page: Page) {
  await openRow(page, 0);
  await focusList(page);
  await page.keyboard.press("r");
  await expect(body(page)).toBeFocused();
}

test.describe("snippets", () => {
  test("written in Settings: name, bold text and a variable from the menu, autosaved", async ({ app: page, server }) => {
    await page.keyboard.press("ControlOrMeta+Comma");
    await page.getByTestId("tab-snippets").click();
    await expect(page.getByTestId("snippets-empty")).toContainText("No snippets yet");
    await page.getByTestId("settings-snippet-new").click();
    await expect(page.getByTestId("snippet-name")).toBeFocused();
    await page.keyboard.type("Follow-up");
    await page.getByTestId("snippet-body").click();
    await page.keyboard.type("Hi ");
    await page.getByTestId("snippet-variable").click();
    await page.getByTestId("snippet-variable-first_name").click();
    await page.getByTestId("snippet-body").focus();
    await page.keyboard.press("End");
    await page.keyboard.type(", ");
    await page.keyboard.press("ControlOrMeta+b");
    await page.keyboard.type("any news?");
    await expect(page.getByTestId("snippet-status")).toHaveText("Saved");
    await page.getByTestId("snippet-done").click();
    const row = page.getByTestId("settings-snippet");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Follow-up");
    await expect(row).toContainText("Hi {first_name}, any news?");
    const [stored] = (await server.backend.server.invoke("snippets.list", {}, { clientId: "t", origin: "dev" as const })) as { bodyHtml: string }[];
    expect(stored!.bodyHtml).toMatch(/<(b|strong)[^>]*>any news\?<\/(b|strong)>/);
  });

  test("⌘; in a reply: type part of the name, Enter inserts it with the first name and the bold kept; ⌘Z takes it out in one step", async ({ app: page, server }) => {
    await seed(server, intro);
    await reply(page);
    await page.keyboard.type("Hello. ");
    await page.keyboard.press("ControlOrMeta+;");
    await expect(page.getByTestId("palette-page")).toContainText("Snippets");
    await input(page).fill("intro");
    await expect(selected(page)).toContainText("Intro call");
    await page.keyboard.press("Enter");
    await expect(body(page)).toBeFocused();
    await expect(body(page)).toContainText(/Hello\. Thanks, \S+! Let’s talk this week\./);
    await expect(body(page)).not.toContainText("{first_name}");
    await expect(body(page).locator("strong, b")).toHaveCount(1);
    // its own undo step: what was typed before stays
    await page.keyboard.press("ControlOrMeta+z");
    await expect(body(page)).toHaveText("Hello. ");
  });

  test("into a reply the subject stays “Re: …”; into a new message the snippet's subject and To come in, and Undo clears them", async ({ app: page, server }) => {
    await seed(server, { ...intro, subject: "Quick call, {first_name}?", to: "Ana García <ana@example.test>" });
    await reply(page);
    await page.keyboard.press("ControlOrMeta+;");
    await input(page).fill("intro");
    await page.keyboard.press("Enter");
    await expect(body(page)).toContainText("Let’s talk this week.");
    await expect(page.getByTestId("compose-subject")).toHaveCount(0);
    await page.keyboard.press("Escape");

    await focusList(page);
    await page.keyboard.press("c");
    await expect(page.getByTestId("compose-to")).toBeFocused();
    await body(page).focus();
    await page.keyboard.press("ControlOrMeta+;");
    await input(page).fill("intro");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("compose-subject")).toHaveValue("Quick call, Ana?");
    await expect(chipsOf(page, "compose-to")).toHaveAttribute("data-email", "ana@example.test");
    await expect(body(page)).toContainText("Thanks, Ana!");
    await expect(snackWith(page, "Inserted “Intro call”")).toBeVisible();
    await snackWith(page, "Inserted").getByRole("button", { name: "Undo" }).click();
    await expect(chipsOf(page, "compose-to")).toHaveCount(0);
    await expect(page.getByTestId("compose-subject")).toHaveValue("");
    await expect(body(page)).not.toContainText("Thanks");
  });

  test("a variable it can't fill is selected: typing replaces it", async ({ app: page, server }) => {
    await seed(server, { id: "s_nobody01", name: "Greeting", bodyText: "Dear {first_name}, welcome aboard." });
    await focusList(page);
    await page.keyboard.press("c");
    await body(page).focus();
    await page.keyboard.press("ControlOrMeta+;");
    await input(page).fill("greet");
    await page.keyboard.press("Enter");
    await expect(body(page)).toBeFocused();
    await page.keyboard.type("Marta");
    await expect(body(page)).toHaveText("Dear Marta, welcome aboard.");
  });

  test("⌘K “intro” ↵ in a draft’s text inserts it; outside a draft “New message from snippet…” opens one with it", async ({ app: page, server }) => {
    await seed(server, intro);
    // ⌘K in the text itself (⌘L is the link)
    await reply(page);
    await page.keyboard.press("ControlOrMeta+k");
    await input(page).fill("intro");
    await expect(selected(page)).toContainText("Insert snippet: Intro call");
    await page.keyboard.press("Enter");
    await expect(body(page)).toContainText("Let’s talk this week.");
    await page.keyboard.press("Escape");

    await focusList(page);
    await page.keyboard.press("ControlOrMeta+k");
    await input(page).fill("new message from snippet");
    await expect(selected(page)).toHaveAttribute("data-testid", "palette-new-from-snippet");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("palette-page")).toContainText("Snippets");
    await page.getByTestId(`palette-snippet-${intro.id}`).click();
    await expect(page.getByTestId("compose-title")).toBeVisible();
    await expect(body(page)).toContainText("Let’s talk this week.");
  });

  test("a new message from a snippet is written content: closed at once, it's kept as a draft (Codex code review 1)", async ({ app: page, server }) => {
    await seed(server, { ...intro, subject: "Quick call" });
    await focusList(page);
    await page.keyboard.press("ControlOrMeta+;");
    await page.getByTestId(`palette-snippet-${intro.id}`).click();
    await expect(body(page)).toContainText("Let’s talk this week.");
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await server.backend.store.drafts.list()).map((d) => d.subject)).toContain("Quick call");
  });

  test("Save as snippet… from a draft opens the editor on its text, named for its subject", async ({ app: page }) => {
    await focusList(page);
    await page.keyboard.press("c");
    await page.getByTestId("compose-subject").fill("Weekly update");
    await body(page).click();
    await page.keyboard.type("This week we shipped snippets.");
    // at once, before any autosave
    await page.keyboard.press("ControlOrMeta+l");
    await expect(page.getByTestId("link-popover")).toBeVisible();
    // ⌘K from the link popover goes on to the palette
    await page.keyboard.press("ControlOrMeta+k");
    await input(page).fill("save as snippet");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("snippet-editor")).toBeVisible();
    await expect(page.getByTestId("snippet-name")).toBeFocused();
    await expect(page.getByTestId("snippet-name")).toHaveValue("Weekly update");
    await expect(page.getByTestId("snippet-body")).toHaveText("This week we shipped snippets.");
    await expect(page.getByTestId("snippet-subject")).toHaveValue("Weekly update");
  });

  test("delete, then Undo: the same snippet is back", async ({ app: page, server }) => {
    await seed(server, intro);
    await page.keyboard.press("ControlOrMeta+Comma");
    await page.getByTestId("tab-snippets").click();
    await page.getByTestId("settings-snippet-delete").click();
    await expect(page.getByTestId("settings-snippet")).toHaveCount(0);
    // in Settings the Undo is where it was (a snack would be under the dialog)
    await expect(page.getByTestId("settings-snippet-deleted")).toContainText("Deleted “Intro call”");
    await page.getByTestId("settings-snippet-undo").click();
    await expect(page.getByTestId("settings-snippet")).toHaveAttribute("data-snippet-id", intro.id);
  });

  test("in Spanish they're Plantillas, and the English words still find them", async ({ app: page, server }) => {
    await seed(server, intro);
    await page.keyboard.press("ControlOrMeta+Comma");
    await page.getByTestId("language-select").click();
    await page.getByTestId("language-es").click();
    await expect(page.locator("html")).toHaveAttribute("lang", "es-MX");
    await expect(page.getByTestId("tab-snippets")).toHaveText("Plantillas");
    await page.keyboard.press("Escape");
    await reply(page);
    await page.getByTestId("compose-to").focus();
    await page.keyboard.press("ControlOrMeta+k");
    await input(page).fill("snippet");
    await expect(selected(page)).toHaveAttribute("data-testid", "palette-draft-snippet");
    await expect(selected(page)).toContainText("Insertar plantilla…");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("palette-page")).toContainText("Plantillas");
  });

  test("the tab, the editor and the palette page are axe-clean, in light and dark", async ({ app: page, server }) => {
    for (const mode of ["light", "dark"] as const) {
      await scenario(mode, async () => {
        await fresh(page);
        if (mode === "light") await seed(server, { ...intro, to: "ana@example.test" });
        await page.emulateMedia({ colorScheme: mode });
        const wcag = () => new AxeBuilder({ page }).setLegacyMode().include("[role=dialog]").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
        await page.keyboard.press("ControlOrMeta+Comma");
        await page.getByTestId("tab-snippets").click();
        await expect(page.getByTestId("settings-snippet")).toHaveCount(1);
        expect((await wcag().analyze()).violations.map((v) => v.id)).toEqual([]);
        await page.getByTestId("settings-snippet-edit").click();
        await expect(page.getByTestId("snippet-body")).toContainText("Let’s talk");
        expect((await wcag().analyze()).violations.map((v) => v.id)).toEqual([]);
        await page.keyboard.press("Escape");
        await reply(page);
        await page.keyboard.press("ControlOrMeta+;");
        await expect(page.getByTestId(`palette-snippet-${intro.id}`)).toBeVisible();
        expect((await wcag().analyze()).violations.map((v) => v.id)).toEqual([]);
      });
    }
  });
});
