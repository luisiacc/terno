import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { startDevServer, type DevServer } from "../../backend-dev/src/server";
import { E2E_NOW, TEMPLATE_ENV } from "./constants";

export { expect };

interface Fixtures {
  /** freeze Date for deterministic list dates (off for perf: the fake clock coarsens performance.now) */
  fixedClock: boolean;
  /** backend-dev knobs: a fresh install with no mailbox, and owner claims through the demo registry */
  backendOptions: { empty?: boolean; ownerClaims?: boolean };
  server: DevServer;
  /** the app, loaded, connected and showing the inbox */
  app: Page;
}

export const test = base.extend<Fixtures>({
  fixedClock: [true, { option: true }],
  backendOptions: [{}, { option: true }],
  server: async ({ backendOptions }, use) => {
    const template = process.env[TEMPLATE_ENV];
    if (!template) throw new Error("global setup did not seed a template database");
    const dir = mkdtempSync(join(tmpdir(), "unica-e2e-"));
    if (!backendOptions.empty) copyFileSync(template, join(dir, "unica.db"));
    const server = await startDevServer({ port: 0, dataDir: dir, token: "e2e", now: () => E2E_NOW, autoSync: true, seed: !backendOptions.empty, ownerClaims: backendOptions.ownerClaims });
    await use(server);
    // Backend.stop() doesn't wait for an in-flight ops batch; let it settle first.
    const b = server.backend as unknown as { workerRunning: boolean };
    for (let i = 0; i < 100 && b.workerRunning; i++) await new Promise((r) => setTimeout(r, 20));
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  },
  app: async ({ page, server, fixedClock, backendOptions }, use) => {
    if (fixedClock) await page.clock.setFixedTime(new Date(E2E_NOW));
    await page.goto(`/?backend=${encodeURIComponent(server.url)}&token=e2e`);
    await page.locator("[data-ready]").waitFor();
    if (!backendOptions.empty) await rows(page).first().waitFor();
    await use(page);
  },
});

export const rows = (page: Page): Locator => page.getByTestId("thread-row");
export const selectedRow = (page: Page): Locator => page.locator("[data-testid=thread-row][aria-selected=true]");

export const rowSubject = (row: Locator): Locator => row.getByTestId("row-subject");
export const rowFrom = (row: Locator): Locator => row.getByTestId("row-from");

export async function selectedId(page: Page): Promise<string | null> {
  return selectedRow(page).getAttribute("data-thread-id");
}

/** Waits until the reader shows the currently selected thread. */
export async function readerSubject(page: Page): Promise<string> {
  const subject = page.getByTestId("reader-subject");
  await subject.waitFor();
  return (await subject.textContent()) ?? "";
}

/** Clicks a row by index and waits for the reader. */
export async function openRow(page: Page, index: number): Promise<string> {
  const row = rows(page).nth(index);
  const id = (await row.getAttribute("data-thread-id"))!;
  await row.dispatchEvent("mousedown");
  await expect(selectedRow(page)).toHaveAttribute("data-thread-id", id);
  await readerSubject(page);
  return id;
}

/** Puts focus on the document body so single-key shortcuts apply. */
export async function focusList(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

export async function search(page: Page, query: string): Promise<void> {
  const input = page.getByTestId("search-input");
  await input.fill(query);
  await expect(page.getByTestId("search-stats")).toBeVisible();
}

/** Brings a specific thread to the top of the list via search and selects it. */
export async function selectThread(page: Page, threadId: number, query: string): Promise<void> {
  await search(page, query);
  const row = page.locator(`[data-testid=thread-row][data-thread-id="${threadId}"]`);
  await row.dispatchEvent("mousedown");
  await expect(row).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("reader-subject")).toBeVisible();
  await focusList(page);
}

/** Visual tests: hide transient toasts and park the mouse so nothing hovers. */
export async function stabilize(page: Page): Promise<void> {
  await page.addStyleTag({ content: "[data-sonner-toaster]{display:none!important} *{caret-color:transparent!important}" });
  await page.mouse.move(0, 0);
}
