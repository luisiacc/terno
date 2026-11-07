// The fixed evidence of a rating (plan 158): the same screens in the same states, for one style, light and dark.
//   node scripts/ui-rating/capture.mjs <design> <outDir> [light|dark]
import { mkdirSync } from "node:fs";
import { launch, resize, setLayout, shot } from "./harness.mjs";

const REPLY = "Hi Isabella,\n\nThanks for flagging this. I looked at the payment and it went through on our side, so it may just be the bank holding it. Can you send me the error you saw?\n\nI'm free for the concert on Friday, by the way.";

async function pass(design, mode, dir) {
  const { app, page, close } = await launch({ design, dark: mode === "dark" });
  const s = (name) => shot(page, `${name}-${mode}`, dir);
  const settle = async () => { await page.mouse.move(0, 0); await page.waitForTimeout(400); };
  const blur = () => page.evaluate(() => document.activeElement?.blur());
  const rows = page.getByTestId("thread-row");
  const subject = () => page.getByTestId("reader-subject").waitFor();
  try {
    await page.waitForTimeout(1500);

    // --- Split view ---
    await settle(); await s("01-split-inbox");
    await rows.filter({ hasText: "Recomendaciones de libros" }).first().click(); await subject(); await settle(); await s("02-split-conversation");

    await rows.first().click(); await subject(); await blur();
    await page.keyboard.press("r"); await page.getByTestId("compose-body").waitFor();
    await page.keyboard.type(REPLY);
    await settle(); await s("03-split-draft-open");
    await page.keyboard.press("Escape"); await page.waitForTimeout(600); await settle(); await s("04-split-draft-collapsed");
    await blur();

    await page.keyboard.press("c"); await page.getByTestId("compose-to").waitFor();
    await settle(); await s("05-new-message-empty");
    await page.keyboard.type("marta.ruiz@example.com"); await page.keyboard.press("Enter");
    await page.getByTestId("compose-subject").fill("Friday's review");
    await page.getByTestId("compose-body").click();
    await page.keyboard.type("Hi Marta,\n\nCould we move Friday's review to the afternoon? I'd like to have the numbers from finance first.\n\nThanks!");
    await settle(); await s("06-new-message-filled");
    await page.keyboard.press("Escape"); await page.waitForTimeout(500); await blur(); await page.waitForTimeout(400);

    await page.keyboard.press("/");
    const input = page.getByTestId("search-input"); await input.waitFor();
    await input.fill("pago"); await page.waitForTimeout(900);
    await settle(); await s("07-search-results");
    await input.fill(""); await page.keyboard.press("Escape"); await page.keyboard.press("Escape"); await page.waitForTimeout(400); await blur();
    await page.keyboard.press("g"); await page.keyboard.press("i"); await page.waitForTimeout(400);

    await page.keyboard.press("Meta+k"); await page.getByTestId("palette-input").waitFor();
    await settle(); await s("08-command-palette");
    await page.keyboard.press("Escape"); await page.waitForTimeout(300);

    await rows.nth(1).click(); await rows.nth(2).click({ modifiers: ["Meta"] }); await rows.nth(3).click({ modifiers: ["Meta"] });
    await page.getByTestId("selection-bar").waitFor({ timeout: 5000 });
    await settle(); await s("09-multi-select");
    await page.keyboard.press("e"); await page.waitForTimeout(500); await s("14-archive-undo");
    await page.keyboard.press("Meta+z"); await page.waitForTimeout(500); await page.keyboard.press("Escape"); await page.waitForTimeout(300);

    await rows.nth(4).click({ button: "right" }); await page.waitForTimeout(400); await s("10-row-menu");
    await page.keyboard.press("Escape"); await page.waitForTimeout(300);

    // the list filtered, by the chip or the button the style has
    const chip = page.getByTestId("quick-filter-unread");
    const onChip = await chip.isVisible().catch(() => false);
    const filter = onChip ? chip : page.getByTestId("unread-filter");
    await filter.click(); await page.waitForTimeout(500); await settle(); await s("15-filtered-unread");
    await (onChip ? page.getByTestId("quick-filter-all") : filter).click(); await page.waitForTimeout(400);

    // a smaller window
    await resize(app, 1100, 700); await page.waitForTimeout(500);
    await rows.first().click(); await subject(); await settle(); await s("16-small-split-inbox");
    await blur(); await page.keyboard.press("r"); await page.getByTestId("compose-body").waitFor(); await settle(); await s("17-small-draft-open");
    await page.keyboard.press("Escape"); await page.waitForTimeout(400);
    await resize(app, 1440, 900); await page.waitForTimeout(500);

    // --- List layout ---
    await setLayout(page, "list"); await page.waitForTimeout(500); await blur();
    for (let i = 0; i < 2 && (await page.getByTestId("reader").isVisible().catch(() => false)); i++) { await page.keyboard.press("Meta+["); await page.waitForTimeout(400); }
    await settle(); await s("11-list-inbox");
    await rows.filter({ hasText: "Recomendaciones de libros" }).first().click(); await subject(); await settle(); await s("12-list-conversation");
    await blur(); await page.keyboard.press("r"); await page.getByTestId("compose-body").waitFor();
    await page.keyboard.type("Hey Arjun,\n\nI liked the second one. Do you have anything shorter for the flight?");
    await settle(); await s("13-list-draft-open");
  } finally { await close(); }
}

const [design, dir, only] = process.argv.slice(2);
if (!design || !dir) throw new Error("usage: capture.mjs <design> <outDir> [light|dark]");
mkdirSync(dir, { recursive: true });
for (const mode of only ? [only] : ["light", "dark"]) await pass(design, mode, dir);
