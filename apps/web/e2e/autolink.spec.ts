/**
 * Plan 39: live autolinks in the composer, in a real browser. The user's
 * report first (type a URL, delete ".com", type "qwe.com": one link to what
 * it says), then the variations: brackets and quotes, ⇧Enter, undo/redo,
 * paste and copy, an IME composition, a draft reopened. Tagged @design: the
 * link's look and its bubble hold in macOS, Lumen and Atelier.
 */
import type { Page } from "@playwright/test";
import { expect, focusList, openRow, test } from "./fixtures";

const body = (page: Page) => page.getByTestId("compose-body");
const ctx = { clientId: "setup", origin: "dev" as const };

/** r on the first conversation, then text typed (focus in the body). */
async function reply(page: Page, text = "") {
  await openRow(page, 0);
  await focusList(page);
  await page.keyboard.press("r");
  await expect(body(page)).toBeFocused();
  if (text) await page.keyboard.type(text);
}

/** Every link in the body: its text, its href, whether it is an autolink. */
const links = (page: Page) =>
  body(page).evaluate((el) =>
    [...el.querySelectorAll("a")].map((a) => ({
      text: a.textContent,
      href: a.getAttribute("href"),
      auto: a.hasAttribute("data-rt-auto"),
    })),
  );

/** The caret right after the first occurrence of `text` in the body (a DOM selection the editor reads). */
async function caretAfter(page: Page, text: string) {
  await body(page).evaluate((root, text) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    const all = nodes.map((n) => n.data).join("");
    let at = all.indexOf(text);
    if (at < 0) throw new Error(`no "${text}" in the body`);
    at += text.length;
    for (const n of nodes) {
      if (at <= n.data.length) {
        const r = document.createRange();
        r.setStart(n, at);
        r.collapse(true);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(r);
        return;
      }
      at -= n.data.length;
    }
  }, text);
  await page.waitForTimeout(30);
}

/** A paste event as the browser sends one. */
async function paste(page: Page, data: Record<string, string>) {
  await body(page).evaluate((el, data) => {
    const dt = new DataTransfer();
    for (const [type, value] of Object.entries(data)) dt.setData(type, value);
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, data);
}

/** Every autolink's href is its text (www. with https://, an address with mailto:). */
async function honest(page: Page) {
  for (const l of await links(page))
    if (l.auto)
      expect(l.href, l.text ?? "").toBe(
        l.text!.startsWith("www.")
          ? `https://${l.text}`
          : l.text!.includes("://")
            ? l.text
            : `mailto:${l.text}`,
      );
}

test.describe("live autolinks", { tag: "@design" }, () => {
  test("the report: https://santo.com, delete .com, type qwe.com → one link to https://santoqwe.com; the bubble shows it", async ({
    app: page,
  }) => {
    await reply(page, "Mira https://santo.com y dime");
    await expect
      .poll(() => links(page))
      .toEqual([
        { text: "https://santo.com", href: "https://santo.com", auto: true },
      ]);
    await caretAfter(page, ".com");
    for (let i = 0; i < 4; i++) await page.keyboard.press("Backspace");
    await expect
      .poll(() => links(page))
      .toEqual([{ text: "https://santo", href: "https://santo", auto: true }]);
    await page.keyboard.type("qwe.com");
    await expect(body(page)).toHaveText("Mira https://santoqwe.com y dime");
    await expect
      .poll(() => links(page))
      .toEqual([
        {
          text: "https://santoqwe.com",
          href: "https://santoqwe.com",
          auto: true,
        },
      ]);
    // one element: the link isn't split where it was edited
    await expect(body(page).locator("a")).toHaveCount(1);
    // the caret inside it: the bubble says where it goes now
    await caretAfter(page, "https://santo");
    await expect(page.getByTestId("link-bubble")).toContainText(
      "https://santoqwe.com",
    );
  });

  test.describe(() => {
    // the real clock: history starts a new undo step after a pause
    test.use({ fixedClock: false });
    test("undo and redo walk the link back and forth with its text, never a stale href", async ({
      app: page,
    }) => {
      await reply(page, "https://santo.com ");
      await caretAfter(page, ".com");
      await page.waitForTimeout(600);
      for (let i = 0; i < 4; i++) {
        await page.keyboard.press("Backspace");
        // a pause between keys: each its own undo step
        await page.waitForTimeout(600);
      }
      await page.keyboard.type("qwe.com");
      await honest(page);
      // back to the link as typed (a step at a time: the typing, then each Backspace), honest at every step
      const seen: string[] = [];
      for (
        let i = 0;
        i < 8 && (await body(page).textContent()) !== "https://santo.com ";
        i++
      ) {
        await page.keyboard.press("ControlOrMeta+z");
        await honest(page);
        seen.push((await body(page).textContent())!);
      }
      expect(seen).toEqual([
        "https://santo ",
        "https://santo. ",
        "https://santo.c ",
        "https://santo.co ",
        "https://santo.com ",
      ]);
      await expect
        .poll(() => links(page))
        .toEqual([
          { text: "https://santo.com", href: "https://santo.com", auto: true },
        ]);
      for (let i = 0; i < 5; i++) {
        await page.keyboard.press("ControlOrMeta+Shift+z");
        await honest(page);
      }
      await expect(body(page)).toHaveText("https://santoqwe.com ");
      await expect
        .poll(() => links(page))
        .toEqual([
          {
            text: "https://santoqwe.com",
            href: "https://santoqwe.com",
            auto: true,
          },
        ]);
    });
  });

  test("brackets, quotes and trailing punctuation stay outside; ⇧Enter links; deleting the scheme unlinks", async ({
    app: page,
  }) => {
    await reply(
      page,
      '(https://a.com) <https://b.com> "https://c.com" www.d.com, ana@e.com. ',
    );
    await page.keyboard.type("https://f.com");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("fin https://santo.com ");
    await expect
      .poll(() =>
        links(page).then((ls) => ls.map((l) => `${l.text}→${l.href}`)),
      )
      .toEqual([
        "https://a.com→https://a.com",
        "https://b.com→https://b.com",
        "https://c.com→https://c.com",
        "www.d.com→https://www.d.com",
        "ana@e.com→mailto:ana@e.com",
        "https://f.com→https://f.com",
        "https://santo.com→https://santo.com",
      ]);
    await caretAfter(page, "fin https://");
    for (let i = 0; i < 8; i++) await page.keyboard.press("Backspace");
    await expect(body(page)).toContainText("fin santo.com");
    await expect
      .poll(() => links(page).then((ls) => ls.map((l) => l.text)))
      .not.toContain("santo.com");
    await expect(body(page).locator("a")).toHaveCount(6);
  });

  test("a composition (IME) inside a link, with nothing typed after it, ends with the link following its text", async ({
    app: page,
  }) => {
    await reply(page, "ver https://cafe.com fin");
    await caretAfter(page, "https://caf");
    await page.keyboard.press("Shift+ArrowRight");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition", {
      text: "é",
      selectionStart: 1,
      selectionEnd: 1,
    });
    await cdp.send("Input.insertText", { text: "é" });
    await expect(body(page)).toHaveText("ver https://café.com fin");
    await expect
      .poll(() => links(page))
      .toEqual([
        { text: "https://café.com", href: "https://café.com", auto: true },
      ]);
  });

  test("paste: a plain text's URLs link; ⇧⌘V doesn't; HTML with a labelled link pastes as copied", async ({
    app: page,
  }) => {
    await reply(page, "a ");
    await paste(page, {
      "text/plain": "mira https://uno.example y www.dos.example.",
    });
    await expect
      .poll(() => links(page).then((ls) => ls.map((l) => l.href)))
      .toEqual(["https://uno.example", "https://www.dos.example"]);
    await page.keyboard.type(" b ");
    await page.keyboard.down("Shift");
    await paste(page, { "text/plain": "https://tres.example" });
    await page.keyboard.up("Shift");
    await expect(body(page)).toContainText("https://tres.example");
    await expect.poll(() => links(page).then((ls) => ls.length)).toBe(2);
    await page.keyboard.type(" c ");
    // the text is a URL, the HTML a link to elsewhere: the HTML's link
    await paste(page, {
      "text/plain": "https://real.example",
      "text/html":
        '<a href="https://tracker.example/r">https://real.example</a>',
    });
    await expect
      .poll(() => links(page).then((ls) => ls.at(-1)))
      .toEqual({
        text: "https://real.example",
        href: "https://tracker.example/r",
        auto: false,
      });
  });

  test("copying part of a link carries the href that part spells, to any app", async ({
    app: page,
  }) => {
    await reply(page, "ver https://santo.com fin");
    await expect.poll(() => links(page).then((ls) => ls.length)).toBe(1);
    const copied = await body(page).evaluate((root) => {
      const text = [...root.querySelectorAll("a")][0]!.firstChild as Text;
      const r = document.createRange();
      r.setStart(text, 0);
      r.setEnd(text, "https://santo.co".length);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(r);
      return new Promise<string>((resolve) =>
        setTimeout(() => {
          const dt = new DataTransfer();
          root.dispatchEvent(
            new ClipboardEvent("copy", {
              clipboardData: dt,
              bubbles: true,
              cancelable: true,
            }),
          );
          resolve(dt.getData("text/html"));
        }, 50),
      );
    });
    expect(copied).toContain('href="https://santo.co"');
    expect(copied).not.toContain("https://santo.com");
  });

  test("a draft reopened keeps its autolinks live", async ({ app: page }) => {
    await reply(page, "ver https://santo.com fin");
    await expect.poll(() => links(page).then((ls) => ls.length)).toBe(1);
    await expect(page.getByTestId("draft-status")).toHaveText("Draft saved", {
      timeout: 15_000,
    });
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await openRow(page, 0);
    await body(page).click();
    await expect
      .poll(() => links(page))
      .toEqual([
        { text: "https://santo.com", href: "https://santo.com", auto: true },
      ]);
    await caretAfter(page, ".com");
    await page.keyboard.type("/plan");
    await expect
      .poll(() => links(page))
      .toEqual([
        {
          text: "https://santo.com/plan",
          href: "https://santo.com/plan",
          auto: true,
        },
      ]);
  });
});

test.describe(
  "screenshots of a live-edited link (AUTOLINK_SHOTS=1)",
  { tag: "@design" },
  () => {
    test.skip(!process.env.AUTOLINK_SHOTS, "visual check only");
    for (const mode of ["light", "dark"] as const)
      test(`${mode}`, async ({ app: page, server }, info) => {
        await server.backend.server.invoke(
          "settings.update",
          { theme: mode },
          ctx,
        );
        await page.reload();
        await page.locator("[data-ready]").waitFor();
        await reply(page, "Mira https://santo.com y dime qué te parece.");
        await caretAfter(page, ".com");
        for (let i = 0; i < 4; i++) await page.keyboard.press("Backspace");
        await page.keyboard.type("qwe.com");
        await caretAfter(page, "https://santo");
        await expect(page.getByTestId("link-bubble")).toBeVisible();
        await page
          .getByTestId("composer")
          .screenshot({
            path: `/tmp/unica-scratch/autolink/${info.project.name}-${mode}.png`,
          });
      });
  },
);
