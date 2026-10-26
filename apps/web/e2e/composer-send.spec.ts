/**
 * Plan 16, the round trip: compose formatted text in the browser, send it
 * through the desktop's real send path (the backend's op, nodemailer's MIME,
 * SMTP) into an in-process server, parse what arrived, and check it: the
 * structure, inline styles only, a readable plain-text part; the HTML through
 * a Gmail-like sanitizer is unchanged and reads back to the document that was
 * written; rendered like a webmail (and in a dark mode that inverts it) it
 * matches its baselines.
 */
import { parseRaw } from "@terno/mail";
import type { Page } from "@playwright/test";
import { expect, navTo, focusList, openRow, test, type CapturedMail } from "./fixtures";

test.use({ backendOptions: { smtpCapture: true } });

const body = (page: Page) => page.getByTestId("compose-body");
const ctx = { clientId: "setup", origin: "dev" as const };

/** Gmail keeps inline styles from this list and drops <style>, classes, ids and everything else. */
const GMAIL_CSS = ["color", "background-color", "font-family", "font-size", "font-weight", "font-style", "text-decoration", "text-align", "margin", "margin-left", "margin-right", "margin-top", "margin-bottom", "padding", "padding-left", "border", "border-left", "line-height", "white-space"];

/** In the page: the HTML as a Gmail-like sanitizer leaves it, and as the same parser leaves it untouched (to compare). */
async function gmail(page: Page, html: string): Promise<{ kept: string; same: string }> {
  return page.evaluate(
    ({ html, allowed }) => {
      const parse = () => new DOMParser().parseFromString(html, "text/html");
      const untouched = parse();
      const doc = parse();
      for (const el of doc.querySelectorAll("style, script, link, meta, title")) el.remove();
      for (const el of doc.body.querySelectorAll<HTMLElement>("*")) {
        for (const a of Array.from(el.attributes)) if (!["style", "href", "start"].includes(a.name)) el.removeAttribute(a.name);
        if (el.hasAttribute("style")) {
          const kept: string[] = [];
          for (let i = 0; i < el.style.length; i++) {
            const prop = el.style.item(i);
            if (allowed.includes(prop) || allowed.some((a) => prop.startsWith(`${a}-`))) kept.push(`${prop}:${el.style.getPropertyValue(prop)}`);
          }
          el.setAttribute("style", kept.join(";"));
        }
      }
      // the same normalization on both sides: style attributes as the CSSOM writes them
      for (const d of [untouched, doc]) for (const el of d.body.querySelectorAll<HTMLElement>("[style]")) el.setAttribute("style", el.style.cssText);
      return { kept: doc.body.innerHTML, same: untouched.body.innerHTML };
    },
    { html, allowed: GMAIL_CSS },
  );
}

/** The body fragment of a sent HTML part. */
const fragment = (html: string) => /<body>([\s\S]*)<\/body>/.exec(html)![1]!;

async function captured(server: { smtp: CapturedMail[] }): Promise<CapturedMail> {
  await expect.poll(() => server.smtp.length, { timeout: 15_000 }).toBe(1);
  return server.smtp[0]!;
}

/** A webmail's reading pane: Arial on white, 16 px margins. With `dark`, a dark mode that inverts the mail. */
async function renderAsWebmail(page: Page, html: string, dark: boolean) {
  const view = await page.context().newPage();
  await view.setViewportSize({ width: 640, height: 600 });
  await view.setContent(`<!doctype html><html><head><style>body{margin:16px;font:14px/1.45 Arial,Helvetica,sans-serif;color:#222;background:#fff}${dark ? "html{filter:invert(1) hue-rotate(180deg);background:#fff}" : ""}</style></head><body>${html}</body></html>`);
  return view;
}

test("a formatted new message arrives as written: multipart/alternative, inline styles only, Gmail keeps all of it, the same document reads back", async ({ app: page, server }) => {
  await focusList(page);
  await page.keyboard.press("c");
  await page.getByTestId("compose-to").fill("ana@example.com");
  await page.getByTestId("compose-subject").fill("Propuesta con formato");
  await body(page).click();
  const k = page.keyboard;
  await k.type("Hola Ana,");
  await k.press("Enter");
  await k.press("Enter");
  await k.type("Esto es ");
  await k.press("ControlOrMeta+b");
  await k.type("negrita");
  await k.press("ControlOrMeta+b");
  await k.type(", ");
  await k.press("ControlOrMeta+i");
  await k.type("cursiva");
  await k.press("ControlOrMeta+i");
  await k.type(", ");
  await k.press("ControlOrMeta+u");
  await k.type("subrayado");
  await k.press("ControlOrMeta+u");
  await k.type(" y ");
  await k.press("ControlOrMeta+Shift+x");
  await k.type("tachado");
  await k.press("ControlOrMeta+Shift+x");
  await k.type(".");
  await k.press("Enter");
  // color and highlight, from the bar, for what's typed next
  await page.getByTestId("format-color").click();
  await page.getByTestId("swatch-text-red").click();
  await page.getByTestId("swatch-highlight-yellow").click();
  await k.press("Escape");
  await k.type("Importante");
  await page.getByTestId("format-color").click();
  await page.getByTestId("swatch-text-none").click();
  await page.getByTestId("swatch-highlight-none").click();
  await k.press("Escape");
  await k.press("Enter");
  await page.getByTestId("format-font").click();
  await page.getByTestId("format-font-serif").click();
  await page.getByTestId("format-size").click();
  await page.getByTestId("format-size-huge").click();
  await k.type("Título");
  await page.getByTestId("format-size").click();
  await page.getByTestId("format-size-normal").click();
  await page.getByTestId("format-font").click();
  await page.getByTestId("format-font-sans").click();
  await page.getByTestId("format-align").click();
  await page.getByTestId("format-align-center").click();
  await k.press("Enter");
  await page.getByTestId("format-align").click();
  await page.getByTestId("format-align-left").click();
  await k.type("- uno");
  await k.press("Enter");
  await k.type("dos");
  await k.press("Enter");
  await k.press("Tab");
  await k.type("anidado");
  await k.press("Enter");
  await k.press("Enter");
  await k.press("Enter");
  await k.type("1. primero");
  await k.press("Enter");
  await k.type("segundo");
  await k.press("Enter");
  await k.press("Enter");
  await page.getByTestId("format-quote").click();
  await k.type("una cita");
  await k.press("Enter");
  await k.press("Enter");
  await page.getByTestId("format-indent").click();
  await k.type("con sangría");
  await k.press("Enter");
  await page.getByTestId("format-outdent").click();
  await k.type("Mira ");
  await page.getByTestId("compose-link").click();
  await page.getByTestId("link-text").fill("la propuesta");
  await page.getByTestId("link-url").fill("https://acme.example/propuesta");
  await page.getByTestId("link-apply").click();
  await k.type(" y escribe a ana@example.com.");
  const written = await page.evaluate(() => (window as unknown as { __terno: { composerDoc(): unknown } }).__terno.composerDoc());
  expect(written).not.toBeNull();
  await k.press("ControlOrMeta+Enter");

  const mail = await captured(server);
  expect(mail.rcpt).toEqual(["ana@example.com"]);
  expect(mail.raw).toMatch(/^Content-Type: multipart\/alternative;/m);
  const parsed = await parseRaw(mail.raw);
  expect(parsed.subject).toBe("Propuesta con formato");

  // the plain-text part reads well on its own
  expect(parsed.text!.replace(/\r\n/g, "\n").trimEnd()).toBe(
    [
      "Hola Ana,",
      "",
      "Esto es negrita, cursiva, subrayado y tachado.",
      "Importante",
      "Título",
      "• uno",
      "• dos",
      "  • anidado",
      // Enter on an empty item leaves the list (and an empty quoted line leaves the quote): no gap left behind
      "1. primero",
      "2. segundo",
      "> una cita",
      "    con sangría",
      "Mira la propuesta (https://acme.example/propuesta) y escribe a ana@example.com.",
    ].join("\n"),
  );

  // the HTML part: inline styles only, nothing a webmail drops
  const html = parsed.html!;
  expect(html).not.toMatch(/<style|class=|\sid=|<script/i);
  const sent = fragment(html);
  expect(sent).toContain("<b>negrita</b>");
  expect(sent).toContain('<span style="background-color:#fff2a8;color:#202124"><span style="color:#b3261e">Importante</span></span>');
  expect(sent).toContain('<div style="text-align:center">');
  expect(sent).toContain('<a href="https://acme.example/propuesta">la propuesta</a>');
  const g = await gmail(page, sent);
  expect(g.kept).toBe(g.same);
  // and it reads back to exactly the document that was written
  const back = await page.evaluate((h) => (window as unknown as { __terno: { parseMailHtml(h: string): unknown } }).__terno.parseMailHtml(h), g.kept);
  expect(back).toEqual(written);

  // what the recipient sees, as a webmail draws it, light and inverted
  for (const dark of [false, true]) {
    const view = await renderAsWebmail(page, g.kept, dark);
    await expect(view.locator("body")).toHaveScreenshot(`webmail-${dark ? "dark" : "light"}.png`);
    await view.close();
  }

  // the sent copy reads as HTML in Terno too
  await navTo(page, "sent");
  const row = page.locator("[data-testid=thread-row]", { hasText: "Propuesta con formato" }).first();
  await row.dispatchEvent("mousedown");
  const frame = page.getByTestId("message").last().locator("iframe").contentFrame();
  await expect(frame.locator("b")).toHaveText("negrita");
  await expect(frame.locator("a")).toHaveAttribute("href", "https://acme.example/propuesta");
});

test("a formatted reply: the signature and the quote as HTML (attribution, blockquote), threaded; the text part quotes with >", async ({ app: page, server }) => {
  const { accounts } = await server.backend.server.invoke("app.bootstrap", {}, ctx);
  for (const a of accounts) await server.backend.server.invoke("accounts.update", { id: a.id, signature: "Luis\nAcme <Studio>" }, ctx);
  await openRow(page, 0);
  await focusList(page);
  await page.keyboard.press("r");
  await expect(body(page)).toBeFocused();
  await page.keyboard.type("Sí, ");
  await page.keyboard.press("ControlOrMeta+b");
  await page.keyboard.type("el viernes");
  await page.keyboard.press("ControlOrMeta+b");
  await page.keyboard.type(" me va bien.");
  await page.keyboard.press("ControlOrMeta+Enter");

  const mail = await captured(server);
  const parsed = await parseRaw(mail.raw);
  expect(parsed.inReplyTo).toBeTruthy();
  const sent = fragment(parsed.html!);
  expect(sent).toMatch(/^<div>Sí, <b>el viernes<\/b> me va bien\.<\/div><div><br><\/div><div>-- <br>Luis<br>Acme &lt;Studio&gt;<\/div><div><br><\/div><div>On .+ wrote:<\/div><blockquote style="margin:0 0 0 0\.8ex;border-left:2px solid #ccc;padding-left:1ex">/);
  const g = await gmail(page, sent);
  expect(g.kept).toBe(g.same);
  const text = parsed.text!.replace(/\r\n/g, "\n");
  expect(text).toMatch(/^Sí, el viernes me va bien\.\n\n-- \nLuis\nAcme <Studio>\n\nOn .+ wrote:\n> /);
});

test("a plain draft from before plan 16, never edited, still sends one text/plain part", async ({ app: page, server }) => {
  const { sqlDb } = await import("../../backend-dev/src/server");
  const db = sqlDb(server.backend.store);
  const m = db.get<{ id: number; thread_id: number; account_id: number }>("SELECT m.id, m.thread_id, m.account_id FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.in_inbox = 1 ORDER BY t.last_date DESC, m.date DESC LIMIT 1")!;
  await server.backend.store.drafts.save({ accountId: m.account_id, threadId: m.thread_id, mode: "reply", to: [{ name: "", email: "ana@example.com" }], cc: [], subject: "Re: x", bodyText: "Texto plano de antes", inReplyToMessageId: m.id }, Date.now());
  await page.reload();
  await page.locator("[data-ready]").waitFor();
  await openRow(page, 0);
  await focusList(page);
  await page.keyboard.press("r");
  await expect(body(page)).toHaveText("Texto plano de antes");
  await page.keyboard.press("ControlOrMeta+Enter");
  const mail = await captured(server);
  expect(mail.raw).not.toMatch(/multipart/);
  expect((await parseRaw(mail.raw)).text).toContain("Texto plano de antes");
});
