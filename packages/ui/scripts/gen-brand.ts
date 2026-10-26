// `pnpm brand` (plan 19): every icon and logo file derived from brand/*.svg.
// Text outputs come from src/brand/generate.ts (a test fails on drift); the
// images are drawn from the vector at each size in Chromium, the .icns by
// iconutil and the macOS 26 asset catalog by actool (Xcode 26). The hashes of
// the sources and of every image go to brand/generated.json, which the test
// checks, so an edited logo without a regeneration (or a hand-edited image) fails.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chromium } from "@playwright/test";
import { BINARY_OUTPUTS, DERIVED_FROM, ICONSET, OUT, SOURCE_FILES, WEB_ICONS, rasterArt, rasterRecipe, textOutputs, type Sources } from "../src/brand/generate";

const root = join(import.meta.dirname, "../../..");
const sha = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex");

if (process.platform !== "darwin") throw new Error("`pnpm brand` runs on macOS: iconutil and actool build the app icon");
let actool = "";
try {
  actool = execFileSync("xcrun", ["actool", "--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
} catch {}
const actoolVersion = /<key>short-bundle-version<\/key>\s*<string>([\d.]+)/.exec(actool)?.[1];
if (!(parseInt(actoolVersion ?? "") >= 26)) throw new Error(`actool ${actoolVersion ?? "isn't installed"}: install Xcode 26 or later (it compiles the macOS 26 icon)`);

const src: Sources = Object.fromEntries(SOURCE_FILES.map((f) => [f, readFileSync(join(root, "brand", f), "utf8")]));
const write = (rel: string, data: string | Buffer) => {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, data);
  console.log(`wrote ${rel}`);
};

rmSync(join(root, OUT.iconComposer), { recursive: true, force: true });
for (const [rel, text] of Object.entries(textOutputs(src))) write(rel, text);

const art = rasterArt(src);
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
/** the vector drawn at this exact size, on a transparent background */
async function render(svg: string, size: number): Promise<Buffer> {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  return page.screenshot({ omitBackground: true, type: "png", clip: { x: 0, y: 0, width: size, height: size } });
}

const tmp = mkdtempSync(join(tmpdir(), "terno-brand-"));
try {
  for (const [file, { size, art: which }] of Object.entries(WEB_ICONS)) write(`${OUT.public}/${file}`, await render(art[which], size));
  write(OUT.macPng, await render(art.mac, 1024));

  const iconset = join(tmp, "icon.iconset");
  mkdirSync(iconset);
  for (const [name, size] of Object.entries(ICONSET)) writeFileSync(join(iconset, name), await render(art.mac, size));
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(root, OUT.icns)]);
  console.log(`wrote ${OUT.icns}`);

  // actool names the icon after the document: Icon.icon → CFBundleIconName "Icon"
  const doc = join(tmp, "Icon.icon");
  cpSync(join(root, OUT.iconComposer), doc, { recursive: true });
  const compiled = join(tmp, "car");
  mkdirSync(compiled);
  execFileSync(
    "xcrun",
    [
      "actool",
      doc,
      "--compile",
      compiled,
      "--output-format",
      "human-readable-text",
      "--warnings",
      "--errors",
      "--output-partial-info-plist",
      join(compiled, "partial.plist"),
      "--app-icon",
      "Icon",
      "--include-all-app-icons",
      "--enable-on-demand-resources",
      "NO",
      "--development-region",
      "en",
      "--target-device",
      "mac",
      "--minimum-deployment-target",
      "26.0",
      "--platform",
      "macosx",
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  // package.mjs sets CFBundleIconName "Icon": hold actool to the same name
  const partial = readFileSync(join(compiled, "partial.plist"), "utf8");
  if (!/<key>CFBundleIconName<\/key>\s*<string>Icon<\/string>/.test(partial)) throw new Error(`actool didn't name the icon "Icon":\n${partial}`);
  write(OUT.assetsCar, readFileSync(join(compiled, "Assets.car")));
  if (process.env.TERNO_BRAND_KEEP) cpSync(compiled, process.env.TERNO_BRAND_KEEP, { recursive: true });
} finally {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
}

const manifest = {
  note: "Written by `pnpm brand`: the sources the images were drawn from, and the images. Do not edit.",
  actool: actoolVersion,
  recipe: sha(rasterRecipe(src)),
  sources: Object.fromEntries(DERIVED_FROM.map((f) => [`brand/${f}`, sha(src[f]!)])),
  outputs: Object.fromEntries(BINARY_OUTPUTS.map((rel) => [rel, sha(readFileSync(join(root, rel)))])),
};
write(OUT.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
