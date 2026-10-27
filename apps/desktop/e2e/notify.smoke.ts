/**
 * Plan 38 on the PACKAGED app, copied outside the repo: the Dock badge and
 * system notifications. The demo mailbox (temp profile) plus a synthetic
 * IMAP account on this test's own plain-text server (imapkit, with a local
 * SMTP server for its verification; plain IMAP is honored only in the demo,
 * behind TERNO_TEST_IMAP_INSECURE).
 *
 * What it proves: main's Dock text matches the sidebar's Inbox count and
 * follows the setting; after the account's first sync, a person's mail that
 * arrives through IDLE makes exactly one Notification.show() with the sender
 * as title (recorded by wrapping Notification.prototype.show in main, the
 * real show still called), list mail none, and its click opens the
 * conversation. Whether macOS draws the banner depends on the permission
 * given to the bundle id (dev.terno.mail) and its signature: the native
 * banner is captured best effort with `screencapture` only when
 * TERNO_SMOKE_SCREENSHOT=1 (it captures the whole screen), never asserted.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import imapkit from "imapkit";
import { SMTPServer } from "smtp-server";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE_APP = join(here, "../release/mac-arm64/Terno.app");
const SHOTS = "/tmp/unica-scratch/notify";
const ME = "smoke@test.local";

let workdir: string;
let app: ElectronApplication;
let page: Page;
let imap: ReturnType<typeof imapkit>;
let imapPort = 0;
let smtp: SMTPServer | null = null;
let smtpPort = 0;

let seq = 0;
function raw(o: { from: string; to?: string; subject: string; body?: string; listId?: string }) {
  return [
    `From: ${o.from}`,
    `To: ${o.to ?? `Smoke <${ME}>`}`,
    `Subject: ${o.subject}`,
    `Message-ID: <smoke-${++seq}@test.local>`,
    `Date: ${new Date().toUTCString()}`,
    ...(o.listId ? [`List-Id: <${o.listId}>`, `List-Unsubscribe: <mailto:off@${o.listId}>`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    o.body ?? "Hola",
  ].join("\r\n");
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.skip(!existsSync(SOURCE_APP), "run `pnpm dist:mac` first");
  imap = imapkit({
    plugins: ["IDLE", "MOVE", "UIDPLUS", "SPECIAL-USE", "ENABLE", "CONDSTORE"],
    // the form signs in with the address as the user name
    users: { [ME]: { password: "smoke-password" } },
    storage: { INBOX: {}, "": { separator: "/", folders: { Sent: { "special-use": "\\Sent" }, Archive: { "special-use": "\\Archive" }, Junk: { "special-use": "\\Junk" }, Trash: { "special-use": "\\Trash" }, Drafts: { "special-use": "\\Drafts" } } } },
  });
  imapPort = await imap.start(0, "127.0.0.1");
  // you wrote to Valeria once; an old message of hers is already there (the first sync's: no news)
  imap.control.addMessage("Sent", { raw: raw({ from: `Smoke <${ME}>`, to: "Valeria Núñez <valeria@studio.example>", subject: "Hola Valeria" }), flags: ["\\Seen"] });
  imap.control.addMessage("INBOX", { raw: raw({ from: "Valeria Núñez <valeria@studio.example>", subject: "Ya estaba aquí" }) });
  smtp = new SMTPServer({ authOptional: true, disabledCommands: ["STARTTLS"], logger: false, onAuth: (_a, _s, cb) => cb(null, { user: "smoke" }), onData: (s, _x, cb) => (s.resume(), s.on("end", () => cb())) });
  await new Promise<void>((r) => smtp!.listen(0, "127.0.0.1", r));
  smtpPort = (smtp.server.address() as { port: number }).port;

  workdir = mkdtempSync(join("/tmp", "terno-notify-smoke-"));
  const appPath = join(workdir, "Terno.app");
  execFileSync("ditto", [SOURCE_APP, appPath]);
  const env = { ...process.env, TERNO_DEMO: "1", TERNO_TEST_LANGUAGES: "en-US", TERNO_USER_DATA: join(workdir, "profile"), TERNO_TEST_IMAP_INSECURE: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.TERNO_DEV_URL;
  app = await electron.launch({ executablePath: join(appPath, "Contents/MacOS/Terno"), env });
  page = await app.firstWindow();
  await page.locator("[data-testid=thread-row]").first().waitFor({ timeout: 60_000 });
  // every notification main shows, recorded (the real show still runs)
  await app.evaluate(({ Notification }) => {
    const g = globalThis as unknown as { __smokeNotices: Electron.Notification[] };
    g.__smokeNotices = [];
    const show = Notification.prototype.show;
    Notification.prototype.show = function (this: Electron.Notification) {
      g.__smokeNotices.push(this);
      return show.call(this);
    };
  });
});

test.afterAll(async () => {
  await app?.close();
  await imap?.stop();
  await new Promise<void>((r) => (smtp ? smtp.close(() => r()) : r()));
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

const dock = () => app.evaluate(({ app: a }) => a.dock?.getBadge() ?? "");
const sidebarInbox = async () => Number(((await page.locator("[data-testid=nav-inbox] [data-slot=nav-count]").textContent()) ?? "0").replace(/\D/g, "")) || 0;
const notices = () => app.evaluate(() => (globalThis as unknown as { __smokeNotices: Electron.Notification[] }).__smokeNotices.map((n) => ({ title: n.title, subtitle: n.subtitle, body: n.body })));

test("the Dock shows the sidebar's Inbox count, and the setting clears it", async () => {
  await expect.poll(async () => (await dock()) === String(await sidebarInbox()) && (await dock()) !== "").toBe(true);
  await page.getByTestId("open-settings").click();
  await page.getByTestId("tab-general").click();
  await page.getByTestId("badge-switch").click();
  await expect.poll(dock).toBe("");
  await page.getByTestId("badge-switch").click();
  await expect.poll(async () => (await dock()) === String(await sidebarInbox())).toBe(true);
  await page.keyboard.press("Escape");
});

test("after an IMAP account's first sync, a person's mail through IDLE makes one notification; list mail none; its click opens the conversation", async () => {
  await page.getByTestId("sidebar").getByText("Add account").click();
  await page.getByTestId("imap-email").fill(ME);
  await page.getByTestId("imap-password").fill("smoke-password");
  await page.getByTestId("imap-host").fill("127.0.0.1");
  await page.getByLabel("IMAP port").fill(String(imapPort));
  await page.getByTestId("smtp-host").fill("127.0.0.1");
  await page.getByLabel("SMTP port").fill(String(smtpPort));
  await page.getByTestId("imap-submit").click();
  await expect(page.getByTestId("add-account-dialog")).toHaveCount(0, { timeout: 30_000 });
  // the first sync brought the old message: no news
  await expect(page.getByTestId("thread-row").filter({ hasText: "Ya estaba aquí" })).toHaveCount(1, { timeout: 30_000 });
  await page.waitForTimeout(3000);
  expect(await notices()).toEqual([]);
  const before = await sidebarInbox();

  imap.control.addMessage("INBOX", { raw: raw({ from: "Boletín <boletin@xataka.example>", subject: "Novedades de la semana", listId: "boletin.xataka.example" }) });
  imap.control.addMessage("INBOX", { raw: raw({ from: "Valeria Núñez <valeria@studio.example>", subject: "¿Comemos el jueves?", body: "Hay un sitio nuevo cerca de la oficina." }) });
  await expect.poll(async () => (await notices()).length, { timeout: 30_000 }).toBe(1);
  // the real banner, if macOS lets this bundle post: a capture of the whole screen, so only when asked for
  // (TERNO_SMOKE_SCREENSHOT=1); best effort, never asserted
  if (process.env.TERNO_SMOKE_SCREENSHOT === "1") {
    mkdirSync(SHOTS, { recursive: true });
    await new Promise((r) => setTimeout(r, 1200));
    try {
      execFileSync("screencapture", ["-x", join(SHOTS, "macos-banner.png")], { timeout: 10_000 });
    } catch {
      // no screen-recording permission for this shell: the calls are what's asserted
    }
  }
  expect((await notices())[0]).toEqual({ title: "Valeria Núñez", subtitle: "¿Comemos el jueves?", body: "Hay un sitio nuevo cerca de la oficina." });
  // the badge counted both arrivals
  await expect.poll(dock).toBe(String(before + 2));

  // the click: Terno forward, the conversation open
  await app.evaluate(() => (globalThis as unknown as { __smokeNotices: Electron.Notification[] }).__smokeNotices[0]!.emit("click"));
  await expect(page.getByTestId("reader-subject")).toHaveText("¿Comemos el jueves?");
  await page.waitForTimeout(2000);
  expect(await notices()).toHaveLength(1);
});
