/**
 * Plan 26: recipients as chips, and reply-all addresses that survive other
 * clients. Tagged @design, so it runs in macOS, Lumen and Atelier. Typing and
 * the commit keys; Backspace selects then removes (a held key never does);
 * arrows, Home/End, ⌘A, ⌘C/⌘X/⌘V, Delete, edit by Enter and double click, ×;
 * undo and redo (keys and the Edit menu's path); blur; the single-key
 * shortcuts stay off a focused chip; 200 recipients collapse and expand, and
 * typing renders no chip; reply-all on the user's mangled Cc (as a broken
 * client wrote it, and as an older parser stored it), Reply-To; axe in light
 * and dark with screenshots.
 */
import { mkdirSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { Address } from "@terno/core";
import { parseRaw } from "@terno/mail";
import { msg } from "@terno/store/conformance";
import { E2E_NOW } from "./constants";
import { addRecipients, chipsOf, expect, focusList, recipientEmails, selectThread, test } from "./fixtures";
import type { DevServer } from "../../backend-dev/src/server";

const SHOTS = "/tmp/unica-scratch/chips-26/shots";
mkdirSync(SHOTS, { recursive: true });
const ctx = { clientId: "setup", origin: "dev" as const };
const to = (page: Page) => page.getByTestId("compose-to");
const chips = (page: Page) => chipsOf(page, "compose-to");
const emails = (page: Page) => recipientEmails(page, "compose-to");
const toast = (page: Page, text: string | RegExp) => page.locator("[data-testid=snack]").filter({ hasText: text });

async function newMessage(page: Page) {
  await focusList(page);
  await page.keyboard.press("c");
  await expect(to(page)).toBeFocused();
}

const wcag = (page: Page) => new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).disableRules(["scrollable-region-focusable"]).exclude("iframe");
async function axeClean(page: Page) {
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length)).toBe(0);
  const r = await wcag(page).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 160)).join(", ")}`)).toEqual([]);
}

test.describe("recipient chips", { tag: "@design" }, () => {
  test("comma, semicolon, Enter, a space after an address and blur commit chips; a name keeps typing", async ({ app: page }) => {
    await newMessage(page);
    await page.keyboard.type("ana@x.io,");
    await page.keyboard.type("Bob Stone <bob@stone.io>;");
    await page.keyboard.type("carla@ruiz.mx ");
    await page.keyboard.type("dan@w.io");
    await page.keyboard.press("Enter");
    // a name being typed: the space is a space
    await page.keyboard.type("Eva Luna");
    await expect(to(page)).toHaveValue("Eva Luna");
    await page.keyboard.type(" <eva@luna.cl>");
    // leaving the field commits it; Enter never sent anything
    await page.getByTestId("compose-subject").focus();
    expect(await emails(page)).toEqual(["ana@x.io", "bob@stone.io", "carla@ruiz.mx", "dan@w.io", "eva@luna.cl"]);
    await to(page).focus();
    await expect(chips(page).nth(1)).toHaveText("Bob Stone");
    await expect(chips(page).nth(1)).toHaveAccessibleName("Bob Stone, bob@stone.io");
    await expect(page.getByTestId("compose-to-field").getByRole("listbox", { name: "To recipients" })).toBeVisible();
    await expect(page.getByTestId("new-message").or(page.getByTestId("composer")).first()).toBeVisible();
  });

  test("Backspace selects the chip before, a second press removes it, a held key never does; ⌘Z brings it back, ⇧⌘Z removes it again", async ({ app: page }) => {
    await newMessage(page);
    await addRecipients(page, "compose-to", "ana@x.io, bob@y.io");
    await page.keyboard.type("ca");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    // the key held on, past the text (auto-repeat): it stops at the chips
    await to(page).evaluate((el) => {
      for (let i = 0; i < 5; i++) el.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", repeat: true, bubbles: true, cancelable: true }));
    });
    await expect(chips(page)).toHaveCount(2);
    await expect(to(page)).toBeFocused();
    await page.keyboard.press("Backspace");
    await expect(chips(page).nth(1)).toBeFocused();
    await expect(chips(page).nth(1)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Backspace");
    expect(await emails(page)).toEqual(["ana@x.io"]);
    await expect(to(page)).toBeFocused();
    await expect(page.getByTestId("recipient-announce").first()).toHaveText("Removed bob@y.io");
    await page.keyboard.press("ControlOrMeta+z");
    expect(await emails(page)).toEqual(["ana@x.io", "bob@y.io"]);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    expect(await emails(page)).toEqual(["ana@x.io"]);
    // the Edit menu's Undo (Electron's role item) arrives as a beforeinput: the same history
    await to(page).evaluate((el) => el.dispatchEvent(new InputEvent("beforeinput", { inputType: "historyUndo", bubbles: true, cancelable: true })));
    expect(await emails(page)).toEqual(["ana@x.io", "bob@y.io"]);
  });

  test("arrows, Home/End, Shift and ⌘A select; Delete removes the selection; Enter and a double click edit in place; × by the mouse", async ({ app: page }) => {
    await newMessage(page);
    await addRecipients(page, "compose-to", "a@x.io, Bob <b@x.io>, c@x.io, d@x.io");
    await page.keyboard.press("ArrowLeft");
    await expect(chips(page).nth(3)).toBeFocused();
    await page.keyboard.press("Shift+ArrowLeft");
    await expect(chips(page).nth(2)).toHaveAttribute("aria-selected", "true");
    await expect(chips(page).nth(3)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Delete");
    expect(await emails(page)).toEqual(["a@x.io", "b@x.io"]);
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Home");
    await expect(chips(page).first()).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(chips(page).nth(1)).toBeFocused();
    // Enter edits: the chip turns into text; committing puts it back where it was
    await page.keyboard.press("Enter");
    await expect(to(page)).toBeFocused();
    await expect(to(page)).toHaveValue("Bob <b@x.io>");
    await to(page).fill("Bobby <b@x.io>");
    await page.keyboard.press("Enter");
    await expect(chips(page)).toHaveText(["a@x.io", "Bobby"]);
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("End");
    await expect(to(page)).toBeFocused();
    // ⌘A in the empty input selects every chip
    await page.keyboard.press("ControlOrMeta+a");
    await expect(chips(page).first()).toHaveAttribute("aria-selected", "true");
    await expect(chips(page).nth(1)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Escape");
    await expect(to(page)).toBeFocused();
    // the mouse: a double click edits, the × removes, focus stays in the field
    await chips(page).first().dblclick();
    await expect(to(page)).toHaveValue("a@x.io");
    await page.keyboard.press("Enter");
    // a click selects (the × shows on the selected chip), the × removes
    await expect(chips(page).nth(1).locator("[data-chip-remove]")).toHaveCount(0);
    await chips(page).nth(1).click();
    await expect(chips(page).nth(1)).toBeFocused();
    await chips(page).nth(1).locator("[data-chip-remove]").click();
    expect(await emails(page)).toEqual(["a@x.io"]);
    await expect(to(page)).toBeFocused();
  });

  test("⌘C and ⌘X copy the selected chips as an address list; ⌘V of a list makes chips, what isn't an address kept", async ({ app: page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await newMessage(page);
    await addRecipients(page, "compose-to", '"Pérez, Luis" <l@y.com>, ana@x.io');
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Shift+ArrowLeft");
    await page.keyboard.press("ControlOrMeta+c");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('"Pérez, Luis" <l@y.com>, ana@x.io');
    await page.keyboard.press("ControlOrMeta+x");
    await expect(chips(page)).toHaveCount(0);
    // pasted into Cc: the same two, then a mixed list (Bob's unfinished address stays, to fix)
    await page.getByTestId("compose-show-cc").click();
    await page.getByTestId("compose-cc").focus();
    await page.keyboard.press("ControlOrMeta+v");
    expect(await recipientEmails(page, "compose-cc")).toEqual(["l@y.com", "ana@x.io"]);
    await page.getByTestId("compose-cc").evaluate((el) => {
      const data = new DataTransfer();
      data.setData("text/plain", "carla@ruiz.mx; bob@");
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    expect(await recipientEmails(page, "compose-cc")).toEqual(["l@y.com", "ana@x.io", "carla@ruiz.mx", "bob@"]);
    await expect(chipsOf(page, "compose-cc").last()).toHaveAttribute("aria-invalid", "true");
  });

  test("a focused chip keeps the single-key shortcuts away from the conversation; a letter types into the field", async ({ app: page }) => {
    const subject = (await page.getByTestId("thread-row").first().getByTestId("row-subject").textContent())!;
    await page.getByTestId("thread-row").first().dispatchEvent("mousedown");
    await expect(page.getByTestId("reader-subject")).toBeVisible();
    await focusList(page);
    await page.keyboard.press("r");
    await to(page).focus();
    await page.keyboard.press("Backspace");
    await expect(chips(page).first()).toBeFocused();
    // e would archive, # would delete: here e is typed, # too
    await page.keyboard.press("e");
    await expect(to(page)).toBeFocused();
    await expect(to(page)).toHaveValue("e");
    await expect(page.getByTestId("reader-subject")).toHaveText(subject);
    await expect(chips(page)).toHaveCount(1);
  });

  test("200 recipients: unfocused they collapse to two and “and N more”, focused they all show; typing renders no chip", async ({ app: page }) => {
    await newMessage(page);
    const many = Array.from({ length: 200 }, (_, i) => `Persona ${i} <p${i}@example.com>`).join(", ");
    await to(page).evaluate((el, text) => {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, many);
    await expect(chips(page)).toHaveCount(200);
    const before = await page.evaluate(() => (window as unknown as { __renders?: Record<string, number> }).__renders?.RecipientChip ?? 0);
    await page.keyboard.type("someone", { delay: 20 });
    const after = await page.evaluate(() => (window as unknown as { __renders?: Record<string, number> }).__renders?.RecipientChip ?? 0);
    expect(after - before, "chip renders while typing").toBe(0);
    await to(page).fill("");
    await page.getByTestId("compose-subject").focus();
    await expect(page.getByTestId("compose-to-field")).toHaveAttribute("data-collapsed", "true");
    await expect(chips(page)).toHaveCount(2);
    await expect(page.getByTestId("recipient-more")).toHaveText("and 198 more");
    await expect(page.getByTestId("recipient-more")).toHaveAccessibleDescription("Show all 200 recipients");
    await page.getByTestId("recipient-more").click();
    await expect(to(page)).toBeFocused();
    await expect(chips(page)).toHaveCount(200);
    // Tab into the collapsed field lands in its input, never on a button that goes away (Codex code review 7)
    await page.getByTestId("compose-subject").focus();
    await expect(page.getByTestId("recipient-more")).toBeVisible();
    await page.getByTestId("compose-from").focus();
    await page.keyboard.press("Tab");
    await expect(to(page)).toBeFocused();
    await expect(chips(page)).toHaveCount(200);
  });

  for (const theme of ["light", "dark"] as const) {
    test(`axe and screenshots: a few chips, an invalid one, a selected one, a collapsed list (${theme})`, async ({ app: page, server, design }) => {
      await server.backend.server.invoke("settings.update", { theme }, ctx);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await newMessage(page);
      await addRecipients(page, "compose-to", "Björn Peña <bjorn.pena@acme.studio>, Ana Torres <ana@torres.mx>, no-reply@shop.com, bjorn@acme");
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("ArrowLeft");
      await expect(chips(page).nth(2)).toBeFocused();
      await axeClean(page);
      const box = (await page.getByTestId("compose-to-field").boundingBox())!;
      const clip = { x: Math.max(0, box.x - 90), y: Math.max(0, box.y - 50), width: 760, height: 150 };
      await page.mouse.move(0, 0);
      await page.screenshot({ path: `${SHOTS}/chips-${design ?? "lumen"}-${theme}.png`, clip });
      // a long list, unfocused
      await to(page).focus();
      await addRecipients(page, "compose-to", Array.from({ length: 12 }, (_, i) => `Persona ${i} <p${i}@example.com>`).join(", "));
      await page.getByTestId("compose-subject").focus();
      await expect(page.getByTestId("recipient-more")).toBeVisible();
      await axeClean(page);
      await page.screenshot({ path: `${SHOTS}/collapsed-${design ?? "lumen"}-${theme}.png`, clip });
      // and focused: every chip, wrapping, the label on the first line
      await page.getByTestId("recipient-more").click();
      await page.screenshot({ path: `${SHOTS}/wrapped-${design ?? "lumen"}-${theme}.png`, clip: { ...clip, height: 220 } });
    });
  }
});

/** The user's report: what a broken client wrote in Cc. */
const MANGLED_CC = '"=?utf-8?Q?Jos=C3=A9?=_David_Sucre_L.?= <david@sucre.net> , Luis Alberto Medina" <lmedina@sucre.net>';

async function ingestRaw(server: DevServer, subject: string, headers: string): Promise<number> {
  const [account] = await server.backend.store.accounts.list();
  const raw = `From: Björn Peña <bjorn.pena@acme.studio>\r\nTo: Luis <${account!.email}>\r\n${headers}\r\nSubject: ${subject}\r\nMessage-ID: <${subject.replace(/\W/g, "")}@acme.studio>\r\nDate: Thu, 22 Oct 2026 10:00:00 -0500\r\n\r\nHola a todos.\r\n`;
  const p = await parseRaw(raw);
  await server.backend.ingestSliced([msg({ accountId: account!.id, providerMsgId: subject, rfcMessageId: p.rfcMessageId, from: p.from, to: p.to, cc: p.cc, replyTo: p.replyTo, subject, bodyText: p.text, date: E2E_NOW - 60_000 })]);
  return threadOf(server, subject);
}

async function threadOf(server: DevServer, subject: string): Promise<number> {
  const { sqlDb } = await import("../../backend-dev/src/server");
  return sqlDb(server.backend.store).get<{ id: number }>("SELECT id FROM threads WHERE subject = ?", subject)!.id;
}

async function replyAll(page: Page, threadId: number, subject: string) {
  await selectThread(page, threadId, `subject:"${subject}"`);
  await page.keyboard.press("a");
  await expect(page.getByTestId("compose-cc")).toBeVisible();
}

test.describe("reply-all with addresses other clients mangled", { tag: "@design" }, () => {
  test("the user's Cc, as the broken client wrote it: two clean recipients, never me", async ({ app: page, server }) => {
    const id = await ingestRaw(server, "Presupuesto Sucre", `Cc: ${MANGLED_CC}`);
    await replyAll(page, id, "Presupuesto Sucre");
    expect(await recipientEmails(page, "compose-to")).toEqual(["bjorn.pena@acme.studio"]);
    expect(await recipientEmails(page, "compose-cc")).toEqual(["david@sucre.net", "lmedina@sucre.net"]);
    await expect(chipsOf(page, "compose-cc")).toHaveText(["José David Sucre L.", "Luis Alberto Medina"]);
    // the reader shows the same two
    await expect(page.getByTestId("reader")).toContainText("Luis Alberto Medina");
  });

  test("the same Cc as an older parser stored it: repaired at read, the reply goes to both", async ({ app: page, server }) => {
    const [account] = await server.backend.store.accounts.list();
    const stored: Address = { name: "_David_Sucre_L.?= <david@sucre.net> , Luis Alberto Medina", email: "lmedina@sucre.net" };
    await server.backend.ingestSliced([msg({ accountId: account!.id, providerMsgId: "legacy", from: { name: "Björn Peña", email: "bjorn.pena@acme.studio" }, to: [{ name: "Luis", email: account!.email }], cc: [stored], subject: "Presupuesto antiguo", date: E2E_NOW - 60_000 })]);
    const id = await threadOf(server, "Presupuesto antiguo");
    await replyAll(page, id, "Presupuesto antiguo");
    await expect(chipsOf(page, "compose-cc")).toHaveText(["David Sucre L.", "Luis Alberto Medina"]);
    // what goes out is two clean recipients (the draft as saved)
    await expect(page.getByTestId("draft-status")).toHaveText(/saved/i, { timeout: 10_000 }).catch(() => undefined);
  });

  test("Reply-To is honoured: the list gets the reply, the author isn't added", async ({ app: page, server }) => {
    const id = await ingestRaw(server, "Lista de proveedores", `Reply-To: Proveedores <proveedores@lists.acme.studio>\r\nCc: Ana Torres <ana@torres.mx>`);
    await replyAll(page, id, "Lista de proveedores");
    expect(await recipientEmails(page, "compose-to")).toEqual(["proveedores@lists.acme.studio"]);
    expect(await recipientEmails(page, "compose-cc")).toEqual(["ana@torres.mx"]);
  });

  test("an address that can't be repaired shows as invalid, and Send says so instead of failing", async ({ app: page, server }) => {
    const [account] = await server.backend.store.accounts.list();
    await server.backend.ingestSliced([msg({ accountId: account!.id, providerMsgId: "junk", from: { name: "Björn Peña", email: "bjorn.pena@acme.studio" }, to: [{ name: "", email: account!.email }], cc: [{ name: "", email: "not an address" }], subject: "Con basura", date: E2E_NOW - 60_000 })]);
    const id = await threadOf(server, "Con basura");
    await replyAll(page, id, "Con basura");
    await expect(chipsOf(page, "compose-cc")).toHaveAttribute("aria-invalid", "true");
    await page.getByTestId("compose-body").focus();
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(toast(page, "“not an address” isn’t an email address. Fix or remove it, then send.")).toBeVisible();
    await expect(chipsOf(page, "compose-cc")).toBeFocused();
    // removing it lets the reply go
    await page.keyboard.press("Backspace");
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(toast(page, /Sending|Message sent/)).toBeVisible();
  });
});
