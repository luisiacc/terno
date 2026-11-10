/**
 * What the site's two picture scripts share (plan 97): `shots.ts` (the app without Pro) and `ai-shots.ts` (Pro's AI on
 * real models). A temp profile seeded with the showcase mailbox, a production build of the renderer served on loopback,
 * a page that reaches nothing but the two local servers, and WebP at 1× and 2× into public/shots/.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Locator, Page } from "@playwright/test";
import { startDevServer } from "@terno/backend-dev/src/server";
import { SHOWCASE_NOW, SNIPPETS, showcaseDataset } from "./showcase";

const here = dirname(fileURLToPath(import.meta.url));
export const site = join(here, "..");
export const repo = join(site, "..", "..");
const web = join(repo, "apps", "web");
export const out = join(site, "public", "shots");
export const ctx = { clientId: "shots", origin: "dev" as const };
export const VIEWPORT = { width: 1440, height: 900 };

export const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

/** The showcase mailbox into an empty profile, as the demo seeds it; `ai` adds what the AI pictures read. */
export async function seedProfile(dir: string, o: { ai?: boolean } = {}): Promise<void> {
  const server = await startDevServer({ port: 0, dataDir: dir, token: "seed", seed: false, autoSync: false, now: () => SHOWCASE_NOW });
  try {
    const { backend } = server;
    const data = showcaseDataset({ ai: o.ai });
    const seeded = await backend.store.dev.seed(data, { now: SHOWCASE_NOW, learningSignals: true });
    // as seedDemo does: demo accounts sync from nothing and need no secret
    for (const [i, id] of seeded.accountIds.entries()) {
      await backend.store.accounts.setProviderConfig(id, { demo: true, senderName: data.accounts[i]!.ownerName });
      // synced a moment ago, as a tended mailbox is: what reads its coverage (Ask's "complete since …") sees its window
      await backend.store.accounts.setSyncState(id, { lastSyncAt: SHOWCASE_NOW - 2 * 60_000 });
    }
    await backend.categorizer.rebuildNow();
    for (const s of SNIPPETS) await backend.server.invoke("snippets.save", { ...s, base: null }, ctx);
  } finally {
    await server.close();
  }
}

/**
 * A production build of the renderer on a free loopback port. Every resource registers its disposal before it's
 * acquired (Codex review 3): `cleanup` runs them in reverse, each on its own.
 */
export async function serveWeb(cleanup: (() => unknown)[]): Promise<number> {
  execFileSync(process.execPath, [join(repo, "packages/backend/scripts/build-incoming-worker.mjs")], { stdio: "inherit" });
  const webPort = await freePort();
  const dist = `dist-shots-${webPort}`;
  cleanup.push(() => rmSync(join(web, dist), { recursive: true, force: true }));
  execFileSync("pnpm", ["vite", "build", "--outDir", dist], { cwd: web, stdio: "inherit" });
  const preview: ChildProcess = spawn("pnpm", ["vite", "preview", "--outDir", dist, "--port", String(webPort), "--strictPort", "--host", "127.0.0.1"], { cwd: web, stdio: "ignore" });
  cleanup.push(() => preview.kill());
  for (let i = 0; i < 100; i++) {
    const up = await fetch(`http://127.0.0.1:${webPort}`).then((r) => r.ok, () => false);
    if (up) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return webPort;
}

export async function dispose(cleanup: (() => unknown)[]): Promise<void> {
  for (const d of cleanup.reverse()) {
    try {
      await d();
    } catch (e) {
      console.error(e);
    }
  }
}

/** A 2× page that reaches only the web build and the backend: anything else is aborted and named in `blocked`. */
export async function fencedPage(browser: Browser, o: { webPort: number; backendUrl: string; mode: "light" | "dark"; blocked: Set<string>; viewport?: { width: number; height: number } }): Promise<Page> {
  const backendPort = new URL(o.backendUrl).port;
  const page = await browser.newPage({ viewport: o.viewport ?? VIEWPORT, deviceScaleFactor: 2, locale: "en-US", timezoneId: "America/Los_Angeles", colorScheme: o.mode, reducedMotion: "reduce" });
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    const local = url.hostname === "127.0.0.1" && (url.port === String(o.webPort) || url.port === backendPort);
    if (local || url.protocol === "data:" || url.protocol === "blob:") return route.continue();
    o.blocked.add(url.origin);
    return route.abort();
  });
  return page;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The union of these elements' boxes, `pad` around, held inside the window: how a picture of one part of the app is
 * framed, from the real elements at capture time (never offsets that go stale when the app changes). `x` takes the
 * frame's sides as given (a pane's edges, no pad), `top` its top (the window's, 0); `below` extends it down.
 */
export async function around(targets: Locator[], o: { pad?: number; below?: number; x?: [number, number]; top?: number; window?: { width: number; height: number } } = {}): Promise<Box> {
  const pad = o.pad ?? 24;
  const window = o.window ?? VIEWPORT;
  const boxes = (await Promise.all(targets.map((t) => t.boundingBox()))).filter((b): b is Box => b !== null);
  if (!boxes.length) throw new Error("nothing to frame");
  const left = Math.max(0, o.x ? o.x[0] : Math.min(...boxes.map((b) => b.x)) - pad);
  const top = Math.max(0, o.top ?? Math.min(...boxes.map((b) => b.y)) - pad);
  const right = Math.min(window.width, o.x ? o.x[1] : Math.max(...boxes.map((b) => b.x + b.width)) + pad);
  const bottom = Math.min(window.height, Math.max(...boxes.map((b) => b.y + b.height)) + (o.below ?? 0) + pad);
  return { x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) };
}

/** The app at its first paint, ready: the list has rows. */
export async function openApp(page: Page, webPort: number, backendUrl: string, token: string): Promise<void> {
  await page.goto(`http://127.0.0.1:${webPort}/?backend=${encodeURIComponent(backendUrl)}&token=${token}`);
  await page.locator("[data-ready]").waitFor();
  await page.getByTestId("thread-row").first().waitFor();
  await page.waitForTimeout(500);
}

/** The settings every picture is taken in: Lumen with the GitHub palettes unless a shot says otherwise (plan 97). */
export const pictureSettings = (mode: "light" | "dark", o: { design?: string; palette?: { light?: string; dark?: string } } = {}) => {
  const palette = o.palette ?? (o.design ? {} : { light: "github-light", dark: "github-dark" });
  return { design: o.design ?? "lumen", theme: mode, senderIcons: false, motionMs: 0, ...(palette.light && { lightTheme: palette.light }), ...(palette.dark && { darkTheme: palette.dark }) };
};

/**
 * WebP at 2× (the capture) and 1× for every PNG in `raw`, and their 1× sizes into src/shots.json (merged with what's
 * there). `og`: the Open Graph image from the dark inbox (Midnight, the site's design, is dark).
 */
export function encode(raw: string, o: { og?: boolean } = {}): void {
  const manifest: Record<string, { width: number; height: number }> = {};
  for (const png of execFileSync("ls", [raw], { encoding: "utf8" }).trim().split("\n").filter((f) => f.endsWith(".png"))) {
    const base = png.slice(0, -4);
    const src = join(raw, png);
    const [w, h] = execFileSync("magick", ["identify", "-format", "%w %h", src], { encoding: "utf8" }).split(" ").map(Number) as [number, number];
    execFileSync("cwebp", ["-quiet", "-q", "82", "-m", "6", src, "-o", join(out, `${base}@2x.webp`)]);
    execFileSync("cwebp", ["-quiet", "-q", "86", "-m", "6", "-resize", String(Math.round(w / 2)), "0", src, "-o", join(out, `${base}.webp`)]);
    manifest[base] = { width: Math.round(w / 2), height: Math.round(h / 2) };
  }
  if (o.og) execFileSync("magick", [join(raw, "inbox-dark.png"), "-resize", "1200x", "-gravity", "north", "-crop", "1200x630+0+0", "+repage", "-quality", "86", join(site, "public", "og.jpg")]);
  const path = join(site, "src", "shots.json");
  let previous: Record<string, unknown> = {};
  try {
    previous = JSON.parse(readFileSync(path, "utf8"));
  } catch {}
  writeFileSync(path, `${JSON.stringify({ ...previous, ...manifest }, null, 2)}\n`);
  console.log(`wrote ${Object.keys(manifest).length} pictures to ${out}`);
}
