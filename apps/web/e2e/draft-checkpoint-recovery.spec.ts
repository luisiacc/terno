import AxeBuilder from "@axe-core/playwright";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, stabilize, test } from "./fixtures";

const shots = process.env.TERNO_R6_CHECKPOINT_SHOTS ?? mkdtempSync(join(tmpdir(), "terno-r6-checkpoint-"));
mkdirSync(shots, { recursive: true });

type Probe = { composerReadFault(enabled?: boolean): number; throwIn(area: string): void; composerDoc(): unknown; setComposerCaret(index: number, offset?: number): boolean; parseMailHtml(html: string): unknown };
const fault = (page: import("@playwright/test").Page, enabled?: boolean) => page.evaluate((value) => (window as unknown as { __terno: Probe }).__terno.composerReadFault(value), enabled);
const selection = (page: import("@playwright/test").Page) => page.evaluate(() => {
  const s = window.getSelection();
  return { anchor: s?.anchorOffset, focus: s?.focusOffset, anchorText: s?.anchorNode?.textContent, focusText: s?.focusNode?.textContent };
});

for (const position of ["backward range", "italic caret"] as const) test(`fatal Review restores a persistently unread rich checkpoint with ${position} @design`, async ({ app: page, server }, info) => {
  let navigations = 0;
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations++; });
  try {
    await page.getByTestId("compose-button").click();
    const body = page.getByTestId("compose-body");
    await page.getByTestId("compose-to").fill('"Pérez, Ana" <ana@example.test>, bob@');
    await body.fill("authored rich work"); await body.press("Meta+a"); await body.press("Meta+b"); await body.press("ArrowRight");
    await page.getByTestId("attachment-input").setInputFiles({ name: "checkpoint.bin", mimeType: "application/octet-stream", buffer: Buffer.from([0, 255, 128]) });
    await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
    const original = (await server.backend.store.drafts.list()).find((d) => d.body_text === "authored rich work")!;
    expect(original).toBeDefined();
    await server.backend.store.drafts.delete(original.id, original.generation);
    await fault(page, true);
    await body.focus(); await body.press("End"); await page.keyboard.type(" latest");
    if (position === "italic caret") expect(await page.evaluate(() => (window as unknown as { __terno: Probe }).__terno.setComposerCaret(0, 6))).toBe(true);
    else await body.press("ArrowLeft");
    await page.getByTestId("format-italic").click();
    await expect(page.getByTestId("format-italic")).toHaveAttribute("aria-pressed", "true");
    const html = await body.innerHTML();
    expect(html).toBe("<p><b>authored rich work latest</b></p>");
    if (position === "backward range") await body.evaluate((el) => {
      el.focus(); const node = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()!;
      const s = window.getSelection()!; s.setBaseAndExtent(node, 6, node, 2); document.dispatchEvent(new Event("selectionchange"));
    });
    await expect(page.getByTestId("format-italic")).toHaveAttribute("aria-pressed", position === "backward range" ? "false" : "true");
    const beforeSelection = await selection(page);
    if (position === "backward range") expect(beforeSelection.anchor).toBeGreaterThan(beforeSelection.focus!);
    else expect(beforeSelection.anchor).toBe(beforeSelection.focus);
    const italic = await page.getByTestId("format-italic").getAttribute("aria-pressed");
    const doc = await page.evaluate(() => (window as unknown as { __terno: Probe }).__terno.composerDoc());
    const beforeSendReads = await fault(page);
    await page.evaluate(() => (document.querySelector('[data-testid="compose-send"]') as HTMLButtonElement).click());
    await expect.poll(() => fault(page)).toBeGreaterThan(beforeSendReads);
    await expect(page.getByTestId("compose-send")).toBeEnabled();
    expect((await server.backend.store.ops.recent(10)).filter((op) => op.kind === "send")).toEqual([]);
    await page.evaluate(() => (window as unknown as { __terno: Probe }).__terno.throwIn("app"));
    await expect(page.getByTestId("app-boundary")).toBeVisible();
    await page.getByTestId("app-boundary-reload").click();
    await expect(page.getByTestId("recovery-reload-warning")).toBeVisible();
    await page.getByTestId("recovery-review").focus(); await page.keyboard.press("Enter");
    await expect(page.getByTestId("recovery-workspace")).toBeVisible();
    await expect(body).toHaveCount(1); await expect(body).toBeFocused();
    expect(await body.innerHTML()).toBe(html); expect(await selection(page)).toEqual(beforeSelection);
    expect(await page.evaluate(() => (window as unknown as { __terno: Probe }).__terno.composerDoc())).toEqual(doc);
    await expect(page.getByTestId("format-italic")).toHaveAttribute("aria-pressed", italic!);
    await page.clock.setFixedTime(new Date((await page.evaluate(() => Date.now())) + 1000));
    await page.keyboard.type("X"); await body.press("Meta+z"); expect(await body.innerHTML()).toBe(html);
    await expect(page.getByTestId("recovery-workspace")).toContainText("Pérez, Ana");
    await expect(page.getByTestId("recovery-workspace")).toContainText("bob@");
    await expect(page.getByTestId("recovery-workspace")).toContainText("checkpoint.bin");
    const ref = JSON.parse(original.attachments_json)[0];
    expect(await server.backend.store.attachments.read(original.account_id, ref.assetId, 0)).toBe("AP+A");
    expect(await server.backend.store.drafts.list()).toHaveLength(0);
    await expect(page.getByTestId("draft-status")).not.toHaveText("Draft saved");
    const reads = await fault(page);
    await page.waitForTimeout(5_100);
    expect(await fault(page)).toBe(reads); expect(await server.backend.store.drafts.list()).toHaveLength(0); expect(navigations).toBe(0);
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme }); await stabilize(page);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.screenshot({ path: join(shots, `checkpoint-${position.replace(" ", "-")}-${info.project.name}-${theme}.png`) });
    }
    await page.getByTestId("recovery-details").click();
    await expect(page.getByTestId("app-boundary")).toBeVisible(); expect(await fault(page)).toBe(reads);
    await fault(page, false);
    await page.getByTestId("app-boundary-reload").click(); await expect(page.getByTestId("recovery-reload-warning")).toBeVisible();
    await page.getByTestId("recovery-review").click(); await expect(page.getByTestId("recovery-workspace")).toBeVisible();
    await page.getByTestId("draft-status").getByRole("button", { name: /retry/i }).click();
    await expect(page.getByTestId("draft-save-copy")).toBeVisible();
    await page.getByTestId("draft-save-copy").click(); await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
    const copy = (await server.backend.store.drafts.list()).find((d) => d.id !== original.id)!;
    expect(copy.body_html).toContain("<b>"); expect(copy.body_text).toBe("authored rich work latest");
    expect(await page.evaluate((html) => (window as unknown as { __terno: Probe }).__terno.parseMailHtml(html), copy.body_html)).toEqual(doc);
    expect(copy.to_json).toContain("Pérez, Ana"); expect(copy.to_json).toContain("bob@");
    const copiedRef = JSON.parse(copy.attachments_json)[0]; expect(await server.backend.store.attachments.read(copy.account_id, copiedRef.assetId, 0)).toBe("AP+A");
    expect((await server.backend.store.ops.recent(10)).filter((op) => op.kind === "send")).toEqual([]); expect(navigations).toBe(0);
    await page.getByTestId("recovery-details").click(); await expect(page.getByTestId("app-boundary")).toBeVisible();
    await Promise.all([page.waitForEvent("framenavigated", { predicate: (frame) => frame === page.mainFrame() }), page.getByTestId("app-boundary-reload").click()]);
    expect(navigations).toBe(1);
  } finally {
    await page.evaluate(() => (window as unknown as { __terno?: Partial<Probe> }).__terno?.composerReadFault?.(false)).catch(() => {});
  }
});
