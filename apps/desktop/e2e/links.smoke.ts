/**
 * Plan 201 on the PACKAGED app, copied outside the repo: a terno://message/ link opens Terno at that message. The link
 * comes from the bundled terno-mcp, as an agent gets it; it reaches the running app through the real `open-url`
 * listener (what macOS calls on a click) and through a second launch's arguments, and a cold start with it opens it
 * once the mailbox is up. LaunchServices itself isn't driven: pointing it at a test copy would take the user's own
 * links away from their Terno; the bundle's declaration is checked instead.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { closePackaged, copyTree } from "./packaged-fixture";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE_APP = join(here, "../release/mac-arm64/Terno.app");
let workdir: string;
let appPath: string;
let userData: string;
let app: ElectronApplication;
let page: Page;

const env = () => {
  const e = { ...process.env, TERNO_DEMO: "1", TERNO_TEST_LANGUAGES: "en-US", TERNO_USER_DATA: userData };
  delete e.ELECTRON_RUN_AS_NODE;
  return e;
};

async function launch(args: string[] = []) {
  app = await electron.launch({ executablePath: join(appPath, "Contents/MacOS/Terno"), args, env: env() });
  page = await app.firstWindow();
  await page.locator("[data-testid=thread-row]").first().waitFor({ timeout: 60_000 });
}

/** One tool call through the bundled terno-mcp, as an agent makes it. */
async function mcp(name: string, args: Record<string, unknown> = {}) {
  const e = { ...process.env, TERNO_USER_DATA: userData };
  delete e.ELECTRON_RUN_AS_NODE;
  const child = spawn(join(appPath, "Contents/Resources/bin/terno-mcp"), [], { env: e, stdio: ["pipe", "pipe", "pipe"] });
  const lines: string[] = [];
  child.stdout.setEncoding("utf8").on("data", (d: string) => lines.push(...d.split("\n").filter(Boolean)));
  const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  child.stdin.end();
  await new Promise((r) => child.on("exit", r));
  const result = lines.map((l) => JSON.parse(l)).find((m) => m.id === 2).result as { isError?: boolean; content: { text: string }[] };
  expect(result.isError, result.content[0]?.text).toBeFalsy();
  return JSON.parse(result.content[0]!.text);
}

/** A second launch with these arguments, as Linux (or a script) opens a link: it hands them over and quits. */
async function secondLaunch(args: string[]) {
  const child = spawn(join(appPath, "Contents/MacOS/Terno"), args, { env: env(), stdio: "ignore" });
  const exited = new Promise((r) => child.on("exit", r));
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  await exited;
  clearTimeout(timer);
}

/** The reader shows this conversation, with this message drawn open and holding focus. */
async function showsMessage(subject: string, messageId: number) {
  await expect(page.getByTestId("reader-subject")).toHaveText(subject);
  const article = page.locator(`[data-reader-scroller] article[data-message-id="${messageId}"]`);
  await expect(article).toHaveAttribute("data-expanded", "true");
  await expect.poll(() => page.evaluate(() => (document.activeElement?.closest("article[data-message-id]") as HTMLElement | null)?.dataset.messageId ?? null)).toBe(String(messageId));
}

let target: { subject: string; messageId: number; link: string };
let other: { subject: string; messageId: number; link: string };

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.skip(!existsSync(SOURCE_APP), "run `pnpm dist:mac` first");
  workdir = mkdtempSync(join("/tmp", "terno-links-"));
  appPath = join(workdir, "Terno.app");
  copyTree(SOURCE_APP, appPath);
  userData = join(workdir, "profile");
  await launch();
});

test.afterAll(async () => {
  await closePackaged(app);
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

test("the app claims terno:// links", () => {
  const info = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", join(appPath, "Contents/Info.plist")], { encoding: "utf8" })) as { CFBundleURLTypes?: { CFBundleURLSchemes: string[] }[] };
  expect(info.CFBundleURLTypes?.flatMap((t) => t.CFBundleURLSchemes)).toEqual(["terno"]);
});

test("an agent's link opens its message in the running app: a click (open-url) and a second launch", async () => {
  await page.getByTestId("open-settings").click();
  await page.getByTestId("tab-agents").click();
  await page.getByRole("switch", { name: "Allow agents" }).click();
  await expect(page.getByTestId("agents-token-row")).toBeVisible();
  await page.keyboard.press("Escape");

  // two conversations further down the Inbox than what is open, each with more than one message
  const listed = (await mcp("list_threads", { view: "inbox", limit: 40 })).threads as { threadId: number; subject: string; messages: number; link: string }[];
  const picked = listed.slice(3).filter((t) => t.messages > 1).slice(0, 2);
  expect(picked).toHaveLength(2);
  const pick = async (t: (typeof picked)[number]) => {
    const thread = await mcp("get_thread", { threadId: t.threadId });
    // its first message, not the newest the conversation opens at: the link says which
    const m = thread.messages[0] as { messageId: number; link: string };
    expect(m.link).toMatch(/^terno:\/\/message\/[^/]+$/);
    expect(t.link).toMatch(/^terno:\/\/message\/[^/]+$/);
    return { subject: thread.subject as string, messageId: m.messageId, link: m.link };
  };
  [target, other] = [await pick(picked[0]!), await pick(picked[1]!)];
  await expect(page.getByTestId("reader-subject")).not.toHaveText(target.subject);

  // what macOS calls on a click: the listener main registered at launch
  await app.evaluate(({ app: a }, url) => void a.emit("open-url", { preventDefault() {} }, url), target.link);
  await showsMessage(target.subject, target.messageId);

  await secondLaunch([other.link]);
  await showsMessage(other.subject, other.messageId);
});

test("a link to an email Terno doesn't have says so, and nothing moves", async () => {
  await app.evaluate(({ app: a }) => void a.emit("open-url", { preventDefault() {} }, "terno://message/nobody%40nowhere.test"));
  await expect(page.getByTestId("snack-message")).toContainText("That email isn't in Terno");
  await expect(page.getByTestId("reader-subject")).toHaveText(other.subject);
});

test("a link that launches Terno opens its message once the mailbox is up", async () => {
  await closePackaged(app);
  await launch([target.link]);
  await showsMessage(target.subject, target.messageId);
});
