import { expect, test } from "./fixtures";

// headless Chromium hides scrollbars by default; this file paints them to measure the pill
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

test("scrollbars are a hairline thumb that only shows while their pane is hovered", async ({ app: page }) => {
  const list = page.getByRole("listbox");
  // the gutter a classic scrollbar takes: at most 8 px (Chromium's "thin" is 11)
  const gutter = await list.evaluate((el) => el.offsetWidth - el.clientWidth - parseFloat(getComputedStyle(el).borderLeftWidth) - parseFloat(getComputedStyle(el).borderRightWidth));
  expect(gutter).toBeLessThanOrEqual(8);
  // the standard properties would disable the custom pill in Chromium, so they must stay unset here
  expect(await list.evaluate((el) => getComputedStyle(el).scrollbarWidth)).toBe("auto");
  // paint: the rightmost 8 px of the pane, decoded in the page; how many device-pixel columns carry ink
  const inkColumns = async () => {
    const box = (await list.boundingBox())!;
    const png = await page.screenshot({ clip: { x: box.x + box.width - 8, y: box.y + 4, width: 8, height: box.height - 8 }, animations: "disabled" });
    return page.evaluate(async (b64) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
      ctx.drawImage(bitmap, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      let columns = 0;
      for (let x = 0; x < width; x++) {
        const [r, g, b] = [data[x * 4], data[x * 4 + 1], data[x * 4 + 2]];
        for (let y = 0; y < height; y++) {
          const i = (y * width + x) * 4;
          if (Math.abs(data[i] - r) + Math.abs(data[i + 1] - g) + Math.abs(data[i + 2] - b) > 6) { columns++; break; }
        }
      }
      return { columns, scale: bitmap.width / 8 };
    }, png.toString("base64"));
  };
  await page.mouse.move(1200, 600); // over the reader
  expect((await inkColumns()).columns).toBe(0);
  await list.hover();
  await expect.poll(async () => (await inkColumns()).columns).toBeGreaterThan(0);
  const { columns, scale } = await inkColumns();
  expect(columns / scale).toBeLessThanOrEqual(4); // a 4 px pill, inset 2 px each side
});
