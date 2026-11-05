/**
 * How long the PACKAGED app takes to show mail: a time, so it runs alone (`pnpm --filter @terno/desktop test:startup`,
 * in the perf stage of test:all, with every other test tagged @alone), never beside the other smoke files or e2e, where
 * another process's work is what it would measure.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
  const start = async () => {
    const started = Date.now();
    app = await electron.launch({ executablePath: join(appPath, "Contents/MacOS/Terno"), env });
    await (await app.firstWindow()).locator("[data-testid=thread-row]").first().waitFor({ timeout: 60_000 });
    return Date.now() - started;
  };
  console.log(`cold start to first rows (includes seeding 3,000 demo threads): ${await start()} ms`);
  const samples: number[] = [];
  for (let i = 0; i < 3; i++) {
    await closePackaged(app);
    samples.push(await start());
  }
  console.log(`warm start to first rows: ${samples.join(" / ")} ms`);
  // includes process spawn, Chromium init, utility process + SQLite open, first query and paint
  expect(Math.min(...samples)).toBeLessThan(1500);
});
