/**
 * `pnpm --filter @terno/site shots` (plan 96): pictures of the real app for terno.app. The real backend on a
 * temp profile seeded with the showcase mailbox, a production build of the renderer, Playwright at 2×, light and
 * dark. Nothing leaves the machine: every request that isn't to these two local servers is aborted. Writes WebP
 * (1× and 2×) into public/shots/ plus the Open Graph image; the outputs are committed, so run it only when the app
 * changes in a way the pictures should show. `--only=<name,…>` retakes a few.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "@playwright/test";
import { startDevServer } from "@terno/backend-dev/src/server";
import { SHOWCASE_NOW, SNIPPETS, showcaseDataset } from "./showcase";

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, "..");
const repo = join(site, "..", "..");
const web = join(repo, "apps", "web");
const out = join(site, "public", "shots");
const raw = join(site, ".shots-raw");
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");
const ctx = { clientId: "shots", origin: "dev" as const };

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

async function seedProfile(dir: string): Promise<void> {
  const server = await startDevServer({ port: 0, dataDir: dir, token: "seed", seed: false, autoSync: false, now: () => SHOWCASE_NOW });
  try {
    const { backend } = server;
    const data = showcaseDataset();
    const seeded = await backend.store.dev.seed(data, { now: SHOWCASE_NOW, learningSignals: true });
    // as seedDemo does: demo accounts sync from nothing and need no secret
    for (const [i, id] of seeded.accountIds.entries()) await backend.store.accounts.setProviderConfig(id, { demo: true, senderName: data.accounts[i]!.ownerName });
    await backend.categorizer.rebuildNow();
    for (const s of SNIPPETS) await backend.server.invoke("snippets.save", { ...s, base: null }, ctx);
  } finally {
    await server.close();
  }
}

interface Shot {
  name: string;
  design?: "lumen" | "macos" | "atelier";
  /** a palette id for both modes, or per mode */
  palette?: { light?: string; dark?: string };
  modes?: readonly ("light" | "dark")[];
  /** what to do before the picture; returns the element to frame (the window when nothing) */
  setup?: (page: Page) => Promise<string | void>;
  viewport?: { width: number; height: number };
}

const row = (page: Page, subject: string) => page.locator("[data-testid=thread-row]").filter({ has: page.getByTestId("row-subject").filter({ hasText: subject }) }).first();
async function open(page: Page, subject: string) {
  await row(page, subject).dispatchEvent("mousedown");
  await page.getByTestId("reader-subject").filter({ hasText: subject }).waitFor();
}
async function blur(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

const SHOTS: Shot[] = [
  { name: "inbox", setup: (p) => open(p, "Homepage concepts, round two") },
  { name: "inbox-macos", design: "macos", setup: (p) => open(p, "Homepage concepts, round two") },
  { name: "inbox-atelier", design: "atelier", setup: (p) => open(p, "Homepage concepts, round two") },
  // palettes in a design that isn't theirs: any palette works with any design
  { name: "palette-dracula", design: "macos", palette: { dark: "dracula" }, modes: ["dark"], setup: (p) => open(p, "Lisbon offsite: flights and the plan") },
  { name: "palette-nord", design: "lumen", palette: { dark: "nord" }, modes: ["dark"], setup: (p) => open(p, "Lisbon offsite: flights and the plan") },
  { name: "palette-solarized", design: "macos", palette: { light: "solarized-light" }, modes: ["light"], setup: (p) => open(p, "Lisbon offsite: flights and the plan") },
  { name: "palette-catppuccin", design: "lumen", palette: { light: "catppuccin-latte" }, modes: ["light"], setup: (p) => open(p, "Lisbon offsite: flights and the plan") },
  { name: "palette-gruvbox", design: "atelier", palette: { dark: "gruvbox-dark" }, modes: ["dark"], setup: (p) => open(p, "Lisbon offsite: flights and the plan") },
  {
    name: "code",
    setup: async (p) => {
      await open(p, "Dinner Saturday?");
      await row(p, "Your Tandem verification code").getByTestId("row-code").waitFor();
    },
  },
  {
    name: "search",
    setup: async (p) => {
      await open(p, "Lisbon offsite: flights and the plan");
      await blur(p);
      if (!(await p.getByTestId("search-input").isVisible())) await p.keyboard.press("/");
      await p.getByTestId("search-input").pressSequentially("hopper ride", { delay: 30 });
      await p.getByTestId("search-stats").waitFor();
      await p.waitForTimeout(400);
    },
  },
  {
    name: "palette",
    setup: async (p) => {
      await open(p, "Last chance: 30% off all outerwear");
      await blur(p);
      await p.keyboard.press("Meta+k");
      await p.getByTestId("palette-input").waitFor();
      await p.getByTestId("palette-input").pressSequentially("arch", { delay: 40 });
      await p.waitForTimeout(300);
    },
  },
  {
    name: "snippets",
    setup: async (p) => {
      await open(p, "Homepage concepts, round two");
      await blur(p);
      await p.keyboard.press("r");
      await p.getByTestId("compose-body").waitFor();
      await p.keyboard.press("Meta+;");
      await p.getByTestId("palette-input").waitFor();
      await p.waitForTimeout(300);
    },
  },
  {
    name: "archive-similar",
    setup: async (p) => {
      await open(p, "Last chance: 30% off all outerwear");
      await blur(p);
      await p.keyboard.press("e");
      await p.locator("[data-testid=snack-dock]").getByText(/Outfitter/).first().waitFor();
      await p.waitForTimeout(600);
    },
  },
  {
    name: "file-similar",
    setup: async (p) => {
      await open(p, "Issue 212: The quiet interface");
      await blur(p);
      await p.keyboard.press("l");
      await p.getByTestId("category-picker").waitFor();
      await p.getByTestId("category-picker").getByText("Reading", { exact: true }).click();
      await p.getByTestId("category-snackbar").waitFor();
      await blur(p);
      await p.waitForTimeout(800);
    },
  },
  {
    name: "shortcuts",
    setup: async (p) => {
      await blur(p);
      await p.keyboard.press("?");
      await p.getByTestId("shortcuts-dialog").waitFor();
      await p.waitForTimeout(300);
    },
  },
];

async function main() {
  rmSync(raw, { recursive: true, force: true });
  mkdirSync(raw, { recursive: true });
  mkdirSync(out, { recursive: true });
  execFileSync(process.execPath, [join(repo, "packages/backend/scripts/build-incoming-worker.mjs")], { stdio: "inherit" });

  // every resource registers its disposal before it's acquired, and each disposal is tried on its own (Codex review 3)
  const cleanup: (() => unknown)[] = [];
  const blocked = new Set<string>();
  try {
    const template = mkdtempSync(join(tmpdir(), "terno-shots-template-"));
    cleanup.push(() => rmSync(template, { recursive: true, force: true }));
    await seedProfile(template);
    const webPort = await freePort();
    const dist = `dist-shots-${webPort}`;
    cleanup.push(() => rmSync(join(web, dist), { recursive: true, force: true }));
    execFileSync("pnpm", ["vite", "build", "--outDir", dist], { cwd: web, stdio: "inherit" });
    const preview: ChildProcess = spawn("pnpm", ["vite", "preview", "--outDir", dist, "--port", String(webPort), "--strictPort", "--host", "127.0.0.1"], { cwd: web, stdio: "ignore" });
    cleanup.push(() => preview.kill());
    const browser = await chromium.launch();
    cleanup.push(() => browser.close());
    for (let i = 0; i < 100; i++) {
      const up = await fetch(`http://127.0.0.1:${webPort}`).then((r) => r.ok, () => false);
      if (up) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    for (const shot of SHOTS) {
      if (only && !only.includes(shot.name)) continue;
      for (const mode of shot.modes ?? (["light", "dark"] as const)) {
        // a fresh copy of the profile per picture: actions in one never show in the next
        const dir = mkdtempSync(join(tmpdir(), "terno-shots-"));
        let server: Awaited<ReturnType<typeof startDevServer>> | null = null;
        try {
          execFileSync("cp", ["-R", `${template}/.`, dir]);
          server = await startDevServer({ port: 0, dataDir: dir, token: "shots", autoSync: false, now: () => SHOWCASE_NOW });
          const settings = { design: shot.design ?? "lumen", theme: mode, localMode: true, senderIcons: false, motionMs: 0, ...(shot.palette?.light && { lightTheme: shot.palette.light }), ...(shot.palette?.dark && { darkTheme: shot.palette.dark }) };
          await server.backend.server.invoke("settings.update", settings as never, ctx);
          const backendPort = new URL(server.url).port;
          const page = await browser.newPage({ viewport: shot.viewport ?? { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "en-US", timezoneId: "America/Los_Angeles", colorScheme: mode, reducedMotion: "reduce" });
          await page.route("**/*", (route) => {
            const url = new URL(route.request().url());
            const local = url.hostname === "127.0.0.1" && (url.port === String(webPort) || url.port === backendPort);
            if (local || url.protocol === "data:" || url.protocol === "blob:") return route.continue();
            blocked.add(url.origin);
            return route.abort();
          });
          await page.clock.setFixedTime(new Date(SHOWCASE_NOW));
          await page.goto(`http://127.0.0.1:${webPort}/?backend=${encodeURIComponent(server.url)}&token=shots`);
          await page.locator("[data-ready]").waitFor();
          await page.getByTestId("thread-row").first().waitFor();
          await page.waitForTimeout(500);
          const target = await shot.setup?.(page);
          await page.addStyleTag({ content: "*{caret-color:transparent!important}" });
          await page.mouse.move(1439, 899);
          const file = join(raw, `${shot.name}-${mode}.png`);
          if (target) await page.locator(target).screenshot({ path: file });
          else await page.screenshot({ path: file });
          await page.close();
          console.log(`✓ ${shot.name} (${mode})`);
        } finally {
          await server?.close().catch((e) => console.error(e));
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  } finally {
    for (const dispose of cleanup.reverse()) {
      try {
        await dispose();
      } catch (e) {
        console.error(e);
      }
    }
  }
  if (blocked.size) console.log(`(aborted requests to: ${[...blocked].join(", ")})`);
  encode();
}

/** WebP at 2× (the capture) and 1×; the Open Graph image from the light inbox. */
function encode() {
  const manifest: Record<string, { width: number; height: number }> = {};
  for (const png of execFileSync("ls", [raw], { encoding: "utf8" }).trim().split("\n").filter((f) => f.endsWith(".png"))) {
    const base = png.slice(0, -4);
    const src = join(raw, png);
    const [w, h] = execFileSync("magick", ["identify", "-format", "%w %h", src], { encoding: "utf8" }).split(" ").map(Number) as [number, number];
    execFileSync("cwebp", ["-quiet", "-q", "82", "-m", "6", src, "-o", join(out, `${base}@2x.webp`)]);
    execFileSync("cwebp", ["-quiet", "-q", "86", "-m", "6", "-resize", String(Math.round(w / 2)), "0", src, "-o", join(out, `${base}.webp`)]);
    manifest[base] = { width: Math.round(w / 2), height: Math.round(h / 2) };
  }
  if (!only || only.includes("inbox")) {
    execFileSync("magick", [join(raw, "inbox-light.png"), "-resize", "1200x", "-gravity", "north", "-crop", "1200x630+0+0", "+repage", "-quality", "86", join(site, "public", "og.jpg")]);
  }
  const path = join(site, "src", "shots.json");
  let previous: Record<string, unknown> = {};
  try {
    previous = JSON.parse(execFileSync("cat", [path], { encoding: "utf8" }));
  } catch {}
  writeFileSync(path, `${JSON.stringify({ ...previous, ...manifest }, null, 2)}\n`);
  console.log(`wrote ${Object.keys(manifest).length} pictures to ${out}`);
}

await main();
