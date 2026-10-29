import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createRegistry } from "@terno/mail";
import { startDevServer, type DevServer } from "../../backend-dev/src/server";

for (const language of ["en", "es"] as const) for (const theme of ["light", "dark"] as const) {
  test(`saved Gmail local pause is distinct from offline/sign-in (${language}, ${theme})`, async ({ page }, testInfo) => {
    const requests: string[] = [];
    const google = createServer(async (req, res) => {
      for await (const _ of req) { /* Synthetic token payload only. */ }
      requests.push(req.url!);
      res.sendDate = false;
      res.writeHead(req.url === "/token" ? 200 : 429, { "content-type": "application/json", "retry-after": "120" });
      res.end(JSON.stringify(req.url === "/token" ? { access_token: "synthetic", token_type: "Bearer", expires_in: 3600 } : {}));
    });
    const dir = mkdtempSync(join(tmpdir(), "terno-cooldown-ui-"));
    let server: DevServer | undefined;
    await new Promise<void>((resolve) => google.listen(0, "127.0.0.1", resolve));
    try {
      const address = google.address();
      if (!address || typeof address === "string") throw new Error("No synthetic Google port");
      const origin = `http://127.0.0.1:${address.port}`;
      server = await startDevServer({ port: 0, dataDir: dir, token: "synthetic", seed: false, autoSync: false, iconTransport: null, providers: createRegistry({ gmail: { endpoints: { token: `${origin}/token`, api: `${origin}/mail` } } }) });
      const backend = server.backend;
      const ctx = { clientId: "synthetic", origin: "dev" as const };
      await backend.server.invoke("settings.update", { language, theme, senderIcons: false, gmailClientId: "synthetic-client" }, ctx);
      const { account } = await backend.store.accounts.create({ kind: "gmail", email: "synthetic@example.test", displayName: "Synthetic Gmail", color: "indigo", now: 1 });
      await backend.setSecret(`account:${account.id}:refreshToken`, "synthetic-refresh");
      await backend.syncAccount(account.id);
      await backend.syncAccount(account.id);
      expect(requests).toEqual(["/token", "/mail/profile"]);
      await page.goto(`/?backend=${encodeURIComponent(server.url)}&token=synthetic`);
      await page.locator("[data-ready]").waitFor();
      await page.getByTestId("open-settings").click();
      await page.getByTestId("tab-accounts").click();
      await expect(page.getByTestId("settings-account")).toContainText(language === "en" ? "Gmail is paused. Try again later." : "Gmail está en pausa. Inténtalo más tarde.");
      await expect(page.getByTestId("connection-pill")).toHaveCount(0);
      await expect(page.getByTestId("account-reconnect")).toHaveCount(0);
      expect((await new AxeBuilder({ page }).include('[data-testid="settings-dialog"]').analyze()).violations).toEqual([]);
      expect(await page.getByTestId("settings-dialog").evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`cooldown-${language}-${theme}.png`) });
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      expect(requests).toEqual(["/token", "/mail/profile"]);
    } finally {
      try { await server?.close(); }
      finally { google.closeAllConnections(); await new Promise<void>((resolve) => google.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
    }
  });
}
