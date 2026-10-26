/**
 * Plan 16: the rich composer. Tagged @design, so it runs in macOS, Lumen and
 * Atelier: select text and click (or press the shortcut) applies to exactly
 * the selection, a caret sets what is typed next, the bar shows the state at
 * the caret; links, paste, undo, folding, keyboard and axe; drafts keep their
 * formatting; a stored hostile body runs and loads nothing.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { sqlDb } from "../../backend-dev/src/server";
import { expect, focusList, openRow, test } from "./fixtures";

const body = (page: Page) => page.getByTestId("compose-body");
const ctx = { clientId: "setup", origin: "dev" as const };

/** r on the first conversation, then a few words typed (focus in the body). */
async function reply(page: Page, text = "Hola Ana, gracias por la propuesta del viernes.") {
  await openRow(page, 0);
  await focusList(page);
  await page.keyboard.press("r");
  await expect(body(page)).toBeFocused();
  if (text) await page.keyboard.type(text);
}

/** Selects the first occurrence of `text` in the body, the way a drag would (a DOM selection the editor reads). */
async function select(page: Page, text: string) {
  // set it again on each check: a re-render settling (a save's answer, a tooltip) may land on the first one
  await expect
    .poll(() =>
      body(page).evaluate((root, text) => {
        (root as HTMLElement).focus();
        // the text may span several nodes (marks split it): map the match onto them
        const nodes: Text[] = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) nodes.push(walker.currentNode as Text);
        const all = nodes.map((n) => n.data).join("");
        const at = all.indexOf(text);
        if (at < 0) throw new Error(`no "${text}" in the body`);
        const point = (offset: number, end: boolean): [Text, number] => {
          let seen = 0;
          for (const n of nodes) {
            if (offset < seen + n.data.length || (end && offset === seen + n.data.length)) return [n, offset - seen];
            seen += n.data.length;
          }
          const last = nodes[nodes.length - 1]!;
          return [last, last.data.length];
        };
        const sel = getSelection()!;
        if (sel.toString() !== text) {
          const range = document.createRange();
          range.setStart(...point(at, false));
          range.setEnd(...point(at + text.length, true));
          sel.removeAllRanges();
          sel.addRange(range);
          return "";
        }
        return sel.toString();
      }, text),
    )
    .toBe(text);
  // the editor reads the DOM selection on selectionchange
  await page.waitForTimeout(30);
}

/** The body's HTML, without ProseMirror's own attributes. */
const html = (page: Page) => body(page).evaluate((el) => el.innerHTML.replace(/ class="[^"]*"| rel="[^"]*"/g, "").replace(/<br class="ProseMirror-trailingBreak">/g, ""));
const pressed = (l: Locator) => expect(l).toHaveAttribute("aria-pressed", "true");
const notPressed = (l: Locator) => expect(l).toHaveAttribute("aria-pressed", "false");

test.describe("formatting the selection", { tag: "@design" }, () => {
  test("bold, italic, underline and strikethrough apply to exactly the selected words, and the bar shows them", async ({ app: page }) => {
    await reply(page);
    for (const [id, tag] of [["bold", "b"], ["italic", "i"], ["underline", "u"], ["strike", "s"]] as const) {
      await select(page, "propuesta");
      await page.getByTestId(`format-${id}`).click();
      await expect(body(page).locator(tag)).toHaveText("propuesta");
      await pressed(page.getByTestId(`format-${id}`));
    }
    // nothing else changed
    await expect(body(page)).toHaveText("Hola Ana, gracias por la propuesta del viernes.");
    await select(page, "Hola");
    for (const id of ["bold", "italic", "underline", "strike"]) await notPressed(page.getByTestId(`format-${id}`));
    // all of a partly bold selection becomes bold; then all of it off (Word, Docs, Gmail)
    await select(page, "la propuesta");
    await page.getByTestId("format-bold").click();
    await expect(body(page).locator("b")).toHaveText("la propuesta");
    await page.getByTestId("format-bold").click();
    await expect(body(page).locator("b")).toHaveCount(0);
  });

  test("font, size, text color and highlight from their menus; the bar names the font at the caret", async ({ app: page }) => {
    await reply(page);
    await select(page, "propuesta");
    await page.getByTestId("format-font").click();
    await page.getByTestId("format-font-serif").click();
    await expect(body(page).locator("[data-rt-font=serif]")).toHaveText("propuesta");
    await expect(page.getByTestId("format-font")).toContainText("Serif");
    // focus went back to the text, the selection kept
    await expect(body(page)).toBeFocused();
    await page.getByTestId("format-size").click();
    await page.getByTestId("format-size-huge").click();
    await expect(body(page).locator("[data-rt-size=huge]")).toHaveText("propuesta");
    await page.getByTestId("format-color").click();
    await page.getByTestId("swatch-text-red").click();
    await page.getByTestId("swatch-highlight-yellow").click();
    await page.keyboard.press("Escape");
    await expect(body(page).locator("[data-rt-color=red]")).toHaveText("propuesta");
    await expect(body(page).locator("[data-rt-highlight=yellow]")).toHaveText("propuesta");
    await expect(body(page)).toHaveText("Hola Ana, gracias por la propuesta del viernes.");
    // Default and None take them off again
    await select(page, "propuesta");
    await page.getByTestId("format-color").click();
    await page.getByTestId("swatch-text-none").click();
    await page.getByTestId("swatch-highlight-none").click();
    await page.keyboard.press("Escape");
    await expect(body(page).locator("[data-rt-color], [data-rt-highlight]")).toHaveCount(0);
  });

  test("alignment, lists, indent, quote and remove formatting act on the lines of the selection", async ({ app: page }) => {
    await reply(page, "");
    for (const [i, line] of ["uno", "dos", "tres"].entries()) {
      if (i) await page.keyboard.press("Enter");
      await page.keyboard.type(line);
    }
    await select(page, "dos");
    await page.getByTestId("format-align").click();
    await page.getByTestId("format-align-center").click();
    await expect(body(page).locator("p", { hasText: "dos" })).toHaveCSS("text-align", "center");
    await page.getByTestId("format-indent").click();
    await expect(body(page).locator("p", { hasText: "dos" })).toHaveCSS("margin-left", "40px");
    await page.getByTestId("format-outdent").click();
    await expect(body(page).locator("p", { hasText: "dos" })).toHaveCSS("margin-left", "0px");
    await page.getByTestId("format-clear").click();
    await expect(body(page).locator("p", { hasText: "dos" })).toHaveCSS("text-align", "start");
    await page.getByTestId("format-bulleted").click();
    await expect(body(page).locator("ul li")).toHaveText(["dos"]);
    await pressed(page.getByTestId("format-bulleted"));
    // the other list kind switches the list; the same kind takes it off
    await page.getByTestId("format-numbered").click();
    await expect(body(page).locator("ol li")).toHaveText(["dos"]);
    await page.getByTestId("format-numbered").click();
    await expect(body(page).locator("ol, ul")).toHaveCount(0);
    await page.getByTestId("format-quote").click();
    await expect(body(page).locator("blockquote")).toHaveText("dos");
    await pressed(page.getByTestId("format-quote"));
    await page.getByTestId("format-quote").click();
    await expect(body(page).locator("blockquote")).toHaveCount(0);
    await expect(body(page).locator("p")).toHaveText(["uno", "dos", "tres"]);
  });

  test("with a caret, a style is for what is typed next; the bar shows it before anything is typed", async ({ app: page }) => {
    await reply(page, "Normal ");
    await page.keyboard.press("ControlOrMeta+b");
    await pressed(page.getByTestId("format-bold"));
    await page.keyboard.type("fuerte");
    await page.keyboard.press("ControlOrMeta+b");
    await page.keyboard.type(" y ");
    await page.getByTestId("format-italic").click();
    await page.keyboard.type("cursiva");
    await expect(body(page).locator("b")).toHaveText("fuerte");
    await expect(body(page).locator("i")).toHaveText("cursiva");
    await expect(body(page)).toHaveText("Normal fuerte y cursiva");
  });

  test("every shortcut: ⌘B ⌘I ⌘U ⇧⌘X, ⇧⌘7 ⇧⌘8, ⌘] ⌘[, ⌘\\, ⌘Z ⇧⌘Z", async ({ app: page }) => {
    await reply(page, "palabra");
    await select(page, "palabra");
    for (const [key, tag] of [["b", "b"], ["i", "i"], ["u", "u"], ["Shift+x", "s"]] as const) {
      await page.keyboard.press(`ControlOrMeta+${key}`);
      await expect(body(page).locator(tag)).toHaveText("palabra");
    }
    await page.keyboard.press("ControlOrMeta+\\");
    await expect(body(page).locator("b, i, u, s")).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+Shift+7");
    await expect(body(page).locator("ol li")).toHaveText(["palabra"]);
    await page.keyboard.press("ControlOrMeta+Shift+8");
    await expect(body(page).locator("ul li")).toHaveText(["palabra"]);
    await page.keyboard.press("ControlOrMeta+Shift+8");
    await expect(body(page).locator("ul")).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+]");
    await expect(body(page).locator("p")).toHaveCSS("margin-left", "40px");
    await page.keyboard.press("ControlOrMeta+[");
    await expect(body(page).locator("p")).toHaveCSS("margin-left", "0px");
    // undo walks back exactly, redo forward again
    await page.keyboard.press("ControlOrMeta+z");
    await expect(body(page).locator("p")).toHaveCSS("margin-left", "40px");
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(body(page).locator("p")).toHaveCSS("margin-left", "0px");
    // the toolbar's undo is the same history
    await page.getByTestId("format-undo").click();
    await expect(body(page).locator("p")).toHaveCSS("margin-left", "40px");
    await page.getByTestId("format-redo").click();
    await expect(body(page).locator("p")).toHaveCSS("margin-left", "0px");
  });

  test("typing - or 1. starts a list; a typed URL becomes a link; ⌘K stays out of the palette", async ({ app: page }) => {
    await reply(page, "- uno");
    await expect(body(page).locator("ul li")).toHaveText(["uno"]);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("1. primero");
    await expect(body(page).locator("ol li")).toHaveText(["primero"]);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("mira https://example.com/a ya");
    await expect(body(page).locator("a")).toHaveAttribute("href", "https://example.com/a");
    await expect(body(page).locator("a")).toHaveText("https://example.com/a");
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByTestId("link-popover")).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Commands" })).toHaveCount(0);
  });
});

test.describe("links", { tag: "@design" }, () => {
  test("⌘K links the selection; the bubble opens, edits and removes it; Enter and Esc in the popover never send or collapse", async ({ app: page }) => {
    await reply(page);
    await select(page, "propuesta");
    await page.keyboard.press("ControlOrMeta+k");
    const popover = page.getByTestId("link-popover");
    await expect(popover).toBeVisible();
    await expect(page.getByTestId("link-text")).toHaveValue("propuesta");
    await expect(page.getByTestId("link-url")).toBeFocused();
    // Esc closes the popover only: the draft stays open, focus back in the text
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
    await expect(page.getByTestId("composer")).toBeVisible();
    await expect(body(page)).toBeFocused();
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("link-url").fill("javascript:alert(1)");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("link-error")).toBeVisible();
    await expect(body(page).locator("a")).toHaveCount(0);
    await page.getByTestId("link-url").fill("acme.example/propuesta");
    await page.keyboard.press("Enter");
    await expect(popover).toHaveCount(0);
    await expect(page.getByTestId("composer")).toBeVisible();
    await expect(body(page).locator("a")).toHaveAttribute("href", "https://acme.example/propuesta");
    await expect(body(page).locator("a")).toHaveText("propuesta");
    // the caret inside it shows the bubble
    await body(page).locator("a").click();
    const bubble = page.getByTestId("link-bubble");
    await expect(bubble).toContainText("https://acme.example/propuesta");
    await page.getByTestId("link-bubble-edit").click();
    await page.getByTestId("link-text").fill("la propuesta");
    await page.getByTestId("link-url").fill("ana@example.com");
    await page.getByTestId("link-apply").click();
    await expect(body(page).locator("a")).toHaveAttribute("href", "mailto:ana@example.com");
    await expect(body(page).locator("a")).toHaveText("la propuesta");
    await body(page).locator("a").click();
    await page.getByTestId("link-bubble-remove").click();
    await expect(body(page).locator("a")).toHaveCount(0);
    await expect(body(page)).toContainText("la propuesta");
  });

  test("the Link button with nothing selected inserts the text as a link; a URL pasted over a selection links it", async ({ app: page }) => {
    await reply(page, "Ver ");
    await page.getByTestId("compose-link").click();
    await page.getByTestId("link-text").fill("el plan");
    await page.getByTestId("link-url").fill("https://plan.example");
    await page.getByTestId("link-apply").click();
    await expect(body(page).locator("a")).toHaveText("el plan");
    await page.keyboard.type(" hoy");
    await expect(body(page).locator("a")).toHaveText("el plan");
    await select(page, "hoy");
    await paste(page, { "text/plain": "https://hoy.example/x" });
    await expect(body(page).locator("a", { hasText: "hoy" })).toHaveAttribute("href", "https://hoy.example/x");
  });
});

/** A paste event as the browser sends one (the editor reads its clipboardData). */
async function paste(page: Page, data: Record<string, string>) {
  await body(page).evaluate((el, data) => {
    const dt = new DataTransfer();
    for (const [type, value] of Object.entries(data)) dt.setData(type, value);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, data);
}

test.describe("Codex review (plan 16)", { tag: "@design" }, () => {
  test("Enter right after a typed URL links it and starts the next line (no error thrown)", async ({ app: page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await reply(page, "https://example.com/x");
    await page.keyboard.press("Enter");
    await page.keyboard.type("siguiente");
    await expect(body(page).locator("a")).toHaveAttribute("href", "https://example.com/x");
    await expect(body(page).locator("p")).toHaveText(["https://example.com/x", "siguiente"]);
    expect(errors).toEqual([]);
  });

  test("a link with only its address, at a caret, goes in as the address", async ({ app: page }) => {
    await reply(page, "Ver ");
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("link-url").fill("plan.example");
    await page.keyboard.press("Enter");
    await expect(body(page).locator("a")).toHaveAttribute("href", "https://plan.example");
    await expect(body(page).locator("a")).toHaveText("https://plan.example");
  });

  test("⇧⌘V of a URL over a selection replaces it with the plain URL (no link)", async ({ app: page }) => {
    await reply(page, "uno dos tres");
    await select(page, "dos");
    await page.keyboard.down("Shift");
    await paste(page, { "text/plain": "https://plain.example" });
    await page.keyboard.up("Shift");
    await expect(body(page)).toHaveText("uno https://plain.example tres");
    await expect(body(page).locator("a")).toHaveCount(0);
  });

  test("while a send is in flight nothing edits the text: the bar is disabled, its shortcuts and undo do nothing", async ({ app: page }) => {
    await reply(page, "texto que se envía");
    await select(page, "texto");
    await page.evaluate(() => (window as unknown as { __terno: { holdSending(v: boolean): void } }).__terno.holdSending(true));
    await expect(page.getByTestId("format-bar")).toHaveAttribute("data-disabled", "");
    await page.getByTestId("format-bold").click({ force: true });
    await page.getByTestId("format-undo").click({ force: true });
    await page.keyboard.press("ControlOrMeta+b");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(body(page).locator("b")).toHaveCount(0);
    await expect(body(page)).toHaveText("texto que se envía");
    await page.evaluate(() => (window as unknown as { __terno: { holdSending(v: boolean): void } }).__terno.holdSending(false));
    await expect(page.getByTestId("format-bar")).not.toHaveAttribute("data-disabled", "");
  });
});

test.describe("before the editor has loaded", () => {
  test("what is typed into the stand-in is saved and sent, and the editor takes it over", async ({ app: page, server }) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await page.route(/\/assets\/rich-[^/]+\.js$/, async (route) => {
      await gate;
      await route.continue();
    });
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await openRow(page, 0);
    await focusList(page);
    await page.keyboard.press("r");
    const standIn = page.getByTestId("compose-body-loading");
    await expect(standIn).toBeFocused();
    await page.keyboard.type("Escrito antes de cargar");
    // saved like any draft
    await expect.poll(() => sqlDb(server.backend.store).get<{ body_text: string }>("SELECT body_text FROM drafts ORDER BY id DESC LIMIT 1")?.body_text, { timeout: 10_000 }).toBe("Escrito antes de cargar");
    // and sent as written, still before the editor loads
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect.poll(() => sqlDb(server.backend.store).get<{ body_text: string }>("SELECT b.body_text FROM messages m JOIN message_bodies b ON b.message_id = m.id WHERE m.is_sent = 1 ORDER BY m.id DESC LIMIT 1")?.body_text).toContain("Escrito antes de cargar");
    release();
  });

  test("Codex review 2: one keystroke (or one paste) into the stand-in is saved", async ({ app: page, server }) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await page.route(/\/assets\/rich-[^/]+\.js$/, async (route) => {
      await gate;
      await route.continue();
    });
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await openRow(page, 0);
    await focusList(page);
    await page.keyboard.press("r");
    await expect(page.getByTestId("compose-body-loading")).toBeFocused();
    await page.keyboard.type("x");
    await expect.poll(() => sqlDb(server.backend.store).get<{ body_text: string }>("SELECT body_text FROM drafts ORDER BY id DESC LIMIT 1")?.body_text, { timeout: 10_000 }).toBe("x");
    release();
  });

  test("Codex review 2: collapsed and reopened while loading, the stand-in still has what was typed, and the editor gets all of it", async ({ app: page }) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await page.route(/\/assets\/rich-[^/]+\.js$/, async (route) => {
      await gate;
      await route.continue();
    });
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await openRow(page, 0);
    await focusList(page);
    await page.keyboard.press("r");
    const standIn = page.getByTestId("compose-body-loading");
    await expect(standIn).toBeFocused();
    await page.keyboard.type("ab");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("draft-collapsed")).toBeVisible();
    await page.getByTestId("draft-collapsed").click();
    await expect(standIn).toHaveText("ab");
    await standIn.click();
    await page.keyboard.press("End");
    await page.keyboard.type("c");
    await expect(standIn).toHaveText("abc");
    release();
    await expect(body(page)).toHaveText("abc");
  });

  test("Codex review 3: under a send in flight the stand-in is read-only too (nothing typed then is lost)", async ({ app: page }) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await page.route(/\/assets\/rich-[^/]+\.js$/, async (route) => {
      await gate;
      await route.continue();
    });
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await openRow(page, 0);
    await focusList(page);
    await page.keyboard.press("r");
    const standIn = page.getByTestId("compose-body-loading");
    await expect(standIn).toBeFocused();
    await page.keyboard.type("A");
    await page.evaluate(() => (window as unknown as { __terno: { holdSending(v: boolean): void } }).__terno.holdSending(true));
    await expect(standIn).toHaveAttribute("contenteditable", "false");
    await page.keyboard.type("B");
    await expect(standIn).toHaveText("A");
    await page.evaluate(() => (window as unknown as { __terno: { holdSending(v: boolean): void } }).__terno.holdSending(false));
    await expect(standIn).toHaveAttribute("contenteditable", "plaintext-only");
    release();
  });

  test("the editor arriving under a focused, untouched stand-in takes the focus", async ({ app: page }) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await page.route(/\/assets\/rich-[^/]+\.js$/, async (route) => {
      await gate;
      await route.continue();
    });
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await openRow(page, 0);
    await focusList(page);
    await page.keyboard.press("r");
    await expect(page.getByTestId("compose-body-loading")).toBeFocused();
    release();
    await expect(body(page)).toBeFocused();
  });

  test("the editor takes over the stand-in's text, once, and keeps the focus", async ({ app: page }) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await page.route(/\/assets\/rich-[^/]+\.js$/, async (route) => {
      await gate;
      await route.continue();
    });
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await openRow(page, 0);
    await focusList(page);
    await page.keyboard.press("r");
    await expect(page.getByTestId("compose-body-loading")).toBeFocused();
    await page.keyboard.type("Hola");
    release();
    await expect(body(page)).toBeFocused();
    await page.keyboard.type(" Ana");
    await expect(body(page)).toHaveText("Hola Ana");
  });
});

test.describe("paste", { tag: "@design" }, () => {
  test("rich paste keeps bold, italic, lists and links and drops styles, classes, scripts and images; ⇧⌘V pastes plain text", async ({ app: page }) => {
    const requests: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("tracker.example")) requests.push(r.url());
    });
    await reply(page, "");
    await paste(page, {
      "text/html": '<meta charset="utf-8"><style>p{color:red}</style><p class="x" style="color:#123456;font-size:30px"><b>Negrita</b> y <i>cursiva</i> <span style="font-family:Comic Sans MS">rara</span><img src="https://tracker.example/p.gif" onerror="window.__pwned=1"></p><ul><li>uno</li></ul><a href="https://ok.example">ok</a> <a href="javascript:window.__pwned=1">mal</a><script>window.__pwned=1</script>',
      "text/plain": "Negrita y cursiva rara\nuno\nok mal",
    });
    await expect(body(page).locator("b")).toHaveText("Negrita");
    await expect(body(page).locator("i")).toHaveText("cursiva");
    await expect(body(page).locator("ul li")).toHaveText(["uno"]);
    await expect(body(page).locator("a")).toHaveCount(1);
    await expect(body(page).locator("a")).toHaveAttribute("href", "https://ok.example");
    expect(await html(page)).not.toMatch(/style="[^"]*(30px|#123456|Comic)|<img|class="x"|script/);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(requests).toEqual([]);
    // plain: the same clipboard, as text (the shift held, as ⇧⌘V does)
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await page.keyboard.down("Shift");
    await paste(page, { "text/html": "<b>Negrita</b>", "text/plain": "Negrita\n\nsegunda" });
    await page.keyboard.up("Shift");
    await expect(body(page).locator("b")).toHaveCount(0);
    await expect(body(page).locator("p")).toHaveText(["Negrita", "", "segunda"]);
  });
});

test.describe("the format bar", { tag: "@design" }, () => {
  test("Aa hides and shows it, remembered after a reload; shortcuts work either way", async ({ app: page }) => {
    await reply(page, "texto");
    await expect(page.getByTestId("format-bar")).toBeVisible();
    const toggle = page.getByTestId("format-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await toggle.click();
    await expect(page.getByTestId("format-bar")).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await select(page, "texto");
    await page.keyboard.press("ControlOrMeta+b");
    await expect(body(page).locator("b")).toHaveText("texto");
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await openRow(page, 0);
    await focusList(page);
    await page.keyboard.press("r");
    await expect(body(page).locator("b")).toHaveText("texto");
    await expect(page.getByTestId("format-bar")).toHaveCount(0);
    await page.getByTestId("format-toggle").click();
    await expect(page.getByTestId("format-bar")).toBeVisible();
  });

  test("one tab stop with arrows between controls; every control has a name; Enter toggles", async ({ app: page }) => {
    await reply(page, "texto");
    await select(page, "texto");
    const bar = page.getByTestId("format-bar");
    await expect(bar).toHaveAttribute("role", "toolbar");
    await expect(bar).toHaveAttribute("aria-label", "Formatting");
    // every control is named
    for (const b of await bar.locator("button").all()) expect(await b.getAttribute("aria-label")).toBeTruthy();
    await page.getByTestId("format-undo").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("format-redo")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("format-font")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("format-bold")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(body(page).locator("b")).toHaveText("texto");
    // Tab leaves the bar at once (one stop)
    await page.keyboard.press("Tab");
    await expect(bar.locator(":focus")).toHaveCount(0);
  });

  test("at the narrowest window the bar fits: the least used groups fold under More, bold and lists stay", async ({ app: page }) => {
    await page.setViewportSize({ width: 980, height: 700 });
    await reply(page, "texto");
    const bar = page.getByTestId("format-bar");
    await expect(page.getByTestId("format-more")).toBeVisible();
    for (const id of ["format-bold", "format-italic", "format-underline", "format-bulleted"]) await expect(page.getByTestId(id)).toBeVisible();
    expect(await bar.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    await select(page, "texto");
    await page.getByTestId("format-more").click();
    await page.getByTestId("format-more-popover").getByTestId("format-strike").click();
    await expect(body(page).locator("s")).toHaveText("texto");
  });

  test("a highlighted word reads in a dark theme: its ink follows the theme's wash, not the mail's dark ink", async ({ app: page, server }) => {
    await server.backend.server.invoke("settings.update", { theme: "dark" }, ctx);
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await reply(page);
    await select(page, "propuesta");
    await page.getByTestId("format-color").click();
    await page.getByTestId("swatch-highlight-yellow").click();
    await page.keyboard.press("Escape");
    const mark = body(page).locator("[data-rt-highlight=yellow]");
    await expect(mark).toHaveCSS("color", "rgb(241, 243, 244)");
    await expect(mark).toHaveCSS("background-color", "rgb(79, 69, 16)");
  });

  for (const theme of ["light", "dark"] as const) {
    test(`axe: the composer with its bar, the color popover and the link popover (${theme})`, async ({ app: page, server }) => {
      await server.backend.server.invoke("settings.update", { theme }, ctx);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await reply(page);
      await select(page, "propuesta");
      await page.getByTestId("format-bold").click();
      const wcag = () => new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).disableRules(["scrollable-region-focusable"]).exclude("iframe");
      const check = async () => {
        // a popover that is still fading in is checked mid-way otherwise (colors at partial opacity)
        await expect.poll(() => page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length)).toBe(0);
        const r = await wcag().analyze();
        expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 140)).join(", ")}`)).toEqual([]);
      };
      await check();
      await page.getByTestId("format-color").click();
      await expect(page.getByTestId("format-color-popover")).toBeVisible();
      await check();
      await page.keyboard.press("Escape");
      await select(page, "viernes");
      await page.keyboard.press("ControlOrMeta+k");
      await expect(page.getByTestId("link-popover")).toBeVisible();
      await check();
    });
  }
});

test.describe("drafts keep their formatting", { tag: "@design" }, () => {
  test("autosaved as HTML beside its text, restored after a reload exactly; collapsing keeps undo", async ({ app: page, server }) => {
    await reply(page);
    await select(page, "propuesta");
    await page.keyboard.press("ControlOrMeta+b");
    await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
    const row = sqlDb(server.backend.store).get<{ body_text: string; body_html: string }>("SELECT body_text, body_html FROM drafts ORDER BY id DESC LIMIT 1")!;
    expect(row.body_text).toBe("Hola Ana, gracias por la propuesta del viernes.");
    expect(row.body_html).toBe("<div>Hola Ana, gracias por la <b>propuesta</b> del viernes.</div>");
    // collapse and reopen: the same document, undo still there
    await page.keyboard.press("Escape");
    await page.getByTestId("draft-collapsed").click();
    await expect(body(page).locator("b")).toHaveText("propuesta");
    await page.getByTestId("format-undo").click();
    await expect(body(page).locator("b")).toHaveCount(0);
    await page.getByTestId("format-redo").click();
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await openRow(page, 0);
    await focusList(page);
    await page.keyboard.press("r");
    await expect(body(page).locator("b")).toHaveText("propuesta");
    await expect(body(page)).toHaveText("Hola Ana, gracias por la propuesta del viernes.");
  });

  test("a plain draft from before opens as its text, untouched until edited", async ({ app: page, server }) => {
    const db = sqlDb(server.backend.store);
    const m = db.get<{ id: number; thread_id: number; account_id: number }>("SELECT m.id, m.thread_id, m.account_id FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.in_inbox = 1 ORDER BY t.last_date DESC, m.date DESC LIMIT 1")!;
    const text = "Línea uno\n\n> no es una cita\n  sangría y\ttab";
    await server.backend.store.drafts.save({ accountId: m.account_id, threadId: m.thread_id, mode: "reply", to: [{ name: "", email: "ana@example.com" }], cc: [], subject: "Re: x", bodyText: text, inReplyToMessageId: m.id }, Date.now());
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await openRow(page, 0);
    await focusList(page);
    await page.keyboard.press("r");
    await expect(body(page).locator("p")).toHaveText(["Línea uno", "", "> no es una cita", "  sangría y\ttab"]);
    await page.waitForTimeout(1200);
    expect(db.get<{ body_text: string; body_html: string }>("SELECT body_text, body_html FROM drafts ORDER BY id DESC LIMIT 1")).toEqual({ body_text: text, body_html: "" });
  });

  test("a stored body with hostile HTML (an import, an agent): nothing runs, nothing loads, its text shows", async ({ app: page, server }) => {
    const requests: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("evil.example")) requests.push(r.url());
    });
    const db = sqlDb(server.backend.store);
    const m = db.get<{ id: number; thread_id: number; account_id: number }>("SELECT m.id, m.thread_id, m.account_id FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.in_inbox = 1 ORDER BY t.last_date DESC, m.date DESC LIMIT 1")!;
    await server.backend.store.drafts.save(
      { accountId: m.account_id, threadId: m.thread_id, mode: "reply", to: [], cc: [], subject: "Re: x", bodyText: "x", bodyHtml: '<div>Hola<img src="https://evil.example/p.gif" onerror="window.__pwned=1"><script>window.__pwned=1</script><a href="javascript:window.__pwned=1">mal</a><iframe src="https://evil.example/f"></iframe><svg onload="window.__pwned=1"></svg></div>', inReplyToMessageId: m.id },
      Date.now(),
    );
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await openRow(page, 0);
    await focusList(page);
    await page.keyboard.press("r");
    await expect(body(page)).toHaveText("Holamal");
    await expect(body(page).locator("a, img, iframe, svg, script")).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(requests).toEqual([]);
  });

  test("a key pressed while focus is still moving to the draft goes to the draft (r then Esc, r then typing at once)", async ({ app: page }) => {
    await openRow(page, 0);
    await focusList(page);
    await page.keyboard.press("r");
    await page.keyboard.type("Rápido");
    await expect(body(page)).toHaveText("Rápido");
    await page.keyboard.press("Escape");
    await page.keyboard.press("r");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("draft-collapsed")).toBeVisible();
    await expect(page.getByTestId("draft-collapsed")).toContainText("Rápido");
  });
});

test.describe("the new message", { tag: "@design" }, () => {
  test("its foot carries the bar and Aa; formatting there works the same", async ({ app: page }) => {
    await focusList(page);
    await page.keyboard.press("c");
    await page.getByTestId("compose-to").fill("ana@example.com");
    await body(page).click();
    await page.keyboard.type("Nuevo ");
    await page.getByTestId("format-underline").click();
    await page.keyboard.type("subrayado");
    await expect(body(page).locator("u")).toHaveText("subrayado");
    await expect(page.getByTestId("format-toggle")).toBeVisible();
    await expect(page.getByTestId("compose-link")).toBeVisible();
  });
});

test.describe("an install with nothing open", () => {
  test.use({ backendOptions: { empty: true } });
  test("doesn't load the editor (no conversation, no composer: no work)", async ({ app: page }) => {
    const loaded: string[] = [];
    page.on("request", (r) => {
      if (/\/assets\/rich-[^/]+\.js$/.test(r.url())) loaded.push(r.url());
    });
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await page.waitForTimeout(800);
    expect(loaded).toEqual([]);
  });
});

test("the editor stays out of the startup bundle: the entry and what it imports statically carry no ProseMirror; it loads with a conversation", async ({ app: page }) => {
  await openRow(page, 0);
  await focusList(page);
  await page.keyboard.press("r");
  await expect(body(page)).toBeFocused();
  const entry = await page.evaluate(async () => {
    const src = document.querySelector<HTMLScriptElement>("script[type=module][src]")!.src;
    const seen = new Set<string>();
    const hits: string[] = [];
    const walk = async (url: string) => {
      if (seen.has(url)) return;
      seen.add(url);
      const code = await (await fetch(url)).text();
      if (/ProseMirror|prosemirror|Invalid content for node/.test(code)) hits.push(url);
      for (const m of code.matchAll(/(?:^|[;\n}])\s*import\s*(?:[^"'();]*?from\s*)?["'](\.\/[^"']+\.js)["']/g)) await walk(new URL(m[1]!, url).href);
    };
    await walk(src);
    return { files: seen.size, hits };
  });
  expect(entry.files).toBeGreaterThan(3);
  expect(entry.hits).toEqual([]);
});

test("a huge draft skips its lines off screen from the start: nothing reads style or layout while all of them would be styled", async ({ app: page, server }) => {
  // a read then styled every line before content-visibility applied, and every keystroke after cost twice as much
  // (a 2 MB draft: 21 ms to the transaction instead of 12, the frame at 60 ms; plan 16, "Huge drafts")
  await page.addInitScript(() => {
    const w = window as unknown as { __unskipped: string[] };
    w.__unskipped = [];
    const check = (what: string) => {
      const body = document.querySelector<HTMLElement>(".rt-body:not(.rt-huge)");
      if (body && body.childElementCount > 2000) w.__unskipped.push(`${what}\n${new Error().stack}`);
    };
    const style = window.getComputedStyle;
    window.getComputedStyle = function (...args: Parameters<typeof style>) {
      check("getComputedStyle");
      return style.apply(this, args);
    };
    for (const name of ["getBoundingClientRect", "getClientRects"] as const) {
      const read = Element.prototype[name] as (this: Element) => unknown;
      (Element.prototype as unknown as Record<string, unknown>)[name] = function (this: Element) {
        check(name);
        return read.call(this);
      };
    }
    for (const name of ["offsetWidth", "offsetHeight", "offsetTop", "offsetLeft"] as const) {
      const d = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)!;
      Object.defineProperty(HTMLElement.prototype, name, {
        ...d,
        get(this: HTMLElement) {
          check(name);
          return d.get!.call(this);
        },
      });
    }
  });
  const db = sqlDb(server.backend.store);
  const m = db.get<{ id: number; thread_id: number; account_id: number }>("SELECT m.id, m.thread_id, m.account_id FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.in_inbox = 1 ORDER BY t.last_date DESC, m.date DESC LIMIT 1")!;
  const lines = Array.from({ length: 2500 }, (_, i) => `${i} Hola, te paso las notas de la reunión.`);
  await server.backend.store.drafts.save({ accountId: m.account_id, threadId: m.thread_id, mode: "reply", to: [{ name: "", email: "ana@example.com" }], cc: [], subject: "Re: x", bodyText: lines.join("\n"), inReplyToMessageId: m.id }, Date.now());
  await page.reload();
  await page.locator("[data-ready]").waitFor();
  await openRow(page, 0);
  await focusList(page);
  await page.keyboard.press("r");
  await expect(body(page)).toBeFocused();
  await expect(body(page)).toHaveClass(/rt-huge/);
  await page.keyboard.type("Gracias.");
  await expect(body(page).locator("p").last()).toHaveText(`${lines.at(-1)}Gracias.`);
  expect(await page.evaluate(() => (window as unknown as { __unskipped: string[] }).__unskipped)).toEqual([]);
});
