/**
 * Plan 189: the INSTALLED Linux package (`/opt/Terno/terno` from the .deb, or TERNO_LINUX_APP), as a user runs it:
 * demo mailbox in a temp profile, Chromium's sandbox on (Playwright turns it off on Linux unless asked), under a
 * display and a session bus with an unlocked keyring (`.github/workflows/release.yml`, docs/DEVELOPMENT.md → Linux).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { closePackaged } from "./packaged-fixture";

const EXECUTABLE = process.env.TERNO_LINUX_APP ?? "/opt/Terno/terno";
const RESOURCES = join(dirname(EXECUTABLE), "resources");
let workdir: string;
let userData: string;
let app: ElectronApplication;
let page: Page;

async function launch(): Promise<void> {
  const env = { ...process.env, TERNO_DEMO: "1", TERNO_TEST_LANGUAGES: "en-US", TERNO_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: EXECUTABLE, env, chromiumSandbox: true });
  page = await app.firstWindow();
  await page.locator("[data-testid=thread-row]").first().waitFor({ timeout: 60_000 });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.skip(process.platform !== "linux", "Linux only");
  if (!existsSync(EXECUTABLE)) throw new Error(`${EXECUTABLE} missing: install the .deb (or set TERNO_LINUX_APP)`);
  workdir = mkdtempSync(join(tmpdir(), "terno-linux-smoke-"));
  userData = join(workdir, "profile");
  await launch();
});

test.afterAll(async () => {
  await closePackaged(app);
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

test("boots from app:// with the backend in a utility process, and the demo mailbox renders", async () => {
  expect(page.url()).toBe("app://terno/");
  const types = await app.evaluate(({ app: a }) => a.getAppMetrics().map((m) => m.type));
  expect(types).toContain("Utility");
  expect(await page.locator("[data-testid=thread-row]").count()).toBeGreaterThan(5);
  expect(await page.evaluate(() => window.ternoDesktop?.platform)).toBe("linux");
});

test("the renderer that shows mail is sandboxed: a seccomp filter and a PID namespace of its own", async () => {
  expect(await app.evaluate(({ app: a }) => a.commandLine.hasSwitch("no-sandbox"))).toBe(false);
  const pid = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getOSProcessId());
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  // 2 = SECCOMP_MODE_FILTER, Chromium's seccomp-bpf sandbox
  expect(status).toMatch(/^Seccomp:\s+2$/m);
  // the namespace (or setuid) sandbox puts it in a new PID namespace: its id there follows the host's
  expect(status.match(/^NSpid:\s+(.+)$/m)?.[1]!.trim().split(/\s+/).length).toBeGreaterThan(1);
});

test("the menu is the Linux one, hidden until Alt: no macOS-only items, Quit under File", async () => {
  const menu = await app.evaluate(({ Menu, BrowserWindow }) => {
    const items = Menu.getApplicationMenu()!.items;
    const win = BrowserWindow.getAllWindows()[0]!;
    return { top: items.map((i) => i.label), file: items[0]!.submenu!.items.map((i) => i.role ?? i.label), autoHide: win.isMenuBarAutoHide(), visible: win.isMenuBarVisible() };
  });
  expect(menu.top).toEqual(["File", "Edit", "View", "Help"]);
  expect(menu.file.at(-1)).toBe("quit");
  expect([menu.autoHide, menu.visible]).toEqual([true, false]);
});

test("checking for updates says Linux updates come from the releases page", async () => {
  await page.getByTestId("open-settings").click();
  // the probe runs with the first check (30 s after launch, or now), never at startup
  await page.getByTestId("updates-check").click();
  await expect(page.getByTestId("updates-status")).toHaveText("Terno can’t update itself on Linux yet. Download new versions from the releases page.");
  await page.keyboard.press("Escape");
});

test("the bundled terno-mcp wrapper finds the Linux binary and answers against the running app (plan 183)", async () => {
  const wrapper = join(RESOURCES, "bin/terno-mcp");
  const env = { ...process.env, TERNO_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  const listAccounts = async () => {
    const child = spawn(wrapper, [], { env, stdio: ["pipe", "pipe", "pipe"] });
    const lines: string[] = [];
    child.stdout.setEncoding("utf8").on("data", (d: string) => lines.push(...d.split("\n").filter(Boolean)));
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_accounts", arguments: {} } });
    child.stdin.end();
    await new Promise((r) => child.on("exit", r));
    return lines.map((l) => JSON.parse(l)).find((m) => m.id === 2).result as { isError?: boolean; content: { text: string }[] };
  };
  await page.getByTestId("open-settings").click();
  await page.getByTestId("tab-agents").click();
  // the command Settings → Agents gives an agent is this package's own, stable path
  await expect(page.getByText(wrapper).first()).toBeVisible();
  await page.getByRole("switch", { name: "Allow agents" }).click();
  await expect(page.getByTestId("agents-token-row")).toBeVisible();
  await page.keyboard.press("Escape");
  const payload = JSON.parse((await listAccounts()).content[0]!.text);
  expect(payload.accounts.length).toBeGreaterThan(0);
});

test("a secret sealed through the keyring opens again after a restart (safeStorage's async API, as the backend uses it)", async () => {
  const sealed = await app.evaluate(async ({ safeStorage }) => {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) return null;
    return (await safeStorage.encryptStringAsync("terno-linux-smoke")).toString("base64");
  });
  expect(sealed).not.toBeNull();
  await closePackaged(app);
  await launch();
  const opened = await app.evaluate(async ({ safeStorage }, blob) => (await safeStorage.decryptStringAsync(Buffer.from(blob, "base64"))).result, sealed!);
  expect(opened).toBe("terno-linux-smoke");
});
