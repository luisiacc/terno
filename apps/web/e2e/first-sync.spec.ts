import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createDemoProvider, demoRegistry } from "@terno/mail";
import { startDevServer, type DevServer } from "../../backend-dev/src/server";

const ctx = { clientId: "synthetic", origin: "dev" as const };
const NEW = "new-account@example.test";

// plan 79: the window is asked for when connecting, the account downloads that, and the sidebar says so while it does
for (const theme of ["light", "dark"] as const) {
  test(`a new account: the window asked for, a quiet pill while its first sync runs (${theme}) @design`, async ({ page }, info) => {
    const dir = mkdtempSync(join(tmpdir(), "terno-first-sync-"));
    let server: DevServer | undefined;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    try {
      server = await startDevServer({
        port: 0, dataDir: dir, token: "synthetic", threads: 40, accounts: 1, iconTransport: null,
        providers: {
          ...demoRegistry,
          create(context) {
            const demo = createDemoProvider(context, 0);
            // the new account's first pass waits until the test lets it finish
            return context.account.email === NEW ? { ...demo, async sync(sink) { await held; return demo.sync(sink); } } : demo;
          },
        },
      });
      await server.backend.server.invoke("settings.update", { theme, senderIcons: false }, ctx);
      await page.goto(`/?backend=${encodeURIComponent(server.url)}&token=synthetic`);
      await page.locator("[data-ready]").waitFor();
      await page.getByTestId("thread-row").first().waitFor();
      await expect(page.getByTestId("first-sync-pill")).toHaveCount(0);

      await page.getByTestId("sidebar").getByRole("button", { name: "Add account", exact: true }).click();
      const dialog = page.getByTestId("add-account-dialog");
      // the General setting's 180 days, preselected
      const choice = dialog.getByTestId("sync-window-choice");
      await expect(choice).toHaveText(/The last 180 days/);
      await expect(choice).toHaveAccessibleName("Download mail from");
      await choice.click();
      await page.getByTestId("sync-window-30").click();
      await expect(choice).toHaveText(/The last 30 days/);

      await dialog.getByTestId("imap-email").fill(NEW);
      await dialog.getByTestId("imap-password").fill("synthetic-password");
      // five-digit ports fit, not cut by the host field beside them
      for (const name of ["IMAP port", "SMTP port"]) {
        const port = dialog.getByRole("spinbutton", { name });
        await port.fill("65535");
        expect(await port.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      }
      await dialog.getByRole("spinbutton", { name: "IMAP port" }).fill("993");
      await dialog.getByRole("spinbutton", { name: "SMTP port" }).fill("465");
      expect((await new AxeBuilder({ page }).include('[data-testid="add-account-dialog"]').analyze()).violations).toEqual([]);
      await page.screenshot({ path: info.outputPath(`add-account-${theme}.png`) });
      await dialog.getByTestId("imap-submit").click();
      await expect(dialog).toHaveCount(0);

      const pill = page.getByTestId("first-sync-pill");
      await expect(pill).toBeVisible();
      await expect(pill.getByRole("status")).toHaveText("Downloading your mail");
      await expect(pill.getByTestId("first-sync-detail")).toHaveText("The last 30 days, newest first");
      expect((await new AxeBuilder({ page }).include('[data-testid="first-sync-pill"]').analyze()).violations).toEqual([]);
      await page.getByTestId("sidebar").screenshot({ path: info.outputPath(`first-sync-pill-${theme}.png`) });

      release();
      await expect(pill).toHaveCount(0);
      const added = (await server.backend.server.invoke("app.bootstrap", {}, ctx)).accounts.find((a) => a.email === NEW)!;
      expect(added.syncWindowDays).toBe(30);
    } finally {
      release?.();
      try { await server?.close(); } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });
}
