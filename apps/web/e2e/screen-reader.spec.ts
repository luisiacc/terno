import { expect } from "@playwright/test";
import { focusList, fresh, openRow, rows, scenario, selectThread, test } from "./fixtures";
import { E2E_NOW } from "./constants";

/**
 * Plan 188: what a screen reader user leans on, in the real app (one page, one backend). Focus follows the keys, F6
 * moves between panes, keys stay with the control they're pressed on, single keys can be turned off, rows and the
 * sidebar say what they show, and Undo send says how long there is.
 */
const active = (page: import("@playwright/test").Page) => page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null;
  return { testId: el?.dataset.testid ?? null, role: el?.getAttribute("role") ?? null, inSidebar: !!el?.closest("#app-sidebar") };
});

test("a screen reader's ways around the app (plan 188)", async ({ app: page, server }) => {
  await scenario("j from a sidebar row brings focus to the list; a row says its state right after who it's from", async () => {
    await page.getByTestId("nav-inbox").focus();
    await page.keyboard.press("j");
    await expect.poll(async () => (await active(page)).role).toBe("listbox");
    const list = page.getByRole("listbox", { name: "Conversations" });
    await expect(list).toHaveAttribute("aria-activedescendant", /^thread-/);
    const option = page.locator(`#${await list.getAttribute("aria-activedescendant")}`);
    await expect(option).toHaveAttribute("aria-posinset", /^\d+$/);
    await expect(option).toHaveAttribute("aria-setsize", /^-?\d+$/);
    // an unread row: "unread" comes before the subject and preview, never after them
    const unread = rows(page).and(page.locator("[data-unread]")).first();
    await expect(unread).toHaveAccessibleName(new RegExp(`^${(await unread.getByTestId("row-from").innerText()).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*, unread`));
  });

  await scenario("Enter opens the conversation and goes into it; F6 cycles sidebar, list, conversation", async () => {
    await focusList(page);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("reader")).toBeFocused();
    await page.keyboard.press("F6");
    expect((await active(page)).inSidebar).toBe(true);
    await page.keyboard.press("F6");
    expect((await active(page)).role).toBe("listbox");
    await page.keyboard.press("F6");
    await expect(page.getByTestId("reader")).toBeFocused();
    await page.keyboard.press("Shift+F6");
    expect((await active(page)).role).toBe("listbox");
  });

  await scenario("F6 leaves a mail's frame for the next pane, as from anywhere in the conversation (Codex review)", async () => {
    const store = server.backend.store;
    const account = (await store.accounts.list())[0]!;
    const ana = { name: "Ana", email: "ana@example.com" };
    const { touched } = await store.sync.ingest([{ accountId: account.id, providerThreadId: "f6-frame", providerMsgId: "f6-frame-1", rfcMessageId: "<f6-frame-1@e2e.test>", inReplyTo: null, references: [], replyTo: [], cc: [], bcc: [], from: ana, to: [{ name: "Luis", email: account.email }], subject: "Frame keys", snippet: "A link", date: E2E_NOW, bodyText: null, bodyHtml: '<p>See <a href="https://example.com/x">the link</a>.</p>', bodyState: "full" as const, listId: null, isRead: true, isStarred: false, inInbox: true, isDraft: false, isTrash: false, isSpam: false, isSent: false, hasAttachments: false, size: 100 }], { applyFilters: false, now: E2E_NOW, classifier: null });
    await selectThread(page, touched[0]!, 'subject:"Frame keys"');
    const link = page.getByTestId("message").last().frameLocator("iframe").getByRole("link", { name: "the link" });
    await link.focus();
    await page.keyboard.press("F6");
    await expect.poll(async () => (await active(page)).inSidebar).toBe(true);
    // (the search it was found by goes: the scenarios after it are about the Inbox)
    await fresh(page);
  });

  await scenario("Delete and ↓ on a sidebar row stay with it: nothing is trashed, the cursor stays", async () => {
    await openRow(page, 0);
    const before = await rows(page).count();
    const selected = await page.getByRole("listbox", { name: "Conversations" }).getAttribute("aria-activedescendant");
    await page.getByTestId("nav-starred").focus();
    await page.keyboard.press("Delete");
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(200);
    expect(await rows(page).count()).toBe(before);
    expect(await page.getByRole("listbox", { name: "Conversations" }).getAttribute("aria-activedescendant")).toBe(selected);
  });

  await scenario("the sidebar says what its numbers count, and its sections are headings", async () => {
    await expect(page.getByTestId("nav-inbox")).toHaveAccessibleName(/^Inbox \d+$/);
    await expect(page.getByTestId("nav-inbox")).toHaveAccessibleDescription(/^\d+ unread$/);
    await expect(page.getByRole("heading", { name: "Categories" })).toBeVisible();
  });

  await scenario("the palette's field has a name", async () => {
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByTestId("palette-input")).toHaveAccessibleName("Search commands and mail");
    await expect(page.getByTestId("palette-input")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("palette-input")).toHaveCount(0);
  });

  await scenario("single-key shortcuts off: e archives nothing; the chord still does", async () => {
    await page.getByTestId("open-settings").click();
    const keys = page.getByTestId("character-keys-switch");
    await keys.click();
    await expect(keys).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Escape");
    const first = await openRow(page, 0);
    await focusList(page);
    await page.keyboard.press("e");
    await page.waitForTimeout(200);
    await expect(page.locator(`[data-thread-id="${first}"]`)).toHaveCount(1);
    await page.keyboard.press("ControlOrMeta+Backspace");
    await expect(page.locator(`[data-thread-id="${first}"]`)).toHaveCount(0);
    // the Undo pill names ⌘Z only: plain z does nothing now (Codex review)
    await expect(page.getByTestId("snack-dock").getByTestId("snack-action")).toHaveAttribute("aria-keyshortcuts", /^(Meta|Control)\+Z$/);
    await page.getByTestId("open-settings").click();
    await keys.click();
    await expect(keys).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
  });

  await scenario("Undo send says how long there is: the window the user chose", async () => {
    await server.backend.server.invoke("settings.update", { undoSend: true, undoSendSeconds: 20 }, { clientId: "setup", origin: "dev" as const });
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await openRow(page, 0);
    await page.keyboard.press("r");
    await expect(page.getByTestId("compose-body")).toBeFocused();
    await page.keyboard.type("Twenty seconds");
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(page.getByTestId("held-message")).toBeVisible();
    await expect(page.getByTestId("announcer")).toHaveText(/^Not sent yet\. Press Z within (19|20) seconds to undo it\.$/);
    // said once per hold, not again each time its conversation is come back to (Codex review)
    await page.evaluate(() => {
      const w = window as unknown as { __said: string[] };
      w.__said = [];
      new MutationObserver(() => w.__said.push(document.querySelector("[data-testid=announcer]")!.textContent ?? "")).observe(document.querySelector("[data-testid=announcer]")!, { childList: true, characterData: true, subtree: true });
    });
    await focusList(page);
    await page.keyboard.press("j");
    await page.keyboard.press("k");
    await expect(page.getByTestId("held-message")).toBeVisible();
    await page.waitForTimeout(200);
    expect((await page.evaluate(() => (window as unknown as { __said: string[] }).__said)).filter((t) => t.startsWith("Not sent yet"))).toEqual([]);
    // taken back and sent again, it's a new hold: said again (Codex review)
    await page.keyboard.press("z");
    await expect(page.getByTestId("held-message")).toHaveCount(0);
    await expect(page.getByTestId("compose-body")).toBeVisible();
    await page.getByTestId("compose-body").click();
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(page.getByTestId("held-message")).toBeVisible();
    await expect.poll(async () => (await page.evaluate(() => (window as unknown as { __said: string[] }).__said)).filter((t) => t.startsWith("Not sent yet")).length).toBe(1);
  });
});
