/**
 * Plan 167: the demo's fixed clock reaches the window, from the sandboxed preload, before the page's own scripts: no
 * Playwright clock here, so what's read is what a person's `pnpm dev:demo-ai` window reads. It survives a reload, and a
 * launch without TERNO_TEST_NOW reads the real clock. Runs the dev build (apps/desktop/dist), as the AI rating's does.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const electronBin = createRequire(join(root, "package.json"))("electron") as unknown as string;
const DEMO_NOW = Date.UTC(2026, 9, 22, 16, 0);

async function launch(extra: Record<string, string>) {
  const work = mkdtempSync("/tmp/terno-window-clock-");
  const env: Record<string, string> = { ...(process.env as Record<string, string>), TERNO_DEMO: "1", TERNO_TEST_BACKGROUND: "1", TERNO_USER_DATA: join(work, "profile"), ...extra };
  for (const k of ["ELECTRON_RUN_AS_NODE", "TERNO_DEV_URL", ...(extra.TERNO_TEST_NOW ? [] : ["TERNO_TEST_NOW"])]) delete env[k];
  const app = await electron.launch({ executablePath: electronBin, args: [join(root, "dist/main.cjs")], env });
  const page = await app.firstWindow();
  await page.getByTestId("thread-row").first().waitFor({ timeout: 60_000 });
  const close = async () => {
    const pid = app.process().pid;
    await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 15_000))]);
    try { if (pid) { process.kill(pid, 0); process.kill(pid, "SIGKILL"); } } catch { /* gone */ }
    rmSync(work, { recursive: true, force: true });
  };
  return { app, page, close };
}

const read = (page: import("@playwright/test").Page) => page.evaluate(() => ({ now: Date.now(), made: new Date().getTime(), given: new Date(0).getTime() }));

test("the demo's clock is the window's, from its first script and after a reload; runs on", async () => {
  const { page, close } = await launch({ TERNO_TEST_NOW: String(DEMO_NOW) });
  try {
    const first = await read(page);
    // within the launch's own minutes of the instant, never the real day
    expect(first.now - DEMO_NOW).toBeGreaterThanOrEqual(0);
    expect(first.now - DEMO_NOW).toBeLessThan(120_000);
    expect(Math.abs(first.made - first.now)).toBeLessThan(1000);
    expect(first.given).toBe(0);
    // the list reads it too: the newest demo mail (15:30) is today's, shown as a time, not as a date
    await expect(page.getByTestId("thread-row").first()).toContainText(/\d{1,2}:\d{2}/);
    await page.reload();
    await page.getByTestId("thread-row").first().waitFor({ timeout: 60_000 });
    const after = await read(page);
    expect(after.now).toBeGreaterThanOrEqual(first.now);
    expect(after.now - DEMO_NOW).toBeLessThan(180_000);
  } finally {
    await close();
  }
});

test("without TERNO_TEST_NOW the window reads the real clock", async () => {
  const { page, close } = await launch({});
  try {
    expect(Math.abs((await read(page)).now - Date.now())).toBeLessThan(5_000);
  } finally {
    await close();
  }
});
