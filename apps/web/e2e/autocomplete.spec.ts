/**
 * Plan 18: autocomplete while writing. Tagged @design, so it runs in macOS,
 * Lumen and Atelier. Recipients: suggestions from the mailbox for names
 * (accents optional), initials and addresses, keyboard (↑ ↓ Enter Tab Esc ,)
 * and mouse, what's already in the draft and the user's own addresses left
 * out, pasted lists; Esc closes the list, not the draft. Body: ghost text
 * from the user's own sent mail, muted, Tab/→/Esc, typing through, a greeting
 * with the recipient's name, the setting. axe with each shown, in light and
 * dark; screenshots for the record.
 */
import { mkdirSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { Address } from "@terno/core";
import { msg } from "@terno/store/conformance";
import { expect, focusList, openRow, test, type CapturedMail } from "./fixtures";
import type { DevServer } from "../../backend-dev/src/server";

const SHOTS = "/tmp/unica-scratch/autocomplete-18";
mkdirSync(SHOTS, { recursive: true });
const ctx = { clientId: "setup", origin: "dev" as const };
const body = (page: Page) => page.getByTestId("compose-body");
// each field has its list; the one showing
const list = (page: Page) => page.locator("[data-testid=recipient-suggestions]:not([hidden])");
const options = (page: Page) => list(page).getByTestId("recipient-suggestion");
// the ghost is a layer beside the editor (never in its text): the one showing
const ghost = (page: Page) => page.locator("[data-testid=compose-ghost]:not([hidden])");

// names and a company the demo mailbox doesn't have
const arjun: Address = { name: "Arjun Patel", email: "arjun.patel@zentrix.dev" };
const ana: Address = { name: "Zuleika Ñúñez", email: "zuleika.nunez@acme.studio" };
const anabel: Address = { name: "Zuleima Ríos", email: "zuleima@rios.mx" };
const beatriz: Address = { name: "Beatriz Quintana", email: "bea@quintana.cl" };

/** People and sentences the tests rely on, in the first account: sent mail (with recurring phrases) and received mail. */
async function seed(server: DevServer & { smtp: CapturedMail[] }): Promise<Address> {
  const [account] = await server.backend.store.accounts.list();
  const me = { name: "Luis Cordero", email: account!.email };
  const accountId = account!.id;
  const sent = (to: Address, bodyText: string, i: number) => msg({ accountId, from: me, to: [to], isSent: true, inInbox: false, isRead: true, bodyText, date: Date.UTC(2026, 9, 10, 9, i) });
  await server.backend.ingestSliced([
    ...[0, 1, 2, 3].map((i) => sent(arjun, `Hi Arjun,\n\nThe draft is attached. Let me know if you have any questions.\n\nBest,\nLuis`, i)),
    ...[4, 5, 6].map((i) => sent(ana, `Hi Zuleika,\n\nThanks for the update. Let me know if you have any questions.\n\nBest,\nLuis`, i)),
    ...[7, 8, 9].map((i) => sent({ name: "Laura Gómez", email: "laura@gomez.mx" }, `Hi Laura,\n\nLet me know if you have any questions.`, i)),
    ...[10, 11].map((i) => msg({ accountId, from: anabel, to: [me], date: Date.UTC(2026, 9, 11, 9, i) })),
  ]);
  return me;
}

async function newMessage(page: Page) {
  await focusList(page);
  await page.keyboard.press("c");
  await expect(page.getByTestId("compose-to")).toBeFocused();
}

/** Types into the body and waits for the ghost to settle (the request goes out 60 ms after the last key). */
async function typeBody(page: Page, text: string) {
  await body(page).click();
  await page.keyboard.type(text);
}

const wcag = (page: Page) => new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).disableRules(["scrollable-region-focusable"]).exclude("iframe");
async function axeClean(page: Page) {
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length)).toBe(0);
  const r = await wcag(page).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 160)).join(", ")}`)).toEqual([]);
}

test.describe("recipients", { tag: "@design" }, () => {
  test("a name prefix suggests people, written-to first; ↓ ↑ and Enter accept; the list closes", async ({ app: page, server }) => {
    await seed(server);
    await newMessage(page);
    const to = page.getByTestId("compose-to");
    await page.keyboard.type("zu");
    await expect(list(page)).toBeVisible();
    // Zuleika (written to) above Zuleima (only wrote)
    await expect(options(page).first()).toContainText("Zuleika Ñúñez");
    await expect(options(page).filter({ hasText: "Zuleima Ríos" })).toHaveCount(1);
    await expect(to).toHaveAttribute("aria-expanded", "true");
    await expect(options(page).first()).toHaveAttribute("aria-selected", "true");
    const second = options(page).nth(1);
    await page.keyboard.press("ArrowDown");
    await expect(second).toHaveAttribute("aria-selected", "true");
    await expect(to).toHaveAttribute("aria-activedescendant", (await second.getAttribute("id"))!);
    await page.keyboard.press("ArrowUp");
    await expect(options(page).first()).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(to).toHaveValue("Zuleika Ñúñez <zuleika.nunez@acme.studio>, ");
    await expect(list(page)).toBeHidden();
    // still in the field, ready for the next one; Enter didn't send
    await expect(to).toBeFocused();
    await expect(page.getByTestId("compose-to")).toBeVisible();
  });

  test("accents optional, initials, an address part; Tab and comma accept; already added and own addresses are left out", async ({ app: page, server }) => {
    const me = await seed(server);
    await newMessage(page);
    const to = page.getByTestId("compose-to");
    await page.keyboard.type("zuleika nun");
    await expect(options(page).first()).toContainText("Zuleika Ñúñez");
    // the matched parts are set apart
    await expect(options(page).first().locator("[data-match]").nth(1)).toHaveText("Ñúñ");
    await page.keyboard.press("Tab");
    await expect(to).toHaveValue("Zuleika Ñúñez <zuleika.nunez@acme.studio>, ");
    await page.keyboard.type("arjun p");
    await expect(options(page).first()).toContainText("Arjun Patel");
    await page.keyboard.press(",");
    await expect(to).toHaveValue("Zuleika Ñúñez <zuleika.nunez@acme.studio>, Arjun Patel <arjun.patel@zentrix.dev>, ");
    // Zuleika is in the field already: not again
    await page.keyboard.type("zul");
    await expect(options(page).first()).toContainText("Zuleima Ríos");
    await expect(options(page).filter({ hasText: "zuleika.nunez@acme.studio" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(list(page)).toBeHidden();
    // a complete address and a comma: the comma is typed, nothing replaced
    await to.fill("someone@new.io");
    await page.keyboard.type(",");
    await expect(to).toHaveValue("someone@new.io,");
    // my own address isn't suggested from a prefix
    await to.fill(me.email.slice(0, 4));
    await page.waitForTimeout(150);
    await expect(options(page).filter({ hasText: me.email })).toHaveCount(0);
  });

  test("the mouse: hover highlights, a click accepts and keeps focus in the field", async ({ app: page, server }) => {
    await seed(server);
    await newMessage(page);
    await page.keyboard.type("quintanilla");
    // nobody by that name: no list; then Arjun by his company's domain
    await page.waitForTimeout(150);
    await expect(list(page)).toBeHidden();
    await page.getByTestId("compose-to").fill("");
    await page.keyboard.type("zentrix");
    await expect(options(page)).toHaveCount(1);
    await options(page).first().hover();
    await expect(options(page).first()).toHaveAttribute("aria-selected", "true");
    await options(page).first().click();
    await expect(page.getByTestId("compose-to")).toHaveValue("Arjun Patel <arjun.patel@zentrix.dev>, ");
    await expect(page.getByTestId("compose-to")).toBeFocused();
  });

  test("a suggestion for what was typed before can't be accepted for what is typed now (codex review)", async ({ app: page, server }) => {
    await seed(server);
    await newMessage(page);
    await page.keyboard.type("zul");
    await expect(options(page).first()).toBeVisible();
    // the backend answers slowly from here (a huge draft being saved holds it): 3 s, without blocking anything
    const handlers = (server.backend.server as unknown as { handlers: Record<string, (...a: unknown[]) => Promise<unknown>> }).handlers;
    const real = handlers["compose.suggestRecipients"]!;
    handlers["compose.suggestRecipients"] = async (...a: unknown[]) => {
      await new Promise((r) => setTimeout(r, 3000));
      return real(...a);
    };
    try {
      await page.keyboard.type("x");
      // nobody shown matches "zulx": the list goes at once (long before the answer), and Tab doesn't put Zuleika in
      await expect(list(page)).toHaveCount(0, { timeout: 1000 });
      await page.keyboard.press("Tab");
      await expect(page.getByTestId("compose-to")).toHaveValue("zulx", { timeout: 1000 });
    } finally {
      handlers["compose.suggestRecipients"] = real;
    }
  });

  test("a pasted list is parsed into recipients", async ({ app: page, server }) => {
    await seed(server);
    await newMessage(page);
    await page.evaluate(() => {
      const el = document.querySelector<HTMLInputElement>("[data-testid=compose-to]")!;
      const data = new DataTransfer();
      data.setData("text/plain", "ana@x.io; Bob Stone <bob@stone.io>\nmailto:carla@ruiz.mx");
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect(page.getByTestId("compose-to")).toHaveValue("ana@x.io, Bob Stone <bob@stone.io>, carla@ruiz.mx, ");
  });

  test("in a reply, Esc closes the list first and the draft only on the next Esc", async ({ app: page, server }) => {
    await seed(server);
    await openRow(page, 0);
    await focusList(page);
    await page.keyboard.press("r");
    await expect(body(page)).toBeFocused();
    await page.getByTestId("compose-show-cc").click();
    await expect(page.getByTestId("compose-cc")).toBeFocused();
    await page.keyboard.type("arjun");
    await expect(list(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(list(page)).toBeHidden();
    await expect(page.getByTestId("composer")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("draft-collapsed")).toBeVisible();
  });

  for (const theme of ["light", "dark"] as const) {
    test(`axe and a screenshot with the list open (${theme})`, async ({ app: page, server, design }) => {
      await server.backend.server.invoke("settings.update", { theme }, ctx);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await seed(server);
      await newMessage(page);
      await page.keyboard.type("zu");
      await expect(options(page).first()).toBeVisible();
      await axeClean(page);
      const box = (await page.getByTestId("compose-to").boundingBox())!;
      await page.screenshot({ path: `${SHOTS}/recipients-${design ?? "lumen"}-${theme}.png`, clip: { x: Math.max(0, box.x - 120), y: Math.max(0, box.y - 60), width: 640, height: 400 } });
    });
  }
});

test.describe("ghost text", { tag: "@design" }, () => {
  test("a phrase the user keeps writing shows muted after the caret; Tab accepts it as one undo step", async ({ app: page, server }) => {
    await seed(server);
    await newMessage(page);
    await page.keyboard.type("arjun pa");
    await expect(options(page).first()).toContainText("Arjun Patel");
    await page.keyboard.press("Enter");
    await typeBody(page, "Let me know i");
    await expect(ghost(page)).toHaveAttribute("data-ghost", "f you have any questions.");
    // not part of the text (nothing to copy, nothing a find or a save sees)
    await expect(body(page)).toHaveText("Let me know i");
    // muted: the theme's muted text color, not the text's
    const [ghostColor, muted] = await ghost(page).evaluate((el) => [getComputedStyle(el).color, getComputedStyle(document.documentElement).getPropertyValue("--muted-foreground")]);
    expect(muted.trim()).not.toBe("");
    expect(ghostColor).not.toBe(await body(page).evaluate((el) => getComputedStyle(el).color));
    // it continues the line exactly: its first glyph where the typed text's last one ends, on the same baseline
    const geometry = await page.evaluate(() => {
      const text = document.querySelector("[data-testid=compose-body] p")!.firstChild as Text;
      const typed = document.createRange();
      typed.setStart(text, text.length - 1);
      typed.setEnd(text, text.length);
      const layer = document.querySelector<HTMLElement>("[data-testid=compose-ghost]:not([hidden])")!;
      const shown = document.createRange();
      shown.setStart(layer.firstChild!, 0);
      shown.setEnd(layer.firstChild!, 1);
      const a = typed.getBoundingClientRect();
      const b = shown.getBoundingClientRect();
      return { dx: b.left - a.right, dy: b.top - a.top, dh: b.height - a.height };
    });
    expect(Math.abs(geometry.dx)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.dy)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.dh)).toBeLessThanOrEqual(1);
    // announced once for screen readers
    await expect(page.getByTestId("compose-ghost-announce")).toHaveText(/f you have any questions\./);
    await page.keyboard.press("Tab");
    await expect(ghost(page)).toHaveCount(0);
    await expect(body(page)).toHaveText("Let me know if you have any questions.");
    await expect(body(page)).toBeFocused();
    await page.keyboard.press("ControlOrMeta+z");
    await expect(body(page)).toHaveText("Let me know i");
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(body(page)).toHaveText("Let me know if you have any questions.");
  });

  test("typing through consumes it, a different letter dismisses it, → takes a word", async ({ app: page, server }) => {
    await seed(server);
    await newMessage(page);
    await typeBody(page, "Let me know if");
    await expect(ghost(page)).toHaveAttribute("data-ghost", " you have any questions.");
    await page.keyboard.type(" yo");
    await expect(ghost(page)).toHaveAttribute("data-ghost", "u have any questions.");
    await page.keyboard.press("ArrowRight");
    await expect(body(page)).toHaveText("Let me know if you");
    await expect(ghost(page)).toHaveAttribute("data-ghost", " have any questions.");
    await page.keyboard.type("x");
    await expect(ghost(page)).toHaveCount(0);
    await expect(body(page)).toHaveText("Let me know if youx");
  });

  test("in a reply, Esc dismisses it and leaves the draft open; the next Esc collapses", async ({ app: page, server }) => {
    await seed(server);
    await openRow(page, 0);
    await focusList(page);
    await page.keyboard.press("r");
    await expect(body(page)).toBeFocused();
    await page.keyboard.type("Let me know if");
    await expect(ghost(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(ghost(page)).toHaveCount(0);
    await expect(page.getByTestId("composer")).toBeVisible();
    await expect(body(page)).toHaveText("Let me know if");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("draft-collapsed")).toBeVisible();
  });

  test("a greeting learns the recipient's name and fills in this draft's", async ({ app: page, server }) => {
    await seed(server);
    await newMessage(page);
    await page.keyboard.type(`${beatriz.name} <${beatriz.email}>`);
    await typeBody(page, "Hi ");
    await expect(ghost(page)).toHaveAttribute("data-ghost", "Beatriz,");
    await page.keyboard.press("Tab");
    await expect(body(page)).toHaveText("Hi Beatriz,");
  });

  test("the setting turns it off (and back on)", async ({ app: page, server }) => {
    await seed(server);
    await server.backend.server.invoke("settings.update", { composeSuggestions: false }, ctx);
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await newMessage(page);
    await typeBody(page, "Let me know if");
    await page.waitForTimeout(400);
    await expect(ghost(page)).toHaveCount(0);
    // on from Settings → General
    await focusList(page);
    await page.getByTestId("open-settings").click();
    const toggle = page.getByTestId("suggestions-switch");
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect(toggle).toBeChecked();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings-dialog")).toHaveCount(0);
    await body(page).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" ");
    await expect(ghost(page)).toHaveAttribute("data-ghost", "you have any questions.");
  });

  test("near the end of a line only the words that fit show, never wrapping over the text below (codex review)", async ({ app: page, server }) => {
    await seed(server);
    await newMessage(page);
    await body(page).click();
    // a long line ending with the habit's start, a line of text below it
    await page.keyboard.press("Enter");
    await page.keyboard.type("Below.");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Home");
    const filler = "thanks again for everything you did for the whole team this week, it really made the difference ".repeat(2);
    await page.evaluate((t) => document.execCommand("insertText", false, t), filler);
    await page.keyboard.type("Let me know if", { delay: 20 });
    await page.waitForTimeout(400);
    const shown = await page.evaluate(() => {
      const layer = document.querySelector<HTMLElement>("[data-testid=compose-ghost]:not([hidden])");
      if (!layer) return null;
      const p = document.querySelector("[data-testid=compose-body] p")!;
      return { h: layer.getBoundingClientRect().height, line: parseFloat(getComputedStyle(p).lineHeight), text: layer.dataset.ghost! };
    });
    // either nothing fits, or what shows stays on the caret's line, a start of the suggestion
    if (shown) {
      expect(shown.h).toBeLessThanOrEqual(shown.line * 1.5);
      expect(" you have any questions.".startsWith(shown.text)).toBe(true);
    }
  });

  test("an IME composition dismisses the ghost: cancelled, Tab inserts nothing unseen (codex review)", async ({ app: page, server }) => {
    await seed(server);
    await newMessage(page);
    await typeBody(page, "Let me know if");
    await expect(ghost(page)).toBeVisible();
    await body(page).evaluate((el) => {
      el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
    });
    await expect(ghost(page)).toHaveCount(0);
    await page.keyboard.press("Tab");
    await expect(body(page)).toHaveText("Let me know if");
  });

  for (const theme of ["light", "dark"] as const) {
    test(`axe and a screenshot with a ghost shown (${theme})`, async ({ app: page, server, design }) => {
      await server.backend.server.invoke("settings.update", { theme }, ctx);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await seed(server);
      await openRow(page, 0);
      await focusList(page);
      await page.keyboard.press("r");
      await expect(body(page)).toBeFocused();
      await page.keyboard.type("Thanks for the update. Let me know i");
      await expect(ghost(page)).toBeVisible();
      await axeClean(page);
      await page.getByTestId("composer").screenshot({ path: `${SHOTS}/ghost-${design ?? "lumen"}-${theme}.png` });
    });
  }
});
