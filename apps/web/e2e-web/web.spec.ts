import { expect, test, type Page } from "@playwright/test";

/** A small demo mailbox: enough rows to triage and search, quick to seed. */
const DEMO = "/?demo=400";
const rows = (page: Page) => page.getByTestId("thread-row");

async function boot(page: Page, url = DEMO) {
  await page.goto(url);
  await rows(page).first().waitFor({ timeout: 60_000 });
}

const web = (page: Page) => page.evaluate(() => window.__unicaWeb!);

test("the backend runs in a worker on SQLite-WASM over OPFS: seeds, lists, searches, opens", async ({ page }) => {
  await boot(page);
  const info = await web(page);
  expect(info.storage).toBe("opfs-sqlite");
  expect(await rows(page).count()).toBeGreaterThan(10);
  await page.getByTestId("search-input").fill("factura");
  await expect(page.getByTestId("search-stats")).toBeVisible();
  await rows(page).first().dispatchEvent("mousedown");
  await expect(page.getByTestId("reader-subject")).toBeVisible();
});

test("a repeat visit opens the stored mailbox (no reseed) and actions persist", async ({ page }) => {
  await boot(page);
  const first = await rows(page).first().getAttribute("data-thread-id");
  await rows(page).first().dispatchEvent("mousedown");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("e"); // archive
  await expect(page.locator(`[data-testid=thread-row][data-thread-id="${first}"]`)).toHaveCount(0);
  await page.reload();
  await rows(page).first().waitFor();
  expect((await web(page)).timings.seed).toBeUndefined();
  await expect(page.locator(`[data-testid=thread-row][data-thread-id="${first}"]`)).toHaveCount(0);
});

test("one tab at a time: a second tab waits, takes over after the first closed its handles, and can be taken back", async ({ context, page }) => {
  await boot(page);
  const second = await context.newPage();
  await second.goto(DEMO);
  await expect(second.getByTestId("web-elsewhere")).toBeVisible();
  await expect(second.getByTestId("thread-row")).toHaveCount(0);
  await second.getByTestId("web-use-here").click();
  await rows(second).first().waitFor();
  await expect(page.getByTestId("web-taken")).toBeVisible();
  await page.getByTestId("web-take-back").click();
  await rows(page).first().waitFor();
  await expect(second.getByTestId("web-taken")).toBeVisible();
  // closing the leader hands the mailbox to a waiting tab on its own
  const third = await context.newPage();
  await third.goto(DEMO);
  await expect(third.getByTestId("web-elsewhere")).toBeVisible();
  await page.close();
  await rows(third).first().waitFor();
});

test("a draft being written reaches the mailbox before another tab takes it over", async ({ context, page }) => {
  await boot(page);
  const id = await rows(page).first().getAttribute("data-thread-id");
  await rows(page).first().dispatchEvent("mousedown");
  await expect(page.getByTestId("reader-subject")).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("r");
  await page.getByTestId("compose-body").focus();
  // typed and handed over at once: well inside the 800 ms autosave pause
  await page.keyboard.type("Texto que no se pierde");
  const second = await context.newPage();
  await second.goto(DEMO);
  await second.getByTestId("web-use-here").click();
  await rows(second).first().waitFor();
  await second.locator(`[data-testid=thread-row][data-thread-id="${id}"]`).dispatchEvent("mousedown");
  await expect(second.getByTestId("reader-subject")).toBeVisible();
  await second.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await second.keyboard.press("r");
  await expect(second.getByTestId("compose-body")).toHaveValue(/Texto que no se pierde/);
});

test("an open error never swaps the mailbox for an empty one", async ({ page }) => {
  await boot(page);
  // the rows in the DOM depend on the list's height: count once the banners above it are in
  await expect(page.getByTestId("mac-banner")).toBeVisible();
  const before = await rows(page).count();
  // the mailbox is pinned to the adapter it was created with; pretend that one is gone
  await page.evaluate(() => localStorage.setItem("unica:storage:unica", "no-such-store"));
  await page.reload();
  await expect(page.getByTestId("web-fatal")).toBeVisible();
  await expect(page.getByTestId("web-fatal")).toContainText("no se creó un buzón nuevo");
  // an explicit ?storage= that isn't available is refused the same way
  await page.evaluate(() => localStorage.removeItem("unica:storage:unica"));
  await page.goto("/?demo=400&storage=nope");
  await expect(page.getByTestId("web-fatal")).toBeVisible();
  // the stored mailbox is untouched
  await boot(page, "/?demo=0");
  await expect(page.getByTestId("mac-banner")).toBeVisible();
  expect(await rows(page).count()).toBe(before);
});

test("offline: the service worker serves this build's shell, worker and WASM", async ({ context, page }) => {
  await boot(page);
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }));
    return reg.active?.state;
  });
  await context.setOffline(true);
  await page.reload();
  await rows(page).first().waitFor();
  await context.setOffline(false);
});

test("what the browser can't do is said plainly: IMAP and agents locked, honest local mode, one Mac nudge", async ({ page }) => {
  await boot(page);
  // the banner: one line, dismissed for a week (and stays dismissed across reloads)
  await expect(page.getByTestId("mac-banner")).toBeVisible();
  await page.getByTestId("mac-banner-dismiss").click();
  await expect(page.getByTestId("mac-banner")).toHaveCount(0);
  await page.reload();
  await rows(page).first().waitFor();
  await expect(page.getByTestId("mac-banner")).toHaveCount(0);

  await page.getByTestId("open-settings").click();
  const settings = page.getByTestId("settings-dialog");
  await expect(settings).toBeVisible();
  await expect(settings.getByTestId("mac-section")).toBeVisible();
  await expect(settings.getByTestId("local-mode-row")).toContainText("no puede fijar direcciones DNS");
  await settings.getByTestId("tab-agents").click();
  await expect(settings.getByTestId("desktop-only-agents")).toBeVisible();
  await expect(settings.getByTestId("mcp-claude")).toHaveCount(0);
  await settings.getByTestId("tab-accounts").click();
  await expect(settings).toContainText("Aplicación web");
  await settings.getByRole("button", { name: "Añadir cuenta" }).click();
  const add = page.getByTestId("add-account-dialog");
  await expect(add.getByTestId("desktop-only-imap")).toBeVisible();
  await expect(add.getByTestId("imap-email")).toHaveCount(0);
  await expect(add.getByTestId("connect-gmail")).toBeVisible();
});

test("first run in the browser offers the Mac app once, then the usual steps", async ({ page }) => {
  await page.goto("/?demo=0&mailbox=fresh");
  await expect(page.getByTestId("first-run")).toBeVisible();
  await expect(page.getByTestId("mac-onboarding")).toBeVisible();
  await expect(page.getByTestId("mac-onboarding").getByTestId("mac-download")).toHaveAttribute("href", /^https:/);
  await expect(page.getByTestId("first-run-local")).toContainText("Única solo se conecta con Google");
});

test("Gmail in the browser: Google's token model through the page, the mailbox synced by the worker", async ({ context, page }) => {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };
  const raw = (subject: string) =>
    Buffer.from(`From: Ana <ana@example.com>\r\nTo: Luis <luis@gmail.com>\r\nSubject: ${subject}\r\nMessage-ID: <${subject}@x>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nhola`).toString("base64url");
  // Google Identity Services, stubbed: the token client answers like the real popup does
  await context.route("https://accounts.google.com/gsi/client", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `window.google = { accounts: { oauth2: { initTokenClient: (c) => ({ requestAccessToken: () => setTimeout(() => c.callback({ access_token: "web-token", expires_in: 3599, scope: ${JSON.stringify(
        "openid email profile https://www.googleapis.com/auth/gmail.modify",
      )} }), 10) }) } } };`,
    }),
  );
  const seen: string[] = [];
  await context.route(/https:\/\/(gmail|openidconnect)\.googleapis\.com\/.*/, (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const url = new URL(req.url());
    seen.push(`${req.method()} ${url.pathname} ${req.headers().authorization ?? ""}`);
    const json = (data: unknown) => route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(data) });
    if (url.hostname === "openidconnect.googleapis.com") return json({ name: "Luis Cordero", sub: "sub-1", email_verified: true });
    const path = url.pathname.replace("/gmail/v1/users/me", "");
    if (path === "/profile") return json({ emailAddress: "luis@gmail.com", historyId: "10" });
    if (path === "/messages") return json({ messages: [{ id: "g1" }, { id: "g2" }] });
    const m = /^\/messages\/(g\d)$/.exec(path);
    if (m) return json({ id: m[1], threadId: `t-${m[1]}`, labelIds: ["INBOX", "UNREAD"], internalDate: String(Date.UTC(2026, 9, 20)), raw: raw(`Desde Gmail ${m[1]}`) });
    return route.fulfill({ status: 404, headers: cors, body: "{}" });
  });
  await page.goto("/?demo=0&mailbox=gmail");
  await page.getByTestId("first-run").waitFor();
  await page.keyboard.press("Escape");
  await page.getByTestId("open-settings").click();
  const settings = page.getByTestId("settings-dialog");
  await settings.getByTestId("tab-accounts").click();
  await settings.locator("#gmail-client-id").fill("123-web.apps.googleusercontent.com");
  await settings.locator("#gmail-client-id").blur();
  await settings.getByRole("button", { name: "Añadir cuenta" }).click();
  await page.getByTestId("connect-gmail").click();
  await expect(page.getByText("luis@gmail.com conectada")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).first()).toContainText("Desde Gmail");
  expect(seen).toContain("GET /gmail/v1/users/me/profile Bearer web-token");
});

test("?storage=idb runs the same app on native IndexedDB, and the mailbox stays pinned there", async ({ page }) => {
  await boot(page, "/?demo=400&mailbox=idb&storage=idb");
  expect((await web(page)).storage).toBe("idb");
  await page.getByTestId("search-input").fill("factura");
  await expect(page.getByTestId("search-stats")).toBeVisible();
  await rows(page).first().dispatchEvent("mousedown");
  await expect(page.getByTestId("reader-subject")).toBeVisible();
  // without ?storage= the mailbox is found where it lives, not recreated in OPFS
  await boot(page, "/?demo=0&mailbox=idb");
  expect((await web(page)).storage).toBe("idb");
  expect(await rows(page).count()).toBeGreaterThan(10);
});

test("a tab whose worker fails to start gives leadership up: another tab opens the mailbox", async ({ context, page }) => {
  await boot(page);
  await page.close();
  const failed = await context.newPage();
  await failed.goto("/?demo=400&storage=nope");
  await expect(failed.getByTestId("web-fatal")).toBeVisible();
  const next = await context.newPage();
  await next.goto(DEMO);
  await rows(next).first().waitFor({ timeout: 20_000 });
});

test("takeover goes to the tab that asked, not to whichever tab waited longest", async ({ context, page }) => {
  await boot(page);
  const waiting = await context.newPage();
  await waiting.goto(DEMO);
  await expect(waiting.getByTestId("web-elsewhere")).toBeVisible();
  const asking = await context.newPage();
  await asking.goto(DEMO);
  await expect(asking.getByTestId("web-elsewhere")).toBeVisible();
  await asking.getByTestId("web-use-here").click();
  await rows(asking).first().waitFor({ timeout: 20_000 });
  await expect(page.getByTestId("web-taken")).toBeVisible();
  await expect(waiting.getByTestId("web-elsewhere")).toBeVisible();
  await expect(rows(waiting)).toHaveCount(0);
  // and the one that waited can still ask for it
  await waiting.getByTestId("web-use-here").click();
  await rows(waiting).first().waitFor({ timeout: 20_000 });
  await expect(asking.getByTestId("web-taken")).toBeVisible();
});

test("blocking screens take focus, make the app behind them inert and suspend its shortcuts", async ({ context, page }) => {
  await boot(page);
  const second = await context.newPage();
  await second.goto(DEMO);
  const screen = second.getByRole("dialog", { name: "Única está abierta en otra pestaña" });
  await expect(screen).toBeVisible();
  await expect(screen).toHaveAttribute("aria-modal", "true");
  await expect(second.getByTestId("web-use-here")).toBeFocused();
  // Tab never leaves the screen; the app behind it is inert
  for (let i = 0; i < 4; i++) {
    await second.keyboard.press("Tab");
    expect(await second.evaluate(() => !!document.activeElement?.closest("[data-testid=web-elsewhere]") || document.activeElement === document.body)).toBe(true);
  }
  expect(await second.evaluate(() => (document.getElementById("root") as HTMLElement & { inert: boolean }).inert)).toBe(true);
  // app shortcuts don't fire behind it (c would open the composer)
  await second.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await second.keyboard.press("c");
  await second.keyboard.press("Meta+k");
  await expect(second.getByTestId("composer")).toHaveCount(0);
  await expect(second.getByRole("dialog")).toHaveCount(1);
  // a screen that goes away gives the app back
  await second.getByTestId("web-use-here").click();
  await rows(second).first().waitFor();
  expect(await second.evaluate(() => (document.getElementById("root") as HTMLElement & { inert: boolean }).inert)).toBe(false);
  await expect(page.getByRole("dialog", { name: "Única se abrió en otra pestaña" })).toBeVisible();
  await expect(page.getByTestId("web-take-back")).toBeFocused();
});

test("storage: persistence is requested and shown in settings, and the mailbox's own data exports as JSON", async ({ page }) => {
  await boot(page);
  await page.getByTestId("open-settings").click();
  const section = page.getByTestId("storage-section");
  await expect(section).toBeVisible();
  await expect(section).toHaveAttribute("data-persisted", /^(granted|denied)$/);
  await expect(section).toContainText(/Persistente|puede borrar/);
  const download = page.waitForEvent("download");
  await section.getByRole("button", { name: "Exportar" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^unica-export-\d{4}-\d{2}-\d{2}\.json$/);
  const dump = JSON.parse(await (await import("node:fs/promises")).readFile((await file.path())!, "utf8")) as { format: string; categories: unknown[]; filters: unknown[]; settings: object; ops: unknown[] };
  expect(dump.format).toBe("unica-export");
  expect(dump.categories.length).toBeGreaterThan(0);
  expect(dump.filters.length).toBeGreaterThan(0);
  expect(dump.settings).toBeTruthy();
});
