/**
 * Plan 78 in the web build: local mode (the default) offers Send for a
 * problem, nothing leaves until the user clicks it, and what leaves is the
 * report "What gets sent" showed, to the build's DSN only. The DSN points at
 * reports.invalid, routed here: the test sees every request the page makes.
 */
import { expect, test, type Page, type Request } from "@playwright/test";

const DEMO = "/?demo=200";
const INGEST = "https://reports.invalid/api/7/envelope/";

async function boot(page: Page) {
  await page.goto(DEMO);
  await page.getByTestId("thread-row").first().waitFor({ timeout: 60_000 });
}

/** A tab that died without a goodbye: the next start reports it. */
async function deadTab(page: Page) {
  await page.evaluate(() =>
    localStorage.setItem("terno:diag:tab:dead-tab", JSON.stringify({ session: "deadbeefdeadbeefdeadbeefdeadbeef", version: "0.1.0", build: "0.1.0+test", crumbs: [{ ts: Date.now() - 5000, cat: "nav", code: "nav.thread", level: "info", fields: { threadId: 7 } }] })),
  );
  await page.reload();
  await page.getByTestId("thread-row").first().waitFor({ timeout: 60_000 });
}

function ingest(page: Page, status: () => number) {
  const sent: Request[] = [];
  const elsewhere: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("reports.invalid") && !r.url().startsWith(INGEST)) elsewhere.push(r.url());
  });
  void page.route("https://reports.invalid/**", async (route) => {
    sent.push(route.request());
    await route.fulfill({ status: status(), body: "{}", headers: { "access-control-allow-origin": "*", "content-type": "application/json" } });
  });
  return { sent, elsewhere };
}

test("local mode offers Send; nothing leaves before the click, and what leaves is the preview", async ({ page }) => {
  const net = ingest(page, () => 200);
  await boot(page);
  // a new install starts in local mode
  await page.getByTestId("open-settings").click();
  await page.getByTestId("tab-general").click();
  await expect(page.getByTestId("local-mode-switch")).toBeChecked();
  await page.keyboard.press("Escape");
  await deadTab(page);
  const row = page.getByTestId("report-row");
  await expect(row).toHaveAttribute("data-offer", "ask");
  await expect(page.getByTestId("report-send")).toHaveText("Send");
  await expect(page.getByTestId("report-export")).toHaveCount(0);
  expect(net.sent).toHaveLength(0);

  await page.getByTestId("report-preview").click();
  await expect(page.getByTestId("report-preview-dialog")).toContainText("reports.invalid");
  const shown = JSON.parse((await page.getByTestId("report-preview-json").textContent()) ?? "{}");
  await page.getByTestId("report-preview-close").click();
  expect(net.sent).toHaveLength(0);

  await page.getByTestId("report-send").click();
  await expect(page.getByTestId("snack-message")).toHaveText("Report sent. Thank you.");
  await expect(row).toHaveCount(0);
  expect(net.sent).toHaveLength(1);
  const req = net.sent[0]!;
  expect(req.method()).toBe("POST");
  expect(req.url()).toMatch(new RegExp(`^${INGEST.replace(/[.?/]/g, "\\$&")}\\?sentry_version=7&sentry_key=testkey&sentry_client=terno%2F`));
  // a simple request: no cookie, no referrer
  const headers = await req.allHeaders();
  expect(headers.cookie).toBeUndefined();
  expect(headers.referer).toBeUndefined();
  const lines = (req.postData() ?? "").trim().split("\n");
  expect(JSON.parse(lines[1]!)).toMatchObject({ type: "event" });
  expect(JSON.parse(lines[2]!)).toEqual(shown);
  expect(net.elsewhere).toEqual([]);

  // sent for good: a reload neither shows it nor sends it again
  await page.reload();
  await page.getByTestId("thread-row").first().waitFor({ timeout: 60_000 });
  await expect(page.getByTestId("report-row")).toHaveCount(0);
  expect(net.sent).toHaveLength(1);
});

test("a report that couldn't go stays, with Send to try again", async ({ page }) => {
  let status = 503;
  const net = ingest(page, () => status);
  await boot(page);
  await deadTab(page);
  await page.getByTestId("report-send").click();
  await expect(page.getByTestId("snack-message")).toHaveText("The report couldn’t be sent. It’s still saved on this computer.");
  await expect(page.getByTestId("report-row")).toHaveAttribute("data-offer", "ask");
  status = 200;
  await page.getByTestId("report-send").click();
  await expect(page.getByTestId("report-row")).toHaveCount(0);
  expect(net.sent).toHaveLength(2);
});

test("Settings: the choice is open in local mode; Never keeps reports here", async ({ page }) => {
  const net = ingest(page, () => 200);
  await boot(page);
  await page.getByTestId("open-settings").click();
  await page.getByTestId("tab-general").click();
  await page.getByTestId("diagnostics-section").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("local-mode-switch")).toBeChecked();
  const select = page.getByTestId("error-reports-select");
  await expect(select).toBeEnabled();
  await expect(page.getByTestId("error-reports-row")).toContainText("Terno asks before sending each one.");
  await select.click();
  await page.getByTestId("error-reports-never").click();
  await expect(page.getByTestId("error-reports-row")).toContainText("Never sent.");
  await page.keyboard.press("Escape");
  await deadTab(page);
  await expect(page.getByTestId("report-row")).toHaveAttribute("data-offer", "local");
  await expect(page.getByTestId("report-export")).toBeVisible();
  expect(net.sent).toHaveLength(0);
});

test("Always: an ordinary error that couldn't go keeps a row with Send (review finding 2)", async ({ page }) => {
  let status = 503;
  const net = ingest(page, () => status);
  await boot(page);
  await page.getByTestId("open-settings").click();
  await page.getByTestId("tab-general").click();
  await page.getByTestId("diagnostics-section").scrollIntoViewIfNeeded();
  await page.getByTestId("error-reports-select").click();
  await page.getByTestId("error-reports-always").click();
  await expect(page.getByTestId("error-reports-row")).toContainText("Sent automatically");
  await page.keyboard.press("Escape");
  await page.getByTestId("thread-row").first().dispatchEvent("mousedown");
  await page.evaluate(() => (window as unknown as { __terno: { throwIn(a: string): void } }).__terno.throwIn("reader"));
  await expect(page.getByTestId("reader-boundary")).toBeVisible();
  // sent automatically, refused by the ingest: the row says so and offers Send
  await expect.poll(() => net.sent.length).toBe(1);
  const row = page.getByTestId("report-row");
  await expect(row).toHaveAttribute("data-offer", "retry");
  await expect(row).toContainText("The report couldn’t be sent yet.");
  status = 200;
  await page.getByTestId("report-send").click();
  await expect(page.getByTestId("snack-message")).toHaveText("Report sent. Thank you.");
  await expect(row).toHaveCount(0);
  expect(net.sent).toHaveLength(2);
});
