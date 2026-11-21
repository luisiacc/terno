// Plan 226: draws the DMG window's background (dmg-layout.ts) at 1x and 2x into
// resources/, and pins the art it drew: dmg-layout.test.ts fails when the art
// changes without a redraw. macOS only (the hint is set in SF, as Finder shows it).
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { DMG_BACKGROUND, DMG_LAYOUT, dmgBackgroundSvg } from "../src/dmg-layout.ts";

if (process.platform !== "darwin") throw new Error("the DMG background is drawn on macOS, in the system font Finder uses");
const resources = join(import.meta.dirname, "../resources");
const sha = (data) => createHash("sha256").update(data).digest("hex");

const browser = await chromium.launch();
try {
  const pin = { note: "Written by `pnpm --filter @terno/desktop gen:dmg-background`. Do not edit.", art: sha(dmgBackgroundSvg(1) + dmgBackgroundSvg(2)), images: {} };
  for (const [file, scale] of [[DMG_BACKGROUND.png, 1], [DMG_BACKGROUND.retina, 2]]) {
    const width = DMG_LAYOUT.width * scale;
    const height = DMG_LAYOUT.height * scale;
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><style>html,body{margin:0}svg{display:block}</style>${dmgBackgroundSvg(scale)}`);
    const png = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width, height } });
    await page.close();
    writeFileSync(join(resources, file), png);
    pin.images[file] = sha(png);
    console.log(`wrote resources/${file}`);
  }
  writeFileSync(join(resources, DMG_BACKGROUND.pin), `${JSON.stringify(pin, null, 2)}\n`);
  console.log(`wrote resources/${DMG_BACKGROUND.pin}`);
} finally {
  await browser.close();
}
