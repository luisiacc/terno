import AxeBuilder from "@axe-core/playwright";
import type { IncomingMessage } from "@terno/store";
import { E2E_NOW } from "./constants";
import { expect, selectThread, stabilize, test, type DevServerFixture } from "./fixtures";

const ctx = { clientId: "setup", origin: "dev" as const };

async function ingestCode(server: DevServerFixture, o: { id: string; subject: string; ageMs: number }): Promise<number> {
  const [account] = await server.backend.store.accounts.list();
  // the page's clock is frozen at E2E_NOW
  const now = E2E_NOW;
  const html = `<div style="font-family:sans-serif"><p>Hi,</p><p>Use this code to finish signing in:</p><table><tr><td style="font-size:28px;font-weight:600;letter-spacing:4px">048291</td></tr></table><p>It expires in 10 minutes. If you didn’t ask for it, ignore this email.</p></div>`;
  const incoming: IncomingMessage = {
    accountId: account!.id, providerMsgId: o.id, providerThreadId: null, rfcMessageId: `${o.id}@acme.test`, inReplyTo: null, references: [],
    from: { name: "Acme", email: "no-reply@acme.test" }, replyTo: [], to: [{ name: "Me", email: account!.email }], cc: [], bcc: [],
    subject: o.subject, date: now - o.ageMs, snippet: "Use this code to finish signing in: 048291", bodyText: null, bodyHtml: html, bodyState: "full", listId: null,
    isRead: false, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 1000,
  };
  const { touched } = await server.backend.store.sync.ingest([incoming], { applyFilters: false, now, classifier: null });
  return touched[0]!;
}

for (const theme of ["light", "dark"] as const) {
  test(`a fresh verification code copies from its chip (${theme})`, { tag: "@design" }, async ({ app: page, server, context }, testInfo) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const id = await ingestCode(server, { id: `code-${theme}`, subject: "Your Acme sign-in code", ageMs: 5 * 60_000 });
    await server.backend.server.invoke("settings.update", { theme }, ctx);
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await selectThread(page, id, 'subject:"Acme sign-in code"');
    const chip = page.getByTestId("message-code");
    await expect(chip).toHaveText("048291");
    await expect(chip).toHaveAccessibleName("Copy verification code 048291");
    await stabilize(page);
    const reader = page.getByTestId("reader");
    await reader.screenshot({ path: testInfo.outputPath(`code-fresh-${theme}.png`) });
    const axe = await new AxeBuilder({ page }).include("[data-testid=message-code]").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(axe.violations.map((v) => v.id)).toEqual([]);

    await chip.click();
    await page.mouse.move(0, 0);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("048291");
    await expect(chip).toHaveAttribute("data-copied", "true");
    await expect(page.getByText("Copied", { exact: true })).toBeAttached();
    await reader.screenshot({ path: testInfo.outputPath(`code-copied-${theme}.png`) });

    // five seconds later: the copy icon is back and the chip is outlined
    await expect(chip).not.toHaveAttribute("data-copied", "true", { timeout: 8000 });
    await expect(chip).toHaveAttribute("data-used", "true");
    expect(await chip.evaluate((el) => getComputedStyle(el).backgroundColor)).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    await reader.screenshot({ path: testInfo.outputPath(`code-used-${theme}.png`) });
    const outlined = await new AxeBuilder({ page }).include("[data-testid=message-code]").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(outlined.violations.map((v) => v.id)).toEqual([]);
  });
}

test("a code older than two hours is not offered", async ({ app: page, server }) => {
  const id = await ingestCode(server, { id: "code-old", subject: "Your old Acme code", ageMs: 3 * 3_600_000 });
  await selectThread(page, id, 'subject:"old Acme code"');
  await expect(page.getByTestId("message")).toBeVisible();
  await expect(page.getByTestId("message-code")).toHaveCount(0);
});

test("the chip copies from the keyboard", async ({ app: page, server, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const id = await ingestCode(server, { id: "code-keys", subject: "Your Acme keyboard code", ageMs: 60_000 });
  await selectThread(page, id, 'subject:"Acme keyboard code"');
  const chip = page.getByTestId("message-code");
  await chip.focus();
  await page.keyboard.press("Enter");
  await expect(chip).toHaveAttribute("data-copied", "true");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("048291");
});
