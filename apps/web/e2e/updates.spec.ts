/**
 * The in-app update's renderer (plan 11): the sidebar pill and its popover,
 * Settings → General → Updates and ⌘K, driven by a stand-in for main's
 * updater (render-probe builds expose it), through every state, in light and
 * dark, with axe. The real updater is the packaged e2e (apps/desktop).
 */
import { mkdirSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import type { UpdateState } from "@terno/core/updates";
import type { Page } from "@playwright/test";
import { expect, stabilize, test } from "./fixtures";

const SHOTS = "/tmp/unica-scratch/updates-11";

const base: UpdateState = {
  status: "idle",
  unsupported: null,
  mode: "auto",
  channel: "stable",
  current: "0.1.0",
  available: null,
  ready: null,
  percent: null,
  checkedAt: null,
  error: null,
  deferred: null,
  localMode: false,
  justUpdated: null,
};
const release = { version: "0.2.0", notes: "What's new\n\n• Faster search across every account\n• Drafts survive quitting mid-sentence\n• Calmer sidebar", size: 118_542_629, releaseDate: "2026-10-24T12:00:00.000Z" };

/** Installs the stand-in: it records calls, and `push` sends a state like main does. */
async function fakeMain(page: Page, initial: Partial<UpdateState>, answers: { check?: Partial<UpdateState> } = {}) {
  await page.evaluate(
    ({ initial, answers }) => {
      const listeners = new Set<(s: unknown) => void>();
      const w = window as unknown as { __upd: { state: unknown; calls: string[]; push(s: unknown): void }; __terno: { updatesBridge(b: unknown): void } };
      const upd = (w.__upd = {
        state: initial,
        calls: [] as string[],
        push(s: unknown) {
          upd.state = s;
          for (const l of listeners) l(s);
        },
      });
      const answer = (name: string, next?: unknown) => async () => {
        upd.calls.push(name);
        if (next) upd.push({ ...(upd.state as object), ...(next as object) });
        return upd.state;
      };
      w.__terno.updatesBridge({
        state: async () => upd.state,
        check: answer("check", answers.check),
        download: answer("download"),
        install: answer("install"),
        setPrefs: async (p: object) => {
          upd.calls.push(`prefs:${JSON.stringify(p)}`);
          upd.push({ ...(upd.state as object), ...p });
          return upd.state;
        },
        seen: () => void upd.calls.push("seen"),
        onState: (l: (s: unknown) => void) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
      });
    },
    { initial: { ...base, ...initial }, answers },
  );
}

const push = (page: Page, s: Partial<UpdateState>) => page.evaluate((s) => (window as unknown as { __upd: { push(s: unknown): void } }).__upd.push(s), { ...base, ...s });
const calls = (page: Page) => page.evaluate(() => (window as unknown as { __upd: { calls: string[] } }).__upd.calls);
const pill = (page: Page) => page.getByTestId("update-pill");

async function shoot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.locator("aside").first().screenshot({ path: `${SHOTS}/${name}.png` });
}

test.describe("updates: the sidebar pill", () => {
  test("nothing while idle or up to date; an offer, a download with its ring, then an accent restart", async ({ app: page }) => {
    await fakeMain(page, { status: "up-to-date", checkedAt: Date.now() });
    await expect(pill(page)).toHaveCount(0);

    await push(page, { status: "available", available: release, localMode: true, mode: "manual" });
    await expect(pill(page)).toHaveText("Update 0.2.0");
    await pill(page).click();
    const popover = page.getByTestId("update-popover");
    await expect(popover).toContainText("Terno 0.2.0");
    await expect(popover).toContainText(/113\.\d MB/);
    await expect(page.getByTestId("update-notes")).toContainText("Faster search across every account");
    // in local mode it says where the download comes from, and that it waits for the user
    await expect(page.getByTestId("update-subtitle")).toContainText("GitHub");
    await page.getByTestId("update-download").click();
    expect(await calls(page)).toContain("download");

    await push(page, { status: "downloading", available: release, percent: 42, localMode: true, mode: "manual" });
    await expect(pill(page)).toHaveText("Downloading 42%");
    await expect(pill(page)).toHaveAttribute("data-state", "downloading");

    await push(page, { status: "ready", available: release, ready: release, percent: 100 });
    await expect(pill(page)).toHaveText("Restart to Update");
    await expect(pill(page)).toHaveClass(/bg-sidebar-primary/);
  });

  test("Restart Now asks main to install; Later quiets the accent but the pill stays", async ({ app: page }) => {
    await fakeMain(page, { status: "ready", available: release, ready: release, percent: 100 });
    await pill(page).click();
    await page.getByTestId("update-restart").click();
    await expect.poll(() => calls(page)).toContain("install");
    await page.keyboard.press("Escape");
    await pill(page).click();
    await page.getByTestId("update-later").click();
    await expect(page.getByTestId("update-popover")).toHaveCount(0);
    await expect(pill(page)).toHaveText("Restart to Update");
    await expect(pill(page)).not.toHaveClass(/bg-sidebar-primary/);
  });

  test("a send in flight: the restart waits and says so", async ({ app: page }) => {
    await fakeMain(page, { status: "ready", available: release, ready: release, percent: 100, deferred: "sending" });
    await expect(pill(page)).toHaveText("Waiting for Send…");
    await pill(page).click();
    await expect(page.getByTestId("update-subtitle")).toContainText("Will install when sending finishes");
    await expect(page.getByTestId("update-restart")).toBeDisabled();
  });

  test("a refused download says what happened and retries", async ({ app: page }) => {
    await fakeMain(page, { status: "available", available: release, error: { stage: "download", kind: "integrity", canRetry: true } });
    await expect(pill(page)).toHaveText("Update Failed");
    await pill(page).click();
    await expect(page.getByTestId("update-subtitle")).toContainText("didn’t match what was published");
    await page.getByTestId("update-retry").click();
    await expect.poll(() => calls(page)).toContain("download");
  });

  test("after an update: one quiet snack with What’s New, then main is told it was seen", async ({ app: page }) => {
    await fakeMain(page, { status: "idle", current: "0.2.0", justUpdated: "0.2.0" });
    await expect(page.getByTestId("snack-dock")).toContainText("Terno updated to 0.2.0");
    await expect.poll(() => calls(page)).toContain("seen");
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`every state looks right and passes axe in ${scheme}`, async ({ app: page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await fakeMain(page, base);
      await stabilize(page);
      const states: [string, Partial<UpdateState>][] = [
        ["available", { status: "available", available: release, mode: "manual" }],
        ["downloading", { status: "downloading", available: release, percent: 64 }],
        ["verifying", { status: "verifying", available: release, percent: 100 }],
        ["ready", { status: "ready", available: release, ready: release, percent: 100 }],
        ["deferred", { status: "ready", available: release, ready: release, percent: 100, deferred: "sending" }],
        ["error", { status: "available", available: release, error: { stage: "download", kind: "offline", canRetry: true } }],
      ];
      for (const [name, s] of states) {
        await push(page, s);
        await expect(pill(page)).toHaveAttribute("data-state", name === "deferred" ? "ready" : name);
        await shoot(page, `pill-${name}-${scheme}`);
        const r = await new AxeBuilder({ page }).include("[data-testid=update-pill]").analyze();
        expect(r.violations.map((v) => `${name}: ${v.id}: ${v.nodes.map((n) => n.html.slice(0, 160)).join(", ")}`)).toEqual([]);
      }
      // the popover, open on the ready state
      await push(page, { status: "ready", available: release, ready: release, percent: 100 });
      await pill(page).click();
      await expect(page.getByTestId("update-popover")).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/popover-ready-${scheme}.png`, clip: { x: 0, y: 420, width: 520, height: 480 } });
      const r = await new AxeBuilder({ page }).include("[data-testid=update-popover]").analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 160)).join(", ")}`)).toEqual([]);
    });
  }
});

test.describe("updates: Settings and ⌘K", () => {
  test("Settings → General → Updates: automatic/manual, channel, check now with its answer; local mode is disclosed", async ({ app: page }) => {
    const now = await page.evaluate(() => Date.now()); // the page runs on the fixture's frozen clock
    await fakeMain(page, { status: "idle", localMode: true, checkedAt: now - 5 * 60_000 }, { check: { status: "up-to-date", checkedAt: now } });
    await page.getByTestId("open-settings").click();
    const section = page.getByTestId("updates-section");
    await expect(section).toContainText("Local mode is on: Terno checks and downloads only when you ask");
    await expect(section).toContainText("github.com");
    await expect(page.getByTestId("updates-status")).toContainText("Last checked 5 minutes ago");
    await expect(page.getByTestId("updates-version")).toHaveText("Terno 0.1.0");
    await page.getByTestId("updates-auto-switch").click();
    await expect.poll(() => calls(page)).toContain(`prefs:${JSON.stringify({ mode: "manual", channel: "stable" })}`);
    await page.getByTestId("updates-channel-select").click();
    await page.getByTestId("updates-channel-nightly").click();
    await expect.poll(() => calls(page)).toContain(`prefs:${JSON.stringify({ mode: "manual", channel: "nightly" })}`);
    await page.getByTestId("updates-check").click();
    await expect(page.getByTestId("snack-dock")).toContainText("Terno is up to date");
    await expect(page.getByTestId("updates-status")).toContainText("Terno is up to date");
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await section.scrollIntoViewIfNeeded();
      mkdirSync(SHOTS, { recursive: true });
      await section.screenshot({ path: `${SHOTS}/settings-${scheme}.png` });
      const r = await new AxeBuilder({ page }).include("[data-testid=updates-section]").analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 160)).join(", ")}`)).toEqual([]);
    }
  });

  test("an unsupported copy says why in plain words and offers nothing it can't do", async ({ app: page }) => {
    await fakeMain(page, { status: "unsupported", unsupported: "translocated" });
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("updates-status")).toHaveText("Move Terno to Applications to get updates.");
    await expect(page.getByTestId("updates-check")).toBeDisabled();
    await expect(pill(page)).toHaveCount(0);
  });

  test("⌘K: Check for Updates… always, Restart to Update once one is ready", async ({ app: page }) => {
    await fakeMain(page, base, { check: { status: "available", available: release } });
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByTestId("palette-check-updates")).toBeVisible();
    await expect(page.getByTestId("palette-restart-update")).toHaveCount(0);
    await page.getByTestId("palette-check-updates").click();
    await expect(page.getByTestId("snack-dock")).toContainText("Terno 0.2.0 is available");
    await push(page, { status: "ready", available: release, ready: release, percent: 100 });
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("palette-restart-update").click();
    await expect.poll(() => calls(page)).toContain("install");
  });
});
