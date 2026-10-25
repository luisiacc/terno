import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type Page } from "@playwright/test";

/** A small demo mailbox: enough rows to triage and search, quick to seed. */
const DEMO = "/?demo=400";
const rows = (page: Page) => page.getByTestId("thread-row");

async function boot(page: Page, url = DEMO) {
  await page.goto(url);
  await rows(page).first().waitFor({ timeout: 60_000 });
}

const web = (page: Page) => page.evaluate(() => window.__ternoWeb!);

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
  await page.evaluate(() => localStorage.setItem("terno:storage:terno", "no-such-store"));
  await page.reload();
  await expect(page.getByTestId("web-fatal")).toBeVisible();
  await expect(page.getByTestId("web-fatal")).toContainText("no new mailbox was created");
  // an explicit ?storage= that isn't available is refused the same way
  await page.evaluate(() => localStorage.removeItem("terno:storage:terno"));
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
  await expect(settings.getByTestId("local-mode-row")).toContainText("can’t pin DNS addresses");
  await settings.getByTestId("tab-agents").click();
  await expect(settings.getByTestId("desktop-only-agents")).toBeVisible();
  await expect(settings.getByTestId("mcp-claude")).toHaveCount(0);
  await settings.getByTestId("tab-accounts").click();
  await expect(settings).toContainText("Web application");
  await settings.getByRole("button", { name: "Add account" }).click();
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
  await expect(page.getByTestId("first-run-local")).toContainText("Terno only connects to Google");
});

test("Español chosen in Settings → General switches live, and after a reload the very first frame is Spanish (cached setting, lazy chunk through the service worker)", async ({ page }) => {
  // html[lang] at the moment #root first gets children: what the first frame is painted in
  await page.addInitScript(() => {
    const w = window as Window & { __firstLang?: string };
    const seen = new MutationObserver(() => {
      if (!document.getElementById("root")?.firstChild) return;
      w.__firstLang = document.documentElement.lang;
      seen.disconnect();
    });
    seen.observe(document, { childList: true, subtree: true });
  });
  const firstLang = () => page.evaluate(() => (window as Window & { __firstLang?: string }).__firstLang);
  const choose = async (language: "es" | "en", tag: string) => {
    await page.keyboard.press("Meta+Comma");
    await page.getByTestId("tab-general").click();
    await expect(page.getByTestId("general-tab")).toBeVisible();
    await page.getByTestId("language-select").click();
    await page.getByTestId(`language-${language}`).click();
    // the app re-mounts in the new language once the list has closed
    await expect(page.locator("html")).toHaveAttribute("lang", tag);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings-dialog")).toHaveCount(0);
  };
  await boot(page);
  expect(await firstLang()).toBe("en-US");
  await expect(page.getByTestId("list-title")).toHaveText("Inbox");
  // the reload below goes through this build's service worker
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }));
  });

  await choose("es", "es-MX");
  await expect(page.getByTestId("list-title")).toHaveText("Entrada");
  await page.reload();
  await rows(page).first().waitFor();
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  expect(await firstLang()).toBe("es-MX");
  await expect(page.getByTestId("list-title")).toHaveText("Entrada");

  // and back to English, live
  await choose("en", "en-US");
  await expect(page.getByTestId("list-title")).toHaveText("Inbox");
});

/** Google, stubbed: Identity Services answers like its popup, the Gmail and OpenID APIs like Google (two messages). Returns the requests seen. */
async function stubGoogle(context: import("@playwright/test").BrowserContext, email = "luis@gmail.com"): Promise<string[]> {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };
  const raw = (subject: string) =>
    Buffer.from(`From: Ana <ana@example.com>\r\nTo: Luis <${email}>\r\nSubject: ${subject}\r\nMessage-ID: <${subject}@x>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nhola`).toString("base64url");
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
    if (path === "/profile") return json({ emailAddress: email, historyId: "10" });
    if (path === "/messages") return json({ messages: [{ id: "g1" }, { id: "g2" }] });
    const m = /^\/messages\/(g\d)$/.exec(path);
    if (m) return json({ id: m[1], threadId: `t-${m[1]}`, labelIds: ["INBOX", "UNREAD"], internalDate: String(Date.UTC(2026, 9, 20)), raw: raw(`Desde Gmail ${m[1]}`) });
    return route.fulfill({ status: 404, headers: cors, body: "{}" });
  });
  return seen;
}

test("Gmail in the browser: Google's token model through the page, the mailbox synced by the worker", async ({ context, page }) => {
  const seen = await stubGoogle(context);
  await page.goto("/?demo=0&mailbox=gmail");
  await page.getByTestId("first-run").waitFor();
  await page.keyboard.press("Escape");
  await page.getByTestId("open-settings").click();
  const settings = page.getByTestId("settings-dialog");
  await settings.getByTestId("tab-accounts").click();
  const clientId = settings.getByRole("textbox", { name: "Google OAuth Client ID" });
  await clientId.fill("123-web.apps.googleusercontent.com");
  await clientId.blur();
  await settings.getByRole("button", { name: "Add account" }).click();
  await page.getByTestId("connect-gmail").click();
  await expect(page.getByTestId("snack-message").getByText("luis@gmail.com connected")).toBeVisible();
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
  const screen = second.getByRole("dialog", { name: "Terno is open in another tab" });
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
  await expect(page.getByRole("dialog", { name: "Terno was opened in another tab" })).toBeVisible();
  await expect(page.getByTestId("web-take-back")).toBeFocused();
});

test("storage: persistence is requested and shown in Settings → Data, and the mailbox's own data exports as JSON", async ({ page }) => {
  await boot(page);
  await page.getByTestId("open-settings").click();
  await page.getByTestId("tab-data").click();
  const section = page.getByTestId("storage-section");
  await expect(section).toBeVisible();
  await expect(section.getByTestId("storage-persistence")).toHaveAttribute("data-persisted", /^(granted|denied)$/);
  await expect(section).toContainText(/won’t clear your mailbox|may clear your mailbox/);
  await expect(page.getByRole("combobox", { name: "Engine" })).toContainText("SQLite (OPFS)");
  const download = page.waitForEvent("download");
  await page.getByTestId("data-export").click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^terno-export-\d{4}-\d{2}-\d{2}\.json$/);
  const dump = JSON.parse(await (await import("node:fs/promises")).readFile((await file.path())!, "utf8")) as { format: string; categories: unknown[]; filters: unknown[]; settings: object; ops: unknown[] };
  expect(dump.format).toBe("terno-export");
  expect(dump.categories.length).toBeGreaterThan(0);
  expect(dump.filters.length).toBeGreaterThan(0);
  expect(dump.settings).toBeTruthy();
});

test("Settings → Data: switching the engine to IndexedDB carries settings and categories, stays pinned, and can switch back", async ({ page }) => {
  await boot(page, "/?demo=200&mailbox=switch");
  expect((await web(page)).storage).toBe("opfs-sqlite");
  await page.evaluate(async () => {
    const c = window.__ternoWeb!.client;
    await c.call("categories.create", { name: "Mudanza", color: "violet" });
    await c.call("settings.update", { density: "compact", motionMs: 50 });
  });
  await page.reload();
  await rows(page).first().waitFor({ timeout: 60_000 });
  await page.keyboard.press("Meta+k");
  await page.getByTestId("palette-input").fill("settings data");
  await page.keyboard.press("Enter");
  await page.getByRole("combobox", { name: "Engine" }).click();
  await page.getByTestId("storage-engine-idb").click();
  await expect(page.getByTestId("storage-switch-dialog")).toContainText("stays where it is");
  // the page reloads into the other engine
  await Promise.all([page.waitForEvent("load"), page.getByTestId("storage-switch-dialog-confirm").click()]);
  await rows(page).first().waitFor({ timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => window.__ternoWeb?.storage)).toBe("idb");
  // what the other engine held came along
  await expect(page.locator("[data-testid^=nav-category-]").filter({ hasText: "Mudanza" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-motion", /./);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--motion").trim())).toBe("50ms");
  // pinned: a reload opens IndexedDB again
  await page.reload();
  await rows(page).first().waitFor({ timeout: 60_000 });
  expect((await web(page)).storage).toBe("idb");
  // and back: the SQLite mailbox was left where it was
  await page.keyboard.press("Meta+Comma");
  await page.getByTestId("tab-data").click();
  await expect(page.getByRole("combobox", { name: "Engine" })).toContainText("IndexedDB");
  await page.getByRole("combobox", { name: "Engine" }).click();
  await page.getByTestId("storage-engine-opfs-sqlite").click();
  await Promise.all([page.waitForEvent("load"), page.getByTestId("storage-switch-dialog-confirm").click()]);
  await rows(page).first().waitFor({ timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => window.__ternoWeb?.storage)).toBe("opfs-sqlite");
  await expect(page.locator("[data-testid^=nav-category-]").filter({ hasText: "Mudanza" })).toHaveCount(1);
});

test("Settings → Data: an export imports into another mailbox (categories by name, settings), and a wrong file says why", async ({ page }) => {
  await boot(page, "/?demo=200&mailbox=import-a");
  const dump = await page.evaluate(async () => {
    const c = window.__ternoWeb!.client;
    await c.call("categories.create", { name: "Importada", color: "lime" });
    return c.call("app.export", {});
  });
  await boot(page, "/?demo=200&mailbox=import-b");
  await page.keyboard.press("Meta+Comma");
  await page.getByTestId("tab-data").click();
  const input = page.getByTestId("data-import-input");
  await input.setInputFiles({ name: "malo.json", mimeType: "application/json", buffer: Buffer.from("{}") });
  await expect(page.getByTestId("data-import-error")).toContainText("This isn’t a Terno export");
  await input.setInputFiles({ name: "terno.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(dump)) });
  await expect(page.getByTestId("data-import-error")).toHaveCount(0);
  await expect(page.locator("[data-testid^=nav-category-]").filter({ hasText: "Importada" })).toBeVisible();
});

test("switching into a fresh, empty engine: drafts and account filters wait for their mailbox and come back when it is connected", async ({ context, page }) => {
  await stubGoogle(context, "luis.cordero@gmail.com");
  await boot(page, "/?demo=200&mailbox=fresh-switch");
  await page.evaluate(async () => {
    const c = window.__ternoWeb!.client;
    const account = (await c.call("app.bootstrap", {})).accounts.find((a) => a.email === "luis.cordero@gmail.com")!;
    await c.call("drafts.save", { accountId: account.id, to: [{ name: "", email: "ana@pendiente.dev" }], bcc: [{ name: "", email: "copia@pendiente.dev" }], subject: "Pendiente", bodyText: "Hola Ana" });
    await c.call("filters.save", { name: "Solo Personal", enabled: true, source: "manual", rule: { match: "all", conditions: [{ field: "account", op: "is", value: account.id }], actions: [{ type: "star" }] } });
  });
  // the same mailbox without the demo seed, so the other engine starts empty (as a real one would)
  await page.goto("/?demo=0&mailbox=fresh-switch");
  await rows(page).first().waitFor({ timeout: 60_000 });
  await page.keyboard.press("Meta+k");
  await page.getByTestId("palette-input").fill("settings data");
  await page.keyboard.press("Enter");
  await page.getByRole("combobox", { name: "Engine" }).click();
  await page.getByTestId("storage-engine-idb").click();
  await Promise.all([page.waitForEvent("load"), page.getByTestId("storage-switch-dialog-confirm").click()]);
  await expect.poll(() => page.evaluate(() => window.__ternoWeb?.storage)).toBe("idb");
  await expect(page.getByTestId("snack-message").getByText(/come back as soon as you connect them/)).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => window.__ternoWeb!.client.call("drafts.list", {}))).toEqual([]);

  // connecting that Gmail account brings its draft and its filter back
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+Comma");
  await page.getByTestId("tab-accounts").click();
  const clientId = page.getByRole("textbox", { name: "Google OAuth Client ID" });
  await clientId.fill("123-web.apps.googleusercontent.com");
  await clientId.blur();
  await page.getByRole("button", { name: "Add account" }).click();
  await page.getByTestId("connect-gmail").click();
  await expect(page.getByTestId("snack-message").getByText("luis.cordero@gmail.com connected")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("strip-item").filter({ hasText: "ana@pendiente.dev" })).toBeVisible();
  const drafts = await page.evaluate(() => window.__ternoWeb!.client.call("drafts.list", {}));
  expect(drafts).toMatchObject([{ subject: "Pendiente", bcc: [{ name: "", email: "copia@pendiente.dev" }] }]);
  await page.keyboard.press("Meta+Comma");
  await page.getByTestId("tab-filters").click();
  await expect(page.locator("[data-testid=settings-filter]").filter({ hasText: "Solo Personal" })).toContainText("luis.cordero@gmail.com");
});

test("AI with your own key runs from the worker: OpenAI and Anthropic get the request (stubbed), a local server refusing this origin says how to allow it", async ({ context, page }) => {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS" };
  const wire = JSON.stringify({ name: "Recibos", explanation: "Archiva los recibos de Uber", match: "all", conditions: [{ field: "fromDomain", op: "equals", value: "uber.com", negate: false }], actions: [{ type: "archive", categoryId: null }] });
  const sent: { url: string; key: string; origin: string; browserAccess?: string }[] = [];
  await context.route(/https:\/\/api\.(openai|anthropic)\.com\/.*/, (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const h = req.headers();
    sent.push({ url: req.url(), key: h.authorization ?? h["x-api-key"] ?? "", origin: h.origin ?? "", browserAccess: h["anthropic-dangerous-direct-browser-access"] });
    const json = (body: unknown, status = 200, headers: Record<string, string> = cors) => route.fulfill({ status, headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (req.url().startsWith("https://api.anthropic.com/")) {
      // like the real API: a browser's request without the opt-in header gets no CORS headers
      if (h["anthropic-dangerous-direct-browser-access"] !== "true") return json({ type: "error", error: { type: "authentication_error", message: "CORS requests must set 'anthropic-dangerous-direct-browser-access' header" } }, 401, {});
      return json({ id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: wire }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
    }
    return json({ id: "c", object: "chat.completion", created: 0, model: "gpt-x", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: wire, refusal: null } }] });
  });
  // Ollama as it answers an origin it wasn't told to allow (OLLAMA_ORIGINS): 403, no CORS headers. A real server:
  // Playwright adds CORS headers to the responses it fulfills itself
  const ollama = createServer((req, res) => {
    res.writeHead(req.headers.origin ? 403 : 200, { "content-type": "application/json" });
    res.end(req.headers.origin ? "" : JSON.stringify({ models: [{ name: "qwen3:8b" }] }));
  });
  await new Promise<void>((r) => ollama.listen(0, "127.0.0.1", r));
  const ollamaURL = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}/v1`;
  await boot(page, "/?demo=40&mailbox=byo-ai");
  const origin = new URL(page.url()).origin;
  const generate = (provider: "openai" | "anthropic", model: string, key: string) =>
    page.evaluate(
      async ({ provider, model, key }) => {
        const client = window.__ternoWeb!.client;
        await client.call("settings.update", { localMode: false, ai: { provider, model } });
        await client.call("ai.setKey", { provider, value: key });
        return client.call("filters.generate", { prompt: "archiva los recibos de uber" });
      },
      { provider, model, key },
    );
  expect(await generate("openai", "gpt-x", "sk-web-openai-1234")).toMatchObject({ name: "Recibos", rule: { actions: [{ type: "archive" }] } });
  expect(await generate("anthropic", "claude-opus-5-5", "sk-ant-web-5678")).toMatchObject({ name: "Recibos" });
  expect(sent).toEqual([
    { url: "https://api.openai.com/v1/chat/completions", key: "Bearer sk-web-openai-1234", origin, browserAccess: undefined },
    { url: "https://api.anthropic.com/v1/messages?beta=true", key: "Bearer sk-ant-web-5678", origin, browserAccess: "true" },
  ]);
  // local mode back on: a literal loopback server is allowed, and when it refuses this page the message says what to do
  const error = await page.evaluate(async (baseURL) => {
    const client = window.__ternoWeb!.client;
    await client.call("settings.update", { localMode: true, ai: { provider: "ollama", model: "qwen3:8b", baseURL } });
    return client.call("ai.listModels", { provider: "ollama", baseURL }).then(
      () => "listed",
      (e: Error) => e.message,
    );
  }, ollamaURL);
  ollama.close();
  expect(error).toContain(`allow the origin ${origin} in Ollama: OLLAMA_ORIGINS=${origin}`);
});

test("a key is never carried through a redirect: Azure's endpoint answering 307 to another CORS-enabled origin gets a clear error, and that origin sees no key", async ({ page }) => {
  // both are real servers (Playwright fulfils CORS for the responses it fakes) on two origins, both allowing this page
  const cors = (req: IncomingMessage) => ({ "access-control-allow-origin": req.headers.origin ?? "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS" });
  const target: { method: string; keys: string[] }[] = [];
  const thief = createServer((req, res) => {
    target.push({ method: req.method!, keys: ["authorization", "api-key", "x-api-key"].filter((h) => req.headers[h] !== undefined) });
    res.writeHead(200, { ...cors(req), "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((r) => thief.listen(0, "127.0.0.1", r));
  const thiefPort = (thief.address() as AddressInfo).port;
  const endpoint = createServer((req, res) => {
    if (req.method === "OPTIONS") return void res.writeHead(204, cors(req)).end();
    res.writeHead(307, { ...cors(req), location: `http://127.0.0.1:${thiefPort}${req.url}` }).end();
  });
  await new Promise<void>((r) => endpoint.listen(0, "127.0.0.1", r));
  const baseURL = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}`;
  try {
    await boot(page, "/?demo=40&mailbox=redirect-ai");
    const error = await page.evaluate(async (baseURL) => {
      const client = window.__ternoWeb!.client;
      await client.call("settings.update", { localMode: false, ai: { provider: "compatible", preset: "azure", model: "dep", baseURL } });
      await client.call("ai.setKey", { provider: "compatible", preset: "azure", value: "azure-web-secret" });
      return client.call("filters.generate", { prompt: "archiva los recibos de uber" }).then(
        () => "generated",
        (e: Error) => e.message,
      );
    }, baseURL);
    expect(target).toEqual([]);
    expect(error).toContain("Terno doesn’t follow redirects for requests that carry your API key");
  } finally {
    endpoint.close();
    thief.close();
  }
});
