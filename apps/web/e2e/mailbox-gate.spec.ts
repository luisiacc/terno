/**
 * Plan 95's screens in the renderer: the mailbox gate (being upgraded, no
 * room, a step that failed, a damaged file with its restore, a folder that
 * can't be written, a mailbox from a newer Terno) and the required update,
 * driven by stand-ins for main's gate host and updater (render-probe builds
 * expose them), in light and dark, with axe. The real gate (a real
 * migration, a real disk) is the packaged smoke in apps/desktop.
 */
import { mkdirSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import type { MailboxGate } from "@terno/core/mailbox";
import type { UpdateState } from "@terno/core/updates";
import type { Page } from "@playwright/test";
import { expect, stabilize, test } from "./fixtures";

const SHOTS = "/tmp/terno-p95/shots";

const base: UpdateState = {
  status: "idle",
  unsupported: null,
  mode: "auto",
  channel: "stable",
  current: "0.1.0",
  available: null,
  target: null,
  ready: null,
  percent: null,
  checkedAt: null,
  error: null,
  deferred: null,
  localMode: true,
  justUpdated: null,
  required: null,
  updatingNow: false,
};
const release = { version: "0.2.0", notes: "Fixes", size: 118_542_629, releaseDate: "2026-10-24T12:00:00.000Z" };
const BACKUP = { createdAt: Date.UTC(2026, 9, 20, 12), appVersion: "0.2.0", fromSchema: 37 };

/** Stand-ins for main: they record what the window asks, and `gate` / `upd` push like main does. */
async function fakeMain(page: Page, o: { gate?: MailboxGate; updates?: Partial<UpdateState>; answers?: { updateNow?: Partial<UpdateState> } } = {}) {
  await page.evaluate(
    ({ gate, updates, answers }) => {
      const w = window as unknown as Record<string, unknown> & { __terno: { mailboxBridge(b: unknown): void; updatesBridge(b: unknown): void } };
      const calls: string[] = [];
      const gateListeners = new Set<(g: unknown) => void>();
      const updListeners = new Set<(s: unknown) => void>();
      const box = { gate, upd: updates as Record<string, unknown>, calls };
      w.__p95 = {
        calls,
        gate(g: unknown) {
          box.gate = g as typeof gate;
          for (const l of gateListeners) l(g);
        },
        upd(s: unknown) {
          box.upd = s as Record<string, unknown>;
          for (const l of updListeners) l(s);
        },
      };
      const asked = (name: string) => async () => (calls.push(name), true);
      w.__terno.mailboxBridge({
        state: async () => box.gate,
        retry: asked("retry"),
        skipBackup: asked("skipBackup"),
        restore: asked("restore"),
        onState: (l: (g: unknown) => void) => (gateListeners.add(l), () => gateListeners.delete(l)),
      });
      const answer = (name: string, next?: unknown) => async () => {
        calls.push(name);
        if (next) (w.__p95 as { upd(s: unknown): void }).upd({ ...box.upd, ...(next as object) });
        return box.upd;
      };
      w.__terno.updatesBridge({
        state: async () => box.upd,
        check: answer("check"),
        download: answer("download"),
        install: answer("install"),
        updateNow: answer("updateNow", answers.updateNow),
        setPrefs: async () => box.upd,
        seen: () => {},
        onState: (l: (s: unknown) => void) => (updListeners.add(l), () => updListeners.delete(l)),
      });
    },
    { gate: o.gate ?? { kind: "open", restoredFrom: null }, updates: { ...base, ...o.updates }, answers: o.answers ?? {} },
  );
}

const gate = (page: Page, g: MailboxGate) => page.evaluate((g) => (window as unknown as { __p95: { gate(g: unknown): void } }).__p95.gate(g), g);
const upd = (page: Page, s: Partial<UpdateState>) => page.evaluate((s) => (window as unknown as { __p95: { upd(s: unknown): void } }).__p95.upd(s), { ...base, ...s });
const calls = (page: Page) => page.evaluate(() => (window as unknown as { __p95: { calls: string[] } }).__p95.calls);
const cover = (page: Page) => page.getByTestId("mailbox-gate");

const failed = (reason: "migration" | "corrupt" | "unwritable" | "backup", o: Partial<Extract<MailboxGate, { kind: "failed" }>> = {}): MailboxGate => ({ kind: "failed", reason, step: reason === "migration" ? 38 : null, backup: null, restoreFailed: null, ...o });

test.describe("mailbox gate (plan 95)", { tag: "@design" }, () => {
  test("an upgrade shows nothing for a quick one, then says it's updating; the mailbox opening uncovers the window", async ({ app: page }) => {
    await fakeMain(page);
    await gate(page, { kind: "upgrading", phase: "backup", from: 37, to: 38 });
    await expect(cover(page)).toHaveCount(0);
    await expect(cover(page)).toHaveAttribute("data-kind", "upgrading");
    await expect(page.getByTestId("mailbox-body")).toHaveText("Making a backup first. Your mail stays on this Mac.");
    await gate(page, { kind: "upgrading", phase: "migrate", from: 37, to: 38 });
    await expect(page.getByTestId("mailbox-body")).toHaveText("This can take a minute on a large mailbox.");
    await gate(page, { kind: "open", restoredFrom: null });
    await expect(cover(page)).toHaveCount(0);
  });

  test("no room for the backup: how much is needed and free, Try Again, and Update Without a Backup when the migration fits", async ({ app: page }) => {
    await fakeMain(page, { gate: { kind: "no-room", stage: "backup", needBytes: 3 * 2 ** 30, freeBytes: 2 * 2 ** 30, canSkipBackup: true } });
    await expect(cover(page)).toHaveAttribute("data-kind", "no-room");
    await expect(cover(page)).toHaveAttribute("role", "alertdialog");
    await expect(page.getByTestId("mailbox-body")).toContainText(/about 3[,.]0 GB free, including a backup of it\. 2[,.]0 GB is free now/);
    await expect(page.getByTestId("mailbox-retry")).toBeFocused();
    await page.getByTestId("mailbox-skip-backup").click();
    await expect.poll(() => calls(page)).toContain("skipBackup");
    // a migration that doesn't fit offers no way around it
    await gate(page, { kind: "no-room", stage: "migrate", needBytes: 2 ** 28, freeBytes: 2 ** 20, canSkipBackup: false });
    await expect(page.getByTestId("mailbox-skip-backup")).toHaveCount(0);
    await page.getByTestId("mailbox-retry").click();
    await expect.poll(() => calls(page)).toContain("retry");
  });

  test("a step that failed: Check for Updates runs the one-click update and says what it found", async ({ app: page }) => {
    await fakeMain(page, { gate: failed("migration"), answers: { updateNow: { status: "up-to-date" } } });
    await expect(cover(page)).toContainText("Terno couldn’t update your mailbox");
    await expect(cover(page)).toContainText("Terno checks GitHub for the new version, downloads it and restarts.");
    await page.getByTestId("update-now").click();
    await expect.poll(() => calls(page)).toContain("updateNow");
    await expect(page.getByTestId("update-now-status")).toHaveText("No newer version is available yet. Try again later.");
    await page.getByTestId("mailbox-retry").click();
    await expect.poll(() => calls(page)).toContain("retry");
  });

  test("Update Terno's progress, a failure with its reason and Try Again, then the restart", async ({ app: page }) => {
    await fakeMain(page, { gate: { kind: "newer", schema: 40, supported: 38 } });
    await expect(cover(page)).toContainText("This mailbox is from a newer version of Terno");
    await upd(page, { status: "downloading", available: release, percent: 42, updatingNow: true });
    await expect(page.getByTestId("update-now-status")).toHaveText("Downloading… 42%");
    await expect(page.getByTestId("update-now")).toBeDisabled();
    await upd(page, { status: "available", available: release, error: { stage: "download", kind: "offline", canRetry: true } });
    await page.getByTestId("update-now").click();
    await expect(page.getByTestId("update-now-status")).toContainText("Terno couldn’t reach GitHub");
    await expect(page.getByTestId("update-now")).toHaveText("Try Again");
    await upd(page, { status: "installing", available: release, ready: release, updatingNow: true });
    await expect(page.getByTestId("update-now-status")).toHaveText("Restarting Terno…");
  });

  test("a copy that can't update itself offers the download page instead", async ({ app: page }) => {
    await fakeMain(page, { gate: { kind: "newer", schema: 40, supported: 38 }, updates: { status: "unsupported", unsupported: "dmg" } });
    await expect(cover(page)).toContainText("Move Terno to Applications to get updates.");
    await expect(page.getByTestId("update-download-page")).toHaveText("Download Terno");
  });

  test("a damaged mailbox with a backup: Restore asks first, says what's lost; a failed restore says so in place", async ({ app: page }) => {
    await fakeMain(page, { gate: failed("corrupt", { backup: BACKUP }) });
    await expect(cover(page)).toContainText("Terno has a copy from October 20, 2026");
    await page.getByTestId("mailbox-restore").click();
    const confirm = page.getByTestId("mailbox-restore-confirm");
    await expect(confirm).toContainText("Restore the copy from October 20, 2026?");
    await expect(confirm).toContainText("Messages waiting to be sent won’t be sent");
    await page.getByTestId("mailbox-restore-confirm-confirm").click();
    await expect.poll(() => calls(page)).toContain("restore");
    await gate(page, { kind: "restoring" });
    await expect(cover(page)).toHaveAttribute("data-kind", "restoring");
    await gate(page, failed("corrupt", { backup: BACKUP, restoreFailed: "no-room" }));
    await expect(page.getByTestId("mailbox-restore-failed")).toHaveText("There isn’t enough free space to restore the copy. Free up some space, then try again.");
    // restored: the window opens, and says once what changed
    await gate(page, { kind: "open", restoredFrom: BACKUP.createdAt });
    await expect(cover(page)).toHaveCount(0);
    await expect(page.getByTestId("snack-dock")).toContainText("Mailbox restored from the copy of October 20, 2026");
  });

  test("a damaged mailbox without a backup, a folder Terno can't write, a backup that failed", async ({ app: page }) => {
    await fakeMain(page, { gate: failed("corrupt") });
    await expect(cover(page)).toContainText("Terno can’t read it.");
    await expect(page.getByTestId("mailbox-restore")).toHaveCount(0);
    await gate(page, failed("unwritable"));
    await expect(cover(page)).toContainText("Terno can’t use its folder");
    await gate(page, failed("backup"));
    await expect(cover(page)).toContainText("Terno couldn’t back up your mailbox");
    await page.getByTestId("mailbox-skip-backup").click();
    await expect.poll(() => calls(page)).toContain("skipBackup");
  });

  test("the engine-stopped screen stays out of the way while the gate explains", async ({ app: page }) => {
    await fakeMain(page, { gate: failed("migration") });
    await expect(cover(page)).toBeVisible();
    await expect(page.getByTestId("engine-stopped")).toHaveCount(0);
  });
});

test.describe("mailbox gate and unsaved drafts (plan 95, Codex review R7)", () => {
  test("a mailbox that can't be used never hides a draft that isn't saved: its review comes first", async ({ app: page, server }) => {
    await fakeMain(page);
    await page.locator("[data-testid=thread-row]").first().dispatchEvent("mousedown");
    await page.keyboard.press("r");
    await page.getByTestId("compose-body").focus();
    const drafts = server.backend.store.drafts as unknown as { save: (...a: unknown[]) => Promise<unknown> };
    const save = drafts.save.bind(drafts);
    drafts.save = () => new Promise(() => {});
    try {
      await page.keyboard.type("Not saved yet");
      await gate(page, failed("corrupt"));
      await expect(page.getByTestId("recovery-workspace")).toBeVisible();
      await expect(cover(page)).toHaveCount(0);
      await expect(page.getByTestId("recovery-workspace")).toContainText("Not saved yet");
    } finally {
      drafts.save = save;
    }
  });
});

test.describe("required update (plan 95)", { tag: "@design" }, () => {
  test("below the feed's minimum the window is covered, with one button that updates; it goes once met", async ({ app: page }) => {
    await fakeMain(page, { updates: { required: "0.2.0", status: "available", available: release } });
    const screen = page.getByTestId("required-update");
    await expect(screen).toContainText("Update Terno to keep going");
    await expect(page.getByTestId("required-body")).toHaveText("This version (0.1.0) is no longer supported. Terno 0.2.0 is ready to install.");
    await expect(page.getByTestId("update-now")).toBeFocused();
    await page.getByTestId("update-now").click();
    await expect.poll(() => calls(page)).toContain("updateNow");
    await upd(page, { required: null, current: "0.2.0" });
    await expect(screen).toHaveCount(0);
  });

  test("never covers a draft that isn't saved: the pill says Update Required until it is", async ({ app: page, server }) => {
    await fakeMain(page);
    await page.locator("[data-testid=thread-row]").first().dispatchEvent("mousedown");
    await page.keyboard.press("r");
    await page.getByTestId("compose-body").focus();
    // the backend holds every draft save: what's typed stays unsaved
    const drafts = server.backend.store.drafts as unknown as { save: (...a: unknown[]) => Promise<unknown> };
    const save = drafts.save.bind(drafts);
    let unhold!: () => void;
    const held = new Promise<void>((r) => (unhold = r));
    drafts.save = async (...a) => (await held, save(...a));
    await page.keyboard.type("Half a thought");
    await upd(page, { required: "0.2.0", status: "available", available: release });
    await expect(page.getByTestId("update-pill")).toHaveText("Update Required");
    await page.waitForTimeout(2500);
    await expect(page.getByTestId("required-update")).toHaveCount(0);
    await expect(page.getByTestId("compose-body")).toHaveText("Half a thought");
    // saved: now it covers (the editor stays mounted beneath)
    unhold();
    drafts.save = save;
    await expect(page.getByTestId("required-update")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("compose-body")).toHaveText("Half a thought");
  });
});

test.describe("plan 95 screens: light and dark, axe", { tag: "@design" }, () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`every screen passes axe in ${scheme}`, async ({ app: page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await fakeMain(page);
      await stabilize(page);
      mkdirSync(SHOTS, { recursive: true });
      const screens: [string, MailboxGate][] = [
        ["upgrading", { kind: "upgrading", phase: "backup", from: 37, to: 38 }],
        ["no-room", { kind: "no-room", stage: "backup", needBytes: 3 * 2 ** 30, freeBytes: 2 * 2 ** 30, canSkipBackup: true }],
        ["migration", failed("migration")],
        ["corrupt", failed("corrupt", { backup: BACKUP, restoreFailed: "failed" })],
        ["unwritable", failed("unwritable")],
        ["backup", failed("backup")],
        ["newer", { kind: "newer", schema: 40, supported: 38 }],
        ["restoring", { kind: "restoring" }],
      ];
      for (const [name, g] of screens) {
        await gate(page, g);
        await expect(cover(page)).toHaveAttribute("data-kind", name);
        await page.screenshot({ path: `${SHOTS}/gate-${name}-${scheme}.png` });
        const r = await new AxeBuilder({ page }).include("[data-testid=mailbox-gate]").analyze();
        expect(r.violations.map((v) => `${name}: ${v.id}: ${v.nodes.map((n) => n.html.slice(0, 160)).join(", ")}`)).toEqual([]);
      }
      await gate(page, { kind: "open", restoredFrom: null });
      await upd(page, { required: "0.2.0", status: "available", available: release });
      await expect(page.getByTestId("required-update")).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/required-${scheme}.png` });
      const r = await new AxeBuilder({ page }).include("[data-testid=required-update]").analyze();
      expect(r.violations.map((v) => `required: ${v.id}: ${v.nodes.map((n) => n.html.slice(0, 160)).join(", ")}`)).toEqual([]);
    });
  }
});
