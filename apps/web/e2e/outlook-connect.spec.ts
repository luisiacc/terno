/**
 * Plan 259: an Outlook account in the window, against a synthetic Microsoft (sign-in, token and Graph): added from Add
 * account (a refused consent first, said in the form), named Outlook in Settings, its mail synced into the Inbox and
 * its folders under it, a message filed into a folder and back with Undo, one archived and one read, a reply that lands
 * in Sent Items (stage 2b), signed in again from its row once Microsoft stops honouring its sign-in, and removed with the
 * way to withdraw Terno's access at Microsoft.
 */
import type { Locator, Page } from "@playwright/test";
import { sqlDb } from "../../backend-dev/src/server";
import { axeBothModes, expect, respond, scenario, test } from "./fixtures";

test.use({ backendOptions: { microsoft: true } });

async function center(l: Locator) {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** a row dragged onto a sidebar folder and dropped (plan 127's gesture), with the list in and the sidebar at rest */
async function dropOn(page: Page, row: Locator, target: Locator) {
  await expect(page.locator("[data-testid=thread-list] [aria-busy=true]")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter((x) => x.playState === "running" && ((x.effect as KeyframeEffect | null)?.target as Element | null)?.closest?.("#app-sidebar")).length)).toBe(0);
  const from = await center(row);
  const to = await center(target);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 6, from.y + 2, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await expect(target).toHaveAttribute("data-drop-state", "over");
  await page.mouse.up();
}

test("plan 259: add an Outlook account, use its mail over Graph, sign in again and remove it", async ({ app: page, server }) => {
  const microsoft = server.microsoft!;
  const ms = microsoft.ms;
  ms.personal("ana@outlook.com");
  // the mailbox before it's connected: two messages in the Inbox and a folder of the person's own
  const projects = ms.folder("Projects");
  const report = ms.deliver("inbox-id", { subject: "Quarterly report", from: "bo@fabrikam.test", body: "The numbers are in." });
  const lunch = ms.deliver("inbox-id", { subject: "Lunch on Friday", from: "cy@fabrikam.test" });
  const dialog = page.getByTestId("add-account-dialog");
  const row = page.getByTestId("settings-account").filter({ hasText: "ana@outlook.com" });
  const accountId = async () => (await server.backend.store.accounts.list()).find((a) => a.email === "ana@outlook.com")!.id;
  const threadRow = (subject: string) => page.locator("[data-testid=thread-row]").filter({ hasText: subject });

  await scenario("Add account offers Microsoft beside Google, and an Outlook.com address typed for IMAP points to it", async () => {
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-accounts").click();
    await page.getByTestId("settings-add-account").click();
    await expect(dialog.getByTestId("connect-microsoft")).toHaveText("Continue with Microsoft");
    const google = await dialog.getByTestId("connect-gmail").boundingBox();
    const box = await dialog.getByTestId("connect-microsoft").boundingBox();
    // stacked under Google's, the same size and edges
    expect(box!.x).toBe(google!.x);
    expect(box!.y).toBeGreaterThan(google!.y);
    expect([box!.width, box!.height]).toEqual([google!.width, google!.height]);
    await dialog.getByTestId("imap-email").fill("ana@outlook.com");
    await expect(dialog.getByTestId("imap-microsoft-hint")).toHaveText("outlook.com no longer takes passwords from other apps. Continue with Microsoft");
    await axeBothModes(page, "[data-testid=add-account-dialog]");
  });

  await scenario("a refused consent is said under the buttons; the form keeps what was typed", async () => {
    microsoft.behaviour = "deny";
    await dialog.getByTestId("connect-microsoft").click();
    await expect(dialog.getByTestId("add-account-error")).toHaveText("Microsoft access was denied.");
    await expect(dialog.getByTestId("imap-email")).toHaveValue("ana@outlook.com");
  });

  await scenario("approved, the account is added and named Outlook in Settings", async () => {
    microsoft.behaviour = "approve";
    await dialog.getByTestId("imap-microsoft-connect").click();
    await expect(page.getByTestId("snack-message").getByText("ana@outlook.com")).toBeVisible();
    await expect(dialog).toHaveCount(0);
    // Add account took Settings' place; back there, the new row
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-accounts").click();
    await expect(row.getByTestId("account-toggle")).toContainText("ana@outlook.com · Outlook");
    const added = (await server.backend.store.accounts.list()).find((a) => a.email === "ana@outlook.com")!;
    expect(added.kind).toBe("outlook");
    expect(ms.authorizations.at(-1)!.get("prompt")).toBe("select_account");
    await page.keyboard.press("Escape");
  });

  await scenario("stage 2b: its mail syncs into its Inbox over Graph, and its own folder shows under it", async () => {
    const id = await accountId();
    await server.backend.syncAccount(id);
    await page.getByTestId(`nav-account-${id}`).dblclick();
    await page.getByTestId(`nav-folder-${id}-inbox`).click();
    await expect(threadRow("Quarterly report")).toBeVisible();
    await expect(threadRow("Lunch on Friday")).toBeVisible();
    await expect(page.getByTestId(`nav-own-${id}-${projects}`)).toBeVisible();
  });

  await scenario("stage 2b: a message dropped on the folder moves there on Graph, and z takes it back to the Inbox", async () => {
    const id = await accountId();
    await dropOn(page, threadRow("Lunch on Friday"), page.getByTestId(`nav-own-${id}-${projects}`));
    await expect(threadRow("Lunch on Friday")).toHaveCount(0);
    await expect(page.getByTestId("snack-message")).toContainText("Moved to");
    await expect.poll(() => ms.messages.get(lunch)!.folder).toBe(projects);
    // the move's answer is what's stored: the folder the message is in now
    const folderOf = () => sqlDb(server.backend.store).get<{ folder: string }>("SELECT f.folder FROM message_folders f JOIN messages m ON m.id = f.message_id WHERE m.provider_msg_id = ?", lunch)?.folder ?? null;
    await expect.poll(folderOf).toBe(projects);
    await page.keyboard.press("z");
    await expect(threadRow("Lunch on Friday")).toBeVisible();
    await expect.poll(() => ms.messages.get(lunch)!.folder).toBe("inbox-id");
    await expect.poll(folderOf).toBeNull();
  });

  await scenario("stage 2b: opened, a message is read on Graph; archived, it goes to Graph's Archive", async () => {
    await threadRow("Quarterly report").dispatchEvent("mousedown");
    await expect(page.getByTestId("reader-subject")).toHaveText("Quarterly report");
    await expect.poll(() => ms.messages.get(report)!.isRead).toBe(true);
    await respond(page, "reply");
    await page.getByTestId("compose-body").fill("Thanks, Bo.");
    await page.getByTestId("compose-send").click();
    // the reply goes through sendMail and lands in Sent Items, where the next read finds it as the one Terno sent
    await expect.poll(() => ms.sent.length, { timeout: 15_000 }).toBe(1);
    expect(ms.sent[0]!.mime).toMatch(/^To: .*bo@fabrikam\.test/m);
    expect(ms.inFolder("sentitems")).toHaveLength(1);
    const id = await accountId();
    await server.backend.syncAccount(id);
    const own = () => sqlDb(server.backend.store).all<{ provider_msg_id: string }>("SELECT provider_msg_id FROM messages WHERE account_id = ? AND is_sent = 1", id).map((r) => r.provider_msg_id);
    await expect.poll(own).toEqual([ms.inFolder("sentitems")[0]!.id]);
    await threadRow("Quarterly report").dispatchEvent("mousedown");
    await page.getByTestId("action-archive").click();
    await expect(threadRow("Quarterly report")).toHaveCount(0);
    await expect.poll(() => ms.messages.get(report)!.folder).toBe("archive-id");
  });

  await scenario("Microsoft stops honouring its sign-in: its row asks, and Continue with Microsoft clears it", async () => {
    const id = await accountId();
    ms.revoke();
    await server.backend.syncAccount(id);
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-accounts").click();
    await expect(row.getByTestId("account-toggle")).toContainText("Needs you to sign in again");
    await row.getByTestId("account-row-sign-in").click();
    const popover = page.getByTestId("sign-in-popover");
    await expect(popover.getByTestId("sign-in-microsoft")).toHaveText("Continue with Microsoft");
    await popover.getByTestId("sign-in-microsoft").click();
    await expect(page.getByTestId("snack-message").getByText("ana@outlook.com is connected again")).toBeVisible();
    // signing in again names the account to Microsoft instead of asking which one
    expect(ms.authorizations.at(-1)!.get("login_hint")).toBe("ana@outlook.com");
    await expect(row.getByTestId("account-row-sign-in")).toHaveCount(0);
    await expect.poll(async () => (await server.backend.store.accounts.get(id))!.syncState).toMatchObject({ authRequired: false });
  });

  await scenario("removing it says Terno can't withdraw its access at Microsoft, and where to", async () => {
    await row.getByTestId("account-toggle").click();
    await row.getByTestId("account-remove").click();
    const remove = page.getByTestId("account-remove-dialog");
    await expect(remove).toContainText("Terno can’t withdraw its own access at Microsoft");
    await expect(remove.getByRole("button", { name: "Personal account" })).toBeVisible();
    await expect(remove.getByRole("button", { name: "Work or school account" })).toBeVisible();
    await expect(remove.getByRole("button", { name: "Cancel" })).toBeFocused();
    await axeBothModes(page, "[data-testid=account-remove-dialog]");
    await page.getByTestId("account-remove-dialog-confirm").click();
    await expect(page.getByTestId("snack-message").getByText("Account removed")).toBeVisible();
    await expect(row).toHaveCount(0);
    expect((await server.backend.store.accounts.list()).some((a) => a.email === "ana@outlook.com")).toBe(false);
  });
});
