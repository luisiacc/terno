import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { expect, openRow, stabilize, test } from "./fixtures";
mkdirSync("/tmp/terno-missing-draft-r2-shots", { recursive: true });

test("render-error recovery reviews exact draft history and files outside the broken app @design", async ({ app: page, server }, info) => {
  await openRow(page, 0); await page.getByTestId("quick-reply").click();
  const body = page.getByTestId("compose-body"); await body.fill("recovered rich work");
  await body.press("Meta+a"); await body.press("Meta+b"); await body.click(); await body.press("ArrowRight"); await body.press("Meta+ArrowRight");
  await page.getByTestId("attachment-input").setInputFiles({ name: "recovered.bin", mimeType: "application/octet-stream", buffer: Buffer.from([0, 255, 128]) });
  await expect.poll(async () => JSON.parse((await server.backend.store.drafts.list())[0]?.attachments_json ?? "[]").length).toBe(1);
  const original = (await server.backend.store.drafts.list())[0]!; await server.backend.store.drafts.delete(original.id);
  await body.click(); await body.press("ArrowRight"); await body.press("Meta+ArrowRight"); await page.keyboard.type(" latest");
  await expect(page.getByTestId("draft-save-copy")).toBeVisible(); await body.press("ArrowLeft");
  await page.getByTestId("format-italic").click(); await expect(page.getByTestId("format-italic")).toHaveAttribute("aria-pressed", "true");
  const html = await body.innerHTML();
  const caret = await page.evaluate(() => ({ offset: window.getSelection()?.anchorOffset, text: window.getSelection()?.anchorNode?.textContent }));
  await page.evaluate("window.__terno.throwIn('app')"); await expect(page.getByTestId("app-boundary")).toBeVisible();
  await page.getByTestId("app-boundary-reload").click(); await expect(page.getByTestId("recovery-reload-warning")).toBeVisible();
  await page.getByTestId("recovery-review").focus(); await page.keyboard.press("Enter");
  await expect(page.getByTestId("recovery-workspace")).toBeVisible(); await expect(body).toBeFocused();
  expect(await body.innerHTML()).toBe(html);
  expect(await page.evaluate(() => ({ offset: window.getSelection()?.anchorOffset, text: window.getSelection()?.anchorNode?.textContent }))).toEqual(caret);
  await expect(page.getByTestId("format-italic")).toHaveAttribute("aria-pressed", "true");
  await page.clock.setFixedTime(new Date((await page.evaluate(() => Date.now())) + 1000));
  await page.keyboard.type("X"); await body.press("Meta+z"); expect(await body.innerHTML()).toBe(html);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme }); await stabilize(page);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({ path: `/tmp/terno-missing-draft-r2-shots/render-recovery-${info.project.name}-${theme}.png` });
  }
  await page.getByTestId("draft-save-copy").focus(); await page.keyboard.press("Enter");
  await expect(page.getByTestId("draft-status")).toHaveText("Draft saved"); await expect(body).toBeFocused();
  const copy = (await server.backend.store.drafts.list())[0]!;
  expect(copy.id).not.toBe(original.id); expect(copy.body_html).toContain("<b>");
  const ref = JSON.parse(copy.attachments_json)[0]; expect(await server.backend.store.attachments.read(copy.account_id, ref.assetId, 0)).toBe("AP+A");
});
