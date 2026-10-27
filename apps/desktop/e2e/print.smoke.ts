/**
 * Printing in the PACKAGED app (copied outside the repo, like packaged.smoke):
 * every print fixture, with headers and content only, on Letter and A4,
 * exported through the real path (sheet → main → hidden window → printToPDF →
 * atomic write) into TERNO_TEST_PDF_DIR, then read back: page size, text
 * present and absent, the footer, nothing outside the printable box. Also the
 * Archivo menu and native print without printers.
 *
 * TERNO_PRINT_SMOKE_DEV=1 runs it against apps/desktop/dist instead (no
 * packaging); TERNO_SMOKE_PDF_OUT keeps the PDFs for a look.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { PRINT_FIXTURE_KEYS, printFixtures, type PrintFixtureKey } from "@terno/mock-data";
import { pdfProblems, QUERY, readPdf } from "../../web/e2e/print-pdf";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../..");
const DEV = process.env.TERNO_PRINT_SMOKE_DEV === "1";
const SOURCE_APP = join(here, "../release/mac-arm64/Terno.app");
const KEEP = process.env.TERNO_SMOKE_PDF_OUT;
const me = { name: "Luis Cordero", email: "" };
const fixtures = new Map(printFixtures(me).map((f) => [f.key, f]));

let workdir: string;
let pdfDir: string;
let app: ElectronApplication;
let page: Page;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.skip(!DEV && !existsSync(SOURCE_APP), "run `pnpm dist:mac` first");
  workdir = mkdtempSync(join("/tmp", "terno-print-smoke-"));
  pdfDir = join(workdir, "pdf");
  mkdirSync(pdfDir);
  const profile = join(workdir, "profile");
  // a small demo mailbox plus the print fixtures, seeded before the app opens it
  execFileSync("pnpm", ["--filter", "@terno/backend-dev", "exec", "tsx", "src/seed.ts", "--out", profile, "--accounts", "2", "--threads", "300", "--print-fixtures"], { cwd: repo, stdio: "ignore" });
  const env = { ...process.env, TERNO_DEMO: "1", TERNO_TEST_LANGUAGES: "en-US", TERNO_USER_DATA: profile, TERNO_TEST_PDF_DIR: pdfDir };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.TERNO_DEV_URL;
  if (DEV) {
    app = await electron.launch({ executablePath: join(here, "../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"), args: [join(here, "../dist/main.cjs")], env });
  } else {
    const appPath = join(workdir, "Terno.app");
    execFileSync("ditto", [SOURCE_APP, appPath]);
    app = await electron.launch({ executablePath: join(appPath, "Contents/MacOS/Terno"), env });
  }
  page = await app.firstWindow();
  await page.locator("[data-testid=thread-row]").first().waitFor({ timeout: 60_000 });
});

test.afterAll(async () => {
  await app?.close();
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

/** The search field; a new profile opens in Lumen (plan 15), whose field "/" opens. */
async function searchBox() {
  const input = page.getByTestId("search-input");
  if (!(await input.isVisible())) {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("/");
  }
  return input;
}

async function openThread(key: PrintFixtureKey) {
  await (await searchBox()).fill(QUERY[key]);
  await expect(page.locator("[data-testid=thread-row]")).toHaveCount(1);
  await page.locator("[data-testid=thread-row]").first().dispatchEvent("mousedown");
  await expect(page.getByTestId("reader-subject")).toHaveText(fixtures.get(key)!.subject);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** Exports what the open sheet shows and returns the file (renamed so the next export can't collide). */
async function savePdf(name: string): Promise<string> {
  const before = new Set(readdirSync(pdfDir));
  await expect(page.getByTestId("print-preview")).toHaveAttribute("data-ready", "true");
  await page.getByTestId("print-save-pdf").click();
  const added = () => readdirSync(pdfDir).find((f) => !before.has(f) && f.endsWith(".pdf"));
  await expect.poll(added, { message: "a new PDF in TERNO_TEST_PDF_DIR", timeout: 30_000 }).toBeTruthy();
  // saved: the sheet closes with a toast that can show it in Finder
  await expect(page.getByTestId("print-sheet")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show in Finder" }).last()).toBeVisible();
  const file = added();
  // atomic: nothing half-written or temporary is left next to it
  expect(readdirSync(pdfDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  const target = join(pdfDir, `${name}.pdf`);
  renameSync(join(pdfDir, file!), target);
  if (KEEP) {
    mkdirSync(KEEP, { recursive: true });
    copyFileSync(target, join(KEEP, `${name}.pdf`));
  }
  return target;
}

for (const key of PRINT_FIXTURE_KEYS) {
  test(`${key}: real PDFs with headers and content only, on Letter and A4`, async () => {
    const f = fixtures.get(key)!;
    await openThread(key);
    await page.keyboard.press("Meta+Shift+p");
    await expect(page.getByTestId("print-sheet")).toBeVisible();
    for (const content of ["headers", "body"] as const) {
      for (const paper of ["letter", "a4"] as const) {
        await page.getByTestId(`print-content-${content}`).click();
        await page.getByTestId(`print-paper-${paper}`).click();
        const file = await savePdf(`${key}-${content}-${paper}`);
        const bytes = readFileSync(file);
        expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
        expect((statSync(file).mode & 0o777).toString(8)).toBe("600");
        const problems = pdfProblems(await readPdf(bytes), { key, headers: content === "headers", paper, subject: f.subject, sender: f.messages[0]!.from.email });
        expect(problems, `${key} ${content} ${paper}`).toEqual([]);
        // the sheet closed on saving: open it again for the next combination
        await page.keyboard.press("Meta+Shift+p");
        await expect(page.getByTestId("print-sheet")).toBeVisible();
      }
    }
    await page.keyboard.press("Escape");
  });
}

test("a realistic demo conversation exports too", async () => {
  // a demo conversation with replies (none of the fixtures)
  await (await searchBox()).fill("");
  await page.getByTestId("nav-inbox").click();
  const fixtureSubjects = new Set([...fixtures.values()].map((f) => f.subject));
  let found = false;
  for (let i = 0; i < 20 && !found; i++) {
    await page.locator("[data-testid=thread-row][data-messages]").nth(i).dispatchEvent("mousedown");
    found = !fixtureSubjects.has((await page.getByTestId("reader-subject").textContent()) ?? "");
  }
  expect(found, "a demo conversation with replies").toBe(true);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (const [content, paper] of [["headers", "letter"], ["body", "a4"], ["headers", "a4"], ["body", "letter"]] as const) {
    await page.keyboard.press("Meta+Shift+p");
    await page.getByTestId(`print-content-${content}`).click();
    await page.getByTestId(`print-paper-${paper}`).click();
    const pages = await readPdf(readFileSync(await savePdf(`demo-${content}-${paper}`)));
    expect(pages.length).toBeGreaterThan(0);
  }
});

test("Archivo → Exportar como PDF… opens the sheet through the renderer, also with focus inside a mail's frame", async () => {
  await openThread("newsletter");
  await page.locator("[data-testid=reader] iframe").first().contentFrame().locator("body").click();
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById("export-pdf")!.click());
  await expect(page.getByTestId("print-sheet")).toBeVisible();
  await expect(page.getByTestId("print-save-pdf")).toBeFocused();
  // the menu again while open: still one sheet
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById("print")!.click());
  await expect(page.getByTestId("print-sheet")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("print-sheet")).toHaveCount(0);
});

test("native print without a printer says so and suggests the PDF (only where none is configured)", async () => {
  let printers = "";
  try {
    printers = execFileSync("lpstat", ["-p"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    /* lpstat exits non-zero with no destinations */
  }
  // with a printer the system dialog would wait for a person
  test.skip(printers.trim() !== "", "a printer is configured");
  await openThread("hostile");
  await page.keyboard.press("Meta+p");
  await expect(page.getByTestId("print-preview")).toHaveAttribute("data-ready", "true");
  await page.getByTestId("print-submit").click();
  // the dock's message (plan 13 also announces it in a screen-reader alert)
  await expect(page.getByTestId("snack-message").getByText("No printers set up", { exact: true })).toBeVisible();
  // the sheet stays: the PDF is one click away
  await expect(page.getByTestId("print-sheet")).toBeVisible();
  await page.keyboard.press("Escape");
});

/**
 * Records, in main, the requests of a session that got past onBeforeRequest (the fence under test) and
 * cancels them right there, so nothing reaches the network; and what was cancelled at all.
 */
async function watchFence(partition: string | null): Promise<void> {
  await app.evaluate(({ session }, partition) => {
    const g = globalThis as unknown as { passed: string[]; blocked: string[] };
    g.passed = [];
    g.blocked = [];
    const ses = partition ? session.fromPartition(partition) : session.defaultSession;
    ses.webRequest.onBeforeSendHeaders({ urls: ["https://*/*", "http://*/*"] }, (d, callback) => {
      const host = new URL(d.url).hostname;
      if (host === "127.0.0.1" || host === "localhost") return callback({});
      g.passed.push(d.url);
      callback({ cancel: true });
    });
    ses.webRequest.onErrorOccurred((d) => {
      if (d.error === "net::ERR_BLOCKED_BY_CLIENT") g.blocked.push(d.url);
    });
  }, partition);
}
const fence = () =>
  app.evaluate(() => {
    const g = globalThis as unknown as { passed: string[]; blocked: string[] };
    return { passed: [...g.passed], blocked: [...g.blocked] };
  });

test("plan 35: in local mode the print window loads the job's approved images and nothing else", async () => {
  await expect(page.getByTestId("local-pill")).toHaveText("Local");
  await watchFence("terno-print");
  const listed = `https://example.com/print-smoke.png?${Date.now()}`;
  const unlisted = `https://example.com/print-smoke-unlisted.png?${Date.now()}`;
  const result = await page.evaluate(
    ([src, other]) => (window as unknown as { ternoDesktop: { print(j: unknown): Promise<{ status: string }> } }).ternoDesktop.print({ html: `<!doctype html><html><head></head><body><p>Hola</p><img src="${src}" alt=""><img src="${other}" alt=""></body></html>`, action: "pdf", paper: "letter", subject: "Red", headers: false, remote: [src] }),
    [listed, unlisted],
  );
  expect(result.status).toBe("saved");
  // the approved image got past the print fence (and was stopped here, before the network); the other never did
  await expect.poll(async () => (await fence()).passed).toContain(listed);
  await expect.poll(async () => (await fence()).blocked).toContain(unlisted);
  expect((await fence()).passed).not.toContain(unlisted);
  // and a job that isn't one is refused outright
  expect(await page.evaluate(() => (window as unknown as { ternoDesktop: { print(j: unknown): Promise<{ status: string }> } }).ternoDesktop.print({ html: 1, action: "fax" }))).toEqual({ status: "failed", reason: "error" });
  // every job's hidden window is gone: only the app's own window is left
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
});

test("plan 35: in local mode “Load content” gets a newsletter's images past main's backstop; the app's own frame still can't", async () => {
  await expect(page.getByTestId("local-pill")).toHaveText("Local");
  await watchFence(null);
  await openThread("newsletter");
  await page.waitForTimeout(300);
  // blocked by the frame's CSP until asked: nothing even reaches main
  expect((await fence()).passed.filter((u) => u.includes("acme.test"))).toEqual([]);
  await page.getByTestId("remote-load").click();
  await expect(page.getByTestId("remote-blocked")).toHaveCount(0);
  await expect.poll(async () => (await fence()).passed).toContain("https://images.acme.test/promo/temporada.png");
  // the same kind of request from the app's page is cancelled by the backstop
  const own = `https://example.com/own-frame.png?${Date.now()}`;
  await page.evaluate((src) => void Object.assign(new Image(), { src }), own);
  await expect.poll(async () => (await fence()).blocked).toContain(own);
  expect((await fence()).passed).not.toContain(own);
  await page.keyboard.press("Escape");
});
