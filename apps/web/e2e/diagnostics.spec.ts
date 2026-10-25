/**
 * Plan 10 in the renderer (the local host: no desktop shell, no DSN): a
 * broken pane stays a pane, an unclean exit shows the quiet row on the next
 * start, and neither "What gets sent" nor the export carries anything of the
 * mailbox (no fixture subject or address, checked on the decoded files).
 */
import type { Page } from "@playwright/test";
import { expect, openRow, rows, test } from "./fixtures";

/** The subjects and senders on screen, the strings that must never leave. */
async function fixtureStrings(page: Page): Promise<string[]> {
  const out = new Set<string>();
  for (const row of await rows(page).all()) {
    const subject = (await row.getByTestId("row-subject").textContent())?.trim();
    const from = (await row.getByTestId("row-from").textContent())?.trim();
    if (subject && subject.length > 4) out.add(subject);
    if (from && from.length > 3) out.add(from);
  }
  return [...out];
}

const throwIn = (page: Page, area: "app" | "reader" | "settings") => page.evaluate((a) => (window as unknown as { __terno: { throwIn(a: string): void } }).__terno.throwIn(a), area);

test.describe("diagnostics", () => {
  test("a reader that throws is that pane only; another thread brings it back", async ({ app: page }) => {
    await openRow(page, 0);
    await throwIn(page, "reader");
    await expect(page.getByTestId("reader-boundary")).toBeVisible();
    await expect(page.getByTestId("reader-boundary")).toContainText("This conversation couldn't be shown");
    // the list still works
    await expect(rows(page).first()).toBeVisible();
    await page.getByTestId("reader-boundary-retry").click();
    await expect(page.getByTestId("reader-subject")).toBeVisible();
  });

  test("a settings section that throws keeps the sheet; the whole window gets a calm reload screen", async ({ app: page }) => {
    await page.getByTestId("open-settings").click();
    await throwIn(page, "settings");
    await expect(page.getByTestId("settings-boundary")).toBeVisible();
    await expect(page.getByTestId("tab-appearance")).toBeVisible();
    await page.getByTestId("tab-appearance").click();
    await expect(page.getByTestId("settings-boundary")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await throwIn(page, "app");
    await expect(page.getByTestId("app-boundary")).toBeVisible();
    await expect(page.getByTestId("app-boundary")).toContainText("Something went wrong");
    await expect(page.getByTestId("app-boundary-reload")).toBeVisible();
    await expect(page.getByTestId("app-boundary-export")).toBeVisible();
  });

  test("an unclean exit shows the row on the next start; its report carries no mail", async ({ app: page }) => {
    const never = await fixtureStrings(page);
    expect(never.length).toBeGreaterThan(5);
    // a tab that died without a goodbye: its marker stays, nobody holds its lock
    await page.evaluate(() =>
      localStorage.setItem(
        "terno:diag:tab:dead-tab",
        JSON.stringify({ session: "deadbeefdeadbeefdeadbeefdeadbeef", version: "0.1.0", build: "0.1.0+test", crumbs: [{ ts: Date.now() - 5000, cat: "nav", code: "nav.thread", level: "info", fields: { threadId: 7 } }] }),
      ),
    );
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    const row = page.getByTestId("report-row");
    await expect(row).toBeVisible();
    await expect(page.getByTestId("report-row-title")).toHaveText("Terno quit unexpectedly");
    // no DSN in this build: the details stay here, with an export
    await expect(row).toHaveAttribute("data-offer", "local");
    await page.getByTestId("report-preview").click();
    const json = (await page.getByTestId("report-preview-json").textContent()) ?? "";
    const event = JSON.parse(json);
    expect(event.exception.values[0]).toMatchObject({ type: "UncleanExit", value: "app.unclean_exit" });
    expect(event.breadcrumbs).toEqual([expect.objectContaining({ message: "nav.thread", data: { threadId: 7 } })]);
    for (const s of never) expect(json).not.toContain(s);
    expect(json).not.toMatch(/@[a-z0-9-]+\.[a-z]/i);
    await page.getByTestId("report-preview-close").click();
    await page.getByTestId("report-close").click();
    await expect(row).toHaveCount(0);
    // dismissed for good
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await expect(page.getByTestId("report-row")).toHaveCount(0);
  });

  test("Settings → Diagnostics: locked in local mode, a sample report and an export, none with mail in them", async ({ app: page }) => {
    // leave a trail and a record: open threads, archive one, break the reader
    for (let i = 0; i < 3; i++) await openRow(page, i);
    const never = await fixtureStrings(page);
    await throwIn(page, "reader");
    await expect(page.getByTestId("reader-boundary")).toBeVisible();

    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-general").click();
    const section = page.getByTestId("diagnostics-section");
    await section.scrollIntoViewIfNeeded();
    await expect(page.getByTestId("error-reports-select")).toBeDisabled();
    await expect(page.getByTestId("error-reports-row")).toContainText(/Local mode sends nothing|doesn't send reports/);
    await expect(page.getByTestId("build-line")).toContainText(/Terno \d+\.\d+\.\d+ · /);

    await page.getByTestId("report-sample").click();
    const sample = (await page.getByTestId("report-preview-json").textContent()) ?? "";
    expect(JSON.parse(sample).breadcrumbs.some((b: { message: string }) => b.message === "nav.thread")).toBe(true);
    for (const s of never) expect(sample).not.toContain(s);
    await page.getByTestId("report-preview-close").click();

    const download = page.waitForEvent("download");
    await page.getByTestId("export-diagnostics").click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^Terno-diagnostics-\d{4}-\d{2}-\d{2}\.json$/);
    const text = await new Response(await file.createReadStream() as unknown as ReadableStream).text();
    const exported = JSON.parse(text);
    expect(exported.records.some((r: { code: string }) => r.code === "ui.boundary")).toBe(true);
    expect(exported.entries.length).toBeGreaterThan(0);
    for (const s of never) expect(text).not.toContain(s);
    expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
  });
});
