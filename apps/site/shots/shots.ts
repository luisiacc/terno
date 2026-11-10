/**
 * `pnpm --filter @terno/site shots` (plan 97): pictures of the real app for terno.app. The real backend on a
 * temp profile seeded with the showcase mailbox, a production build of the renderer, Playwright at 2×, light and
 * dark. Nothing leaves the machine: every request that isn't to these two local servers is aborted. Writes WebP
 * (1× and 2×) into public/shots/ plus the Open Graph image; the outputs are committed, so run it only when the app
 * changes in a way the pictures should show. `--only=<name,…>` retakes a few.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "@playwright/test";
import { startDevServer } from "@terno/backend-dev/src/server";
import { ctx, dispose, encode, fencedPage, openApp, out, pictureSettings, seedProfile, serveWeb, site } from "./lib";
import { SHOWCASE_NOW } from "./showcase";

const raw = join(site, ".shots-raw");
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");

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
  // color themes, each a light and dark pair, in a design that isn't theirs: any palette works with any design
  { name: "palette-dracula", design: "macos", palette: { light: "apple-light", dark: "dracula" }, setup: (p) => open(p, "Lisbon offsite: flights and the plan") },
  { name: "palette-nord", design: "lumen", palette: { light: "terno-light", dark: "nord" }, setup: (p) => open(p, "Lisbon offsite: flights and the plan") },
  { name: "palette-solarized", design: "macos", palette: { light: "solarized-light", dark: "tokyo-night" }, setup: (p) => open(p, "Lisbon offsite: flights and the plan") },
  { name: "palette-catppuccin", design: "lumen", palette: { light: "catppuccin-latte", dark: "catppuccin-mocha" }, setup: (p) => open(p, "Lisbon offsite: flights and the plan") },
  { name: "palette-gruvbox", design: "atelier", palette: { light: "gruvbox-light", dark: "gruvbox-dark" }, setup: (p) => open(p, "Lisbon offsite: flights and the plan") },
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
      // plan 158: a success is one line, and what could follow opens on Similar…
      await p.getByTestId("snackbar-similar").click();
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
      await p.getByTestId("snackbar-similar").click();
      await p.locator("[data-testid=snack-dock]").getByText(/Fieldnotes/).first().waitFor();
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
  const cleanup: (() => unknown)[] = [];
  const blocked = new Set<string>();
  try {
    const template = mkdtempSync(join(tmpdir(), "terno-shots-template-"));
    cleanup.push(() => rmSync(template, { recursive: true, force: true }));
    await seedProfile(template);
    const webPort = await serveWeb(cleanup);
    const browser = await chromium.launch();
    cleanup.push(() => browser.close());
    for (const shot of SHOTS) {
      if (only && !only.includes(shot.name)) continue;
      for (const mode of shot.modes ?? (["light", "dark"] as const)) {
        // a fresh copy of the profile per picture: actions in one never show in the next
        const dir = mkdtempSync(join(tmpdir(), "terno-shots-"));
        let server: Awaited<ReturnType<typeof startDevServer>> | null = null;
        try {
          execFileSync("cp", ["-R", `${template}/.`, dir]);
          server = await startDevServer({ port: 0, dataDir: dir, token: "shots", autoSync: false, now: () => SHOWCASE_NOW });
          await server.backend.server.invoke("settings.update", pictureSettings(mode, shot) as never, ctx);
          const page = await fencedPage(browser, { webPort, backendUrl: server.url, mode, blocked, viewport: shot.viewport });
          await page.clock.setFixedTime(new Date(SHOWCASE_NOW));
          await openApp(page, webPort, server.url, "shots");
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
    await dispose(cleanup);
  }
  if (blocked.size) console.log(`(aborted requests to: ${[...blocked].join(", ")})`);
  encode(raw, { og: !only || only.includes("inbox") });
}

await main();
