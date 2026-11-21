// Plan 226: the DMG's window, drag-to-install. One place for its geometry: the
// background art (rendered by `pnpm --filter @terno/desktop gen:dmg-background`)
// and the electron-builder config that places the icons over it. Plain
// TypeScript (no enums, no parameter properties): package.mjs and the
// generator import it with Node's type stripping.

/**
 * Finder points; the background is drawn at this size and twice it, and the window is sized to it. Positions are
 * from the top of the content, below Finder's chrome: macOS 26 shows its toolbar whatever the DMG asks (and a user's
 * path and status bars take ~56 pt more), so everything sits in the top 270 pt and the rest is field. Icon positions
 * are their centers; the hint is a baseline.
 */
export const DMG_LAYOUT = {
  width: 600,
  height: 400,
  iconSize: 112,
  textSize: 13,
  app: { x: 160, y: 120 },
  applications: { x: 440, y: 120 },
  hintY: 252,
} as const;

export const DMG_BACKGROUND = { png: "dmg-background.png", retina: "dmg-background@2x.png", pin: "dmg-background.json" } as const;

/** The only words on the image: a DMG has one background, so English; the arrow carries the meaning on its own. */
export const DMG_HINT = "Drag Terno to Applications to install it.";

/**
 * Finder draws the icons and their labels over this. Over a picture it keeps
 * the labels dark in dark mode too (macOS 26, checked in both), so the field
 * is a light neutral; the hint is 5.5:1 on it. The arrow and the hint are
 * quiet, never a second focal point.
 */
export const DMG_COLORS = { field: "#E9E9EE", arrow: "#8A8A93", hint: "#5C5C66" } as const;

export function dmgBackgroundSvg(scale: 1 | 2): string {
  const { width, height, iconSize, app, applications, hintY } = DMG_LAYOUT;
  // the shaft runs between the two icons with a breath of space at each end
  const gap = iconSize / 2 + 28;
  const x1 = app.x + gap;
  const x2 = applications.x - gap;
  const y = app.y;
  const head = 9;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width * scale}" height="${height * scale}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="${DMG_COLORS.field}"/>`,
    `<path d="M${x1} ${y}H${x2}M${x2 - head} ${y - head}L${x2} ${y}L${x2 - head} ${y + head}" fill="none" stroke="${DMG_COLORS.arrow}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    `<text x="${width / 2}" y="${hintY}" text-anchor="middle" font-family="-apple-system, 'SF Pro Text', 'Helvetica Neue', sans-serif" font-size="13" fill="${DMG_COLORS.hint}">${DMG_HINT}</text>`,
    `</svg>`,
    "",
  ].join("\n");
}

/** electron-builder's `dmg` options: Terno on the left, the Applications link on the right, the background under both. */
export function dmgConfig(resources: string): Record<string, unknown> {
  const { iconSize, textSize, app, applications } = DMG_LAYOUT;
  return {
    // its own name: the zip's `…-arm64-mac.${ext}` pattern would otherwise apply (release-assets.mjs lists this one)
    artifactName: "${productName}-${version}-${arch}.${ext}",
    // i18n-ignore: electron-builder's macro, the volume named after the product
    title: "${productName}",
    // the DMG is a download, never an update: no blockmap, no channel entry
    writeUpdateInfo: false,
    icon: `${resources}/icon.icns`,
    // electron-builder pairs it with the @2x file into one Retina TIFF, and sizes the window to it
    background: `${resources}/${DMG_BACKGROUND.png}`,
    iconSize,
    iconTextSize: textSize,
    contents: [
      { x: app.x, y: app.y, type: "file" },
      { x: applications.x, y: applications.y, type: "link", path: "/Applications" },
    ],
  };
}
