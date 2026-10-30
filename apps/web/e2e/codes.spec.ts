import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { IncomingMessage } from "@terno/store";
import { E2E_NOW } from "./constants";
import { expect, search, stabilize, test, type DevServerFixture } from "./fixtures";

const ctx = { clientId: "setup", origin: "dev" as const };
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

async function ingestCode(server: DevServerFixture, o: { id: string; subject: string; ageMs: number; code?: string }): Promise<number> {
  const [account] = await server.backend.store.accounts.list();
  // the page's clock is frozen at E2E_NOW
  const now = E2E_NOW;
  const text = `Use this code to finish signing in: ${o.code ?? "048291"}\n\nIt expires in 10 minutes. If you didn’t ask for it, ignore this email.`;
  const incoming: IncomingMessage = {
    accountId: account!.id, providerMsgId: o.id, providerThreadId: null, rfcMessageId: `${o.id}@acme.test`, inReplyTo: null, references: [],
    from: { name: "Acme", email: "no-reply@acme.test" }, replyTo: [], to: [{ name: "Me", email: account!.email }], cc: [], bcc: [],
    subject: o.subject, date: now - o.ageMs, snippet: text.replace(/\s+/g, " "), bodyText: text, bodyHtml: null, bodyState: "full", listId: null,
    isRead: false, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 1000,
  };
  const { touched } = await server.backend.store.sync.ingest([incoming], { applyFilters: false, now, classifier: null });
  return touched[0]!;
}

const rowOf = (page: Page, id: number) => page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`);

for (const theme of ["light", "dark"] as const) {
  test(`a fresh verification code copies from its row (${theme})`, { tag: "@design" }, async ({ app: page, server, context }, testInfo) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const id = await ingestCode(server, { id: `code-${theme}`, subject: "Your Acme sign-in code", ageMs: 5 * 60_000 });
    // a second one, open, so the screenshots show a chip on a plain row and on the selected one
    const other = await ingestCode(server, { id: `code-open-${theme}`, subject: "Your Acme backup code", ageMs: 20 * 60_000, code: "731406" });
    await server.backend.server.invoke("settings.update", { theme }, ctx);
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await search(page, "Acme code");
    const row = rowOf(page, id);
    await rowOf(page, other).click();
    await expect(rowOf(page, other)).toHaveAttribute("data-cursor", "true");
    const chip = row.getByTestId("row-code");
    await expect(chip).toHaveText("048291");
    await expect(rowOf(page, other).getByTestId("row-code")).toHaveText("731406");
    // screen readers hear it in the row
    await expect(row).toContainText("Verification code 048291");
    await stabilize(page);
    const list = page.getByTestId("thread-list");
    await list.screenshot({ path: testInfo.outputPath(`code-fresh-${theme}.png`) });
    const axe = await new AxeBuilder({ page }).include("[data-testid=thread-list]").withTags(AXE_TAGS).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 120)).join(", ")}`)).toEqual([]);

    await chip.click();
    await page.mouse.move(0, 0);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("048291");
    await expect(chip).toHaveAttribute("data-copied", "true");
    // copying doesn't open the thread
    await expect(rowOf(page, other)).toHaveAttribute("data-cursor", "true");
    await expect(row).not.toHaveAttribute("data-cursor", "true");
    await list.screenshot({ path: testInfo.outputPath(`code-copied-${theme}.png`) });

    // five seconds later: the copy icon is back and the chip is outlined
    await expect(chip).not.toHaveAttribute("data-copied", "true", { timeout: 8000 });
    await expect(chip).toHaveAttribute("data-used", "true");
    expect(await chip.evaluate((el) => getComputedStyle(el).backgroundColor)).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    await list.screenshot({ path: testInfo.outputPath(`code-used-${theme}.png`) });
    const outlined = await new AxeBuilder({ page }).include("[data-testid=thread-list]").withTags(AXE_TAGS).analyze();
    expect(outlined.violations.map((v) => v.id)).toEqual([]);
  });
}

test("the thread menu copies the code too (the keyboard's way)", async ({ app: page, server, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const id = await ingestCode(server, { id: "code-menu", subject: "Your Acme menu code", ageMs: 60_000 });
  await search(page, '"Acme menu code"');
  const row = rowOf(page, id);
  await row.click({ button: "right" });
  await expect(page.getByTestId("menu-copy-code")).toHaveText("Copy verification code 048291");
  await page.getByTestId("menu-copy-code").click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("048291");
  await expect(row.getByTestId("row-code")).toHaveAttribute("data-copied", "true");
});

test("dragging from the chip doesn't drag the row", async ({ app: page, server }) => {
  const id = await ingestCode(server, { id: "code-drag", subject: "Your Acme drag code", ageMs: 60_000 });
  await search(page, '"Acme drag code"');
  const box = (await rowOf(page, id).getByTestId("row-code").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 200, box.y + 40, { steps: 8 });
  await expect(page.getByTestId("drag-ghost")).toBeHidden();
  await page.mouse.up();
});

test("a code older than two hours is not offered", async ({ app: page, server }) => {
  const id = await ingestCode(server, { id: "code-old", subject: "Your old Acme code", ageMs: 3 * 3_600_000 });
  await search(page, '"old Acme code"');
  await expect(rowOf(page, id)).toBeVisible();
  await expect(rowOf(page, id).getByTestId("row-code")).toHaveCount(0);
});

test.describe("the full-width list", () => {
  test.use({ layout: "list" });
  test("puts the code next to the sender, before the subject", async ({ app: page, server }) => {
    const id = await ingestCode(server, { id: "code-wide", subject: "Your Acme wide code", ageMs: 60_000 });
    await search(page, '"Acme wide code"');
    const row = rowOf(page, id);
    await expect(row).toHaveAttribute("data-wide", "true");
    const chip = (await row.getByTestId("row-code").boundingBox())!;
    const from = (await row.getByTestId("row-from").boundingBox())!;
    const subject = (await row.getByText("Your Acme wide code").boundingBox())!;
    expect(chip.x).toBeGreaterThan(from.x + from.width);
    expect(chip.x + chip.width).toBeLessThan(subject.x);
  });
});
