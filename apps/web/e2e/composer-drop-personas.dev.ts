import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseRaw } from "@terno/mail";
import type { JSHandle, Locator, Page, TestInfo } from "@playwright/test";
import { addRecipients, expect, openRow, test } from "./fixtures";

/**
 * Plan 76 usability pass (dev only: playwright.composer-drop-personas.config.ts).
 * Five personas drop files into the composer. Most checks are soft: the point
 * is to observe and log what each persona meets (findings.jsonl and the
 * screenshots in $PERSONAS_OUT), not to gate.
 */

test.use({ backendOptions: { smtpCapture: true } });

const OUT = process.env.PERSONAS_OUT ?? "/tmp/terno-personas";
mkdirSync(join(OUT, "shots"), { recursive: true });

function note(info: TestInfo, scenario: string, data: Record<string, unknown>) {
  const line = { persona: info.titlePath[1] ?? "", test: info.title, scenario, ...data };
  appendFileSync(join(OUT, "findings.jsonl"), JSON.stringify(line) + "\n");
  console.log(`[${scenario}]`, JSON.stringify(data));
}

async function shoot(page: Page, name: string, target?: Locator) {
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForTimeout(30);
    await (target ?? page.getByTestId("composer")).screenshot({ path: join(OUT, "shots", `${name}-${theme}.png`) }).catch(() => {});
  }
  await page.emulateMedia({ colorScheme: "light" });
}

type Spec =
  | { name: string; kind: "raster"; type: string; width?: number; height?: number }
  | { name: string; kind: "gif" }
  | { name: string; kind: "photo"; width: number; height: number; quality?: number }
  | { name: string; kind: "bytes"; type: string; bytes: number }
  | { name: string; kind: "text"; type: string; text: string };

/** A drag's DataTransfer, made in the page (images are real, drawn on a canvas). */
function transfer(page: Page, files: Spec[], extra?: Record<string, string>): Promise<JSHandle<DataTransfer>> {
  return page.evaluateHandle(async ({ specs, extra }) => {
    const dt = new DataTransfer();
    for (const [k, v] of Object.entries(extra ?? {})) dt.setData(k, v);
    for (const s of specs) {
      if (s.kind === "gif") {
        dt.items.add(new File([Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (c) => c.charCodeAt(0))], s.name, { type: "image/gif" }));
      } else if (s.kind === "raster") {
        const canvas = new OffscreenCanvas(s.width ?? 80, s.height ?? 40);
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#3a7"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#e52"; ctx.fillRect(4, 4, canvas.width / 3, canvas.height / 3);
        dt.items.add(new File([await canvas.convertToBlob({ type: s.type })], s.name, { type: s.type }));
      } else if (s.kind === "photo") {
        // a phone photo: smooth gradients plus sensor noise (so the JPEG is as heavy as a real one)
        const canvas = new OffscreenCanvas(s.width, s.height);
        const ctx = canvas.getContext("2d")!;
        const g = ctx.createLinearGradient(0, 0, s.width, s.height);
        g.addColorStop(0, "#2b5876"); g.addColorStop(0.5, "#e9b44c"); g.addColorStop(1, "#4e4376");
        ctx.fillStyle = g; ctx.fillRect(0, 0, s.width, s.height);
        const img = ctx.getImageData(0, 0, s.width, s.height);
        const d = img.data;
        let seed = 7;
        for (let i = 0; i < d.length; i += 4) {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          const n = (seed % 61) - 30;
          d[i] = d[i]! + n; d[i + 1] = d[i + 1]! + n; d[i + 2] = d[i + 2]! + n;
        }
        ctx.putImageData(img, 0, 0);
        dt.items.add(new File([await canvas.convertToBlob({ type: "image/jpeg", quality: s.quality ?? 0.95 })], s.name, { type: "image/jpeg" }));
      } else if (s.kind === "bytes") {
        dt.items.add(new File([new Uint8Array(s.bytes).fill(7)], s.name, { type: s.type }));
      } else {
        dt.items.add(new File([s.text], s.name, { type: s.type }));
      }
    }
    return dt;
  }, { specs: files, extra });
}

const sizes = (dt: JSHandle<DataTransfer>) => dt.evaluate((d) => [...d.files].map((f) => ({ name: f.name, type: f.type, size: f.size })));

type Ev = "dragenter" | "dragover" | "drop" | "dragleave";
async function drag(target: Locator, dt: JSHandle<DataTransfer>, at: { x: number; y: number }, ...types: Ev[]) {
  for (const type of types) await target.dispatchEvent(type, { dataTransfer: dt, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true });
}
/** As a browser moves a drag from one element to another: enter the new, leave the old, then over the new. */
async function move(from: Locator | null, to: Locator, dt: JSHandle<DataTransfer>, at: { x: number; y: number }) {
  await drag(to, dt, at, "dragenter");
  if (from) await drag(from, dt, at, "dragleave");
  await drag(to, dt, at, "dragover");
}

const after = (page: Page, text: string) => page.getByTestId("compose-body").evaluate((el, text) => {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const i = node.data.indexOf(text);
    if (i < 0) continue;
    const range = document.createRange();
    range.setStart(node, i + text.length - 1); range.setEnd(node, i + text.length);
    const r = range.getBoundingClientRect();
    return { x: r.right - 1, y: r.top + r.height / 2 };
  }
  throw new Error(`no ${text}`);
}, text);
/** The point just before the first character of `text`. */
const before = (page: Page, text: string) => page.getByTestId("compose-body").evaluate((el, text) => {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const i = node.data.indexOf(text);
    if (i < 0) continue;
    const range = document.createRange();
    range.setStart(node, i); range.setEnd(node, i + 1);
    const r = range.getBoundingClientRect();
    return { x: r.left + 1, y: r.top + r.height / 2 };
  }
  throw new Error(`no ${text}`);
}, text);
const centre = async (l: Locator) => { const b = (await l.boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };

/** The body as a line of text: [img:alt] for images, [adding] for a placeholder, ¶ between blocks, • for list items, > for quotes. */
const shape = (page: Page) => page.getByTestId("compose-body").evaluate((el) => {
  const out: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === 3) { out.push((n as Text).data); return; }
    const e = n as HTMLElement;
    if (e.tagName === "IMG") {
      if (e.classList.contains("ProseMirror-separator")) return;
      out.push(e.dataset.state === "adding" ? "[adding]" : `[img:${(e as HTMLImageElement).alt}${e.dataset.state ? `/${e.dataset.state}` : ""}]`);
      return;
    }
    if (e.tagName === "BR") return;
    if (e.tagName === "LI") out.push("• ");
    if (e.tagName === "BLOCKQUOTE") out.push("> ");
    for (const c of e.childNodes) walk(c);
    if (e.tagName === "P") out.push(" ¶ ");
  };
  for (const c of el.childNodes) walk(c);
  return out.join("").replace(/\s*¶\s*$/, "").replace(/\s+¶\s+/g, " ¶ ");
});

/** What the drop layer shows right now. */
const look = (page: Page) => page.evaluate(() => {
  const layers = [...document.querySelectorAll<HTMLElement>("[data-testid=compose-drop]")];
  const label = document.querySelector("[data-testid=compose-drop-label]")?.textContent ?? null;
  const caret = document.querySelector<HTMLElement>("[data-testid=compose-drop-caret]");
  return { layers: layers.length, state: layers[0]?.dataset.state ?? null, label, caret: caret ? !caret.hidden : null };
});

const snacks = (page: Page) => page.locator("[data-testid=snack]").allTextContents();
const chips = (page: Page) => page.getByTestId("draft-attachment").allTextContents();
const images = (page: Page) => page.getByTestId("compose-body").locator("img.rt-image:not([data-state])");

async function openReply(page: Page) {
  await openRow(page, 0);
  await page.getByTestId("quick-reply").click();
  await expect(page.getByTestId("compose-body")).toBeVisible();
}

async function sentMail(server: { smtp: { raw: string | Uint8Array }[] }, i = 0) {
  const sent = await parseRaw(server.smtp[i]!.raw);
  return {
    html: sent.html ?? "",
    text: sent.text ?? "",
    attachments: sent.attachments.map((a) => ({ filename: a.filename, mime: a.mime, size: a.size, contentId: a.contentId ?? null })),
  };
}

// ───────────────────────────────────────────────────────────── 1. Rushed executive

test.describe("1 rushed executive", () => {
  test("1a phone photo + PDF onto the reply, types at once, ⌘↵ straight away", async ({ app: page, server }, info) => {
    test.setTimeout(120_000);
    await openReply(page);
    const body = page.getByTestId("compose-body");
    const dt = await transfer(page, [{ name: "IMG_4512.JPG", kind: "photo", width: 4032, height: 3024 }, { name: "Q3 board deck.pdf", kind: "bytes", type: "application/pdf", bytes: 1_200_000 }]);
    note(info, "1a files", { files: await sizes(dt) });
    const spot = await centre(body);
    await drag(body, dt, spot, "dragenter", "dragover");
    note(info, "1a over body", await look(page));
    await shoot(page, "1a-over-body");
    await drag(body, dt, spot, "drop");
    const t0 = Date.now();
    // types at once, then sends
    await page.keyboard.type("See attached. ", { delay: 5 });
    await page.keyboard.press("ControlOrMeta+Enter");
    await page.waitForTimeout(400);
    note(info, "1a first ⌘↵", { ms: Date.now() - t0, smtp: server.smtp.length, snacks: await snacks(page), composer: await page.getByTestId("composer").count(), shape: await shape(page).catch(() => null), adding: await page.getByTestId("compose-image-adding").count() });
    await shoot(page, "1a-staging");
    // wait for it to settle, then send for real
    await expect.poll(async () => (await page.getByTestId("composer").count()) === 0 || (await page.getByTestId("compose-image-adding").count()) === 0, { timeout: 60_000 }).toBe(true);
    note(info, "1a settled", { ms: Date.now() - t0, smtp: server.smtp.length, shape: await shape(page).catch(() => null), chips: await chips(page), snacks: await snacks(page) });
    await shoot(page, "1a-settled");
    if (server.smtp.length === 0) {
      await body.click();
      await page.keyboard.press("ControlOrMeta+Enter");
      await expect.poll(() => server.smtp.length, { timeout: 15_000 }).toBe(1);
    }
    const mail = await sentMail(server);
    note(info, "1a sent", { attachments: mail.attachments, htmlImg: mail.html.match(/<img[^>]*>/g), text: mail.text.slice(0, 200) });
    expect.soft(mail.attachments.map((a) => a.filename).sort(), "both the photo and the PDF went").toEqual(expect.arrayContaining(["Q3 board deck.pdf"]));
    expect.soft(mail.attachments.length, "photo + PDF").toBe(2);
  });

  test("1b keeps typing while the photo stages", async ({ app: page }, info) => {
    test.setTimeout(120_000);
    await openReply(page);
    const body = page.getByTestId("compose-body");
    await body.click();
    await page.keyboard.type("Team, ");
    const dt = await transfer(page, [{ name: "IMG_4513.JPG", kind: "photo", width: 4032, height: 3024 }]);
    const spot = await after(page, "Team,");
    await drag(body, dt, spot, "dragenter", "dragover", "drop");
    const t0 = Date.now();
    // a steady typist for ~4 s
    await page.keyboard.type("here is the photo from the offsite, the whiteboard is on the left and the plan on the right. ".repeat(3), { delay: 12 });
    await expect.poll(() => page.getByTestId("compose-image-adding").count(), { timeout: 60_000 }).toBe(0);
    await page.waitForTimeout(300);
    note(info, "1b after typing", { ms: Date.now() - t0, shape: (await shape(page)).slice(0, 160), snacks: await snacks(page), chips: await chips(page), placed: await images(page).count() });
    await shoot(page, "1b-after-typing");
    expect.soft(await images(page).count(), "the photo landed despite typing").toBe(1);
    expect.soft((await snacks(page)).join(" "), "no error for typing").not.toMatch(/unavailable|Reattach/);
  });

  test("1c ⌘↵ the moment a small image is dropped (before decode finishes)", async ({ app: page, server }, info) => {
    await openReply(page);
    const body = page.getByTestId("compose-body");
    await body.click();
    await page.keyboard.type("Approved.");
    const dt = await transfer(page, [{ name: "signature.png", kind: "raster", type: "image/png", width: 300, height: 100 }]);
    const spot = await after(page, "Approved.");
    // drop and ⌘↵ in the same task, as fast as a person can
    await drag(body, dt, spot, "dragenter", "dragover", "drop");
    await page.keyboard.press("ControlOrMeta+Enter");
    await page.waitForTimeout(1500);
    note(info, "1c result", { smtp: server.smtp.length, snacks: await snacks(page), composer: await page.getByTestId("composer").count() });
    if (server.smtp.length) {
      const mail = await sentMail(server);
      note(info, "1c sent", { attachments: mail.attachments, htmlImg: mail.html.match(/<img[^>]*>/g) });
      expect.soft(mail.attachments.length, "an image dropped just before ⌘↵ goes with the mail (or Send waits/refuses)").toBe(1);
    }
  });
});

test.describe("1 rushed executive (decode window)", () => {
  test("1d drops a phone photo and hits ⌘↵ at once (no typing in between)", async ({ app: page, server }, info) => {
    test.setTimeout(90_000);
    await openReply(page);
    const body = page.getByTestId("compose-body");
    await body.click();
    await page.keyboard.type("Photo from the site visit.");
    const dt = await transfer(page, [{ name: "IMG_4600.JPG", kind: "photo", width: 4032, height: 3024 }]);
    const spot = await after(page, "visit.");
    const t = await page.evaluate(async ({ dt, spot }) => {
      const el = document.querySelector("[data-testid=compose-body]")!;
      for (const type of ["dragenter", "dragover", "drop"]) el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, clientX: spot.x, clientY: spot.y, bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 120));
      const adding = document.querySelectorAll("[data-testid=compose-image-adding]").length;
      (document.querySelector("[data-testid=compose-send]") as HTMLButtonElement).click();
      return { addingAtSend: adding };
    }, { dt, spot });
    await page.waitForTimeout(6000);
    note(info, "1d result", { ...t, smtp: server.smtp.length, snacks: await snacks(page), composer: await page.getByTestId("composer").count() });
    if (server.smtp.length) {
      const mail = await sentMail(server);
      note(info, "1d sent", { attachments: mail.attachments, imgs: mail.html.match(/<img[^>]*>/g), text: mail.text.slice(0, 80) });
      expect.soft(mail.attachments.length, "the photo the user saw (dimmed) in the text was sent").toBe(1);
    }
  });
});

// ───────────────────────────────────────────────────────────── 2. Careful novice

test.describe("2 careful novice", () => {
  test("2a hovers slowly over every part of the reply and reads the pill", async ({ app: page }, info) => {
    await openReply(page);
    const body = page.getByTestId("compose-body");
    await body.click();
    await page.keyboard.type("Hi Ana, here it is.");
    // put a PDF chip there first, so there is a chip row to hover
    const pdf = await transfer(page, [{ name: "contract.pdf", kind: "bytes", type: "application/pdf", bytes: 2000 }]);
    await drag(page.getByTestId("compose-to"), pdf, await centre(page.getByTestId("compose-to")), "dragenter", "dragover", "drop");
    await expect(page.getByTestId("draft-attachment")).toHaveCount(1);
    const img = await transfer(page, [{ name: "floorplan.png", kind: "raster", type: "image/png", width: 200, height: 120 }]);
    const row = page.getByTestId("thread-row").nth(1);
    const spots: [string, Locator][] = [
      ["thread list", row],
      ["sidebar", page.getByTestId("compose-button")],
      ["reader header", page.getByTestId("reader-subject")],
      ["composer To", page.getByTestId("compose-to")],
      ["format bar", page.getByTestId("format-bar")],
      ["body", body],
      ["chip", page.getByTestId("draft-attachment").first()],
      ["send button", page.getByTestId("compose-send")],
    ];
    let prev: Locator | null = null;
    for (const [name, l] of spots) {
      if (!(await l.count())) { note(info, "2a missing", { name }); continue; }
      const at = name === "body" ? await after(page, "Ana,") : await centre(l.first());
      await move(prev, l.first(), img, at);
      await page.waitForTimeout(50);
      const seen = await look(page);
      note(info, `2a over ${name}`, seen);
      if (["thread list", "composer To", "body", "send button"].includes(name)) await shoot(page, `2a-${name.replace(/ /g, "-")}`, name === "thread list" ? page.locator("body") : undefined);
      prev = l.first();
    }
    // leaves the window from the composer (no element below: relatedTarget null, at the edge)
    await prev!.dispatchEvent("dragleave", { dataTransfer: img, clientX: 0, clientY: 0, bubbles: true, cancelable: true });
    await page.waitForTimeout(50);
    const gone = await look(page);
    note(info, "2a left the window", gone);
    expect.soft(gone.layers, "nothing stays lit after the drag leaves the window").toBe(0);
  });

  test("2b cancels a drag over the text: nothing stays highlighted", async ({ app: page }, info) => {
    await openReply(page);
    const body = page.getByTestId("compose-body");
    await body.click();
    await page.keyboard.type("Draft line");
    const img = await transfer(page, [{ name: "a.png", kind: "raster", type: "image/png" }]);
    const spot = await after(page, "Draft");
    // enter from outside: the window, the composer form, then the text
    await move(null, page.getByTestId("composer"), img, spot);
    await move(page.getByTestId("composer"), body, img, spot);
    note(info, "2b over text", await look(page));
    // Escape: Chrome cancels the OS drag and sends dragleave to the element under the pointer (no keydown reaches the page)
    await drag(body, img, spot, "dragleave");
    await page.waitForTimeout(50);
    const after1 = await look(page);
    note(info, "2b after cancel (one dragleave)", after1);
    expect.soft(after1.layers, "cancel clears the composer").toBe(0);
    expect.soft(after1.caret, "no stray drop caret").toBeFalsy();
    // Escape pressed as a key while something is lit (a stuck state): does it clear?
    await move(null, body, img, spot);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    note(info, "2b Escape key while lit (no dragleave)", { ...(await look(page)), collapsed: await page.getByTestId("draft-collapsed").count() });
    // the drag ends elsewhere (dragend/drop at the window): clears
    await page.evaluate(() => window.dispatchEvent(new DragEvent("dragend", { bubbles: true })));
    await page.waitForTimeout(50);
    note(info, "2b after window dragend", await look(page));
    // nothing changed in the text
    if (await page.getByTestId("draft-collapsed").count()) note(info, "2b body after (collapsed)", { text: await page.getByTestId("draft-collapsed").textContent() });
    else note(info, "2b body after", { shape: await shape(page), chips: await chips(page) });
  });

  test("2c drag in and out of the composer several times, ending over the list", async ({ app: page }, info) => {
    await openReply(page);
    const body = page.getByTestId("compose-body");
    const to = page.getByTestId("compose-to");
    const list = page.getByTestId("thread-row").first();
    const pdf = await transfer(page, [{ name: "brief.pdf", kind: "bytes", type: "application/pdf", bytes: 500 }]);
    let prev: Locator | null = null;
    for (let i = 0; i < 4; i++) {
      for (const l of [list, to, body, list]) { await move(prev, l, pdf, await centre(l)); prev = l; }
    }
    const seen = await look(page);
    note(info, "2c over the list after 4 round trips", seen);
    expect.soft(seen.state, "back over the list: only the faint 'available' hint").toBe("available");
    await drag(list, pdf, await centre(list), "drop");
    await page.waitForTimeout(50);
    note(info, "2c dropped on list", { ...(await look(page)), chips: await chips(page), url: page.url() });
  });
});

// ───────────────────────────────────────────────────────────── 3. Power user

test.describe("3 power user", () => {
  async function longMessage(page: Page) {
    const body = page.getByTestId("compose-body");
    await body.click();
    await page.keyboard.type("Alpha paragraph opens the note.");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Beta paragraph sits in the middle.");
    await page.keyboard.press("Enter");
    await page.keyboard.type("- first bullet");
    await page.keyboard.press("Enter");
    await page.keyboard.type("second bullet");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Quoted wisdom here.");
    await page.getByTestId("format-quote").click().catch(async () => { await page.getByTestId("format-more").click(); await page.getByTestId("format-quote").click(); });
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Omega closes it.");
    return body;
  }

  test("3a images at the start, in a bullet, in a quote, between two images, at the end", async ({ app: page, server }, info) => {
    test.setTimeout(90_000);
    await openReply(page);
    const body = await longMessage(page);
    note(info, "3a typed", { shape: await shape(page) });
    const drop = async (name: string, at: { x: number; y: number }) => {
      const dt = await transfer(page, [{ name, kind: "raster", type: "image/png", width: 60, height: 30 }]);
      await drag(body, dt, at, "dragenter", "dragover");
      await page.waitForTimeout(50);
      const seen = await look(page);
      await drag(body, dt, at, "drop");
      await expect.poll(() => page.getByTestId("compose-image-adding").count()).toBe(0);
      await expect(body.locator(`img[alt="${name}"]`)).toHaveCount(1).catch(() => {});
      note(info, `3a drop ${name}`, { pill: seen.label, caret: seen.caret, shape: await shape(page) });
    };
    await drop("start.png", await before(page, "Alpha"));
    await drop("bullet.png", await after(page, "first"));
    await drop("quote.png", await after(page, "Quoted"));
    await drop("end.png", await after(page, "closes it."));
    // between: right after end.png → find the image's right edge
    const endImg = body.locator('img[alt="end.png"]');
    const b = (await endImg.boundingBox())!;
    await drop("between.png", { x: b.x + b.width + 1, y: b.y + b.height / 2 });
    // past the end of the text (empty area below the last line)
    const bb = (await body.boundingBox())!;
    await drop("below.png", { x: bb.x + 40, y: bb.y + bb.height - 4 });
    // way left of a line, in the margin
    const alpha = await before(page, "Beta");
    await drop("margin.png", { x: bb.x + 2, y: alpha.y });
    await shoot(page, "3a-placed");
    const final = await shape(page);
    note(info, "3a final", { shape: final });
    expect.soft(final).toMatch(/^\[img:start\.png\]Alpha/);
    expect.soft(final).toContain("• first[img:bullet.png]");
    expect.soft(final).toContain("Quoted[img:quote.png]");
    expect.soft(final).toMatch(/closes it\.\[img:end\.png\]\[img:between\.png\]/);
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect.poll(() => server.smtp.length).toBe(1);
    const mail = await sentMail(server);
    note(info, "3a sent", { count: mail.attachments.length, inline: mail.attachments.filter((a) => a.contentId).length, imgs: (mail.html.match(/<img[^>]*>/g) ?? []).length });
  });

  test("3b undo/redo repeatedly across three drops and typing", async ({ app: page }, info) => {
    await openReply(page);
    const body = page.getByTestId("compose-body");
    await body.click();
    await page.keyboard.type("one two three");
    const steps: Record<string, unknown>[] = [];
    for (const [name, word] of [["x.png", "one"], ["y.png", "two"], ["z.png", "three"]] as const) {
      const dt = await transfer(page, [{ name, kind: "raster", type: "image/png" }]);
      await drag(body, dt, await after(page, word), "dragenter", "dragover", "drop");
      await expect.poll(() => page.getByTestId("compose-image-adding").count()).toBe(0);
      await page.keyboard.type("!");
    }
    steps.push({ at: "start", shape: await shape(page) });
    for (let i = 0; i < 8; i++) { await page.keyboard.press("ControlOrMeta+z"); steps.push({ at: `undo${i + 1}`, shape: await shape(page) }); }
    for (let i = 0; i < 8; i++) { await page.keyboard.press("ControlOrMeta+Shift+z"); steps.push({ at: `redo${i + 1}`, shape: await shape(page) }); }
    note(info, "3b steps", { steps });
    expect.soft(steps.at(-1)!.shape, "redo all the way restores everything").toBe(steps[0]!.shape);
  });

  test("3c cut an image and paste it elsewhere; copy-paste duplicates it", async ({ app: page, server, context }, info) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openReply(page);
    const body = page.getByTestId("compose-body");
    await body.click();
    await page.keyboard.type("Top line");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Bottom line");
    const dt = await transfer(page, [{ name: "move-me.png", kind: "raster", type: "image/png", width: 90, height: 40 }]);
    await drag(body, dt, await after(page, "Top"), "dragenter", "dragover", "drop");
    await expect(images(page)).toHaveCount(1);
    note(info, "3c placed", { shape: await shape(page) });
    // click the image: a node selection?
    await images(page).first().click();
    const sel = await page.evaluate(() => ({ selected: !!document.querySelector("img.rt-image.ProseMirror-selectednode"), active: document.activeElement?.getAttribute("data-testid") }));
    note(info, "3c click on image", sel);
    await shoot(page, "3c-image-selected");
    await page.keyboard.press("ControlOrMeta+x");
    await page.waitForTimeout(100);
    note(info, "3c after ⌘X", { shape: await shape(page) });
    await page.getByTestId("compose-body").locator("p").nth(1).click();
    await page.keyboard.press("End");
    note(info, "3c caret before ⌘V", await page.evaluate(() => { const s = getSelection()!; return { node: s.anchorNode?.textContent?.slice(0, 30), offset: s.anchorOffset, clip: null }; }));
    note(info, "3c clipboard", { types: await page.evaluate(async () => { try { return (await navigator.clipboard.read()).flatMap((i) => [...i.types]); } catch (e) { return String(e); } }) });
    await page.keyboard.press("ControlOrMeta+v");
    await page.waitForTimeout(300);
    const moved = await shape(page);
    note(info, "3c after ⌘V at the end of the 2nd line", { shape: moved, broken: await body.locator("img.rt-image[data-state=missing]").count() });
    expect.soft(moved, "the cut image lands where pasted").toMatch(/Bottom line\[img:move-me\.png\]/);
    // copy-paste duplicates
    await images(page).first().click();
    await page.keyboard.press("ControlOrMeta+c");
    await page.getByTestId("compose-body").locator("p").first().click();
    await page.keyboard.press("Home");
    await page.keyboard.press("ControlOrMeta+v");
    await page.waitForTimeout(300);
    note(info, "3c after copy + paste at start", { shape: await shape(page) });
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect.poll(() => server.smtp.length).toBe(1);
    const mail = await sentMail(server);
    note(info, "3c sent", { attachments: mail.attachments, imgs: mail.html.match(/<img[^>]*>/g) });
  });

  test("3d drag an already-placed image to another spot (real mouse)", async ({ app: page }, info) => {
    await openReply(page);
    const body = page.getByTestId("compose-body");
    await body.click();
    await page.keyboard.type("Start of text");
    await page.keyboard.press("Enter");
    await page.keyboard.type("End of text");
    const dt = await transfer(page, [{ name: "drag-me.png", kind: "raster", type: "image/png", width: 90, height: 40 }]);
    await drag(body, dt, await after(page, "Start"), "dragenter", "dragover", "drop");
    await expect(images(page)).toHaveCount(1);
    note(info, "3d placed", { shape: await shape(page) });
    // watch what the drop layer does during an in-editor drag
    await page.evaluate(() => {
      const w = window as unknown as { __seen: unknown[] };
      w.__seen = [];
      const obs = new MutationObserver(() => {
        const l = document.querySelector<HTMLElement>("[data-testid=compose-drop]");
        if (l) w.__seen.push({ state: l.dataset.state, label: document.querySelector("[data-testid=compose-drop-label]")?.textContent });
      });
      obs.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state"] });
      document.addEventListener("dragstart", (e) => w.__seen.push({ dragstart: [...(e.dataTransfer?.types ?? [])] }), true);
      document.addEventListener("drop", (e) => w.__seen.push({ drop: [...(e.dataTransfer?.types ?? [])], files: e.dataTransfer?.files.length }), true);
    });
    const img = (await images(page).first().boundingBox())!;
    const target = await after(page, "End of text");
    await page.mouse.move(img.x + img.width / 2, img.y + img.height / 2);
    await page.mouse.down();
    await page.mouse.move(img.x + img.width / 2 + 10, img.y + img.height / 2 + 5, { steps: 3 });
    await page.mouse.move(target.x + 2, target.y, { steps: 8 });
    const during = await look(page);
    await page.mouse.up();
    await page.waitForTimeout(500);
    const result = await shape(page);
    note(info, "3d moved by mouse", { during, result, events: await page.evaluate(() => (window as unknown as { __seen: unknown[] }).__seen.slice(0, 12)), adding: await page.getByTestId("compose-image-adding").count(), chips: await chips(page) });
    expect.soft((result.match(/\[img:/g) ?? []).length, "a move never duplicates the image").toBe(1);
  });
});

// ───────────────────────────────────────────────────────────── 4. Screenshot-heavy support agent

test.describe("4 support agent", () => {
  const paste = (page: Page, dt: JSHandle<DataTransfer>) =>
    page.getByTestId("compose-body").evaluate((el, dt) => el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })), dt);

  test("4a New Message: pastes screenshots, drops PNGs on the text and on To; reload; send", async ({ app: page, server }, info) => {
    test.setTimeout(90_000);
    await page.getByTestId("compose-button").first().click();
    const form = page.getByRole("form", { name: "New message" });
    await expect(form).toBeVisible();
    await addRecipients(page, "compose-to", "customer@example.com");
    await page.getByTestId("compose-subject").fill("Re: export fails");
    const body = page.getByTestId("compose-body");
    await body.click();
    await page.keyboard.type("Step 1: open Settings.");
    await paste(page, await transfer(page, [{ name: "image.png", kind: "raster", type: "image/png", width: 1280, height: 800 }]));
    await page.keyboard.press("Enter");
    await page.keyboard.type("Step 2: click Export.");
    await paste(page, await transfer(page, [{ name: "image.png", kind: "raster", type: "image/png", width: Number(process.env.SECOND_W ?? 1280), height: 800 }]));
    await expect.poll(() => images(page).count()).toBe(2);
    note(info, "4a two pastes", { shape: await shape(page), alts: await images(page).evaluateAll((els) => els.map((e) => (e as HTMLImageElement).alt)) });
    // a dragged PNG from Finder onto the text, then one onto To
    const drop = await transfer(page, [{ name: "error-dialog.png", kind: "raster", type: "image/png", width: 500, height: 300 }]);
    await drag(body, drop, await after(page, "Settings."), "dragenter", "dragover");
    note(info, "4a over text (new message)", await look(page));
    await shoot(page, "4a-new-message-over-text", form);
    await drag(body, drop, await after(page, "Settings."), "drop");
    const log = await transfer(page, [{ name: "console.png", kind: "raster", type: "image/png" }]);
    await drag(page.getByTestId("compose-to"), log, await centre(page.getByTestId("compose-to")), "dragenter", "dragover");
    note(info, "4a over To (new message)", await look(page));
    await drag(page.getByTestId("compose-to"), log, await centre(page.getByTestId("compose-to")), "drop");
    await expect.poll(() => images(page).count()).toBe(3);
    await expect(page.getByTestId("draft-attachment")).toHaveCount(1);
    await shoot(page, "4a-new-message-placed", form);
    const shapeBefore = await shape(page);
    note(info, "4a before reload", { shape: shapeBefore, chips: await chips(page) });
    await page.waitForTimeout(1500);
    await page.reload();
    await page.getByTestId("strip-item").first().click().catch(() => {});
    await expect(page.getByTestId("compose-body")).toBeVisible();
    await expect.poll(() => images(page).count(), { timeout: 10_000 }).toBe(3).catch(() => {});
    note(info, "4a stored html", { html: ((await server.backend.store.drafts.list()).map((d) => d.body_html ?? "").join(" | ").match(/<img[^>]*>/g) ?? []) });
    note(info, "4a stored draft", { drafts: (await server.backend.store.drafts.list()).map((d) => ({ ...d, body_html: undefined, body_text: undefined })) });
    note(info, "4a after reload cids", { cids: await page.getByTestId("compose-body").locator("img.rt-image").evaluateAll((els) => els.map((e) => ({ alt: (e as HTMLImageElement).alt, state: (e as HTMLElement).dataset.state ?? "ok", src: (e as HTMLImageElement).src.slice(0, 30) }))) });
    note(info, "4a after reload", { shape: await shape(page), chips: await chips(page), missing: await page.getByTestId("compose-body").locator("img[data-state=missing]").count() });
    expect.soft(await shape(page)).toBe(shapeBefore);
    await page.getByTestId("compose-body").click();
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect.poll(() => server.smtp.length).toBe(1);
    const mail = await sentMail(server);
    note(info, "4a sent", { attachments: mail.attachments, imgs: mail.html.match(/<img[^>]*>/g), text: mail.text });
    const names = mail.attachments.map((a) => a.filename);
    expect.soft(new Set(names).size, "two pasted screenshots both called image.png: are the names distinguishable?").toBe(names.length);
  });

  test("4b collapses the reply (Esc) while a big screenshot stages, reopens", async ({ app: page }, info) => {
    test.setTimeout(90_000);
    await openReply(page);
    const body = page.getByTestId("compose-body");
    await body.click();
    await page.keyboard.type("Here is what I see:");
    const dt = await transfer(page, [{ name: "Screenshot 2026-10-30 at 10.12.44.png", kind: "photo", width: 3024, height: 1964, quality: 0.97 }]);
    note(info, "4b file", { files: await sizes(dt) });
    await drag(body, dt, await after(page, "see:"), "dragenter", "dragover", "drop");
    await page.waitForTimeout(80);
    const staging = await page.getByTestId("compose-image-adding").count();
    await shoot(page, "4b-staging");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    note(info, "4b collapsed while staging", { stagingShown: staging, collapsed: await page.getByTestId("draft-collapsed").count(), collapsedText: await page.getByTestId("draft-collapsed").textContent().catch(() => null) });
    await page.waitForTimeout(6000);
    note(info, "4b collapsed after wait", { collapsedText: await page.getByTestId("draft-collapsed").textContent().catch(() => null), snacks: await snacks(page) });
    await page.getByTestId("draft-collapsed").click();
    await expect(page.getByTestId("compose-body")).toBeVisible();
    await expect.poll(() => page.getByTestId("compose-image-adding").count(), { timeout: 30_000 }).toBe(0);
    await page.waitForTimeout(500);
    const s = await shape(page);
    note(info, "4b reopened", { shape: s, chips: await chips(page), snacks: await snacks(page) });
    expect.soft(s, "the screenshot is in the text after reopening").toContain("[img:");
  });

  test("4c a reload while an image is still staging", async ({ app: page }, info) => {
    test.setTimeout(90_000);
    await openReply(page);
    const body = page.getByTestId("compose-body");
    await body.click();
    await page.keyboard.type("Logs below");
    const dt = await transfer(page, [{ name: "huge.png", kind: "photo", width: 4032, height: 3024, quality: 0.98 }]);
    await drag(body, dt, await after(page, "below"), "dragenter", "dragover", "drop");
    await page.waitForTimeout(150);
    note(info, "4c before reload", { adding: await page.getByTestId("compose-image-adding").count() });
    let dialog = false;
    page.on("dialog", (d) => { dialog = true; void d.dismiss(); });
    await page.reload();
    await page.getByTestId("draft-collapsed").or(page.getByTestId("compose-body")).first().waitFor({ timeout: 10_000 }).catch(() => {});
    if (await page.getByTestId("draft-collapsed").count()) await page.getByTestId("draft-collapsed").click();
    await page.waitForTimeout(800);
    note(info, "4c after reload", { beforeUnloadPrompt: dialog, shape: await shape(page).catch(() => null), chips: await chips(page), snacks: await snacks(page) });
  });
});

// ───────────────────────────────────────────────────────────── 5. Skeptic

test.describe("5 skeptic", () => {
  test("5a odd types and names on the text: heic, webp, svg, 0 bytes, emoji name, unknown type, uppercase type", async ({ app: page }, info) => {
    await openReply(page);
    const body = page.getByTestId("compose-body");
    await body.click();
    await page.keyboard.type("Testing odd files");
    const cases: Spec[] = [
      { name: "IMG_0001.HEIC", kind: "bytes", type: "image/heic", bytes: 3000 },
      { name: "sticker.webp", kind: "raster", type: "image/webp" },
      { name: "logo.svg", kind: "text", type: "image/svg+xml", text: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>' },
      { name: "empty.txt", kind: "bytes", type: "text/plain", bytes: 0 },
      { name: "empty.png", kind: "bytes", type: "image/png", bytes: 0 },
      { name: "📸 Résumé — 日本 «final».png", kind: "raster", type: "image/png" },
      { name: "no-type-file", kind: "bytes", type: "", bytes: 100 },
      { name: "corrupt.jpg", kind: "bytes", type: "image/jpeg", bytes: 500 },
    ];
    for (const c of cases) {
      const before = { chips: (await chips(page)).length, imgs: await images(page).count() };
      const dt = await transfer(page, [c]);
      const spot = await after(page, "odd");
      await drag(body, dt, spot, "dragenter", "dragover");
      await page.waitForTimeout(50);
      const seen = await look(page);
      await drag(body, dt, spot, "drop");
      await page.waitForTimeout(700);
      await expect.poll(() => page.getByTestId("compose-image-adding").count()).toBe(0);
      const now = { chips: (await chips(page)).length, imgs: await images(page).count() };
      note(info, `5a ${c.name}`, { pill: seen.label, caret: seen.caret, became: now.imgs > before.imgs ? "inline" : now.chips > before.chips ? "chip" : "nothing", snacks: await snacks(page) });
    }
    await shoot(page, "5a-odd-files");
    note(info, "5a final", { shape: await shape(page), chips: await chips(page) });
  });

  test("5b a file too large (19 MB) and a mix whose total is too large", async ({ app: page }, info) => {
    test.setTimeout(90_000);
    await openReply(page);
    const body = page.getByTestId("compose-body");
    const big = await transfer(page, [{ name: "raw-footage.mov", kind: "bytes", type: "video/quicktime", bytes: 19 * 1024 * 1024 }]);
    await drag(body, big, await centre(body), "dragenter", "dragover");
    note(info, "5b over body (19 MB)", await look(page));
    await drag(body, big, await centre(body), "drop");
    await expect.poll(async () => (await snacks(page)).length, { timeout: 15_000 }).toBeGreaterThan(0).catch(() => {});
    note(info, "5b 19 MB", { snacks: await snacks(page), chips: await chips(page), adding: await page.getByText("Adding attachments…").count() });
    await shoot(page, "5b-too-large", page.locator("body"));
    // two 10 MB files: each fine, together too large
    const pair = await transfer(page, [{ name: "a.zip", kind: "bytes", type: "application/zip", bytes: 10 * 1024 * 1024 }, { name: "b.zip", kind: "bytes", type: "application/zip", bytes: 10 * 1024 * 1024 }]);
    await drag(body, pair, await centre(body), "dragenter", "dragover", "drop");
    await page.waitForTimeout(3000);
    note(info, "5b 2×10 MB", { snacks: await snacks(page), chips: await chips(page) });
  });

  test("5c drops while the message is sending", async ({ app: page, server }, info) => {
    await openReply(page);
    const body = page.getByTestId("compose-body");
    await body.click();
    await page.keyboard.type("Sending now");
    const dt = await transfer(page, [{ name: "late.png", kind: "raster", type: "image/png" }]);
    const spot = await after(page, "Sending");
    // click Send and, in the same task, drag over the text
    const seen = await page.evaluate(async ({ dt, spot }) => {
      (document.querySelector("[data-testid=compose-send]") as HTMLButtonElement).click();
      const el = document.querySelector("[data-testid=compose-body]")!;
      for (let i = 0; i < 60 && document.querySelector("[data-testid=compose-send]")?.getAttribute("aria-busy") !== "true"; i++) await new Promise((r) => requestAnimationFrame(r));
      for (const type of ["dragenter", "dragover", "dragover"]) el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, clientX: spot.x, clientY: spot.y, bubbles: true, cancelable: true }));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const layer = document.querySelector<HTMLElement>("[data-testid=compose-drop]");
      const out = { state: layer?.dataset.state ?? null, label: document.querySelector("[data-testid=compose-drop-label]")?.textContent ?? null, sendBusy: document.querySelector("[data-testid=compose-send]")?.getAttribute("aria-busy") };
      el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, clientX: spot.x, clientY: spot.y, bubbles: true, cancelable: true }));
      return out;
    }, { dt, spot });
    note(info, "5c over text while sending", seen);
    await expect.poll(() => server.smtp.length).toBe(1);
    await page.waitForTimeout(500);
    const mail = await sentMail(server);
    note(info, "5c sent", { attachments: mail.attachments, snacks: await snacks(page), composer: await page.getByTestId("composer").count() });
  });

  test("5d drops on the thread list, sidebar and reader with no composer open, and with one open", async ({ app: page }, info) => {
    await openRow(page, 0);
    const url = page.url();
    const pdf = await transfer(page, [{ name: "stray.pdf", kind: "bytes", type: "application/pdf", bytes: 100 }]);
    for (const [name, l] of [["list", page.getByTestId("thread-row").first()], ["sidebar", page.getByTestId("compose-button").first()], ["reader", page.getByTestId("reader-subject")]] as const) {
      const r = await l.evaluate((el, dt) => {
        const over = new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true });
        el.dispatchEvent(over);
        const drop = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
        el.dispatchEvent(drop);
        return { overPrevented: over.defaultPrevented, dropEffect: dt.dropEffect, dropPrevented: drop.defaultPrevented };
      }, pdf);
      note(info, `5d no composer, ${name}`, { ...r, layer: (await look(page)).layers });
    }
    await page.getByTestId("quick-reply").click();
    for (const [name, l] of [["list", page.getByTestId("thread-row").first()], ["sidebar", page.getByTestId("compose-button").first()]] as const) {
      await drag(l, pdf, await centre(l), "dragenter", "dragover");
      const seen = await look(page);
      const prevented = await l.evaluate((el, dt) => { const e = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }); el.dispatchEvent(e); return e.defaultPrevented; }, pdf);
      note(info, `5d composer open, ${name}`, { seen, prevented, after: await look(page), chips: await chips(page) });
    }
    expect.soft(page.url()).toBe(url.replace(/\/?$/, "") === page.url().replace(/\/?$/, "") ? page.url() : url);
    await shoot(page, "5d-available", page.locator("body"));
  });

  test("5e plain text / a link dragged from elsewhere: no file overlay", async ({ app: page }, info) => {
    await openReply(page);
    const body = page.getByTestId("compose-body");
    await body.click();
    await page.keyboard.type("Paste target");
    const text = await page.evaluateHandle(() => { const d = new DataTransfer(); d.setData("text/plain", "hello from Notes"); return d; });
    const link = await page.evaluateHandle(() => { const d = new DataTransfer(); d.setData("text/uri-list", "https://example.com/a.png"); d.setData("text/html", '<img src="https://example.com/a.png">'); return d; });
    for (const [name, dt] of [["text", text], ["link/img-html", link]] as const) {
      await drag(page.getByTestId("thread-row").first(), dt, await centre(page.getByTestId("thread-row").first()), "dragenter", "dragover");
      const anywhere = await look(page);
      await drag(body, dt, await after(page, "Paste"), "dragenter", "dragover");
      note(info, `5e ${name}`, { anywhere, overBody: await look(page) });
      expect.soft((await look(page)).layers, `${name}: no overlay`).toBe(0);
      await drag(body, dt, await after(page, "Paste"), "dragleave");
    }
  });

  test("5f rapid double drop of the same image at two spots, then a third before either settles", async ({ app: page }, info) => {
    await openReply(page);
    const body = page.getByTestId("compose-body");
    await body.click();
    await page.keyboard.type("left middle right");
    const dt = await transfer(page, [{ name: "same.png", kind: "raster", type: "image/png" }]);
    const l = await after(page, "left"), m = await after(page, "middle"), r = await after(page, "right");
    await page.evaluate(({ dt, pts }) => {
      const el = document.querySelector("[data-testid=compose-body]")!;
      for (const p of pts) for (const type of ["dragenter", "dragover", "drop"]) el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, clientX: p.x, clientY: p.y, bubbles: true, cancelable: true }));
    }, { dt, pts: [l, m, r] });
    const mid = await shape(page);
    await expect.poll(() => page.getByTestId("compose-image-adding").count(), { timeout: 15_000 }).toBe(0);
    await page.waitForTimeout(300);
    const s = await shape(page);
    note(info, "5f result", { whilePending: mid, shape: s, snacks: await snacks(page), chips: await chips(page) });
    expect.soft(s).toBe("left[img:same.png] middle[img:same.png] right[img:same.png]");
  });

  test("5g a drag with files the browser can't type yet (no items while dragging)", async ({ app: page }, info) => {
    await openReply(page);
    const body = page.getByTestId("compose-body");
    await body.click();
    await page.keyboard.type("Unknown kind");
    // a DataTransfer that says "Files" but has an item of unknown type
    const dt = await transfer(page, [{ name: "mystery", kind: "bytes", type: "", bytes: 10 }]);
    await drag(body, dt, await after(page, "Unknown"), "dragenter", "dragover");
    note(info, "5g over text", await look(page));
    await drag(body, dt, await after(page, "Unknown"), "drop");
    await page.waitForTimeout(800);
    note(info, "5g dropped", { shape: await shape(page), chips: await chips(page) });
  });
});
