/**
 * Printing (plan 09): every way into the print sheet opens it on the right
 * target, the options change the real print document in the preview, the
 * browser prints the preview's own document (stubbed here) under the subject's
 * title, and the sheet is accessible in light and dark. The print code stays
 * out of the startup bundle.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import type { FrameLocator, Page } from "@playwright/test";
import { expect, focusList, ingestPrintFixtures, selectThread, test } from "./fixtures";
import { sqlDb, type DevServer } from "../../backend-dev/src/server";

const here = dirname(fileURLToPath(import.meta.url));
const sheet = (page: Page) => page.getByTestId("print-sheet");
const preview = (page: Page): FrameLocator => page.frameLocator("[data-testid=print-preview]");
const ready = (page: Page) => expect(page.getByTestId("print-preview")).toHaveAttribute("data-ready", "true");
const pressed = (page: Page, testId: string) => expect(page.getByTestId(testId)).toHaveAttribute("aria-pressed", "true");

async function open(page: Page, server: DevServer, key: "long-plain" | "inline-replies" | "newsletter" | "images" | "hostile", query: string) {
  const ids = await ingestPrintFixtures(server);
  await selectThread(page, ids[key], query);
  return ids;
}

test.describe("print sheet", { tag: "@design" }, () => {
  test("⌘P opens it on the open conversation, ⇧⌘P on “Save PDF…”; Esc closes; nothing to print, nothing opens", async ({ app: page, server }) => {
    // a new message in the reader pane: nothing to print, and the browser doesn't print the app either
    await focusList(page);
    await page.keyboard.press("c");
    await expect(page.getByTestId("composer")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+p");
    await page.waitForTimeout(400);
    await expect(sheet(page)).toHaveCount(0);

    await open(page, server, "long-plain", 'subject:"Notas de la junta de planeación"');
    await page.keyboard.press("ControlOrMeta+p");
    await expect(sheet(page)).toBeVisible();
    await expect(page.getByTestId("print-subject")).toHaveText("Notas de la junta de planeación — lanzamiento del primer trimestre");
    await pressed(page, "print-scope-thread");
    await expect(page.getByTestId("print-scope-thread")).toHaveText("Conversation (4)");
    await ready(page);
    await expect(page.getByTestId("print-submit")).toBeFocused();
    await expect(preview(page).locator(".msg")).toHaveCount(4);
    // already open: the chord again changes nothing
    await page.keyboard.press("ControlOrMeta+p");
    await expect(sheet(page)).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(sheet(page)).toHaveCount(0);

    await page.keyboard.press("ControlOrMeta+Shift+p");
    await expect(sheet(page)).toBeVisible();
    await ready(page);
    await expect(page.getByTestId("print-save-pdf")).toBeFocused();
    await page.keyboard.press("Escape");
  });

  test("from the toolbar (focus comes back to it), the thread menu, a message's menu, inside an HTML mail, and the palette", async ({ app: page, server }) => {
    const ids = await open(page, server, "inline-replies", 'subject:"Preguntas sobre el contrato"');
    await page.getByTestId("action-print").click();
    await expect(sheet(page)).toBeVisible();
    await pressed(page, "print-scope-thread");
    await page.keyboard.press("Escape");
    await expect(sheet(page)).toHaveCount(0);
    await expect(page.getByTestId("action-print")).toBeFocused();

    // the thread's context menu: one conversation
    await page.locator(`[data-testid=thread-row][data-thread-id="${ids["inline-replies"]}"]`).click({ button: "right" });
    await page.getByTestId("menu-print").click();
    await expect(sheet(page)).toBeVisible();
    await pressed(page, "print-scope-thread");
    await page.keyboard.press("Escape");
    await expect(sheet(page)).toHaveCount(0);

    // a message's own menu: just that message (the plain-text inline reply, unfolded and opened)
    await page.getByTestId("more-messages").click();
    const messages = page.getByTestId("reader").getByTestId("message");
    await expect(messages).toHaveCount(5);
    await messages.nth(1).getByTestId("message-toggle").click();
    await messages.nth(1).getByTestId("message-toggle").click({ button: "right" });
    await expect(page.getByTestId("message-menu")).toBeVisible();
    await page.getByTestId("message-menu-print").click();
    await pressed(page, "print-scope-message");
    await expect(sheet(page).getByRole("heading", { name: "Print message" })).toBeVisible();
    await ready(page);
    await expect(preview(page).locator(".msg")).toHaveCount(1);
    await expect(preview(page).locator("body")).toContainText("A 30 días naturales desde la factura.");
    // one message keeps its quotes by default
    await pressed(page, "print-quoted-show");
    await page.getByTestId("print-scope-thread").click();
    await expect(preview(page).locator(".msg")).toHaveCount(5);
    await pressed(page, "print-quoted-hide");
    await page.keyboard.press("Escape");
    await expect(sheet(page)).toHaveCount(0);

    // a right-click inside the last message's HTML frame (Outlook) opens that message's menu
    const frame = messages.nth(4).locator("iframe");
    await expect(frame).toBeVisible();
    // taller reader headers (plan 15) can leave it below the fold
    await frame.scrollIntoViewIfNeeded();
    const box = (await frame.boundingBox())!;
    await page.mouse.click(box.x + 40, box.y + 12, { button: "right" });
    await page.getByTestId("message-menu-pdf").click();
    await expect(sheet(page)).toBeVisible();
    await pressed(page, "print-scope-message");
    await expect(page.getByTestId("print-save-pdf")).toBeFocused();
    await ready(page);
    await expect(preview(page).locator("body")).toContainText("con eso lo firmamos el lunes");
    await page.keyboard.press("Escape");
    await expect(sheet(page)).toHaveCount(0);

    // ⌘P while focus is inside a mail's frame still opens the sheet (the frame passes the chord on)
    await page.frameLocator("[data-testid=reader] iframe >> nth=-1").locator("body").click();
    await page.keyboard.press("ControlOrMeta+p");
    await expect(sheet(page)).toBeVisible();
    await pressed(page, "print-scope-thread");
    // The frame keeps keyboard focus until the sheet finishes its initial focus transfer.
    await expect(page.getByTestId("print-submit")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(sheet(page)).toHaveCount(0);

    await focusList(page);
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("palette-input").fill("print");
    await page.getByTestId("palette-print").click();
    await expect(sheet(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet(page)).toHaveCount(0);
    // focus went back into the mail's frame (where it was before the palette): leave it
    await focusList(page);
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("palette-input").fill("pdf");
    await page.keyboard.press("Enter");
    await expect(sheet(page)).toBeVisible();
    await expect(page.getByTestId("print-save-pdf")).toBeFocused();
  });

  test("the options change the print document: headers, quoted text, paper; the choices are remembered", async ({ app: page, server }) => {
    await open(page, server, "long-plain", 'subject:"Notas de la junta de planeación"');
    await page.keyboard.press("ControlOrMeta+p");
    await ready(page);
    const doc = preview(page);
    await expect(doc.locator(".subject")).toHaveText("Notas de la junta de planeación — lanzamiento del primer trimestre");
    await expect(doc.locator(".head")).toHaveCount(4);
    await expect(doc.locator(".head").first()).toContainText("yuki.gutierrez@acme.studio");
    await expect(doc.locator(".head").first()).toContainText("To Luis Cordero");
    // the whole conversation hides the trailing quotes
    await expect(doc.locator("body")).not.toContainText("escribió:");

    await page.getByTestId("print-content-body").click();
    await ready(page);
    await expect(doc.locator(".head, .subject, .atts")).toHaveCount(0);
    await expect(doc.locator("body")).not.toContainText("yuki.gutierrez@acme.studio");
    await expect(doc.locator("body")).toContainText("Te comparto las notas de la junta");

    await page.getByTestId("print-quoted-show").click();
    await ready(page);
    await expect(doc.locator(".quote").first()).toContainText("escribió:");

    await expect(page.getByTestId("print-preview")).toHaveAttribute("data-paper", "letter");
    const letter = (await page.getByTestId("print-preview").boundingBox())!.width;
    await page.getByTestId("print-paper-a4").click();
    await ready(page);
    await expect(page.getByTestId("print-preview")).toHaveAttribute("data-paper", "a4");
    expect(await doc.locator("html").getAttribute("data-paper")).toBe("a4");
    // the printable width: 210mm less two 16mm margins
    expect(Number.parseFloat(await doc.locator("main").evaluate((m) => getComputedStyle(m).width))).toBeCloseTo((178 * 96) / 25.4, 1);
    // A4 paper is narrower than Letter
    expect((await page.getByTestId("print-preview").boundingBox())!.width).toBeLessThan(letter);
    await page.keyboard.press("Escape");

    // reopened: content, quotes and paper as left
    await page.keyboard.press("ControlOrMeta+p");
    await ready(page);
    await pressed(page, "print-content-body");
    await pressed(page, "print-quoted-show");
    await pressed(page, "print-paper-a4");
  });

  test("toggling quickly through options builds the document once, after the changes settle", async ({ app: page, server }) => {
    await open(page, server, "long-plain", 'subject:"Notas de la junta de planeación"');
    await page.keyboard.press("ControlOrMeta+p");
    await ready(page);
    const builds = () => page.evaluate(() => (window as unknown as { __renders?: Record<string, number> }).__renders?.buildPrintDocument ?? 0);
    const before = await builds();
    // fourteen changes 30 ms apart (each one rendered), quicker than the settle time
    await page.evaluate(async () => {
      const ids = [...Array.from({ length: 3 }, () => ["print-content-body", "print-paper-a4", "print-content-headers", "print-paper-letter"]).flat(), "print-content-body", "print-quoted-show"];
      for (const id of ids) {
        document.querySelector<HTMLElement>(`[data-testid=${id}]`)!.click();
        await new Promise((r) => setTimeout(r, 30));
      }
    });
    await ready(page);
    expect(await builds()).toBe(before + 1);
    // and that one build is the final state
    await expect(preview(page).locator(".head")).toHaveCount(0);
    await expect(preview(page).locator(".quote").first()).toContainText("escribió:");
  });

  test("Print prints the preview's own document under the subject, and puts the page's title back", async ({ app: page, server }) => {
    await open(page, server, "long-plain", 'subject:"Notas de la junta de planeación"');
    const title = await page.title();
    await page.keyboard.press("ControlOrMeta+p");
    await ready(page);
    await expect(page.getByTestId("print-hint-web")).toContainText("Save as PDF");
    // the browser's dialog, stubbed: what it would print, and under which title
    await page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>("[data-testid=print-preview]")!;
      const w = window as unknown as { __printed?: { title: string; frameTitle: string; msgs: number } };
      frame.contentWindow!.print = () => {
        w.__printed = { title: document.title, frameTitle: frame.contentDocument!.title, msgs: frame.contentDocument!.querySelectorAll(".msg").length };
      };
    });
    await page.getByTestId("print-submit").click();
    await expect(sheet(page)).toHaveCount(0);
    const printed = await page.evaluate(() => (window as unknown as { __printed: unknown }).__printed);
    expect(printed).toEqual({ title: "Notas de la junta de planeación — lanzamiento del primer trimestre", frameTitle: "Notas de la junta de planeación — lanzamiento del primer trimestre", msgs: 4 });
    expect(await page.title()).toBe(title);
  });

  test("remote images print only where the reader loaded them, local mode included (plan 37)", async ({ app: page, server }) => {
    // the e2e profile is in local mode; the images are answered here, never fetched
    expect((await server.backend.server.invoke("app.bootstrap", {}, { clientId: "setup", origin: "dev" })).settings.localMode).toBe(true);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    await page.route(/acme\.test/, (route) => route.fulfill({ contentType: "image/png", body: png }));
    await open(page, server, "newsletter", 'subject:"Boletín Acme"');
    await page.keyboard.press("ControlOrMeta+p");
    await ready(page);
    await expect(page.getByTestId("print-note-remote")).toContainText("you didn’t load in the reader");
    await expect(preview(page).locator('img[src^="https:"]')).toHaveCount(0);
    await expect(preview(page).locator(".img-alt")).toContainText(["Promoción de temporada"]);
    await page.keyboard.press("Escape");
    // “Load content” in the reader: that message prints them
    await page.getByTestId("remote-load").click();
    await page.keyboard.press("ControlOrMeta+p");
    await ready(page);
    await expect(page.getByTestId("print-note-remote")).toHaveCount(0);
    const promo = preview(page).locator('img[src="https://images.acme.test/promo/temporada.png"]');
    await expect(promo).toHaveCount(1);
    // loaded in the preview (the routed PNG), not just listed: the preview's CSP let it in
    await expect.poll(() => promo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  });

  test("mixed consent: nothing of a blocked message is requested while another's images load", async ({ app: page, server }) => {
    // one conversation, two HTML messages, both unread (open): the first allowed in the reader, the second not
    const db = sqlDb(server.backend.store);
    const acct = db.get<{ id: number; email: string }>("SELECT id, email FROM accounts ORDER BY id LIMIT 1")!;
    const blocked = [
      `<svg><image href="https://tracker.test/svg-image.png" width="10" height="10"/><image xlink:href="https://tracker.test/svg-xlink.png"/><use href="https://tracker.test/sprite.svg#a"/><rect width="5" height="5" fill="url(https://tracker.test/paint.svg#p)"/></svg>`,
      `<video poster="https://tracker.test/poster.png"></video><picture><source srcset="https://tracker.test/pic.webp"><img src="https://tracker.test/pic.png" alt="foto"></picture>`,
      `<table background="https://tracker.test/table.png"><tr><td style="background:url(//tracker.test/proto.png)">x</td></tr></table><input type="image" src="https://tracker.test/input.png"><img src="//tracker.test/rel.png" alt="r">`,
    ].join("");
    const message = (i: number, html: string) => ({
      accountId: acct.id,
      providerMsgId: `consent-${i}`,
      providerThreadId: "thread-consent",
      rfcMessageId: `<consent-${i}@e2e.test>`,
      inReplyTo: i ? "<consent-0@e2e.test>" : null,
      references: i ? ["<consent-0@e2e.test>"] : [],
      from: { name: "Boletines", email: "news@consent.test" },
      to: [{ name: "Luis", email: acct.email }],
      cc: [],
      bcc: [],
      subject: i ? "Re: Consentimiento por mensaje" : "Consentimiento por mensaje",
      date: Date.UTC(2026, 9, 22, 10 + i),
      snippet: "x",
      bodyText: "x",
      bodyHtml: html,
      bodyState: "full" as const,
      listId: null,
      isRead: false,
      isStarred: false,
      inInbox: true,
      isSent: false,
      isDraft: false,
      isTrash: false,
      isSpam: false,
      hasAttachments: false,
      size: 100,
    });
    await server.backend.store.sync.ingest([message(0, `<p>Aprobado</p><img src="https://allowed.test/a.png" alt="a" width="20" height="20">`), message(1, `<p>Bloqueado</p>${blocked}`)], { applyFilters: false, now: Date.UTC(2026, 9, 22, 15), classifier: null });
    await server.backend.server.invoke("settings.update", { localMode: false }, { clientId: "setup", origin: "dev" });
    const hits: string[] = [];
    await page.route(/tracker\.test/, (route) => {
      hits.push(route.request().url());
      return route.abort();
    });
    const allowed: string[] = [];
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    await page.route(/allowed\.test/, (route) => (allowed.push(route.request().url()), route.fulfill({ contentType: "image/png", body: png })));
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    const id = db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE provider_msg_id = 'consent-0'")!.thread_id;
    await selectThread(page, id, 'subject:"Consentimiento por mensaje"');
    const messages = page.getByTestId("reader").getByTestId("message");
    await expect(messages).toHaveCount(2);
    await messages.nth(0).getByTestId("remote-load").click();
    await expect.poll(() => allowed.length).toBeGreaterThan(0);
    await focusList(page);
    await page.keyboard.press("ControlOrMeta+p");
    await ready(page);
    await expect(preview(page).locator('img[src="https://allowed.test/a.png"]')).toHaveCount(1);
    await expect(preview(page).locator("body")).toContainText("Bloqueado");
    await page.waitForTimeout(300);
    expect(hits).toEqual([]);
  });

  test("an approved image whose server never answers doesn't hold printing: past the deadline it prints as its description", async ({ app: page, server }) => {
    await server.backend.server.invoke("settings.update", { localMode: false }, { clientId: "setup", origin: "dev" });
    // the newsletter's remote images: requests that never get an answer
    const stalled: string[] = [];
    await page.route(/acme\.test/, (route) => void stalled.push(route.request().url()));
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await open(page, server, "newsletter", 'subject:"Boletín Acme"');
    await page.getByTestId("remote-load").click();
    await page.keyboard.press("ControlOrMeta+p");
    await expect(page.getByTestId("print-preview")).toHaveAttribute("data-ready", "true", { timeout: 12_000 });
    await expect(page.getByTestId("print-submit")).toBeEnabled();
    expect(stalled.some((u) => u.includes("images.acme.test"))).toBe(true);
    // what it couldn't load prints as its description, not as an endless request
    await expect(preview(page).locator('img[src*="acme.test"]')).toHaveCount(0);
    await expect(preview(page).locator(".img-alt")).toContainText(["Promoción de temporada"]);
  });

  test("a body not downloaded yet prints as missing, with a warning; a hostile subject stays text", async ({ app: page, server }) => {
    const ids = await open(page, server, "hostile", "from:soporte@banco-falso.test");
    await page.keyboard.press("ControlOrMeta+p");
    await ready(page);
    await expect(page.getByTestId("print-subject")).toHaveText(`<img src=x onerror=alert(1)> "Factura" & </title><script>alert('xss')</script>`);
    await expect(preview(page).locator(".subject")).toHaveText(`<img src=x onerror=alert(1)> "Factura" & </title><script>alert('xss')</script>`);
    // sanitized like the reader: no scripts, frames, <style> from the mail, or handlers
    await expect(preview(page).locator("body script, body iframe, body style")).toHaveCount(0);
    await expect(preview(page).locator("[onclick], [onerror], [onload]")).toHaveCount(0);
    await page.keyboard.press("Escape");

    // a message whose body sync hasn't fetched
    const db = sqlDb(server.backend.store);
    const { id } = db.get<{ id: number }>("SELECT id FROM messages WHERE provider_msg_id = 'print-hostile-0'")!;
    db.run("DELETE FROM message_bodies WHERE message_id = ?", id);
    db.run("UPDATE messages SET body_state = 'none' WHERE id = ?", id);
    await selectThread(page, ids["long-plain"], 'subject:"Notas de la junta de planeación"');
    await selectThread(page, ids.hostile, "from:soporte@banco-falso.test");
    await page.keyboard.press("ControlOrMeta+p");
    await ready(page);
    await expect(page.getByTestId("print-note-missing")).toContainText("One message hasn’t downloaded yet");
    await expect(preview(page).locator(".missing")).toHaveText("Content not downloaded yet");
  });

  for (const [label, size] of [["a 320 px window", { width: 320, height: 640 }], ["200% zoom (720×450)", { width: 720, height: 450 }]] as const) {
    test(`at ${label} every control is on screen and reachable, nothing cut off`, async ({ app: page, server }) => {
      await open(page, server, "inline-replies", 'subject:"Preguntas sobre el contrato"');
      await page.setViewportSize(size);
      await page.keyboard.press("ControlOrMeta+p");
      await ready(page);
      const s = sheet(page);
      // nothing runs past the sheet's sides
      expect(await s.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      const box = (await s.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(size.width);
      // the top of the sticky button bar: a control scrolled into view isn't left under it
      const bar = await page.getByTestId("print-submit").evaluate((el) => el.parentElement!.getBoundingClientRect().top);
      const controls = ["print-scope-thread", "print-scope-message", "print-content-headers", "print-content-body", "print-quoted-hide", "print-quoted-show", "print-paper-letter", "print-paper-a4", "print-save-pdf", "print-submit"];
      for (const id of controls) {
        const c = page.getByTestId(id);
        await c.scrollIntoViewIfNeeded();
        await expect(c).toBeInViewport({ ratio: 1 });
        const b = (await c.boundingBox())!;
        expect(b.x).toBeGreaterThanOrEqual(box.x);
        expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
        if (id !== "print-save-pdf" && id !== "print-submit") expect(b.y + b.height).toBeLessThanOrEqual(bar + 0.5);
      }
      // the buttons stay in view while the sheet scrolls
      await s.evaluate((el) => el.scrollTo(0, 0));
      await expect(page.getByTestId("print-submit")).toBeInViewport({ ratio: 1 });
      // and the keyboard gets there
      await page.getByTestId("print-scope-thread").focus();
      for (let i = 0; i < 20 && !(await page.getByTestId("print-submit").evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
      await expect(page.getByTestId("print-submit")).toBeFocused();
      await page.getByTestId("print-content-body").click();
      await ready(page);
      await expect(preview(page).locator(".head")).toHaveCount(0);
    });
  }

  for (const scheme of ["light", "dark"] as const) {
    test(`accessible (axe) in ${scheme}`, async ({ app: page, server }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, server, "images", 'subject:"Fotos de la visita a la obra"');
      await page.keyboard.press("ControlOrMeta+p");
      await ready(page);
      // the app's controls (the preview is the mail's own document, checked by the print-quality suite)
      const r = await new AxeBuilder({ page }).include("[data-testid=print-sheet]").exclude("[data-testid=print-preview]").setLegacyMode(true).analyze();
      expect(r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    });
  }
});

test("the print sheet and document builder stay out of the startup bundle", () => {
  // the build the suite serves (E2E_PORT gives a worktree its own)
  const dist = join(here, process.env.E2E_PORT ? `../dist-e2e-${process.env.E2E_PORT}` : "../dist-e2e");
  const entry = /<script type="module"[^>]*src="\.\/(assets\/[^"]+\.js)"/.exec(readFileSync(join(dist, "index.html"), "utf8"))![1]!;
  const code = (f: string) => readFileSync(join(dist, f), "utf8");
  // markers the minifier keeps (copy lives in the catalog, in the entry): the document's root attribute and the
  // sheet's own test ids as string literals in any quotes, so a chunk's file name in the entry's imports doesn't count
  const markers = [/data-print-doc/, /["'`]print-preview["'`]/, /["'`]print-submit["'`]/];
  const chunks = readdirSync(join(dist, "assets")).filter((f) => f.endsWith(".js"));
  for (const m of markers) {
    expect(code(entry)).not.toMatch(m);
    // and they are in the build at all, so their absence from the entry means something
    expect(chunks.some((f) => m.test(code(`assets/${f}`))), String(m)).toBe(true);
  }
});
