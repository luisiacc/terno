import { readFileSync } from "node:fs";
import { msg } from "@terno/store/conformance";
import { axeBothModes, expect, selectThread, stabilize, test } from "./fixtures";

/** a 1×1 PNG: what a browser shows as an image */
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

test("reader attachment controls include all visible labels and localized download purpose; plan 212: a file opens, and its menu downloads", async ({ app: page, server, context }) => {
  const [account] = await server.backend.store.accounts.list();
  const { touched } = await server.backend.store.sync.ingest([msg({ accountId: account!.id, providerMsgId: "attachment-controls", subject: "Attachment controls fixture", attachments: [
    { filename: "résumé.bin", mime: "application/octet-stream", size: 3, bytes: new Uint8Array([0, 255, 128]) },
    { filename: "empty.txt", mime: "text/plain", size: 0, bytes: new Uint8Array() },
    { filename: "unavailable.pdf", mime: "application/pdf", size: 1024 },
    // the message says HTML; the browser is told PNG all the same (its extension's type)
    { filename: "pixel.png", mime: "text/html", size: PIXEL.length, bytes: new Uint8Array(PIXEL) },
  ] })], { applyFilters: false, now: Date.now(), classifier: null });
  await page.reload(); await selectThread(page, touched[0]!, 'subject:"Attachment controls fixture"');
  const cached = page.getByTestId("attachment").getByRole("button", { name: /Download résumé.bin/ });
  await expect(cached).toBeVisible();
  await stabilize(page);
  await axeBothModes(page, "[data-testid=attachment]");
  await expect(cached).toHaveAccessibleName("Download résumé.bin 3 B");
  await expect(cached).toHaveAccessibleDescription("application/octet-stream");
  await expect(page.getByTestId("attachment").getByRole("button", { name: /Download empty.txt/ })).toHaveAccessibleName("Download empty.txt 0 B");
  // plan 212: what a click does is the name; the web build opens a PDF or an image in a tab
  await expect(page.getByTestId("attachment").getByRole("button", { name: "Open unavailable.pdf 1 KB · Unavailable offline", exact: true })).toBeVisible();
  const pixel = page.getByTestId("attachment").getByRole("button", { name: `Open pixel.png ${PIXEL.length} B`, exact: true });
  const tab = context.waitForEvent("page");
  await pixel.click();
  const shown = await tab;
  await shown.waitForURL(/^blob:/);
  await expect.poll(() => shown.evaluate(() => document.querySelector("img")?.naturalWidth ?? 0)).toBe(1);
  await shown.close();

  // its own menu, not the conversation's: Open and Download; focus comes back to the file
  await pixel.click({ button: "right" });
  const menu = page.getByTestId("attachment-menu");
  await expect(menu).toBeVisible();
  await expect(page.getByTestId("message-menu")).toHaveCount(0);
  await expect(menu.getByRole("menuitem")).toHaveText(["Open", "Download"]);
  await axeBothModes(page, "[data-testid=attachment-menu]");
  const download = page.waitForEvent("download");
  await menu.getByTestId("attachment-menu-download").click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe("pixel.png");
  expect(readFileSync((await saved.path())!)).toEqual(PIXEL);
  await expect(menu).toHaveCount(0);
  await expect(pixel).toBeFocused();

  // a Download button at the file's right, shown on hover; a file whose click downloads shows the glyph there instead
  const pixelTile = page.getByTestId("attachment").filter({ hasText: "pixel.png" });
  const hoverDownload = pixelTile.getByRole("button", { name: "Download pixel.png", exact: true });
  await expect(hoverDownload).toHaveCSS("opacity", "0");
  await pixelTile.hover();
  await expect(hoverDownload).toHaveCSS("opacity", "1");
  await axeBothModes(page, "[data-testid=attachment]");
  const viaButton = page.waitForEvent("download");
  await hoverDownload.click();
  expect(readFileSync((await (await viaButton).path())!)).toEqual(PIXEL);
  await expect(page.getByTestId("attachment").filter({ hasText: "résumé.bin" }).getByTestId("attachment-download")).toHaveCount(0);

  // a file that only downloads: Download alone; ⇧F10 opens it from the keyboard
  await cached.focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveText(["Download"]);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(cached).toBeFocused();

  // between the files: the conversation's menu, as before
  const list = page.getByRole("list", { name: "Attachments" });
  const box = (await list.boundingBox())!;
  await page.mouse.click(box.x + box.width - 4, box.y + box.height - 4, { button: "right" });
  await expect(page.getByTestId("message-menu")).toBeVisible();
  await expect(menu).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+Comma");
  await page.getByTestId("language-select").click(); await page.getByTestId("language-es").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "es-MX");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("attachment").getByRole("button", { name: /Descargar résumé.bin/ })).toHaveAccessibleName("Descargar résumé.bin 3 B");
});
