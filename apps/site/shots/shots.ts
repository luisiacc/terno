/**
 * `pnpm --filter @terno/site shots` (plan 97): pictures of the real app for terno.app. The real backend on a
 * temp profile seeded with the showcase mailbox, a production build of the renderer, Playwright at 2×, light and
 * dark. Nothing leaves the machine: every request that isn't to these two local servers is aborted. Writes WebP
 * (1× and 2×) into public/shots/ plus the Open Graph image; the outputs are committed, so run it only when the app
 * changes in a way the pictures should show. `--only=<name,…>` retakes a few (a section picture by its own name).
 *
 * A design that shows one part of the app (the code row, the snackbar, ⌘K) uses a section picture of it: framed at
 * capture time from the real elements' boxes (`around`), on the same page as its window, so it can't go stale when the
 * app's layout moves.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "@playwright/test";
import { startDevServer } from "@terno/backend-dev/src/server";
import type { DesignId } from "@terno/core";
import { around, type Box, ctx, dispose, encode, fencedPage, openApp, out, pictureSettings, seedProfile, serveWeb, site } from "./lib";
import { SHOWCASE_NOW } from "./showcase";

const raw = join(site, ".shots-raw");
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");

interface Shot {
  name: string;
  design?: DesignId;
  /** a palette id for both modes, or per mode */
  palette?: { light?: string; dark?: string };
  modes?: readonly ("light" | "dark")[];
  /** what to do before the picture; returns the element to frame (the window when nothing) */
  setup?: (page: Page) => Promise<string | void>;
  viewport?: { width: number; height: number };
  /** section pictures of this state, each framed from the elements it shows: `<name>-detail` */
  details?: Record<string, (page: Page) => Promise<Box>>;
}

/** the space around a section, the same in every one */
const PAD = 16;
/** the list pane's own edges: a section of it shows the whole pane's width and nothing beside it */
async function listPane(page: Page): Promise<[number, number]> {
  const b = (await page.getByTestId("thread-list").boundingBox())!;
  return [b.x, b.x + b.width];
}
const rows = (page: Page, n: number) => page.getByTestId("thread-row").filter({ visible: true }).nth(n);
/** rows end where a row ends: no sliver of the next one (a row's own padding is its margin) */
const listRows = async (page: Page, first: number, last: number) => around([rows(page, first), rows(page, last)], { pad: 0, x: await listPane(page) });
/** a dialog on its own: the app's plain background behind it, not slivers of the dimmed list (the window keeps them) */
async function dialog(page: Page, target = page.getByRole("dialog")): Promise<Box> {
  await page.addStyleTag({ content: "[data-slot=dialog-overlay]{background:var(--background)!important;backdrop-filter:none!important}" });
  return around([target], { pad: PAD });
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
  {
    name: "inbox",
    setup: (p) => open(p, "Homepage concepts, round two"),
    // the accounts in the sidebar and their conversations in one list, each row naming its account
    details: { unified: async (p) => around([p.getByTestId("sidebar-add-account"), rows(p, 6)], { pad: 0, x: [0, (await listPane(p))[1]], top: 0 }) },
  },
  { name: "inbox-macos", design: "macos", setup: (p) => open(p, "Homepage concepts, round two") },
  { name: "inbox-atelier", design: "atelier", setup: (p) => open(p, "Homepage concepts, round two") },
  { name: "inbox-luma", design: "luma", setup: (p) => open(p, "Homepage concepts, round two") },
  { name: "inbox-graphite", design: "graphite", setup: (p) => open(p, "Homepage concepts, round two") },
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
    // the code row first, under it the list it sits in
    details: { code: (p) => listRows(p, 0, 2) },
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
    // the field, what it found and the first results
    details: { search: async (p) => around([p.getByTestId("search-button"), rows(p, 3)], { pad: 0, x: await listPane(p), top: 0 }) },
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
    details: { palette: (p) => dialog(p) },
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
    details: { snippets: (p) => dialog(p) },
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
    details: { archive: (p) => around([p.getByTestId("snack")], { pad: PAD }) },
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
    details: { triage: (p) => around([p.getByTestId("snack")], { pad: PAD }) },
  },
  {
    name: "shortcuts",
    setup: async (p) => {
      await blur(p);
      await p.keyboard.press("?");
      await p.getByTestId("shortcuts-dialog").waitFor();
      await p.waitForTimeout(300);
    },
    details: { shortcuts: (p) => dialog(p, p.getByTestId("shortcuts-dialog")) },
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
      const pictures = [shot.name, ...Object.keys(shot.details ?? {}).map((d) => `${d}-detail`)];
      const wanted = (name: string) => !only || only.includes(name);
      if (!pictures.some(wanted)) continue;
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
          if (wanted(shot.name)) {
            if (target) await page.locator(target).screenshot({ path: file });
            else await page.screenshot({ path: file });
          }
          for (const [detail, frame] of Object.entries(shot.details ?? {})) {
            if (wanted(`${detail}-detail`)) await page.screenshot({ path: join(raw, `${detail}-detail-${mode}.png`), clip: await frame(page) });
          }
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
