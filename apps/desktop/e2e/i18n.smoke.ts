/**
 * Plan 14 on the desktop: the menu bar (nested items included) and the
 * window are English on an English system, Spanish right after choosing
 * Español in Settings → General (no restart), still Spanish on the next
 * start (main's locale.json), and English again after switching back.
 * Runs against the packaged app, or the dev build with TERNO_I18N_SMOKE_DEV=1.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../..");
const DEV = process.env.TERNO_I18N_SMOKE_DEV === "1";
const SOURCE_APP = join(here, "../release/mac-arm64/Terno.app");

let workdir: string;
let profile: string;
let appPath: string;
let app: ElectronApplication;
let page: Page;

test.describe.configure({ mode: "serial" });

async function launch() {
  // an English system, whatever this Mac's languages are
  const env = { ...process.env, TERNO_DEMO: "1", TERNO_USER_DATA: profile, TERNO_TEST_LANGUAGES: "en-US" };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.TERNO_DEV_URL;
  app = DEV
    ? await electron.launch({ executablePath: join(here, "../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"), args: [join(here, "../dist/main.cjs")], env })
    : await electron.launch({ executablePath: join(appPath, "Contents/MacOS/Terno"), env });
  page = await app.firstWindow();
  await page.locator("[data-testid=thread-row]").first().waitFor({ timeout: 60_000 });
}

/** Top-level labels, and every label under them, from main's menu. */
function menuLabels() {
  return app.evaluate(({ Menu }) => {
    const walk = (items: Electron.MenuItem[]): string[] => items.flatMap((i) => [i.label, ...(i.submenu ? walk(i.submenu.items) : [])]).filter(Boolean);
    const menu = Menu.getApplicationMenu()!;
    return { top: menu.items.map((i) => i.label), all: walk(menu.items) };
  });
}

async function chooseLanguage(value: "es" | "en") {
  await page.keyboard.press("Meta+Comma");
  await page.getByTestId("general-tab").waitFor();
  await page.getByTestId("language-select").click();
  await page.getByTestId(`language-${value}`).click();
}

test.beforeAll(async () => {
  test.skip(!DEV && !existsSync(SOURCE_APP), "run `pnpm dist:mac` first");
  workdir = mkdtempSync(join("/tmp", "terno-i18n-smoke-"));
  profile = join(workdir, "profile");
  execFileSync("pnpm", ["--filter", "@terno/backend-dev", "exec", "tsx", "src/seed.ts", "--out", profile, "--accounts", "2", "--threads", "200"], { cwd: repo, stdio: "ignore" });
  appPath = join(workdir, "Terno.app");
  if (!DEV) execFileSync("ditto", [SOURCE_APP, appPath]);
  await launch();
});

test.afterAll(async () => {
  await app?.close();
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

test("English by default: the menu bar, nested items and the window", async () => {
  const { top, all } = await menuLabels();
  expect(top).toEqual(["Terno", "File", "Edit", "View", "Window", "Help"]);
  expect(all).toEqual(expect.arrayContaining(["Print…", "Undo", "Paste and Match Style", "Start Speaking", "Filter by Unread", "Bring All to Front", "Export Diagnostics…", "Quit Terno"]));
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await expect(page.getByRole("navigation").getByText("Inbox", { exact: true }).first()).toBeVisible();
});

test("Español in Settings: the window and the menu bar switch at once, without a restart", async () => {
  await chooseLanguage("es");
  await expect(page.locator("html")).toHaveAttribute("lang", "es-MX");
  await expect.poll(async () => (await menuLabels()).top).toEqual(["Terno", "Archivo", "Edición", "Ver", "Ventana", "Ayuda"]);
  const { all } = await menuLabels();
  expect(all).toEqual(expect.arrayContaining(["Imprimir…", "Deshacer", "Pegar con el mismo estilo", "Iniciar locución", "Filtrar por no leídos", "Traer todo al frente", "Exportar diagnóstico…", "Salir de Terno"]));
  expect(all).not.toContain("Undo");
  // the settings sheet stayed open, in Spanish
  await expect(page.getByTestId("general-tab")).toBeVisible();
  expect(JSON.parse(readFileSync(join(profile, "locale.json"), "utf8"))).toEqual({ language: "es" });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("navigation").getByText("Entrada", { exact: true }).first()).toBeVisible();
});

test("the next start is Spanish from the first menu", async () => {
  await app.close();
  await launch();
  expect((await menuLabels()).top).toEqual(["Terno", "Archivo", "Edición", "Ver", "Ventana", "Ayuda"]);
  await expect(page.locator("html")).toHaveAttribute("lang", "es-MX");
});

test("back to English", async () => {
  await chooseLanguage("en");
  await expect.poll(async () => (await menuLabels()).top).toEqual(["Terno", "File", "Edit", "View", "Window", "Help"]);
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
});
