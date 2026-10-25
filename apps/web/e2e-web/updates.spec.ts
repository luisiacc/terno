/**
 * A new web deployment (plan 11 §8.8): the periodic registration.update()
 * finds it, the sidebar pill offers "New Version · Reload", and activation
 * reloads every tab only after each saved what it was writing. Two builds of
 * the service worker are served from one directory switched under the page
 * (the second differs in its build id, as a deploy does).
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
// the config builds into dist-web-e2e-<WEB_PORT> when a port is given
const BUILT = join(here, "..", process.env.WEB_PORT ? `dist-web-e2e-${process.env.WEB_PORT}` : "dist-web-e2e");
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };

let dirs: { a: string; b: string };
let serving: string;
let server: Server;
let origin: string;

test.beforeAll(async () => {
  test.skip(!existsSync(join(BUILT, "sw.js")), "the web e2e build (dist-web-e2e) is made by this config's webServer");
  const root = mkdtempSync(join(tmpdir(), "terno-sw-"));
  dirs = { a: join(root, "a"), b: join(root, "b") };
  cpSync(BUILT, dirs.a, { recursive: true });
  cpSync(BUILT, dirs.b, { recursive: true });
  // the next deploy: a new build id in the service worker (its bytes change, so the browser installs it)
  const sw = readFileSync(join(dirs.b, "sw.js"), "utf8");
  const next = sw.replace(/const BUILD = "([^"]+)"/, (_m, id: string) => `const BUILD = "${id}-next"`);
  expect(next).not.toBe(sw);
  writeFileSync(join(dirs.b, "sw.js"), next);
  serving = dirs.a;
  server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    let file = join(serving, path === "/" ? "index.html" : path);
    if (!file.startsWith(serving) || !existsSync(file) || statSync(file).isDirectory()) file = join(serving, "index.html");
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(() => {
  server?.close();
  if (dirs) rmSync(dirname(dirs.a), { recursive: true, force: true });
});

const rows = (page: Page) => page.getByTestId("thread-row");
// a small mailbox, and the deployment check every second instead of every 30 minutes
const URL_ = "/?demo=200&swcheck=1000";

test("a new deployment: offered in the pill, and a tab writing a draft saves it before every tab reloads", async ({ context, page }) => {
  await page.goto(`${origin}${URL_}`);
  await rows(page).first().waitFor({ timeout: 60_000 });
  // controlled by this build's service worker (from the second load on)
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }));
  });
  await page.reload();
  await rows(page).first().waitFor();
  await expect(page.getByTestId("update-pill")).toHaveCount(0);

  // a second tab takes the mailbox and opens a reply
  const second = await context.newPage();
  await second.goto(`${origin}${URL_}`);
  await second.getByTestId("web-use-here").click();
  await rows(second).first().waitFor();
  await expect(page.getByTestId("web-taken")).toBeVisible();
  await rows(second).first().dispatchEvent("mousedown");
  await expect(second.getByTestId("reader-subject")).toBeVisible();
  await second.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await second.keyboard.press("r");
  await expect(second.getByTestId("compose-body")).toBeVisible();

  // deploy: the periodic check finds it and the pill offers it
  serving = dirs.b;
  await expect(second.getByTestId("update-pill")).toHaveText("New Version · Reload", { timeout: 30_000 });

  // another tab activates the new build while this one is still typing (each key restarts the 800 ms autosave
  // pause): what the field held as the page went away must be what the mailbox has
  await second.evaluate(() =>
    addEventListener("pagehide", () => sessionStorage.setItem("draft-at-reload", (document.querySelector("[data-testid=compose-body]") as HTMLElement | null)?.innerText ?? "")),
  );
  await second.getByTestId("compose-body").focus();
  await second.keyboard.type("Lo que escribía al recargar");
  let navigated = false;
  second.once("framenavigated", () => (navigated = true));
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.postMessage("skip-waiting"));
  for (let i = 0; i < 100 && !navigated; i++) {
    await second.keyboard.type(" más").catch(() => {});
    await second.waitForTimeout(40).catch(() => {});
  }
  expect(navigated).toBe(true);
  const atReload = () => second.evaluate(() => sessionStorage.getItem("draft-at-reload"));
  await expect.poll(atReload).not.toBeNull();
  const typed = (await atReload())!;
  expect(typed).toMatch(/^Lo que escribía al recargar( más)+/);

  // every tab reloads into the new build; whichever leads now has the draft as it was typed
  const leader = async () => {
    for (const p of [page, second]) if ((await rows(p).count()) > 0) return p;
    return null;
  };
  await expect.poll(leader, { timeout: 60_000 }).not.toBeNull();
  const tab = (await leader())!;
  const drafts = await tab.evaluate(() => window.__ternoWeb!.client.call("drafts.list", {}));
  expect(drafts.map((d) => d.bodyText.trimEnd())).toContain(typed.trimEnd());
  const build = await tab.evaluate(async () => {
    const sw = navigator.serviceWorker.controller;
    if (!sw) return null;
    return new Promise<string>((resolve) => {
      navigator.serviceWorker.addEventListener("message", (e) => e.data?.type === "build" && resolve(e.data.build), { once: true });
      sw.postMessage("build");
    });
  });
  expect(build).toMatch(/-next$/);
});
