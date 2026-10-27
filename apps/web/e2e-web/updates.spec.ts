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

let dirs: { a: string; b: string; c: string };
let serving: string;
let server: Server;
let origin: string;

test.beforeAll(async () => {
  test.skip(!existsSync(join(BUILT, "sw.js")), "the web e2e build (dist-web-e2e) is made by this config's webServer");
  const root = mkdtempSync(join(tmpdir(), "terno-sw-"));
  dirs = { a: join(root, "a"), b: join(root, "b"), c: join(root, "c") };
  cpSync(BUILT, dirs.a, { recursive: true });
  cpSync(BUILT, dirs.b, { recursive: true });
  // the next deploy: a new build id in the service worker (its bytes change, so the browser installs it)
  const sw = readFileSync(join(dirs.b, "sw.js"), "utf8");
  const next = sw.replace(/const BUILD = "([^"]+)"/, (_m, id: string) => `const BUILD = "${id}-next"`);
  expect(next).not.toBe(sw);
  writeFileSync(join(dirs.b, "sw.js"), next);
  cpSync(dirs.b, dirs.c, { recursive: true });
  writeFileSync(join(dirs.c, "sw.js"), next.replace(/-next"/, '-third"'));
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
  await second.keyboard.type(" más");
  await Promise.all([
    second.waitForEvent("framenavigated", { predicate: (frame) => frame === second.mainFrame() }),
    page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.postMessage("skip-waiting")),
  ]);
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


test("terminal recovery holds repeated deployments and persistent Reload survives A-B-C activation", async ({ context, page }) => {
  serving = dirs.a;
  await page.goto(`${origin}${URL_}`); await rows(page).first().waitFor({ timeout: 60_000 });
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
  });
  await page.reload(); await rows(page).first().waitFor();
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  const body = page.getByTestId("compose-body"); await body.fill("web recovery exact");
  await expect.poll(() => page.evaluate(async () => (await window.__ternoWeb!.client.call("drafts.list", {}))[0]?.bodyText)).toBe("web recovery exact");
  await page.evaluate(async () => { const c = window.__ternoWeb!.client; const d = (await c.call("drafts.list", {}))[0]!; await c.call("drafts.delete", { id: d.id, generation: d.generation }); });
  await body.click(); await body.press("ArrowRight"); await body.press("Meta+ArrowRight"); await page.keyboard.type(" latest");
  await expect(page.getByTestId("draft-save-copy")).toBeVisible();
  let navigations = 0; page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations++; });
  await page.evaluate(() => { const c = new BroadcastChannel("terno-tabs"); c.postMessage({ type: "leader", build: "different-synthetic-build" }); c.close(); });
  await expect(page.getByTestId("update-pill")).toBeVisible(); await page.getByTestId("update-pill").click();
  await expect(page.getByRole("button", { name: "Try Again", exact: true })).toBeVisible();
  expect(navigations).toBe(0); await expect(body).toHaveText("web recovery exact latest");
  serving = dirs.b;
  await page.evaluate(async () => { await (await navigator.serviceWorker.ready).update(); });
  await expect.poll(() => page.evaluate(async () => Boolean((await navigator.serviceWorker.ready).waiting))).toBe(true);
  await page.evaluate(async () => {
    const changed = new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
    (await navigator.serviceWorker.ready).waiting!.postMessage("skip-waiting"); await changed;
  });
  await expect(page.getByRole("button", { name: "Try Again", exact: true })).toBeVisible();
  expect(navigations).toBe(0); await expect(body).toHaveText("web recovery exact latest");
  serving = dirs.c;
  await page.evaluate(async () => { await (await navigator.serviceWorker.ready).update(); });
  await expect.poll(() => page.evaluate(async () => Boolean((await navigator.serviceWorker.ready).waiting))).toBe(true);
  const other = await context.newPage(); await other.goto(`${origin}/sw.js`);
  await other.evaluate(async () => (await navigator.serviceWorker.ready).waiting!.postMessage("skip-waiting"));
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toContain("sw.js");
  await expect.poll(() => page.evaluate(async () => Boolean((await navigator.serviceWorker.ready).waiting))).toBe(false);
  expect(navigations).toBe(0); await expect(body).toHaveText("web recovery exact latest");
  await other.close();
  await page.getByTestId("draft-save-copy").click(); await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
  await Promise.all([page.waitForEvent("framenavigated", { predicate: (frame) => frame === page.mainFrame(), timeout: 5000 }), page.getByTestId("update-pill").click()]);
  await rows(page).first().waitFor();
  await page.getByTestId("strip-item").first().click(); await expect(body).toHaveText("web recovery exact latest");
});


test("recovery holds storage switching and mailbox handover while the current worker remains usable", async ({ page }) => {
  serving = dirs.a; await page.goto(`${origin}${URL_}`); await rows(page).first().waitFor({ timeout: 60_000 });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); await page.keyboard.press("c");
  const body = page.getByTestId("compose-body"); await body.fill("handover recovery exact");
  await expect.poll(() => page.evaluate(async () => (await window.__ternoWeb!.client.call("drafts.list", {}))[0]?.bodyText)).toBe("handover recovery exact");
  await page.evaluate(async () => { const c = window.__ternoWeb!.client; const d = (await c.call("drafts.list", {}))[0]!; await c.call("drafts.delete", { id: d.id, generation: d.generation }); });
  await body.click(); await body.press("ArrowRight"); await body.press("Meta+ArrowRight"); await page.keyboard.type(" latest"); await expect(page.getByTestId("draft-save-copy")).toBeVisible();
  let navigations = 0; page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations++; });
  await page.evaluate(() => { const c = new BroadcastChannel("terno-tabs"); c.postMessage({ type: "takeover", from: "synthetic-requesting-tab" }); c.close(); });
  await expect(page.getByTestId("snack-message")).toContainText("Save or discard your unsaved drafts before opening this mailbox in another tab.");
  await expect(page.getByTestId("web-taken")).toHaveCount(0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); await page.keyboard.press("Meta+k");
  await page.getByTestId("palette-input").fill("settings data"); await page.keyboard.press("Enter");
  await page.getByRole("combobox", { name: "Engine" }).click(); await page.getByTestId("storage-engine-idb").click();
  await page.getByTestId("storage-switch-dialog-confirm").click();
  await expect(page.getByTestId("snack-message")).toContainText("Save or discard your unsaved drafts before switching storage. Your work is still here.");
  expect(navigations).toBe(0); expect(await page.evaluate(() => window.__ternoWeb!.storage)).toBe("opfs-sqlite");
  await page.keyboard.press("Escape"); await expect(body).toHaveText("handover recovery exact latest");
  await page.getByTestId("draft-save-copy").click(); await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
  expect((await page.evaluate(() => window.__ternoWeb!.client.call("drafts.list", {})))[0]!.bodyText).toBe("handover recovery exact latest");
});

test("slow storage export cannot commit an earlier snapshot over later recovery", async ({ page }) => {
  serving = dirs.a; await page.goto(`${origin}${URL_}`); await rows(page).first().waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  const body = page.getByTestId("compose-body"); await body.fill("storage exact");
  await body.press("Meta+a"); await body.press("Meta+b"); await body.press("ArrowRight");
  await page.getByTestId("compose-to").fill('"Pérez, Ana" <ana@example.test>, bob@');
  await page.getByTestId("attachment-input").setInputFiles({ name: "carry.bin", mimeType: "application/octet-stream", buffer: Buffer.from([0, 255, 128]) });
  await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
  await page.evaluate(() => {
    const client = window.__ternoWeb!.client, call = client.call.bind(client);
    Object.defineProperty(client, "call", { value: (method: string, params: unknown) => {
      const result = call(method as "app.export", params as Record<string, never>);
      if (method !== "app.export") return result;
      return result.then((dump) => new Promise((resolve) => { Object.assign(window, { exportCalls: (Reflect.get(window, "exportCalls") ?? 0) + 1, releaseExport: () => resolve(dump) }); }));
    } });
  });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); await page.keyboard.press("Meta+k");
  await page.getByTestId("palette-input").fill("settings data"); await page.keyboard.press("Enter");
  await page.getByRole("combobox", { name: "Engine" }).click(); await page.getByTestId("storage-engine-idb").click();
  await page.getByTestId("storage-switch-dialog-confirm").click();
  await expect.poll(() => page.evaluate(() => "releaseExport" in window)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(body).toHaveText("storage exact");
  await page.evaluate(async () => { const c = window.__ternoWeb!.client, d = (await c.call("drafts.list", {}))[0]!; await c.call("drafts.delete", { id: d.id, generation: d.generation }); });
  await page.evaluate("window.__terno.setComposerCaret(0)");
  await page.keyboard.type(" latest"); await expect(body).toHaveText("storage exact latest");
  await expect(page.getByTestId("draft-save-copy")).toBeVisible();
  const originalPin = await page.evaluate(() => localStorage.getItem("terno:storage:terno"));
  let navigations = 0; page.on("framenavigated", (f) => { if (f === page.mainFrame()) navigations++; });
  await page.evaluate(() => Reflect.get(window, "releaseExport")());
  await expect(page.getByTestId("snack-message")).toContainText("Save or discard your unsaved drafts before switching storage");
  expect(navigations).toBe(0);
  expect(await page.evaluate(() => sessionStorage.getItem("terno:carry"))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("terno:storage:terno"))).toBe(originalPin);
  await expect(body).toHaveText("storage exact latest");
  await page.getByTestId("draft-save-copy").click(); await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
  const latest = await page.evaluate(async () => (await window.__ternoWeb!.client.call("drafts.list", {}))[0]!);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); await page.keyboard.press("Meta+k");
  await page.getByTestId("palette-input").fill("settings data"); await page.keyboard.press("Enter");
  await page.getByRole("combobox", { name: "Engine" }).click(); await page.getByTestId("storage-engine-idb").click();
  await page.getByTestId("storage-switch-dialog-confirm").click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "exportCalls"))).toBe(2);
  await Promise.all([page.waitForEvent("framenavigated", { predicate: (f) => f === page.mainFrame() }), page.evaluate(() => Reflect.get(window, "releaseExport")())]);
  await rows(page).first().waitFor();
  expect(await page.evaluate(() => window.__ternoWeb!.storage)).toBe("idb");
  const copied = await page.evaluate(async () => (await window.__ternoWeb!.client.call("drafts.list", {}))[0]!);
  expect(copied).toMatchObject({ bodyText: "storage exact latest", bodyHtml: latest.bodyHtml, to: latest.to, subject: latest.subject });
  expect(copied.bodyHtml).toContain("<b>"); expect(copied.to.map((a) => a.email)).toContain("bob@");
  expect(copied.attachments).toHaveLength(1);
  expect(await page.evaluate(async (d) => window.__ternoWeb!.client.call("attachments.read", { accountId: d.accountId, assetId: d.attachments![0]!.assetId, index: 0 }), copied)).toEqual({ dataBase64: "AP+A" });
});

for (const accepted of ["upload", "composition"] as const) test(`accepted ${accepted} holds deployment reload and mailbox takeover until its exact work settles`, async ({ page }) => {
  serving = dirs.a; await page.goto(`${origin}${URL_}`); await rows(page).first().waitFor({ timeout: 60_000 });
  await page.evaluate(async () => { await navigator.serviceWorker.ready; if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r, { once: true })); });
  await page.reload(); await rows(page).first().waitFor();
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  const body = page.getByTestId("compose-body"); await body.fill("accepted exact work");
  await body.press("Meta+a"); await body.press("Meta+b"); await body.press("ArrowRight");
  await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
  if (accepted === "upload") {
    await page.evaluate(() => {
      const c = window.__ternoWeb!.client, call = c.call.bind(c);
      Object.defineProperty(c, "call", { value: (m: string, p: unknown) => {
        const result = call(m as "attachments.seal", p as { accountId: number; assetId: string });
        return m === "attachments.seal" ? result.then((sealed) => new Promise((resolve) => Object.assign(window, { finishSeal: () => resolve(sealed) }))) : result;
      } });
    });
    await page.getByTestId("attachment-input").setInputFiles({ name: "accepted.bin", mimeType: "application/octet-stream", buffer: Buffer.from([0, 255, 128]) });
    await expect.poll(() => page.evaluate(() => "finishSeal" in window)).toBe(true);
  } else await body.dispatchEvent("compositionstart", { data: "pending" });
  let navigations = 0; page.on("framenavigated", (f) => { if (f === page.mainFrame()) navigations++; });
  await page.evaluate(() => { const c = new BroadcastChannel("terno-tabs"); c.postMessage({ type: "leader", build: "synthetic-different" }); c.close(); });
  await page.getByTestId("update-pill").click(); await expect(page.getByRole("button", { name: "Try Again", exact: true })).toBeVisible();
  serving = dirs.b; await page.evaluate(async () => { await (await navigator.serviceWorker.ready).update(); });
  await expect.poll(() => page.evaluate(async () => Boolean((await navigator.serviceWorker.ready).waiting))).toBe(true);
  await page.evaluate(async () => { const changed = new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r, { once: true })); (await navigator.serviceWorker.ready).waiting!.postMessage("skip-waiting"); await changed; });
  await expect(page.getByRole("button", { name: "Try Again", exact: true })).toBeVisible();
  await page.evaluate(() => { const c = new BroadcastChannel("terno-tabs"); c.postMessage({ type: "takeover", from: "pending-work-tab" }); c.close(); });
  await expect(page.getByTestId("snack-message")).toContainText("before opening this mailbox in another tab");
  expect(navigations).toBe(0); await expect(page.getByTestId("web-taken")).toHaveCount(0);
  if (accepted === "upload") await page.evaluate(() => Reflect.get(window, "finishSeal")());
  else await body.dispatchEvent("compositionend", { data: "" });
  await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
  if (accepted === "upload") await expect(page.getByTestId("draft-attachment")).toContainText("accepted.bin");
  await Promise.all([page.waitForEvent("framenavigated", { predicate: (f) => f === page.mainFrame() }), page.getByTestId("update-pill").click()]);
  await rows(page).first().waitFor();
  const d = (await page.evaluate(() => window.__ternoWeb!.client.call("drafts.list", {})))[0]!;
  expect(d).toMatchObject({ bodyText: "accepted exact work" }); expect(d.bodyHtml).toContain("<b>");
  if (accepted === "upload") expect(await page.evaluate(async (d) => window.__ternoWeb!.client.call("attachments.read", { accountId: d.accountId, assetId: d.attachments![0]!.assetId, index: 0 }), d)).toEqual({ dataBase64: "AP+A" });
});
