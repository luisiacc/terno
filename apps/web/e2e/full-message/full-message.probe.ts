import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

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
  expect(loaded.filter((path) => /\/src\/components\/(full-message|mail-sections)\.tsx?$/.test(path))).toEqual([]);
  await show(page).click();
  await expect(full(page)).toBeVisible();
  await expect(full(page)).toHaveAttribute("aria-busy", "false");
  expect(loaded).toContain("/src/components/full-message.tsx");
  expect(loaded).toContain("/src/components/mail-sections.ts");
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
