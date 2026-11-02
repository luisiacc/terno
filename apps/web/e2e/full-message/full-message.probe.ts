import { inflateSync } from "node:zlib";
import { existsSync, renameSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

  const color = (png: Buffer) => {
    const chunks: Buffer[] = [];
    for (let offset = 8; offset < png.length;) {
      const length = png.readUInt32BE(offset);
      if (png.toString("ascii", offset + 4, offset + 8) === "IDAT") chunks.push(png.subarray(offset + 8, offset + 8 + length));
      offset += length + 12;
    }
    // A 1×1 first-row PNG has zero predictors under every PNG filter.
    return [...inflateSync(Buffer.concat(chunks)).subarray(1, 4)];
  };
type Fixture = { fullFixture: { calls: string[]; original: string; cursor(): { selectedId: number | null; anchorId: number | null; readerOpen: boolean; checked: number[] }; replace(): void; navigate(): void; collapse(): void } };
const show = (page: Page, es = false) => page.getByRole("button", { name: es ? "Mostrar mensaje completo" : "Show full message", exact: true });
const full = (page: Page) => page.getByTestId("full-message");
const mail = (page: Page) => full(page).locator("iframe").contentFrame();
async function nativeMessageCopy(page: Page): Promise<string> {
  const body = page.locator("iframe").first().contentFrame().locator("body");
  await body.click({ position: { x: 2, y: 2 } });
  await body.evaluate((element) => {
    const range = element.ownerDocument.createRange(); range.selectNodeContents(element);
    const selection = element.ownerDocument.getSelection()!;
    selection.removeAllRanges(); selection.addRange(range);
  });
  await page.keyboard.press("Meta+c");
  return page.evaluate(() => navigator.clipboard.readText());
}
const blockNetwork = (page: Page) => page.route("**/*", (route) => {
  const url = new URL(route.request().url());
  const local = url.origin === "http://127.0.0.1:61640" && /^\/(?:e2e\/full-message\/|src\/|node_modules\/|@vite\/|@fs\/|@id\/|@react-refresh|mail-image)/.test(url.pathname);
  return local ? route.continue() : route.abort();
});

test.beforeEach(async ({ page }) => { await blockNetwork(page); });

test("tall/short and actually overflowing sender boxes disclose at full width with no inner scroll", async ({ page }) => {
  for (const query of ["", "?absolute", "?overflow"]) {
    await page.goto(`/e2e/full-message/index.html${query}`);
    await expect(show(page)).toBeVisible();
    if (!query) await expect(page.locator("iframe").contentFrame().locator("#last")).toHaveAttribute("tabindex", "-1");
    const frame = page.locator("iframe");
    const widths = await frame.evaluate((f: HTMLIFrameElement) => ({ frame: f.getBoundingClientRect().width, parent: f.parentElement!.getBoundingClientRect().width, overflow: getComputedStyle(f.contentDocument!.documentElement).overflowY }));
    expect(widths.frame).toBe(widths.parent);
    expect(widths.overflow).toBe("clip");
    await frame.evaluate((f: HTMLIFrameElement) => f.contentWindow!.scrollTo(0, 1000));
    expect(await frame.evaluate((f: HTMLIFrameElement) => f.contentWindow!.scrollY)).toBe(0);
  }
  await page.goto("/e2e/full-message/index.html?short");
  await expect(page.locator("iframe").contentFrame().locator("body")).toHaveText("Short exact message");
  await expect(show(page)).toHaveCount(0);
  expect(await page.locator("iframe").evaluate((f) => f.getBoundingClientRect().height)).toBeLessThan(120);
});

for (const mode of ["light", "dark"] as const) for (const es of [false, true]) {
  test(`physical-limit body is complete in actual Reader; exact keyboard return (${mode}/${es ? "es" : "en"})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: mode });
    await page.goto(`/e2e/full-message/index.html?reader&physical${es ? "&es" : ""}`);
    const trigger = show(page, es);
    await trigger.scrollIntoViewIfNeeded();
    await trigger.focus();
    const source = page.locator("[data-reader-scroller]");
    const before = await source.evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight }));
    const anchor = await trigger.boundingBox();
    const cursor = await page.evaluate(() => (window as unknown as Fixture).fullFixture.cursor());
    for (const exit of ["Escape", "back", "Escape"]) {
      await page.keyboard.press("Enter");
      await expect(full(page)).toBeVisible();
  await expect(full(page)).toHaveAttribute("aria-busy", "false");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(full(page).getByRole("button", { name: es ? "Volver a la conversación" : "Back to conversation", exact: true })).toBeFocused();
      const text = await mail(page).locator("body").textContent();
      for (let i = 0; i < 40; i++) expect(text).toContain(`Block ${i}`);
      await full(page).locator("[data-full-message-scroller]").evaluate((el) => { el.scrollTop = el.scrollHeight; });
      const bounds = await mail(page).locator("#last").boundingBox();
      const outer = (await full(page).locator("[data-full-message-scroller]").boundingBox())!;
      expect(bounds!.y).toBeGreaterThanOrEqual(outer.y);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(outer.y + outer.height);
      expect(await full(page).locator("iframe").evaluate((f: HTMLIFrameElement) => f.contentWindow!.scrollY)).toBe(0);
      if (exit === "back") await full(page).getByRole("button", { name: es ? "Volver a la conversación" : "Back to conversation", exact: true }).click();
      else {
        await mail(page).locator("#last").click();
        await page.keyboard.press("Escape");
      }
      await expect(full(page)).toHaveCount(0);
      await expect(trigger).toBeFocused();
      expect(await source.evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight }))).toEqual(before);
      expect(await trigger.boundingBox()).toEqual(anchor);
      expect(await page.evaluate(() => (window as unknown as Fixture).fullFixture.cursor())).toEqual(cursor);
    }
    await page.keyboard.press("Enter");
    await expect(full(page)).toBeVisible();
  await expect(full(page)).toHaveAttribute("aria-busy", "false");
    expect((await new AxeBuilder({ page }).setLegacyMode().include('[data-testid="full-message"]').withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.screenshot({ path: `/tmp/terno-w11-full-61640/full-${mode}-${es ? "es" : "en"}.png` });
  });
}

test("one intrinsically huge text leaf preserves all sections, links, native selection and whole-message copy", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/e2e/full-message/index.html?intrinsic");
  await expect(show(page)).toBeVisible();
  const nativeCopy = await nativeMessageCopy(page);
  expect(nativeCopy.match(/Exact words/g)).toHaveLength(2000);
  expect(nativeCopy).toContain("Exact final mail text");
  await show(page).click();
  await expect(full(page)).toBeVisible();
  await expect(full(page)).toHaveAttribute("aria-busy", "false");
  const text: string[] = [];
  for (;;) {
    await expect(full(page)).toHaveAttribute("aria-busy", "false");
    const body = mail(page).locator("body");
    await expect(body).toContainText("Exact");
    text.push((await body.textContent())!);
    if (await full(page).getByRole("button", { name: "Next section", exact: true }).isDisabled()) break;
    await full(page).getByRole("button", { name: "Next section", exact: true }).click();
  }
  expect(text.join("")).toBe("Exact words 😀\n ".repeat(2000) + "Exact final mail text");
  await full(page).getByRole("button", { name: "Copy entire message", exact: true }).click();
  await expect(full(page).getByRole("button", { name: "Message copied", exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(nativeCopy);
  await full(page).getByRole("button", { name: "Previous section", exact: true }).click();
  const selected = await mail(page).locator("body").evaluate((el) => {
    const range = el.ownerDocument.createRange(); range.selectNodeContents(el);
    el.ownerDocument.getSelection()!.removeAllRanges(); el.ownerDocument.getSelection()!.addRange(range);
    return el.ownerDocument.getSelection()!.toString();
  });
  expect(selected).toContain("Exact words");
  await expect(mail(page).locator("a")).toHaveAttribute("href", "https://example.invalid/last");
});

test("loading can be cancelled and old module completion cannot reopen a changed message", async ({ page }) => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/src/components/full-message.tsx*", async (route) => { await hold; await route.continue(); });
  await page.goto("/e2e/full-message/index.html");
  await show(page).click();
  await expect(page.getByText("Loading full message…", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(show(page)).toBeFocused();
  await show(page).click();
  await page.evaluate(() => (window as unknown as Fixture).fullFixture.replace());
  release();
  await expect(page.locator("iframe").contentFrame().locator("body")).toHaveText("Replacement short body");
  await expect(full(page)).toHaveCount(0);
  await expect(show(page)).toHaveCount(0);
});

test("semantic collapse and target navigation retire the active page", async ({ page }) => {
  for (const action of ["collapse", "navigate"] as const) {
    await page.goto("/e2e/full-message/index.html");
    await show(page).click();
    await expect(full(page)).toBeVisible();
  await expect(full(page)).toHaveAttribute("aria-busy", "false");
    await page.evaluate((name) => (window as unknown as Fixture).fullFixture[name](), action);
    await expect(full(page)).toHaveCount(0);
  }
});

test("remote consent and exact local CID remain shared; print Escape closes print before full view", async ({ page }) => {
  const hits: string[] = [];
  await page.route("**/mail-image", (route) => { hits.push(route.request().url()); return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>' }); });
  await page.goto("/e2e/full-message/index.html?remote");
  await show(page).click();
  await expect(full(page)).toBeVisible();
  await expect(full(page)).toHaveAttribute("aria-busy", "false");
  expect(hits).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as Fixture).fullFixture.calls.filter((c) => c === "attachments.read"))).toEqual([]);
  await full(page).getByTestId("inline-load").click();
  await expect(mail(page).getByAltText("Inline logo")).toHaveJSProperty("naturalWidth", 1);
  await expect(mail(page).getByAltText("Inline logo")).toHaveAttribute("src", "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0u0AAAAASUVORK5CYII=");
  expect(hits).toEqual([]);
  await full(page).getByTestId("remote-load").click();
  await expect(mail(page).getByAltText("Remote image")).toHaveJSProperty("naturalWidth", 100);
  await mail(page).locator("body").click();
  await page.keyboard.press("Meta+p");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(full(page)).toBeVisible();
  await expect(full(page)).toHaveAttribute("aria-busy", "false");
  await page.keyboard.press("Escape");
  await expect(full(page)).toHaveCount(0);
  await expect(show(page)).toBeFocused();
});

test("heavy modules stay unloaded until opened; source replacement shrinks the preview", async ({ page }) => {
  const loaded: string[] = [];
  page.on("request", (request) => loaded.push(new URL(request.url()).pathname));
  await page.goto("/e2e/full-message/index.html");
  await expect(show(page)).toBeVisible();
  expect(loaded.filter((path) => /\/src\/components\/(full-message|mail-sections|mail-graphic)\.tsx?$/.test(path))).toEqual([]);
  await show(page).click();
  await expect(full(page)).toBeVisible();
  await expect(full(page)).toHaveAttribute("aria-busy", "false");
  expect(loaded).toContain("/src/components/full-message.tsx");
  expect(loaded).toContain("/src/components/mail-sections.ts");
  expect(loaded).toContain("/src/components/mail-graphic.ts");
  await page.keyboard.press("Escape");
  await page.evaluate(() => (window as unknown as Fixture).fullFixture.replace());
  await expect(show(page)).toHaveCount(0);
  await expect(page.locator("iframe").contentFrame().locator("body")).toHaveText("Replacement short body");
  await expect.poll(() => page.locator("iframe").evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(120);
});

test("fractional width and zoom reflow keep the final content on the outer page", async ({ page }) => {
  await page.goto("/e2e/full-message/index.html?physical");
  await page.evaluate(() => { document.documentElement.style.zoom = "1.25"; document.querySelector<HTMLElement>("main")!.style.width = "637.5px"; });
  await show(page).click();
  await expect(full(page)).toBeVisible();
  await expect(full(page)).toHaveAttribute("aria-busy", "false");
  await full(page).locator("[data-full-message-scroller]").evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const last = (await mail(page).locator("#last").boundingBox())!;
  const outer = (await full(page).locator("[data-full-message-scroller]").boundingBox())!;
  expect(last.y).toBeGreaterThanOrEqual(outer.y);
  expect(last.y + last.height).toBeLessThanOrEqual(outer.y + outer.height + 1);
  expect(await full(page).locator("iframe").evaluate((f: HTMLIFrameElement) => f.contentWindow!.scrollY)).toBe(0);
});

test("a late image can make previously short content clipped; keyboard uses the outer scroller", async ({ page }) => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/mail-image", async (route) => {
    await hold;
    await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="2500"><rect width="100" height="2500" fill="red"/></svg>' });
  });
  await page.goto("/e2e/full-message/index.html?late");
  await expect.poll(() => page.locator("iframe").evaluate((f: HTMLIFrameElement) => f.contentDocument?.readyState === "complete" && f.getBoundingClientRect().height > 19_000)).toBe(true);
  await expect(show(page)).toHaveCount(0);
  await page.getByTestId("remote-load").click();
  await page.locator("[data-reader-scroller]").evaluate((el) => { el.scrollTop = el.scrollHeight; });
  release();
  await expect(show(page)).toBeVisible();
  await show(page).click();
  await expect(full(page)).toBeVisible();
  await expect(full(page)).toHaveAttribute("aria-busy", "false");
  await full(page).getByRole("button", { name: "Back to conversation", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(full(page).getByRole("button", { name: "Copy entire message", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  const outer = full(page).locator("[data-full-message-scroller]");
  await expect(outer).toBeFocused();
  expect(await outer.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("none");
  await page.keyboard.press("PageDown");
  await expect.poll(() => outer.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await full(page).locator("iframe").evaluate((f: HTMLIFrameElement) => f.contentWindow!.scrollY)).toBe(0);
});

test("the reader Back command returns from full message before navigating the conversation", async ({ page }) => {
  await page.goto("/e2e/full-message/index.html");
  await show(page).click();
  await expect(full(page)).toBeVisible();
  await expect(full(page)).toHaveAttribute("aria-busy", "false");
  await page.evaluate(async () => { const path = "/src/lib/page.ts"; (await import(path)).goBack(); });
  await expect(full(page)).toHaveCount(0);
  await expect(show(page)).toBeFocused();
});

test("whole-message copy preserves the original paragraph boundaries", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/e2e/full-message/index.html");
  await expect(show(page)).toBeVisible();
  const nativeCopy = await nativeMessageCopy(page);
  expect(nativeCopy).toContain("Line 0\n");
  expect(nativeCopy).toContain("Line 1399\n");
  expect(nativeCopy).toContain("Exact final mail text");
  await show(page).click();
  await full(page).getByRole("button", { name: "Copy entire message", exact: true }).click();
  await expect(full(page).getByRole("button", { name: "Message copied", exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(nativeCopy);
});

test("repainting the clipped preview keeps its document and entry point", async ({ page }) => {
  await page.goto("/e2e/full-message/index.html");
  await expect(show(page)).toBeVisible();
  await page.locator("iframe").evaluate((f: HTMLIFrameElement) => Object.assign(window, { previewDocument: f.contentDocument }));
  await page.evaluate(async () => {
    const path = "/src/lib/appearance.ts";
    (await import(path)).applyAppearance({ theme: "dark", design: "macos", lightTheme: "design", darkTheme: "design", motionMs: 0, customThemes: [] });
  });
  await expect(show(page)).toBeVisible();
  expect(await page.locator("iframe").evaluate((f: HTMLIFrameElement) => f.contentDocument === (window as unknown as { previewDocument: Document }).previewDocument)).toBe(true);
  expect(await page.locator("iframe").evaluate((f: HTMLIFrameElement) => f.contentWindow!.scrollY)).toBe(0);
});

test("a failed lazy load leaves an accessible return to the unchanged conversation", async ({ page }) => {
  await page.route("**/src/components/full-message.tsx*", (route) => route.abort());
  await page.goto("/e2e/full-message/index.html");
  await show(page).click();
  await expect(page.getByRole("alert")).toHaveText("The full message could not load. Go back and try again.");
  await page.getByRole("button", { name: "Back to conversation", exact: true }).click();
  await expect(show(page)).toBeFocused();
});

test("deep repeated display context is adaptively bounded without losing payload", async ({ page }) => {
  await page.goto("/e2e/full-message/index.html?deep");
  await show(page).click();
  const parts: string[] = [];
  for (;;) {
    await expect(full(page)).toHaveAttribute("aria-busy", "false");
    const frame = full(page).locator("iframe");
    await expect.poll(() => frame.evaluate((f: HTMLIFrameElement) => f.contentDocument?.readyState === "complete" && f.contentDocument.querySelector("[data-terno-flow]") !== null && Math.abs(f.getBoundingClientRect().height - f.contentDocument.documentElement.getBoundingClientRect().height) < 1)).toBe(true);
    expect(await frame.evaluate((f) => f.getBoundingClientRect().height)).toBeLessThanOrEqual(4_000_000);
    parts.push((await mail(page).locator("body").textContent())!);
    if (await full(page).getByRole("button", { name: "Next section", exact: true }).isDisabled()) break;
    await full(page).getByRole("button", { name: "Next section", exact: true }).click();
  }
  expect(parts.join("")).toBe(Array.from({ length: 8 }, (_, i) => `Payload ${i}`).join("") + "Exact final mail text");
});

test("consented image shrink keeps full view open and returns to the same message", async ({ page }) => {
  await page.route("**/mail-image", (route) => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>' }));
  await page.goto("/e2e/full-message/index.html?shrink");
  await show(page).click();
  await expect(full(page)).toBeVisible();
  await full(page).getByTestId("remote-load").click();
  await expect(mail(page).getByAltText("Shrinking image")).toHaveJSProperty("naturalWidth", 100);
  await expect(full(page)).toBeVisible();
  await full(page).getByRole("button", { name: "Back to conversation", exact: true }).click();
  await expect(full(page)).toHaveCount(0);
  await expect(show(page)).toHaveCount(0);
  await expect(page.locator("iframe")).toBeFocused();
  await expect.poll(() => page.locator("iframe").evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(200);
});

test("full-view message menu opens one print sheet containing the entire original body", async ({ page }) => {
  await page.goto("/e2e/full-message/index.html?reader");
  await show(page).click();
  await expect(full(page)).toHaveAttribute("aria-busy", "false");
  await mail(page).locator("p").first().click({ button: "right" });
  await expect(page.getByTestId("message-menu")).toHaveCount(1);
  await page.getByTestId("message-menu-print").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const printed = page.getByTestId("print-preview").contentFrame().locator("body");
  await expect(printed).toContainText("Line 1399");
  await expect(printed).toContainText("Exact final mail text");
  await page.keyboard.press("Escape");
  await expect(full(page)).toBeVisible();
});

test("a new reader focus request retires the child page without stealing its focus", async ({ page }) => {
  await page.goto("/e2e/full-message/index.html?reader");
  await show(page).click();
  await expect(full(page)).toHaveAttribute("aria-busy", "false");
  await page.evaluate(async () => {
    const path = "/src/state/app.ts";
    (await import(path)).setApp({ draftFocus: { key: "synthetic-focus-owner", target: "body", seq: 42 } });
  });
  await expect(full(page)).toHaveCount(0);
  await expect(show(page)).not.toBeFocused();
  await page.evaluate(async () => { const path = "/src/state/app.ts"; (await import(path)).setApp({ draftFocus: null }); });
  await expect(full(page)).toHaveCount(0);
});

test("multiple background assets on ancestor context still expose the complete payload", async ({ page }) => {
  await page.goto("/e2e/full-message/index.html?background-cap");
  await expect(show(page)).toBeVisible();
  await show(page).click();
  let images = 0; const text: string[] = [];
  for (;;) {
    await expect(full(page)).toHaveAttribute("aria-busy", "false");
    images += await mail(page).locator("img").count();
    text.push((await mail(page).locator("body").textContent())!);
    expect(await full(page).locator("iframe").evaluate((frame) => frame.getBoundingClientRect().height)).toBeLessThanOrEqual(4_000_000);
    if (await full(page).getByRole("button", { name: "Next section", exact: true }).isDisabled()) break;
    await full(page).getByRole("button", { name: "Next section", exact: true }).click();
  }
  expect(images).toBe(960);
  expect(text.join("")).toBe("Exact final mail text");
});

test("the full-width preview affordance aligns in the actual reader in both themes", async ({ page }) => {
  for (const mode of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: mode });
    await page.goto("/e2e/full-message/index.html?reader");
    await show(page).scrollIntoViewIfNeeded();
    await expect(show(page)).toBeVisible();
    const frame = page.getByTestId("reader").locator("iframe");
    expect(await frame.evaluate((element) => element.getBoundingClientRect().width === element.parentElement!.getBoundingClientRect().width)).toBe(true);
    await page.screenshot({ path: `/tmp/terno-w11-full-61640/preview-${mode}.png` });
  }
});

test("a 100000-node SVG never takes an atomic deep-clone expansion on opening", async ({ page }) => {
  await page.goto("/e2e/full-message/index.html?large-svg");
  await expect(show(page)).toBeVisible();
  await page.evaluate(() => {
    const original = Range.prototype.cloneContents;
    Object.assign(window, { largestGraphicClone: 0 });
    Range.prototype.cloneContents = function () {
      const result = original.call(this);
      const count = result.querySelectorAll("svg *").length;
      const state = window as unknown as { largestGraphicClone: number };
      state.largestGraphicClone = Math.max(state.largestGraphicClone, count);
      return result;
    };
  });
  await show(page).click();
  await expect(full(page)).toHaveAttribute("aria-busy", "false");
  expect(await page.evaluate(() => (window as unknown as { largestGraphicClone: number }).largestGraphicClone)).toBeLessThanOrEqual(64);
  await expect(mail(page).locator("svg path")).toHaveCount(100000);
  const graphic = (await mail(page).locator("svg").first().boundingBox())!;
  expect(color(await page.screenshot({ clip: { x: graphic.x + graphic.width / 2, y: graphic.y + graphic.height / 2, width: 1, height: 1 } }))).toEqual([0,128,0]);
  await expect(mail(page).locator("svg text")).toHaveText("Complete graphic label");
});

for (const query of ["svg-reference", "svg-inherited", "svg-case-upper", "svg-case-inherited"]) test(`a later SVG renders its earlier pattern dependency (${query})`, async ({ page }) => {
  await page.goto(`/e2e/full-message/index.html?${query}`);
  await expect(show(page)).toBeVisible();
  const control = await page.locator("iframe").contentFrame().locator("#control-pixel").boundingBox();
  const prefix = `/tmp/terno-w11-r1-fixes-61640/cross-reference-${query}`;
  for (const kind of ["control", "result"]) { const path = `${prefix}-${kind}.png`; if (existsSync(path)) renameSync(path, `${path}.${Date.now()}.archive`); }
  const expected = await page.screenshot({ path: `${prefix}-control.png`, clip: { x: control!.x + control!.width / 2, y: control!.y + control!.height / 2, width: 1, height: 1 } });
  expect(color(expected)).toEqual([0, 255, 0]);
  await show(page).click();
  for (;;) {
    await expect(full(page)).toHaveAttribute("aria-busy", "false");
    if (await mail(page).locator("#referenced-pixel").count()) break;
    await full(page).getByRole("button", { name: "Next section", exact: true }).click();
  }
  await mail(page).locator("#referenced-pixel").scrollIntoViewIfNeeded();
  const actual = await mail(page).locator("#referenced-pixel").boundingBox();
  expect(color(await page.screenshot({ path: `${prefix}-result.png`, clip: { x: actual!.x + actual!.width / 2, y: actual!.y + actual!.height / 2, width: 1, height: 1 } }))).toEqual(color(expected));
});

test("Escape dismisses the full-reader context menu before returning to the conversation", async ({ page }) => {
  await page.goto("/e2e/full-message/index.html?reader&keyboard");
  await page.evaluate(async () => { const path = "/src/state/app.ts"; (await import(path)).setApp({ checked: new Set([1]), anchorId: 1 }); });
  const cursor = await page.evaluate(() => (window as unknown as Fixture).fullFixture.cursor());
  const trigger = show(page);
  await trigger.scrollIntoViewIfNeeded(); await trigger.focus();
  const position = await page.locator("[data-reader-scroller]").evaluate((element) => element.scrollTop);
  await page.keyboard.press("Enter");
  await expect(full(page)).toHaveAttribute("aria-busy", "false");
  await mail(page).locator("p").first().click({ button: "right" });
  const menu = page.getByTestId("message-menu");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(full(page)).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as Fixture).fullFixture.cursor())).toEqual(cursor);
  expect(await page.evaluate(() => document.activeElement?.closest('[data-full-message-host]') !== null)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(full(page)).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await page.locator("[data-reader-scroller]").evaluate((element) => element.scrollTop)).toBe(position);
});

test("a consumed or composing Escape preserves full-reader focus ownership", async ({ page }) => {
  await page.goto("/e2e/full-message/index.html?reader");
  await show(page).click();
  await expect(full(page)).toHaveAttribute("aria-busy", "false");
  await full(page).evaluate((element) => element.addEventListener("keydown", (event) => event.preventDefault(), { once: true }));
  await page.keyboard.press("Escape");
  await expect(full(page)).toBeVisible();
  await full(page).evaluate((element) => element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, isComposing: true })));
  await expect(full(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(full(page)).toHaveCount(0);
});

test("the unchanged print document produces a bounded native Chromium PDF", async ({ page, context }) => {
  await page.goto("/e2e/full-message/index.html?reader");
  await show(page).click();
  await expect(full(page)).toHaveAttribute("aria-busy", "false");
  await mail(page).locator("p").first().click({ button: "right" });
  await page.getByTestId("message-menu-print").click();
  const preview = page.getByTestId("print-preview");
  await expect(preview).toHaveAttribute("data-ready", "true");
  const source = await preview.evaluate((element: HTMLIFrameElement) => element.srcdoc);
  const output = "/tmp/terno-w11-r1-fixes-61640/full-message-print.pdf";
  if (existsSync(output)) renameSync(output, `${output}.${Date.now()}.archive`);
  const printed = await context.newPage();
  try {
    await blockNetwork(printed);
    await printed.setContent(source, { waitUntil: "load" });
    const pdf = await printed.pdf({ path: output, format: "A4", printBackground: true });
    expect(pdf.byteLength).toBeGreaterThan(1000);
    expect(pdf.byteLength).toBeLessThan(5_000_000);
  } finally { await printed.close(); }
});

test("Escape returns before the actual global keyboard can change the reader cursor", async ({ page }) => {
  await page.goto("/e2e/full-message/index.html?reader&keyboard");
  await page.evaluate(async () => { const path = "/src/state/app.ts"; (await import(path)).setApp({ checked: new Set([1]), anchorId: 1 }); });
  const cursor = await page.evaluate(() => (window as unknown as Fixture).fullFixture.cursor());
  await show(page).click();
  await expect(full(page)).toHaveAttribute("aria-busy", "false");
  await page.keyboard.press("Escape");
  await expect(full(page)).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as Fixture).fullFixture.cursor())).toEqual(cursor);
  await expect(show(page)).toBeFocused();
});

for (const query of ["svg-theme", "svg-theme-link"]) test(`staged SVG paint follows an in-place reader theme repaint (${query})`, async ({ page }) => {
  await page.goto(`/e2e/full-message/index.html?${query}`);
  await show(page).click();
  await expect(full(page)).toHaveAttribute("aria-busy", "false");
  const frame = full(page).locator("iframe");
  const before = await frame.evaluate((element: HTMLIFrameElement) => { Object.assign(window, { graphicDocument: element.contentDocument }); return getComputedStyle(element.contentDocument!.body).color; });
  await page.evaluate(async () => { const path = "/src/lib/appearance.ts"; (await import(path)).applyAppearance({ theme: "dark", design: "macos", lightTheme: "design", darkTheme: "design", motionMs: 0, customThemes: [] }); });
  await expect.poll(() => frame.evaluate((element: HTMLIFrameElement) => getComputedStyle(element.contentDocument!.body).color)).not.toBe(before);
  const state = await frame.evaluate((element: HTMLIFrameElement) => {
    const doc = element.contentDocument!;
    const graphic = doc.querySelector("svg")!;
    return { color: getComputedStyle(graphic).color, inherited: getComputedStyle(graphic.parentElement!).color, same: doc === (window as unknown as { graphicDocument: Document }).graphicDocument };
  });
  expect(state.color).toBe(state.inherited);
  expect(state.same).toBe(true);
});

for (const failure of [false, true]) test(`delayed reader completion and Back yield to newer external focus (${failure ? "failure" : "success"})`, async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/src/components/full-message.tsx*", async (route) => { await held; if (failure) await route.abort(); else await route.continue(); });
  await page.goto("/e2e/full-message/index.html?reader");
  await show(page).click();
  await expect(page.getByText("Loading full message…", { exact: true })).toBeVisible();
  await page.evaluate(() => { const control = document.createElement("button"); control.id = "new-owner"; control.textContent = "Synthetic sidebar"; document.body.append(control); control.focus(); });
  release();
  if (failure) await expect(page.getByRole("alert")).toBeVisible(); else await expect(full(page)).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#new-owner")).toBeFocused();
  const top = await page.locator("[data-reader-scroller]").evaluate((element) => element.scrollTop);
  await page.evaluate(async () => { const path = "/src/lib/page.ts"; (await import(path)).goBack(); });
  await expect(full(page)).toHaveCount(0);
  await expect(show(page)).toBeVisible();
  await expect(page.locator("#new-owner")).toBeFocused();
  expect(await page.locator("[data-reader-scroller]").evaluate((element) => element.scrollTop)).toBe(top);
});

for (const query of ["filter-explicit", "filter-implicit", "filter-slice"]) test(`SVG filter paint preserves the original viewport (${query})`, async ({ page }) => {
  await page.goto(`/e2e/full-message/index.html?${query}`);
  await expect(show(page)).toBeVisible();
  const pixel = async (frame: ReturnType<Page["locator"]>) => {
    const svg = (await frame.contentFrame().locator("svg").first().boundingBox())!;
    const scale = Math.min(svg.width / 100, svg.height / 100);
    return color(await page.screenshot({ clip: { x: svg.x + (svg.width - 100 * scale) / 2 + 15 * scale, y: svg.y + (svg.height - 100 * scale) / 2 + 45 * scale, width: 1, height: 1 } }));
  };
  expect(await pixel(page.locator("iframe"))).toEqual([0,255,0]);
  await show(page).click();
  await expect(full(page)).toHaveAttribute("aria-busy", "false");
  expect(await pixel(full(page).locator("iframe"))).toEqual([0,255,0]);
});

for (const query of ["void-background", "variable-background"]) test(`backgrounds remain loaded and visibly painted in the complete reader (${query})`, async ({ page }) => {
  await page.goto(`/e2e/full-message/index.html?${query}`);
  await expect(show(page)).toBeVisible();
  const rule = (await page.locator("iframe").contentFrame().locator(query === "void-background" ? "hr" : 'div[style*="height:30000px"]').boundingBox())!;
  expect(color(await page.screenshot({ clip: { x: rule.x + 5, y: rule.y + 5, width: 1, height: 1 } }))).toEqual([255,0,0]);
  await show(page).click();
  await expect(full(page)).toHaveAttribute("aria-busy", "false");
  await expect(mail(page).locator("img")).toHaveCount(query === "void-background" ? 2 : 1);
  for (const image of await mail(page).locator("img").all()) {
    await expect(image).toHaveJSProperty("naturalWidth", 1);
    await image.scrollIntoViewIfNeeded();
    const box = (await image.boundingBox())!;
    const outer = (await full(page).locator("[data-full-message-scroller]").boundingBox())!;
    expect(color(await page.screenshot({ clip: { x: box.x, y: Math.max(box.y + 1, outer.y + 4), width: 1, height: 1 } }))).toEqual([255,0,0]);
  }
  expect(await mail(page).locator("body").textContent()).toBe("BeforeAfter");
});

for (const failure of [false, true]) test(`external focus persistently revokes loading and return ownership (${failure})`, async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/src/components/full-message.tsx*", async (route) => { await held; if (failure) await route.abort(); else await route.continue(); });
  await page.goto("/e2e/full-message/index.html?reader");
  await show(page).click();
  await expect(page.getByText("Loading full message…", { exact: true })).toBeVisible();
  await page.evaluate(() => { const button = document.createElement("button"); button.id = "outside-owner"; button.textContent = "Sidebar"; const blank = document.createElement("div"); blank.id = "sidebar-blank"; blank.style.cssText = "position:fixed;right:0;top:0;width:30px;height:30px"; document.body.append(button, blank); });
  await page.locator("#outside-owner").click();
  await page.locator("#sidebar-blank").click();
  await expect(page.locator("body")).toBeFocused();
  release();
  if (failure) await expect(page.getByRole("alert")).toBeVisible(); else await expect(full(page)).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("body")).toBeFocused();
  const top = await page.locator("[data-reader-scroller]").evaluate((element) => element.scrollTop);
  await page.evaluate(async () => { const path = "/src/lib/page.ts"; (await import(path)).goBack(); });
  await expect(show(page)).toBeVisible();
  await expect(page.locator("body")).toBeFocused();
  expect(await page.locator("[data-reader-scroller]").evaluate((element) => element.scrollTop)).toBe(top);
});
