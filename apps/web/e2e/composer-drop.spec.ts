import { parseRaw } from "@terno/mail";
import AxeBuilder from "@axe-core/playwright";
import type { JSHandle, Locator, Page } from "@playwright/test";
import { expect, openRow, stabilize, test } from "./fixtures";

/**
 * Plan 76: files dropped into the composer. Images dropped on the text go
 * where the pointer is; anything else (or a drop off the text) attaches.
 */

test.use({ backendOptions: { smtpCapture: true } });

type Spec = { name: string; type: string; width?: number; height?: number; bytes?: number };

/** A drag's DataTransfer, made in the page: images are real PNGs drawn on a canvas. */
function transfer(page: Page, files: Spec[]): Promise<JSHandle<DataTransfer>> {
  return page.evaluateHandle(async (specs) => {
    const dt = new DataTransfer();
    for (const s of specs) {
      if (s.type === "image/gif") {
        // (a canvas can't write GIF): a real 1×1 one
        dt.items.add(new File([Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (c) => c.charCodeAt(0))], s.name, { type: s.type }));
      } else if (s.type.startsWith("image/")) {
        const canvas = new OffscreenCanvas(s.width ?? 80, s.height ?? 40);
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#3a7"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        dt.items.add(new File([await canvas.convertToBlob({ type: s.type })], s.name, { type: s.type }));
      } else dt.items.add(new File([new Uint8Array(s.bytes ?? 16).fill(7)], s.name, { type: s.type }));
    }
    return dt;
  }, files);
}

async function drag(target: Locator, dt: JSHandle<DataTransfer>, at: { x: number; y: number }, ...types: ("dragenter" | "dragover" | "drop" | "dragleave")[]) {
  for (const type of types) await target.dispatchEvent(type, { dataTransfer: dt, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true });
}

/** The viewport point just after the first `text` in the body. */
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

const centre = async (l: Locator) => { const b = (await l.boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };

test("an image dropped on the text goes where the pointer is; undo takes it out; it is sent inline @design", async ({ app: page, server }, testInfo) => {
  await openRow(page, 0);
  await page.getByTestId("quick-reply").click();
  const body = page.getByTestId("compose-body");
  await body.click();
  await page.keyboard.type("Hello world");
  const dt = await transfer(page, [{ name: "chart.png", type: "image/png", width: 120, height: 60 }]);
  const spot = await after(page, "Hello");
  await drag(body, dt, spot, "dragenter", "dragover");
  const layer = page.getByTestId("compose-drop");
  await expect(layer).toHaveAttribute("data-state", "text");
  await expect(page.getByTestId("compose-drop-label")).toHaveText("Drop to place the image here");
  await expect(page.getByTestId("compose-drop-caret")).toBeVisible();
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await stabilize(page);
    await page.getByTestId("composer").screenshot({ path: testInfo.outputPath(`drag-text-${theme}.png`) });
  }
  await drag(body, dt, spot, "drop");
  await expect(layer).toHaveCount(0);
  const image = body.locator("img.rt-image");
  await expect(image).toHaveCount(1);
  await expect(image).toHaveAttribute("src", /^blob:/);
  await expect(image).toHaveAttribute("alt", "chart.png");
  // in the text where it was dropped, never a chip
  expect(await body.evaluate((el) => el.innerHTML.replace(/<img class="ProseMirror-separator"[^>]*>/g, "").replace(/<img[^>]*>/, "[img]").replace(/<[^>]+>/g, ""))).toBe("Hello[img] world");
  await expect(page.getByTestId("draft-attachment")).toHaveCount(0);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await stabilize(page);
    expect((await new AxeBuilder({ page }).include("[data-testid=composer]").analyze()).violations).toEqual([]);
    await page.getByTestId("composer").screenshot({ path: testInfo.outputPath(`placed-${theme}.png`) });
  }
  // one undo step: out, and back
  await page.keyboard.press("ControlOrMeta+z");
  await expect(image).toHaveCount(0);
  await expect(body).toHaveText("Hello world");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(image).toHaveCount(1);
  // it survives a reload (read back from the local file)
  await expect.poll(async () => (await server.backend.store.drafts.list())[0]?.body_html ?? "").toContain("cid:terno-img-");
  await page.reload();
  await expect(page.getByTestId("compose-body").locator("img.rt-image")).toHaveAttribute("src", /^blob:/);
  await page.getByTestId("compose-send").click();
  await expect.poll(() => server.smtp.length).toBe(1);
  const sent = await parseRaw(server.smtp[0]!.raw);
  expect(sent.attachments).toHaveLength(1);
  const cid = sent.attachments[0]!.contentId!;
  expect(cid).toMatch(/^terno-img-[0-9a-f-]+@terno$/);
  expect(sent.html).toContain(`<img src="cid:${cid}" alt="chart.png" width="120"`);
  expect(sent.text).toContain("Hello[image: chart.png] world");
});

test("a file dropped off the text, or one that isn't an image, attaches as a chip @design", async ({ app: page }, testInfo) => {
  await openRow(page, 0);
  await page.getByTestId("quick-reply").click();
  const dt = await transfer(page, [{ name: "notes.pdf", type: "application/pdf" }]);
  // over the recipients: attach
  const to = page.getByTestId("compose-to");
  await drag(to, dt, await centre(to), "dragenter", "dragover");
  await expect(page.getByTestId("compose-drop")).toHaveAttribute("data-state", "attach");
  await expect(page.getByTestId("compose-drop-label")).toHaveText("Drop to attach");
  await expect(page.getByTestId("compose-drop-caret")).toBeHidden();
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await stabilize(page);
    await page.getByTestId("composer").screenshot({ path: testInfo.outputPath(`drag-attach-${theme}.png`) });
  }
  // leaving clears it at once
  await drag(to, dt, await centre(to), "dragleave");
  await expect(page.getByTestId("compose-drop")).toHaveCount(0);
  // a PDF over the text: still a chip, no caret
  const body = page.getByTestId("compose-body");
  await drag(body, dt, await centre(body), "dragenter", "dragover");
  await expect(page.getByTestId("compose-drop-label")).toHaveText("Drop to attach");
  await expect(page.getByTestId("compose-drop-caret")).toBeHidden();
  await drag(body, dt, await centre(body), "drop");
  await expect(page.getByTestId("draft-attachment")).toHaveCount(1);
  await expect(page.getByTestId("draft-attachment")).toContainText("notes.pdf");
  // an image dropped on the recipients attaches too (the label says how to place it instead)
  const img = await transfer(page, [{ name: "photo.png", type: "image/png" }]);
  await drag(to, img, await centre(to), "dragenter", "dragover");
  await expect(page.getByTestId("compose-drop")).toContainText("Drop on the text to place images in it");
  await drag(to, img, await centre(to), "drop");
  await expect(page.getByTestId("draft-attachment")).toHaveCount(2);
  await expect(body.locator("img.rt-image")).toHaveCount(0);
});

test("images and other files dropped together: images in the text, the rest as chips; several drops in a row all land", async ({ app: page }) => {
  await openRow(page, 0);
  await page.getByTestId("quick-reply").click();
  const body = page.getByTestId("compose-body");
  await body.click();
  await page.keyboard.type("One two");
  const mixed = await transfer(page, [{ name: "a.png", type: "image/png" }, { name: "b.zip", type: "application/zip" }, { name: "c.jpg", type: "image/jpeg" }]);
  const spot = await after(page, "One");
  await drag(body, mixed, spot, "dragenter", "dragover");
  await expect(page.getByTestId("compose-drop-label")).toHaveText("Drop to place the images here and attach the rest");
  await drag(body, mixed, spot, "drop");
  // straight after, before the first has settled: it waits its turn
  const second = await transfer(page, [{ name: "d.gif", type: "image/gif" }]);
  await drag(body, second, await after(page, "two"), "dragenter", "dragover", "drop");
  await expect(body.locator("img.rt-image:not([data-state])")).toHaveCount(3);
  await expect(page.getByTestId("draft-attachment")).toHaveCount(1);
  await expect(page.getByTestId("draft-attachment")).toContainText("b.zip");
  expect(await body.evaluate((el) => [...el.querySelectorAll("img.rt-image")].map((i) => (i as HTMLImageElement).alt))).toEqual(["a.png", "c.jpg", "d.gif"]);
});

test("a pasted screenshot goes in at the caret", async ({ app: page }) => {
  await openRow(page, 0);
  await page.getByTestId("quick-reply").click();
  const body = page.getByTestId("compose-body");
  await body.click();
  await page.keyboard.type("See ");
  const dt = await transfer(page, [{ name: "image.png", type: "image/png" }]);
  await body.evaluate((el, dt) => el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })), dt);
  await page.keyboard.type("above");
  await expect(body.locator("img.rt-image:not([data-state])")).toHaveCount(1);
  expect(await body.evaluate((el) => el.innerHTML.replace(/<img class="ProseMirror-separator"[^>]*>/g, "").replace(/<img[^>]*>/, "[img]").replace(/<[^>]+>/g, ""))).toBe("See [img]above");
});

test("a file dropped outside the composer never leaves the app; dragging anywhere shows the composer takes files", async ({ app: page }) => {
  await openRow(page, 0);
  await page.getByTestId("quick-reply").click();
  const url = page.url();
  const dt = await transfer(page, [{ name: "notes.pdf", type: "application/pdf" }]);
  const list = page.getByTestId("thread-row").first();
  await drag(list, dt, await centre(list), "dragenter", "dragover");
  await expect(page.getByTestId("compose-drop")).toHaveAttribute("data-state", "available");
  await expect(page.getByTestId("compose-drop-label")).toHaveText("Drop files here to attach");
  const prevented = await list.evaluate((el, dt) => { const e = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }); el.dispatchEvent(e); return e.defaultPrevented; }, dt);
  expect(prevented).toBe(true);
  await expect(page.getByTestId("compose-drop")).toHaveCount(0);
  expect(page.url()).toBe(url);
  await expect(page.getByTestId("draft-attachment")).toHaveCount(0);
});
