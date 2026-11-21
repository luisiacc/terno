import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error a build script (plain JS)
import { releaseAssets } from "../scripts/release-assets.mjs";
import { DMG_BACKGROUND, DMG_LAYOUT, dmgBackgroundSvg, dmgConfig } from "./dmg-layout";

const resources = join(import.meta.dirname, "../resources");
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

describe("the DMG window (plan 226)", () => {
  it("is named as the release lists it, and adds nothing to the update contract", () => {
    const c = dmgConfig("/r");
    const name = String(c.artifactName).replace("${productName}", "Terno").replace("${version}", "1.2.3").replace("${arch}", "arm64").replace("${ext}", "dmg");
    expect(releaseAssets("1.2.3", ["mac"]) as string[]).toContain(name);
    expect(c.writeUpdateInfo).toBe(false);
    expect(c.title).toBe("${productName}");
  });

  it("puts Terno and the Applications link on one line, where the background's arrow runs between them", () => {
    const c = dmgConfig("/r") as { contents: { x: number; y: number; type: string; path?: string }[]; iconSize: number; background: string };
    expect(c.contents).toEqual([
      { x: DMG_LAYOUT.app.x, y: DMG_LAYOUT.app.y, type: "file" },
      { x: DMG_LAYOUT.applications.x, y: DMG_LAYOUT.applications.y, type: "link", path: "/Applications" },
    ]);
    expect(DMG_LAYOUT.app.y).toBe(DMG_LAYOUT.applications.y);
    expect(c.iconSize).toBe(DMG_LAYOUT.iconSize);
    expect(c.background).toBe(`/r/${DMG_BACKGROUND.png}`);
    expect(dmgBackgroundSvg(1)).toContain(`H${DMG_LAYOUT.applications.x - (DMG_LAYOUT.iconSize / 2 + 28)}`);
  });

  it("the checked-in background is what the art draws (run `pnpm --filter @terno/desktop gen:dmg-background`)", () => {
    const pin = JSON.parse(readFileSync(join(resources, DMG_BACKGROUND.pin), "utf8")) as { art: string; images: Record<string, string> };
    expect(pin.art).toBe(sha(dmgBackgroundSvg(1) + dmgBackgroundSvg(2)));
    for (const [file, scale] of [[DMG_BACKGROUND.png, 1], [DMG_BACKGROUND.retina, 2]] as const) {
      const png = readFileSync(join(resources, file));
      expect(sha(png), file).toBe(pin.images[file]);
      // PNG's IHDR: width and height, big-endian, at bytes 16 and 20
      expect([png.readUInt32BE(16), png.readUInt32BE(20)], file).toEqual([DMG_LAYOUT.width * scale, DMG_LAYOUT.height * scale]);
    }
  });

  it("package.mjs can import the layout with Node's type stripping", () => {
    const file = join(import.meta.dirname, "dmg-layout.ts");
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(file)}); console.log(typeof m.dmgConfig)`], { encoding: "utf8" });
    expect(out.trim()).toBe("function");
  });
});
