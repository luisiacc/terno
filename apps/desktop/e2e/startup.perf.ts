/**
 * How long the PACKAGED app takes to show mail: a time, so it runs alone (`pnpm --filter @terno/desktop test:startup`,
 * in the perf stage of test:all, with every other test tagged @alone), never beside the other smoke files or e2e, where
 * another process's work is what it would measure.
 */
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { closePackaged, copyTree } from "./packaged-fixture";

const SOURCE_APP = join(dirname(fileURLToPath(import.meta.url)), "../release/mac-arm64/Terno.app");
let workdir: string;
let app: ElectronApplication | undefined;

test.afterAll(async () => {
  await closePackaged(app);
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

test("warm start: relaunching with an existing mailbox shows mail fast", { tag: "@alone" }, async () => {
  test.skip(!existsSync(SOURCE_APP), "run `pnpm dist:mac` first");
  workdir = mkdtempSync(join("/tmp", "terno-startup-"));
  const appPath = join(workdir, "Terno.app");
  copyTree(SOURCE_APP, appPath);
  const env = { ...process.env, TERNO_DEMO: "1", TERNO_TEST_LANGUAGES: "en-US", TERNO_USER_DATA: join(workdir, "profile") } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const cache = join(workdir, "profile", "engine.v8cache");
  // by the page's own clock: a locator's retries (0, 20, 50, 100, 100, then every 500 ms) read a row up to 500 ms late
  const start = async () => {
    const started = Date.now();
    app = await electron.launch({ executablePath: join(appPath, "Contents/MacOS/Terno"), env });
    const win = await app.firstWindow();
    await win.waitForFunction(() => performance.getEntriesByName("terno:first-rows").length > 0, undefined, { timeout: 60_000 });
    return win.evaluate((t0) => Math.round(performance.timeOrigin + performance.getEntriesByName("terno:first-rows")[0]!.startTime - t0), started);
  };
  console.log(`cold start to first rows (includes seeding 3,000 demo threads): ${await start()} ms`);
  // plan 156: written a moment after the first screen; the launches that follow use it, and leave it as it is
  await expect.poll(() => existsSync(cache), { timeout: 15_000 }).toBe(true);
  const written = statSync(cache).mtimeMs;
  const samples: number[] = [];
  for (let i = 0; i < 3; i++) {
    await closePackaged(app);
    samples.push(await start());
  }
  console.log(`warm start to first rows: ${samples.join(" / ")} ms`);
  expect(statSync(cache).mtimeMs, "a warm start used the code cache").toBe(written);
  // the first launch after an update: its cache belongs to the build before
  await closePackaged(app);
  rmSync(cache);
  console.log(`warm start without a code cache: ${await start()} ms`);
  // includes process spawn, Chromium init, utility process + SQLite open, first query and paint
  expect(Math.min(...samples)).toBeLessThan(1000);
});
