/**
 * Plan 132 in the page, on the offline fake model or a stub on this machine: nothing here reaches a real provider.
 * New mail comes through a real sync pass; old mail is summarized by hand.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { SettingsPatch } from "@terno/core/rpc";
import type { IncomingMessage } from "@terno/store";
import { E2E_NOW } from "./constants";
import { inEveryLook } from "./helpers/looks";
import { unclipped } from "./helpers/unclipped";
import { expect, ingestConversation, navTo, openRow, rows, test, type DevServerFixture, fresh, scenario } from "./fixtures";
import { englishLeaks } from "./i18n-leaks";
import { answerFor } from "../../../scripts/ui-rating/model-stub.mjs";
import { startOllamaStub } from "./ollama-stub";

test.use({ backendOptions: { network: true } });

const dev = { clientId: "setup", origin: "dev" as const };
const LONG =
  "Ana can't make the 12th and proposes the 19th instead. She needs the signed contract before then, because the bank closes the file that week. " +
  "Please send the signed contract by Friday, so that legal has time to read it again and the notary can keep the morning free. " +
  "Can you confirm the 19 March works for you? The rest of the team has already said yes, and nothing else in the plan moves with this change.";

function incoming(accountId: number, subject: string, over: Partial<IncomingMessage> = {}): IncomingMessage {
  const key = subject.replace(/\W/g, "");
  return {
    accountId, providerMsgId: `summary-${key}`, providerThreadId: null, rfcMessageId: `${key}@summary.test`, inReplyTo: null, references: [],
    from: { name: "Ana Pérez", email: "ana@studio.example" }, to: [{ name: "Me", email: "me@example.com" }], cc: [], bcc: [],
    subject, date: E2E_NOW - 60_000, snippet: LONG.slice(0, 80), bodyText: LONG, bodyHtml: null, bodyState: "full", listId: null,
    isRead: false, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 500, gmailLabels: ["INBOX", "UNREAD"],
    ...over,
  };
}

async function firstAccount(server: DevServerFixture): Promise<number> {
  const { accounts } = (await server.backend.server.invoke("app.bootstrap", {}, dev)) as { accounts: { id: number }[] };
  return accounts[0]!.id;
}

/** The app again, with what the setup just saved. */
async function settingUp(page: Page, server: DevServerFixture, patch: SettingsPatch) {
  await server.backend.server.invoke("settings.update", patch, dev);
  await page.reload();
  await page.locator("[data-ready]").waitFor();
  await rows(page).first().waitFor();
}

/** New mail, through a real sync pass of the demo provider. */
async function deliver(page: Page, server: DevServerFixture, m: IncomingMessage) {
  server.net.incoming.push(m);
  await server.backend.syncAccount(m.accountId);
  await expect(page.getByTestId("thread-row").filter({ hasText: m.subject }).first()).toBeVisible();
}

async function openSubject(page: Page, subject: string) {
  await page.getByTestId("thread-row").filter({ hasText: subject }).first().dispatchEvent("mousedown");
  await expect(page.getByTestId("reader-subject")).toHaveText(subject);
}


test.describe("summaries (plan 132)", () => {
  test("plan 162: the summary's provenance popover is whole in every design, light and dark, 1440 and 1100", { tag: "@design" }, async ({ app: page, server }) => {
    const accountId = await firstAccount(server);
    await settingUp(page, server, { ai: { provider: "fake" } });
    await deliver(page, server, incoming(accountId, "The contract, new date"));
    await openSubject(page, "The contract, new date");
    await expect(page.getByTestId("summary-block")).toHaveAttribute("data-state", "ready");
    await inEveryLook(page, async (where) => {
      await page.getByTestId("summary-provenance").click();
      const popover = page.getByTestId("summary-provenance-popover");
      await expect(popover, where).toBeVisible();
      expect(await unclipped(popover), where).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(popover, where).toHaveCount(0);
      // Esc closed only it, and gave the keys back to what opened it
      await expect(page.getByTestId("summary-provenance"), where).toBeFocused();
    });
  });

  test("on with AI, new mail gets a summary between the header and the conversation; old mail has none; axe-clean in both modes", { tag: "@variant" }, async ({ app: page, server }) => {
    const accountId = await firstAccount(server);
    await settingUp(page, server, { ai: { provider: "fake" } });

    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-ai").click();
    const group = page.getByTestId("ai-summaries");
    await group.scrollIntoViewIfNeeded();
    await expect(group).toContainText("Summarize new mail");
    await expect(group).toContainText("Sends the text of each new conversation to Offline demo as it arrives.");
    // plan 157: on with AI, with no click
    await expect(page.getByTestId("ai-summaries-switch")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("ai-drafting-sent-mail")).toHaveAttribute("aria-checked", "true");
    expect((await new AxeBuilder({ page }).setLegacyMode().include("[data-testid=ai-summaries]").include("[data-testid=ai-use]").analyze()).violations).toEqual([]);
    await page.keyboard.press("Escape");

    // what was here before it went on has no summary and sends nothing
    const old = (await rows(page).first().getAttribute("data-thread-id"))!;
    await openRow(page, 0);
    await page.waitForTimeout(100);
    await expect(page.getByTestId("summary-block")).toHaveCount(0);
    expect(await server.backend.store.aiSummaries.get(Number(old))).toBeNull();

    await deliver(page, server, incoming(accountId, "The contract, new date"));
    await openSubject(page, "The contract, new date");
    const block = page.getByTestId("summary-block");
    await expect(block).toBeVisible();
    await expect(block).toHaveAttribute("data-state", "ready");
    await expect(page.getByTestId("summary-text")).toContainText("Ana can't make the 12th and proposes the 19th instead.");
    // plan 162 (after ai162-r02): the summary reads at the mail's measure (it ran 100 to 110 characters a line), in a card that keeps the pane's width
    const measure = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--read-max").trim());
    expect(measure).not.toBe("");
    expect(await page.getByTestId("summary-text").evaluate((e) => getComputedStyle(e).maxWidth)).not.toBe("none");
    await expect(page.getByTestId("summary-item").first()).toContainText("To do");
    await expect(page.getByTestId("summary-item").first()).toContainText("Please send the signed contract by Friday");
    // plan 161, pass 2: a conversation of one message is that message, on screen: the item is its words, with nowhere to go
    await expect(page.getByTestId("summary-item-open")).toHaveCount(0);
    expect(await page.getByTestId("summary-item").first().evaluate((el) => el.tagName)).toBe("LI");
    // pass 3: an Action is answered with the ordinary reply, said so: Reply, which opens it as R does
    await expect(page.getByTestId("summary-item").first().locator("button")).toHaveCount(1);
    await expect(page.getByTestId("summary-item").first().getByTestId("summary-item-reply")).toBeVisible();
    await expect(page.getByTestId("summary-item-reply").first()).toHaveAccessibleName("Reply");

    // it stands above the conversation
    const blockBox = (await block.boundingBox())!;
    const messageBox = (await page.getByTestId("message").first().boundingBox())!;
    expect(blockBox.y + blockBox.height).toBeLessThanOrEqual(messageBox.y + 1);

    // plan 161, pass 3: who wrote it is a button at the row's end (a label that took focus did nothing), its popover who and
    // when, and that it can be wrong
    await expect(page.getByTestId("summary-provenance-label")).toHaveText("Written with AI");
    await expect(page.getByTestId("summary-provenance")).toHaveRole("button");
    await page.getByTestId("summary-provenance").click();
    await expect(page.getByTestId("summary-provenance-popover")).toContainText(/Written by demo, .*It can make mistakes\./);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("summary-provenance-popover")).toHaveCount(0);
    // and Copy, the one Copy every AI surface has, 28 px: Copied in place, then Copy again
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    expect((await page.getByTestId("summary-copy").boundingBox())!.height).toBeGreaterThanOrEqual(28);
    await page.getByTestId("summary-copy").click();
    await expect(page.getByTestId("summary-copy")).toHaveAttribute("data-copied", "true");
    await expect(page.getByTestId("summary-copy-status")).toHaveText("Copied");
    await expect(page.getByTestId("summary-copy")).not.toHaveAttribute("data-copied", "true");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/Ana can't make the 12th[\s\S]*\nTo do: Please send the signed contract by Friday/);

    expect((await new AxeBuilder({ page }).setLegacyMode().include("[data-testid=summary-block]").analyze()).violations).toEqual([]);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    expect((await new AxeBuilder({ page }).setLegacyMode().include("[data-testid=summary-block]").analyze()).violations).toEqual([]);
    await page.emulateMedia({ colorScheme: "light" });

    // the disclosure: closed stays closed, across a reload, and opens again
    await page.getByTestId("summary-toggle").click();
    await expect(page.getByTestId("summary-text")).toHaveCount(0);
    await page.mouse.move(0, 0);
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await openSubject(page, "The contract, new date");
    await expect(page.getByTestId("summary-toggle")).toHaveAttribute("aria-expanded", "false");
    await page.getByTestId("summary-toggle").click();
    await expect(page.getByTestId("summary-text")).toBeVisible();

    // plan 161, pass 3: three Sparkles, three names, each with its key where it has one
    await expect(page.getByTestId("action-summarize")).toHaveAccessibleName("Summarize this conversation");
    await expect(page.getByTestId("quick-ai")).toHaveAccessibleName("Reply with AI");
    // plan 162 (after ai162-r03): the item's Reply is the ordinary reply, as R is: nothing in ⌘J (on real models a question
    // item is their question, and Write drafted a reply with no stance from it)
    await page.getByTestId("summary-item-reply").first().click();
    await expect(page.getByTestId("composer")).toHaveAttribute("data-mode", "reply");
    await expect(page.getByTestId("compose-body")).toBeFocused();
    await expect(page.getByTestId("ai-row-input")).toHaveCount(0);
    await expect(page.getByTestId("compose-ai")).toHaveAccessibleName("Write with AI");
    await page.getByTestId("compose-ai").hover();
    await expect(page.locator("[data-slot=tooltip-content]")).toContainText("Write with AI");
    await expect(page.locator("[data-slot=tooltip-content]")).toContainText(/⌘\s*J/);
  });

  test("plan 148: a card in every design, its edges on the column and its text inset; nothing spills out of it", { tag: "@design" }, async ({ app: page, server }) => {
    const accountId = await firstAccount(server);
    await settingUp(page, server, { ai: { provider: "fake" } });
    const unbroken = `https://example.test/${"alongpath".repeat(40)}`;
    await deliver(page, server, incoming(accountId, "A card", { bodyText: `The file moved to ${unbroken} last night. It still opens. Please read ${unbroken} today.` }));
    await openSubject(page, "A card");
    await page.getByTestId("action-summarize").click();
    const block = page.getByTestId("summary-block");
    await expect(block).toHaveAttribute("data-state", "ready");
    await expect(page.getByTestId("summary-text")).toContainText("alongpath");

    // tinted, or in Graphite outlined on its surface: never just more of the mail's own page
    const surface = await block.evaluate((el) => { const s = getComputedStyle(el); return { fill: s.backgroundColor, ring: s.boxShadow }; });
    const NONE = "rgba(0, 0, 0, 0)";
    // plan 162 (the owner, 2026-11-08: the grey box "feels cheap"): no fill of its own in light, the page's surface under a
    // hairline and the faintest lift; dark lifts it by the ink's wash. Ringed in every design (its floor is contrast.test.ts's),
    // so it never reads as mail
    expect(surface.fill).toBe(NONE);
    expect(surface.ring).toContain("inset");
    expect(surface.ring).not.toMatch(/^rgba\(0, 0, 0, 0\)/);

    // on the column: the subject's line and the conversation's ends. The label's icon and the text share the inset
    const box = (await block.boundingBox())!;
    const message = (await page.getByTestId("message").first().boundingBox())!;
    expect(box.x).toBe((await page.getByTestId("reader-subject").boundingBox())!.x);
    expect(box.x).toBe(message.x);
    expect(box.width).toBe(message.width);
    const inset = (await page.getByTestId("summary-text").boundingBox())!.x - box.x;
    expect(inset).toBeGreaterThanOrEqual(12);
    expect((await page.getByTestId("summary-toggle").locator("svg").first().boundingBox())!.x - box.x).toBe(inset);

    // the minimum window: a long link wraps, inside the card
    await page.setViewportSize({ width: 980, height: 600 });
    for (const text of [page.getByTestId("summary-text"), page.getByTestId("summary-item-text").first()]) {
      const fits = await text.evaluate((el) => el.scrollWidth <= el.clientWidth);
      expect(fits).toBe(true);
      const right = (await text.boundingBox())!;
      const card = (await block.boundingBox())!;
      expect(right.x + right.width).toBeLessThanOrEqual(card.x + card.width);
    }

    // plan 162 (after ai162-r01): one left edge in the card: the item starts where the paragraph does
    for (const width of [1100, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const item = page.getByTestId("summary-item-text").first();
      if (!(await item.count())) break;
      expect(Math.abs((await item.boundingBox())!.x - (await page.getByTestId("summary-text").boundingBox())!.x)).toBeLessThanOrEqual(1);
    }
    // plan 162: an item's controls are a line of their own under its words at every width, starting at the words' edge;
    // Reply is the card's one secondary (bordered), Copy a quiet utility
    for (const width of [980, 1100, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const controls = page.getByTestId("summary-item-controls").first();
      if (!(await controls.count())) break;
      const words = (await page.getByTestId("summary-item-text").first().boundingBox())!;
      const row = (await controls.boundingBox())!;
      expect(row.y).toBeGreaterThanOrEqual(words.y + words.height - 1);
      expect(Math.abs(row.x - words.x)).toBeLessThanOrEqual(1);
      const reply = page.getByTestId("summary-item-reply").first();
      if (await reply.count()) expect(Math.abs((await reply.boundingBox())!.x - words.x)).toBeLessThanOrEqual(1);
    }
    // every button keeps a 1 px border; a quiet one's is clear
    const edge = (testId: string) => page.getByTestId(testId).first().evaluate((el) => getComputedStyle(el).borderTopColor);
    if (await page.getByTestId("summary-item-reply").count()) expect(await edge("summary-item-reply")).not.toBe("rgba(0, 0, 0, 0)");
    expect(await edge("summary-copy")).toBe("rgba(0, 0, 0, 0)");
    await page.setViewportSize({ width: 980, height: 600 });

    // closed, the card is its one row
    await page.getByTestId("summary-toggle").click();
    await expect(page.getByTestId("summary-text")).toHaveCount(0);
    expect((await block.boundingBox())!.height).toBe((await page.getByTestId("summary-toggle").boundingBox())!.height);
  });

  test("by hand on an old conversation: appears at once, can be stopped, and its arrow goes to the message", async ({ app: page, server }) => {
    // the model answers when the steps that need it thinking are done, however long they take here
    let answer!: () => void;
    const stub = await startOllamaStub({ chatHeld: new Promise((r) => (answer = r)) });
    try {
      await settingUp(page, server, { ai: { provider: "ollama", baseURL: `${stub.url}/v1`, model: "qwen3:8b" } });
      // not live mail: old as far as summaries go, whatever its date
      const threadId = await ingestConversation(server, { subject: "A long conversation", count: 8, html: 8, unread: 1, now: E2E_NOW + 3_600_000 });
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      const select = `[data-thread-id="${threadId}"]`;
      await page.locator(select).waitFor();
      await page.locator(select).dispatchEvent("mousedown");
      await expect(page.getByTestId("reader-subject")).toHaveText("A long conversation");
      await expect(page.getByTestId("summary-block")).toHaveCount(0);

      // stopped: nothing written, the block gone
      const summarize = page.getByTestId("action-summarize");
      await expect(summarize).toHaveAttribute("aria-label", "Summarize this conversation");
      await summarize.click();
      const block = page.getByTestId("summary-block");
      await expect(block).toHaveAttribute("data-state", "running");
      await expect(block).toContainText("Summarizing…");
      // plan 148: at the minimum window a short status keeps its action on the row, the height of the card's header
      await page.setViewportSize({ width: 980, height: 600 });
      expect((await block.boundingBox())!.height).toBe(40);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByTestId("summary-stop").click();
      await expect(block).toHaveCount(0);
      expect(await server.backend.store.aiSummaries.get(threadId)).toBeNull();
      // Stop took the whole block with it: focus goes to the button that started it, never the page
      await expect(summarize).toBeFocused();

      // from the palette, then leaving the thread doesn't lose it
      await page.keyboard.press("Meta+k");
      await page.getByRole("combobox").fill("summarize");
      await page.getByTestId("palette-summarize").click();
      await expect(block).toHaveAttribute("data-state", "running");
      const running = (await block.boundingBox())!;
      await openRow(page, 1);
      await expect(block).toHaveCount(0);
      answer();
      await expect.poll(async () => (await server.backend.store.aiSummaries.get(threadId))?.state).toBe("ready");
      await page.locator(select).dispatchEvent("mousedown");
      await expect(block).toHaveAttribute("data-state", "ready");
      // the stub's own answer to what was sent (plan 161: one source with the rating's stand-in)
      const written = JSON.parse(answerFor(stub.last.thread_summary)!.content) as { summary: string; items: { message: string }[] };
      await expect(page.getByTestId("summary-text")).toHaveText(written.summary);
      // plan 148: the answer takes the running card's place: same box, same header line
      const ready = (await block.boundingBox())!;
      expect({ x: ready.x, y: ready.y, width: ready.width }).toEqual({ x: running.x, y: running.y, width: running.width });
      expect((await page.getByTestId("summary-toggle").boundingBox())!.height).toBe(running.height);

      // plan 161, pass 3: the source is named for where it goes, whose message and when; its name is what it shows
      await expect(page.getByTestId("summary-item-open")).toHaveText(/^Yuki’s message, /);
      await expect(page.getByTestId("summary-item-open")).toHaveAccessibleName(/^Yuki’s message, /);
      // it unfolds and goes to the message it names, and the toolbar's button stays where it is
      await page.getByTestId("summary-item-open").click();
      // its item cites the question in Yuki's last message, m7 of 8: the one before the user's reply
      expect(written.items[0]!.message).toBe("m7");
      const target = page.locator(`[data-reader-scroller] article[data-message-id]`).nth(-2);
      await expect(target).toHaveAttribute("data-expanded", "true");
      await expect.poll(async () => (await target.boundingBox())!.y).toBeLessThan(200);

      // focus stayed with what the user is doing, and no ring after a click
      expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
    } finally {
      await stub.close();
    }
  });

  test("a result arriving while the user reads further down doesn't move what they're reading", async ({ app: page, server }) => {
    const stub = await startOllamaStub({ chatDelayMs: 400 });
    try {
      await settingUp(page, server, { ai: { provider: "ollama", baseURL: `${stub.url}/v1`, model: "qwen3:8b" } });
      const threadId = await ingestConversation(server, { subject: "A thread to read", count: 8, html: 8, unread: 8, now: E2E_NOW + 3_600_000 });
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await rows(page).first().waitFor();
      await page.locator(`[data-thread-id="${threadId}"]`).dispatchEvent("mousedown");
      await expect(page.getByTestId("reader-subject")).toHaveText("A thread to read");
      const scroller = page.locator("[data-reader-scroller]");
      await scroller.evaluate((el) => { el.scrollTop = 600; });
      const last = page.getByTestId("message").nth(3);
      const before = (await last.boundingBox())!.y;
      await page.getByTestId("action-summarize").click();
      await expect(page.getByTestId("summary-block")).toHaveAttribute("data-state", "ready");
      await expect.poll(async () => Math.abs((await last.boundingBox())!.y - before)).toBeLessThan(2);
    } finally {
      await stub.close();
    }
  });

  test("never in spam or trash; a new message hides it; Clear AI data; every word in en and es", async ({ app: page, server }) => {
    await scenario("never offered in spam or trash, nor with one spam message in the thread", async () => {
      const accountId = await firstAccount(server);
      // by hand only: new mail waits for a click here
      await settingUp(page, server, { ai: { provider: "fake" }, summaries: { enabled: false } });
      await deliver(page, server, incoming(accountId, "Clean, then spam"));
      await openSubject(page, "Clean, then spam");
      await expect(page.getByTestId("action-summarize")).toBeVisible();

      const spamReply = incoming(accountId, "Clean, then spam", { providerMsgId: "summary-spam-reply", rfcMessageId: "spamreply@summary.test", inReplyTo: "Cleanthenspam@summary.test", references: ["Cleanthenspam@summary.test"], isSpam: true, inInbox: false, date: E2E_NOW - 30_000 });
      server.net.incoming.push(spamReply);
      await server.backend.syncAccount(accountId);
      await expect(page.getByTestId("action-summarize")).toHaveCount(0);
      await page.keyboard.press("Meta+k");
      await page.getByRole("combobox").fill("summarize");
      await expect(page.getByTestId("palette-summarize")).toHaveCount(0);
      await page.keyboard.press("Escape");

      await deliver(page, server, incoming(accountId, "For the trash"));
      await openSubject(page, "For the trash");
      await expect(page.getByTestId("action-summarize")).toBeVisible();
      await page.getByTestId("action-trash").click();
      await navTo(page, "trash");
      await openSubject(page, "For the trash");
      await expect(page.getByTestId("action-summarize")).toHaveCount(0);
    });
    await scenario("a new message hides it; with the setting off the button reads Update summary", async () => {
      await fresh(page);
      const accountId = await firstAccount(server);
      await settingUp(page, server, { ai: { provider: "fake" } });
      const first = incoming(accountId, "Changing thread");
      await deliver(page, server, first);
      await openSubject(page, "Changing thread");
      await page.getByTestId("action-summarize").click();
      await expect(page.getByTestId("summary-block")).toHaveAttribute("data-state", "ready");

      // the user clicked away from the card before it went: focus stays where they left it, not on the toolbar
      await page.getByTestId("summary-toggle").focus();
      await page.getByTestId("reader-subject").click();
      await expect(page.getByTestId("summary-toggle")).not.toBeFocused();

      server.net.incoming.push(incoming(accountId, "Changing thread", { providerMsgId: "summary-next", rfcMessageId: "next@summary.test", inReplyTo: first.rfcMessageId, references: [first.rfcMessageId!], date: E2E_NOW - 20_000, bodyText: `${LONG} One more thing.` }));
      await server.backend.syncAccount(accountId);
      await expect(page.getByTestId("message")).toHaveCount(2);
      await expect(page.getByTestId("summary-block")).toHaveCount(0);
      const button = page.getByTestId("action-summarize");
      await expect(button).not.toBeFocused();
      await expect(button).toHaveAttribute("aria-label", "Update summary");
      await button.click();
      await expect(page.getByTestId("summary-block")).toHaveAttribute("data-state", "ready");
      await expect(button).toHaveAttribute("aria-label", "Summarize this conversation");
    });
    await scenario("Settings → Storage: Clear AI data", async () => {
      await fresh(page);
      const accountId = await firstAccount(server);
      await settingUp(page, server, { ai: { provider: "fake" } });
      await deliver(page, server, incoming(accountId, "To be cleared"));
      await openSubject(page, "To be cleared");
      await page.getByTestId("action-summarize").click();
      await expect(page.getByTestId("summary-block")).toHaveAttribute("data-state", "ready");
      await page.getByTestId("open-settings").click();
      await page.getByTestId("tab-storage").click();
      await page.getByTestId("storage-clear-ai").click();
      await expect(page.getByTestId("snack-message")).toHaveText("AI data cleared");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("summary-block")).toHaveCount(0);
      await expect.poll(async () => (await server.backend.server.invoke("ai.summaries.status", {}, dev)) as { pending: number }).toMatchObject({ pending: 0 });
    });
    await scenario("en and es: every word of it in the app's language", async () => {
      await fresh(page);
      const accountId = await firstAccount(server);
      await settingUp(page, server, { ai: { provider: "fake" }, language: "es" });
      await deliver(page, server, incoming(accountId, "Una fecha nueva", { bodyText: `${LONG} Necesito el contrato por favor.` }));
      await openSubject(page, "Una fecha nueva");
      await page.getByTestId("action-summarize").click();
      const block = page.getByTestId("summary-block");
      await expect(block).toHaveAttribute("data-state", "ready");
      await expect(page.getByTestId("summary-toggle")).toContainText("Resumen");
      await expect(page.getByTestId("summary-item").first()).toContainText("Por hacer");
      await expect(page.getByTestId("action-summarize")).toHaveAttribute("aria-label", "Resumir esta conversación");
      await page.getByTestId("open-settings").click();
      await page.getByTestId("tab-ai").click();
      await page.getByTestId("ai-summaries").scrollIntoViewIfNeeded();
      await expect(page.getByTestId("ai-summaries")).toContainText("Resumir el correo nuevo");
      await expect(page.getByTestId("ai-use")).toContainText("Límite mensual");
      expect(await englishLeaks(page)).toEqual([]);
    });
  });

  test("a cloud request goes at once; no provider points to Settings; errors say what to do", async ({ app: page, server }) => {
    const accountId = await firstAccount(server);
    let failing: number | null = null;
    const stub = await startOllamaStub({ summaryFails: () => failing });
    try {
      // plan 147: nothing set up: nothing offered, in the toolbar or the palette; Settings → AI is the way in
      await settingUp(page, server, { ai: { provider: "none" }, summaries: { enabled: false } });
      await deliver(page, server, incoming(accountId, "No provider yet"));
      await openSubject(page, "No provider yet");
      await expect(page.getByTestId("action-summarize")).toHaveCount(0);
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByTestId("palette-input").fill("summarize");
      await expect(page.getByTestId("palette-summarize")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await page.getByTestId("open-settings").click();
      await page.getByTestId("tab-ai").click();
      await expect(page.getByTestId("ai-tab")).toBeVisible();
      const target = page.getByTestId("ai-summaries-target");
      await target.scrollIntoViewIfNeeded();
      await expect(target.getByTestId("ai-summaries-add-key")).toHaveText("Add an OpenAI key");
      await expect(target.getByTestId("ai-summaries-use")).toHaveCount(0);
      // plan 157: they do nothing without AI, so they aren't here
      await expect(page.getByTestId("ai-summaries-switch")).toHaveCount(0);
      await expect(page.getByTestId("ai-drafting-sent-mail")).toHaveCount(0);

      // only another provider's key: it asks, with both ways, and sends nothing to anyone
      await server.backend.server.invoke("settings.update", { ai: { provider: "anthropic", baseURL: `${stub.url}`, model: "claude-sonnet-5-5" } }, dev);
      await server.backend.server.invoke("ai.setKey", { provider: "anthropic", value: "sk-ant-e2e-not-a-real-key" }, dev);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await page.getByTestId("open-settings").click();
      await page.getByTestId("tab-ai").click();
      await target.scrollIntoViewIfNeeded();
      await expect(target.getByTestId("ai-summaries-add-key")).toBeVisible();
      await expect(target.getByTestId("ai-summaries-use")).toHaveText(/Use Claude/);
      await target.getByTestId("ai-summaries-add-key").click();
      await expect(target.getByTestId("ai-summaries-key")).toBeVisible();
      await page.keyboard.press("Escape");
      expect(stub.summaries).toEqual([]);

      // OpenAI (on the stub, never the real one): it goes at once, with nothing to agree to (plan 131: no per-use consent)
      await server.backend.server.invoke("settings.update", { ai: { provider: "openai", baseURL: `${stub.url}/v1`, model: "gpt-6-luna" } }, dev);
      await server.backend.server.invoke("ai.setKey", { provider: "openai", value: "sk-openai-e2e-not-a-real-key" }, dev);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await openSubject(page, "No provider yet");
      await page.getByTestId("action-summarize").click();
      await expect(page.getByTestId("summary-block")).toHaveAttribute("data-state", "ready");
      expect(stub.summaries).toHaveLength(1);
      await page.getByTestId("summary-provenance").click();
      await expect(page.getByTestId("summary-provenance-popover")).toContainText("Written by GPT Luna");
      await page.keyboard.press("Escape");

      // when it fails, the block says so and can try again
      await deliver(page, server, incoming(accountId, "Next one"));
      await openSubject(page, "Next one");
      failing = 401;
      await page.getByTestId("action-summarize").click();
      await expect(page.getByTestId("summary-block")).toHaveAttribute("data-state", "error");
      await expect(page.getByTestId("summary-error")).toContainText("Check the API key");
      failing = null;
      await page.getByTestId("summary-retry").click();
      await expect(page.getByTestId("summary-block")).toHaveAttribute("data-state", "ready");
      expect(stub.summaries.length).toBeGreaterThanOrEqual(2);

      // the provider went behind this window's back (another window's Settings): the block points to the row
      await deliver(page, server, incoming(accountId, "Provider went"));
      await openSubject(page, "Provider went");
      await server.backend.server.invoke("settings.update", { ai: { provider: "none" } }, dev);
      await server.backend.server.invoke("ai.setKey", { provider: "openai", value: "" }, dev);
      await page.getByTestId("action-summarize").click();
      await expect(page.getByTestId("summary-block")).toHaveAttribute("data-state", "no-provider");
      await page.getByTestId("summary-settings").click();
      await expect(page.getByTestId("ai-tab")).toBeVisible();
    } finally {
      await stub.close();
    }
  });

  test("plan 161, pass 2: one AI error, in plain words and never an address, on the summary and ⌘J", async ({ app: page, server }) => {
    const accountId = await firstAccount(server);
    const stub = await startOllamaStub();
    await settingUp(page, server, { ai: { provider: "ollama", baseURL: `${stub.url}/v1`, model: "qwen3:8b" } });
    const host = new URL(stub.url).host;
    // Ollama goes away: the provider's own message names its address
    await stub.close();
    await deliver(page, server, incoming(accountId, "Nobody home"));
    await openSubject(page, "Nobody home");
    await page.getByTestId("action-summarize").click();
    await expect(page.getByTestId("summary-block")).toHaveAttribute("data-state", "error");
    const error = page.getByTestId("summary-error");
    await expect(error).toContainText("Couldn’t reach Ollama");
    await expect(error).toContainText("Open Ollama, then try again.");
    for (const text of [await page.getByTestId("summary-block").innerText()]) {
      expect(text).not.toContain(host);
      expect(text).not.toMatch(/127\.0\.0\.1|localhost|:\d{4,5}\b/);
    }
    await expect(page.getByTestId("summary-retry")).toBeVisible();
    await expect(page.getByTestId("summary-error-settings")).toHaveText("AI settings");
    expect((await new AxeBuilder({ page }).setLegacyMode().include("[data-testid=summary-block]").analyze()).violations).toEqual([]);
    // ⌘J says it the same way
    await page.keyboard.press("ControlOrMeta+j");
    await page.getByTestId("ai-row-input").fill("say thanks");
    await page.keyboard.press("Enter");
    const row = page.getByTestId("ai-error");
    await expect(row).toBeVisible();
    await expect(page.getByTestId("ai-error-text")).toContainText("Couldn’t reach Ollama");
    expect(await row.innerText()).not.toContain(host);
    await expect(page.getByTestId("ai-error-retry")).toBeVisible();
    await expect(page.getByTestId("ai-error-settings")).toBeVisible();
    // plan 162: and Ask too, in the same notice (it was a red sentence of the provider's, with its address)
    await page.getByTestId("ai-error-close").click();
    await page.keyboard.press("Escape");
    await page.getByTestId("reader-subject").click();
    await page.keyboard.press("ControlOrMeta+Shift+k");
    await page.getByTestId("palette-input").fill("who wrote about the payment?");
    await page.keyboard.press("Enter");
    const asked = page.getByTestId("ask-error");
    await expect(page.getByTestId("ask-error-text")).toContainText("Couldn’t reach Ollama");
    await expect(page.getByTestId("ask-error-text")).toContainText("Open Ollama, then try again.");
    expect(await asked.innerText()).not.toContain(host);
    await expect(page.getByTestId("ask-retry")).toBeVisible();
    await expect(page.getByTestId("ask-error-settings")).toHaveText("AI settings");
  });

  test("Settings → AI: use this month and the monthly limit; a bad key is findable there", async ({ app: page, server }) => {
    const accountId = await firstAccount(server);
    const stub = await startOllamaStub({ summaryFails: () => 401 });
    try {
      await settingUp(page, server, { ai: { provider: "ollama", baseURL: `${stub.url}/v1`, model: "qwen3:8b" }, summaries: { enabled: true } });
      await deliver(page, server, incoming(accountId, "Key goes bad"));
      await expect.poll(() => stub.summaries.length).toBeGreaterThan(0);
      await page.getByTestId("open-settings").click();
      await page.getByTestId("tab-ai").click();
      const status = page.getByTestId("ai-summaries-status");
      await status.scrollIntoViewIfNeeded();
      await expect(status).toContainText("Check the API key");
      await expect(page.getByTestId("ai-usage-value")).toContainText(/1 request|\d requests/);
      // the models the provider lists, to choose from
      await expect(page.getByTestId("ai-summaries-model")).toContainText("qwen3:8b");
      const limit = page.getByTestId("ai-limit-input");
      await expect(limit).toHaveValue("$10");
      await limit.fill("25");
      await limit.press("Enter");
      await expect.poll(async () => ((await server.backend.server.invoke("app.bootstrap", {}, dev)) as { settings: { ai: { monthlyLimitUsd: number } } }).settings.ai.monthlyLimitUsd).toBe(25);
      // the change in settings looked again
      await expect(page.getByTestId("ai-limit-input")).toHaveValue("$25");
    } finally {
      await stub.close();
    }
  });

});
