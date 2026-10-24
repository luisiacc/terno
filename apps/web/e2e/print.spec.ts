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

test.describe("print sheet", () => {
  test("⌘P opens it on the open conversation, ⇧⌘P on «Guardar PDF…»; Esc closes; nothing to print, nothing opens", async ({ app: page, server }) => {
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
    await expect(page.getByTestId("print-scope-thread")).toHaveText("Conversación (4)");
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

    // a message's own menu: just that message (the plain-text inline reply, unfolded and opened)
    await page.getByTestId("more-messages").click();
    const messages = page.getByTestId("reader").getByTestId("message");
    await expect(messages).toHaveCount(5);
    await messages.nth(1).getByTestId("message-toggle").click();
    await messages.nth(1).getByTestId("message-toggle").click({ button: "right" });
    await expect(page.getByTestId("message-menu")).toBeVisible();
    await page.getByTestId("message-menu-print").click();
    await pressed(page, "print-scope-message");
    await expect(sheet(page).getByRole("heading", { name: "Imprimir mensaje" })).toBeVisible();
    await ready(page);
    await expect(preview(page).locator(".msg")).toHaveCount(1);
    await expect(preview(page).locator("body")).toContainText("A 30 días naturales desde la factura.");
    // one message keeps its quotes by default
    await pressed(page, "print-quoted-show");
    await page.getByTestId("print-scope-thread").click();
    await expect(preview(page).locator(".msg")).toHaveCount(5);
    await pressed(page, "print-quoted-hide");
    await page.keyboard.press("Escape");

    // a right-click inside the last message's HTML frame (Outlook) opens that message's menu
    const frame = messages.nth(4).locator("iframe");
    await expect(frame).toBeVisible();
    const box = (await frame.boundingBox())!;
    await page.mouse.click(box.x + 40, box.y + 12, { button: "right" });
    await page.getByTestId("message-menu-pdf").click();
    await expect(sheet(page)).toBeVisible();
    await pressed(page, "print-scope-message");
    await expect(page.getByTestId("print-save-pdf")).toBeFocused();
    await ready(page);
    await expect(preview(page).locator("body")).toContainText("con eso lo firmamos el lunes");
    await page.keyboard.press("Escape");

    // ⌘P while focus is inside a mail's frame still opens the sheet (the frame passes the chord on)
    await page.frameLocator("[data-testid=reader] iframe >> nth=-1").locator("body").click();
    await page.keyboard.press("ControlOrMeta+p");
    await expect(sheet(page)).toBeVisible();
    await pressed(page, "print-scope-thread");
    await page.keyboard.press("Escape");

    await focusList(page);
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("palette-input").fill("imprimir");
    await page.getByTestId("palette-print").click();
    await expect(sheet(page)).toBeVisible();
    await page.keyboard.press("Escape");
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
    await expect(doc.locator(".head").first()).toContainText("Para");
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

  test("Imprimir prints the preview's own document under the subject, and puts the page's title back", async ({ app: page, server }) => {
    await open(page, server, "long-plain", 'subject:"Notas de la junta de planeación"');
    const title = await page.title();
    await page.keyboard.press("ControlOrMeta+p");
    await ready(page);
    await expect(page.getByTestId("print-hint-web")).toContainText("Guardar como PDF");
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

  test("remote images print only where the reader loaded them; local mode never", async ({ app: page, server }) => {
    await open(page, server, "newsletter", 'subject:"Boletín Acme"');
    await page.keyboard.press("ControlOrMeta+p");
    await ready(page);
    await expect(page.getByTestId("print-note-remote")).toContainText("modo local");
    await expect(preview(page).locator('img[src^="https:"]')).toHaveCount(0);
    await expect(preview(page).locator(".img-alt")).toContainText(["Promoción de temporada"]);
    await page.keyboard.press("Escape");

    await server.backend.server.invoke("settings.update", { localMode: false }, { clientId: "setup", origin: "dev" });
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await selectThread(page, sqlDb(server.backend.store).get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE provider_msg_id = 'print-newsletter-0'")!.thread_id, 'subject:"Boletín Acme"');
    await page.keyboard.press("ControlOrMeta+p");
    await ready(page);
    await expect(page.getByTestId("print-note-remote")).toContainText("que no cargaste en el lector");
    await page.keyboard.press("Escape");
    // «Cargar contenido» in the reader: that message prints them
    await page.getByTestId("remote-load").click();
    await page.keyboard.press("ControlOrMeta+p");
    await ready(page);
    await expect(page.getByTestId("print-note-remote")).toHaveCount(0);
    await expect(preview(page).locator('img[src="https://images.acme.test/promo/temporada.png"]')).toHaveCount(1);
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
    await expect(page.getByTestId("print-note-missing")).toContainText("Un mensaje aún no se ha descargado");
    await expect(preview(page).locator(".missing")).toHaveText("Contenido aún no descargado");
  });

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
  const dist = join(here, "../dist-e2e");
  const entry = /<script type="module"[^>]*src="\.\/(assets\/[^"]+\.js)"/.exec(readFileSync(join(dist, "index.html"), "utf8"))![1]!;
  const code = (f: string) => readFileSync(join(dist, f), "utf8");
  expect(code(entry)).not.toContain("data-print-doc");
  expect(code(entry)).not.toContain("Vista previa de impresión");
  const chunks = readdirSync(join(dist, "assets")).filter((f) => f.endsWith(".js"));
  expect(chunks.some((f) => code(`assets/${f}`).includes("data-print-doc"))).toBe(true);
});
