import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createRegistry } from "@terno/mail";
import { startDevServer, type DevServer } from "../../backend-dev/src/server";

// plan 139: the copy is the language's and contrast the theme's; a screen with both doesn't read either differently
const BOTH = [["en", "light"], ["es", "dark"]] as const;

test.beforeEach(async ({ page }) => {
  await page.route("**/*", async (route) => {
    if (["127.0.0.1", "localhost", "[::1]"].includes(new URL(route.request().url()).hostname)) await route.continue();
    else { await route.abort(); throw new Error("Unexpected non-loopback UI request"); }
  });
});

for (const [language, theme] of BOTH) {
  test(`saved Gmail local pause is distinct from offline/sign-in (${language}, ${theme})`, async ({ page }) => {
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
      server = await startDevServer({ port: 0, dataDir: dir, token: "synthetic", seed: false, autoSync: false, iconTransport: null, googleClients: { preferred: "synthetic-client", clients: [{ clientId: "synthetic-client", clientSecret: "" }] }, providers: createRegistry({ gmail: { endpoints: { token: `${origin}/token`, api: `${origin}/mail` } } }) });
      const backend = server.backend;
      const ctx = { clientId: "synthetic", origin: "dev" as const };
      await backend.server.invoke("settings.update", { language, theme, senderIcons: false }, ctx);
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
      expect((await new AxeBuilder({ page }).setLegacyMode().include('[data-testid="settings-dialog"]').analyze()).violations).toEqual([]);
      expect(await page.getByTestId("settings-dialog").evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      expect(requests).toEqual(["/token", "/mail/profile"]);
    } finally {
      try { await server?.close(); }
      finally { google.closeAllConnections(); await new Promise<void>((resolve) => google.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
    }
  });
}

for (const [language, theme] of BOTH) {
  test(`status owner shows policy then genuine sign-in recovery (${language}, ${theme})`, async ({ page }) => {
    const requests: string[] = [];
    let phase: "policy" | "auth" = "policy";
    const google = createServer(async (req, res) => {
      for await (const _ of req) { /* Synthetic credentials only. */ }
      requests.push(req.url!);
      const token = req.url === "/token";
      const status = phase === "policy" ? token ? 200 : 403 : token ? 400 : 401;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(phase === "policy" ? token ? { access_token: "synthetic", token_type: "Bearer", expires_in: 3600 } : { error: { errors: [{ reason: "SERVICE_DISABLED" }] } } : token ? { error: "invalid_grant" } : {}));
    });
    const dir = mkdtempSync(join(tmpdir(), "terno-owner-ui-"));
    let server: DevServer | undefined;
    await new Promise<void>((resolve) => google.listen(0, "127.0.0.1", resolve));
    try {
      const address = google.address();
      if (!address || typeof address === "string") throw new Error("Missing synthetic port");
      const origin = `http://127.0.0.1:${address.port}`;
      server = await startDevServer({ port: 0, dataDir: dir, token: "synthetic", seed: false, autoSync: false, iconTransport: null, googleClients: { preferred: "synthetic-client", clients: [{ clientId: "synthetic-client", clientSecret: "" }] }, providers: createRegistry({ gmail: { endpoints: { token: `${origin}/token`, api: `${origin}/mail` } } }) });
      const backend = server.backend, ctx = { clientId: "synthetic", origin: "dev" as const };
      await backend.server.invoke("settings.update", { language, theme, senderIcons: false }, ctx);
      const { account } = await backend.store.accounts.create({ kind: "gmail", email: "synthetic@example.test", displayName: "Synthetic Gmail", color: "indigo", now: 1 });
      await backend.setSecret(`account:${account.id}:refreshToken`, "synthetic-refresh");
      await backend.syncAccount(account.id);
      await page.goto(`/?backend=${encodeURIComponent(server.url)}&token=synthetic`);
      await page.locator("[data-ready]").waitFor();
      await page.getByTestId("open-settings").click();
      await page.getByTestId("tab-accounts").click();
      const tabTo = async (id: string) => {
        for (let i = 0; i < 40; i++) {
          await page.keyboard.press("Tab");
          if (await page.getByTestId(id).evaluate((element) => element === document.activeElement)) return;
        }
        throw new Error(`Keyboard could not reach ${id}`);
      };
      await expect(page.getByTestId("settings-account")).toContainText(language === "en" ? "Gmail is disabled" : "Gmail está desactivado");
      expect((await new AxeBuilder({ page }).setLegacyMode().include('[data-testid="settings-dialog"]').analyze()).violations).toEqual([]);
      await tabTo("account-toggle");
      await page.keyboard.press("Enter");
      await tabTo("account-reconnect");
      await expect(page.getByTestId("settings-account")).toContainText(language === "en" ? "then choose Retry now." : "luego elige Reintentar ahora.");
      phase = "auth";
      await backend.server.invoke("sync.now", { accountId: account.id, reason: "user" }, ctx);
      await backend.syncAccount(account.id);
      await expect(page.getByTestId("settings-account")).toContainText(language === "en" ? "Needs you to sign in again" : "Necesita que vuelvas a iniciar sesión");
      const reconnect = page.getByTestId("account-reconnect");
      await expect(reconnect).toHaveText(language === "en" ? "Sign in again" : "Volver a iniciar sesión");
      await tabTo("account-reconnect");
      await expect(reconnect).toBeFocused();
      expect((await new AxeBuilder({ page }).setLegacyMode().include('[data-testid="settings-dialog"]').analyze()).violations).toEqual([]);
      const before = requests.slice();
      await backend.server.invoke("sync.now", { accountId: account.id, reason: "user" }, ctx);
      await backend.syncAccount(account.id);
      await backend.runWorker();
      expect(requests).toEqual(before);
    } finally {
      try { await server?.close(); }
      finally { google.closeAllConnections(); await new Promise<void>((resolve) => google.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
    }
  });
}
