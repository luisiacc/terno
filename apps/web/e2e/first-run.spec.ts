/**
 * Plan 98: a fresh install's setup. The layout, then the style and colors,
 * each previewed as the whole app in sample mail, then the first account.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, isolateLocalDiscovery, test } from "./fixtures";
import { startOllamaStub } from "./ollama-stub";

const ctx = { clientId: "setup", origin: "dev" as const };

async function settings(server: { backend: { server: { invoke: (m: string, p: unknown, c: typeof ctx) => Promise<unknown> } } }) {
  return ((await server.backend.server.invoke("app.bootstrap", {}, ctx)) as { settings: Record<string, unknown> }).settings;
}

async function open(page: Page, server: Parameters<typeof isolateLocalDiscovery>[0]) {
  await isolateLocalDiscovery(server);
  await page.reload();
  await expect(page.getByTestId("first-run")).toBeVisible();
}

const step = (page: Page) => page.getByTestId("first-run");
const preview = (page: Page) => page.getByTestId("first-run-preview");

test.describe("first-run setup", () => {
  // a new install: its own defaults (Lumen in the GitHub palettes), not a project's design
  test.use({ backendOptions: { empty: true, ownerClaims: true }, design: null });

  test("the preview's sidebar is spaced as Graphite's real one (plan 137)", async ({ app: page, server }) => {
    await open(page, server);
    await page.getByTestId("first-run-continue").click();
    await page.getByTestId("first-run-design-graphite").click();
    await expect(preview(page)).toHaveAttribute("data-design", "graphite");
    const nav = preview(page).locator("aside nav");
    await expect(nav).toHaveCSS("padding-left", "12px");
    await expect(preview(page).getByText("New message", { exact: true }).locator("xpath=../..")).toHaveCSS("padding-bottom", "0px");
    await expect(preview(page).getByText("New message", { exact: true })).toHaveCSS("font-size", "13px");
    const section = nav.getByText("Categories", { exact: true });
    await expect(section).toHaveCSS("font-size", "12px");
    await expect(section.locator("..")).toHaveCSS("margin-top", "20px");
    await expect(section.locator("..")).toHaveCSS("min-height", "26px");
  });

  test("the style tiles: one box each, one specimen size and baseline, names clear of the edges, in every style (plan 137)", async ({ app: page, server }) => {
    await open(page, server);
    await page.getByTestId("first-run-continue").click();
    const tiles = page.locator('[data-testid^="first-run-design-"]');
    const measure = () =>
      tiles.evaluateAll((els) =>
        els.map((tile) => {
          const specimen = tile.querySelector<HTMLElement>("[data-design]")!;
          const name = tile.lastElementChild as HTMLElement;
          const box = tile.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(name);
          const text = range.getBoundingClientRect();
          // an empty inline block sits on its line's baseline
          const probe = specimen.appendChild(document.createElement("span"));
          probe.style.display = "inline-block";
          const baseline = probe.getBoundingClientRect().bottom - box.top;
          probe.remove();
          return { left: box.left, width: box.width, height: box.height, size: getComputedStyle(specimen).fontSize, baseline, boxed: [specimen, specimen.parentElement!].some((el) => getComputedStyle(el).boxShadow !== "none"), inset: Math.min(text.left - box.left, box.right - text.right), clipped: name.scrollWidth > name.clientWidth };
        }),
      );
    const first = await measure();
    expect(first).toHaveLength(5);
    // in each style's own text scale: the same tiles, every name fits
    for (const id of ["lumen", "atelier", "macos", "luma", "graphite"]) {
      await page.getByTestId(`first-run-design-${id}`).click();
      await expect(preview(page)).toHaveAttribute("data-design", id);
      const now = await measure();
      expect(new Set(now.map((m) => m.size))).toEqual(new Set(["22px"]));
      expect(new Set(now.map((m) => m.baseline)).size).toBe(1);
      for (const [i, m] of now.entries()) {
        expect(m.boxed).toBe(false);
        expect(m.clipped).toBe(false);
        expect(m.inset).toBeGreaterThanOrEqual(5);
        expect([m.left, m.width, m.height]).toEqual([first[i]!.left, first[i]!.width, first[i]!.height]);
      }
    }
  });

  test("layout, then style and colors, each live in the app and the preview; Back keeps the picks", async ({ app: page, server }) => {
    await open(page, server);
    await expect(step(page)).toHaveAttribute("data-step", "layout");
    // the defaults: Lumen in GitHub Light, Split, with the sample mail and its open conversation
    await expect(preview(page)).toHaveAttribute("data-design", "lumen");
    await expect(preview(page)).toHaveAttribute("data-theme", "github-light");
    await expect(preview(page)).toHaveAttribute("data-layout", "split");
    await expect(preview(page).getByTestId("thread-row")).toHaveCount(7);
    await expect(preview(page)).toContainText("Dinner on Friday?");
    await expect(page.getByTestId("first-run-layout-split")).toHaveAttribute("aria-checked", "true");

    await page.getByTestId("first-run-layout-list").click();
    await expect(page.locator("html")).toHaveAttribute("data-layout", "list");
    await expect(preview(page)).toHaveAttribute("data-layout", "list");
    // List's full-width rows, and no conversation beside them
    await expect(preview(page).locator("[data-testid=thread-row][data-wide]")).toHaveCount(7);
    await expect.poll(async () => (await settings(server)).layout).toBe("list");

    await page.getByTestId("first-run-continue").click();
    await expect(step(page)).toHaveAttribute("data-step", "look");
    await page.getByTestId("first-run-design-atelier").click();
    await expect(page.locator("html")).toHaveAttribute("data-design", "atelier");
    await expect(preview(page)).toHaveAttribute("data-design", "atelier");
    await expect(page.getByTestId("first-run-design-atelier")).toHaveAttribute("aria-checked", "true");

    // following the system (the default), both modes' colors are offered; a dark palette picked in a light window previews dark, the window stays light
    await expect(page.getByTestId("first-run-look-system")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("first-run-palettes-light")).toBeVisible();
    await expect(page.getByTestId("first-run-palettes-dark")).toBeVisible();
    await expect(page.getByTestId("theme-card-github-dark")).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("theme-card-dracula").click();
    await expect(preview(page)).toHaveAttribute("data-mode", "dark");
    await expect(preview(page)).toHaveClass(/\bdark\b/);
    await expect(preview(page)).toHaveAttribute("data-theme", "dracula");
    await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
    await expect.poll(async () => (await settings(server)).darkTheme).toBe("dracula");
    expect((await settings(server)).lightTheme).toBe("github-light");

    // Light and Dark are the appearance itself: the app switches, and only that mode's colors are offered
    await page.getByTestId("first-run-look-dark").click();
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    await expect(page.getByTestId("first-run-palettes-light")).toHaveCount(0);
    await expect(preview(page)).toHaveAttribute("data-theme", "dracula");
    await expect.poll(async () => (await settings(server)).theme).toBe("dark");
    await page.getByTestId("first-run-look-light").click();
    await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
    await expect(page.getByTestId("first-run-palettes-dark")).toHaveCount(0);
    await expect(preview(page)).toHaveAttribute("data-mode", "light");
    await page.getByTestId("first-run-look-system").click();
    await expect.poll(async () => (await settings(server)).theme).toBe("system");

    await page.getByTestId("first-run-back").click();
    await expect(step(page)).toHaveAttribute("data-step", "layout");
    await expect(page.getByTestId("first-run-layout-list")).toHaveAttribute("aria-checked", "true");
  });

  test("the account step adds the first mailbox in the same window; what's typed survives Back", async ({ app: page, server }) => {
    await open(page, server);
    await page.getByTestId("first-run-continue").click();
    await page.getByTestId("first-run-continue").click();
    await expect(step(page)).toHaveAttribute("data-step", "account");
    await page.getByTestId("imap-email").fill("ana@icloud.com");
    await page.getByTestId("first-run-back").click();
    await page.getByTestId("first-run-continue").click();
    await expect(page.getByTestId("imap-email")).toHaveValue("ana@icloud.com");
    await expect(page.getByTestId("imap-host")).toHaveValue("imap.mail.me.com");
    await page.getByTestId("imap-password").fill("app-password");
    await page.getByTestId("imap-submit").click();
    await expect(step(page)).toHaveCount(0);
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-accounts").click();
    await expect(page.getByTestId("owner-email")).toHaveText("ana@icloud.com");
    // finished: it doesn't come back
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await expect(step(page)).toHaveCount(0);
  });

  test("a reload resumes on the same step; Skip ends the setup for good and keeps the picks", async ({ app: page, server }) => {
    await open(page, server);
    await page.getByTestId("first-run-continue").click();
    await page.getByTestId("first-run-design-macos").click();
    await expect(page.locator("html")).toHaveAttribute("data-design", "macos");
    await page.reload();
    await expect(step(page)).toHaveAttribute("data-step", "look");
    await page.getByTestId("first-run-skip").click();
    await expect(step(page)).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("data-design", "macos");
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await expect(step(page)).toHaveCount(0);
  });

  test("the preview is a picture: nothing in it is focusable, announced or fetched", async ({ app: page, server }) => {
    await open(page, server);
    const frame = page.locator("[inert]").filter({ has: preview(page) });
    await expect(frame).toHaveAttribute("aria-hidden", "true");
    await expect(preview(page).locator("img, [data-testid=sender-icon]")).toHaveCount(0);
    // Tab walks the choices and the footer, never into the preview
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest("[data-testid=first-run-preview]"))).toBe(false);
    }
  });

  test("keyboard: arrows move the choice, Enter on a choice selects it and doesn't advance; a new step is announced by its heading", async ({ app: page, server }) => {
    await open(page, server);
    await page.getByTestId("first-run-layout-split").focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("first-run-layout-list")).toBeFocused();
    await expect(page.getByTestId("first-run-layout-list")).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("first-run-layout-split")).toHaveAttribute("aria-checked", "true");
    await expect(step(page)).toHaveAttribute("data-step", "layout");
    await page.getByTestId("first-run-continue").click();
    await expect(step(page).getByRole("heading", { name: "Make it yours" })).toBeFocused();
  });

  test("two quick style picks end on the second, in the app, the preview and the settings", async ({ app: page, server }) => {
    await open(page, server);
    await page.getByTestId("first-run-continue").click();
    await page.getByTestId("first-run-design-atelier").click();
    await page.getByTestId("first-run-design-macos").click();
    await expect(page.locator("html")).toHaveAttribute("data-design", "macos");
    await expect(preview(page)).toHaveAttribute("data-design", "macos");
    await expect.poll(async () => (await settings(server)).design).toBe("macos");
  });

  test("motion off: a new step comes in without animating", async ({ app: page, server }) => {
    await server.backend.server.invoke("settings.update", { motionMs: 0 }, ctx);
    await open(page, server);
    await page.getByTestId("first-run-continue").click();
    await expect(step(page)).toHaveAttribute("data-step", "look");
    const running = await step(page).evaluate((el) => el.getAnimations({ subtree: true }).filter((a) => a.playState === "running").length);
    expect(running).toBe(0);
  });

  // Codex code review #1: a detour to Settings unmounts the setup; what was typed comes back with it
  test("a detour to Settings keeps what was typed for the account", async ({ app: page, server }) => {
    await open(page, server);
    await page.getByTestId("first-run-continue").click();
    await page.getByTestId("first-run-continue").click();
    await page.getByTestId("imap-email").fill("ana@icloud.com");
    await page.keyboard.press("ControlOrMeta+Comma");
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(step(page)).toHaveAttribute("data-step", "account");
    await expect(page.getByTestId("imap-email")).toHaveValue("ana@icloud.com");
  });

  // Codex code review round 2: coming back from the detour doesn't run the local-model discovery again over a choice made meanwhile
  test("the detour back from Settings keeps an AI chosen there", async ({ app: page, server }) => {
    const ollama = await startOllamaStub();
    try {
      await isolateLocalDiscovery(server, ollama.url);
      await page.reload();
      await expect(step(page)).toBeVisible();
      await expect.poll(async () => ((await settings(server)).ai as { provider: string }).provider).toBe("ollama");
      await page.getByTestId("first-run-continue").click();
      await page.getByTestId("first-run-continue").click();
      await page.keyboard.press("ControlOrMeta+Comma");
      await expect(page.getByTestId("settings-dialog")).toBeVisible();
      await server.backend.server.invoke("settings.update", { ai: { provider: "none" } }, ctx);
      await page.keyboard.press("Escape");
      await expect(step(page)).toHaveAttribute("data-step", "account");
      // what a second discovery would have written by now (the stub answers at once)
      await page.waitForTimeout(500);
      expect(((await settings(server)).ai as { provider: string }).provider).toBe("none");
    } finally {
      await ollama.close();
    }
  });

  // Codex code review #2: a short window still reaches every palette and the footer
  test.describe("a short window", () => {
    test.use({ viewport: { width: 900, height: 400 } });
    test("every palette can be scrolled to and picked; the footer stays in view", async ({ app: page, server }) => {
      await open(page, server);
      await page.getByTestId("first-run-continue").click();
      const last = page.getByTestId("theme-card-catppuccin-latte");
      await last.scrollIntoViewIfNeeded();
      await expect(last).toBeInViewport({ ratio: 1 });
      await last.click();
      await expect(last).toHaveAttribute("aria-checked", "true");
      await expect(page.getByTestId("first-run-continue")).toBeInViewport({ ratio: 1 });
    });
  });

  // Codex code review #3: List's preview has the inbox's tabs, Split's chips the whole filter set
  test("the preview's list header is the real one: Split's filter chips, List's tabs", async ({ app: page, server }) => {
    await open(page, server);
    await expect(preview(page).getByTestId("first-run-preview-chips")).toContainText("With attachments");
    await page.getByTestId("first-run-layout-list").click();
    const tabs = preview(page).getByTestId("first-run-preview-tabs");
    await expect(tabs).toHaveAttribute("data-kind", "pill");
    await expect(tabs).toContainText("All");
    await expect(tabs).toContainText("Unread");
    await expect(tabs).toContainText("Travel");
    await expect(preview(page).getByTestId("first-run-preview-chips")).toHaveCount(0);
  });

  for (const scheme of ["light", "dark"] as const) {
    test.describe(scheme, () => {
      test.use({ colorScheme: scheme });
      test(`every step is axe-clean (${scheme})`, async ({ app: page, server }) => {
        await open(page, server);
        for (const s of ["layout", "look", "account"]) {
          await expect(step(page)).toHaveAttribute("data-step", s);
          const r = await new AxeBuilder({ page }).include("[data-testid=first-run]").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
          expect(r.violations.map((v) => `${s} ${v.id}: ${v.nodes.map((n) => n.html.slice(0, 120)).join(", ")}`)).toEqual([]);
          if (s !== "account") await page.getByTestId("first-run-continue").click();
        }
      });
    });
  }
});
