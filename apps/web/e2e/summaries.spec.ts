/**
 * Plan 132 in the page, on the offline fake model or a stub on this machine: nothing here reaches a real provider.
 * New mail comes through a real sync pass; old mail is summarized by hand.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { SettingsPatch } from "@terno/core/rpc";
import type { IncomingMessage } from "@terno/store";
import { E2E_NOW } from "./constants";
import { expect, ingestConversation, navTo, openRow, rows, test, type DevServerFixture, fresh, scenario } from "./fixtures";
import { englishLeaks } from "./i18n-leaks";
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
  test("turned on, new mail gets a summary between the header and the conversation; old mail has none; axe-clean in both modes", { tag: "@variant" }, async ({ app: page, server }) => {
    const accountId = await firstAccount(server);
    await settingUp(page, server, { ai: { provider: "fake" } });

    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-ai").click();
    const group = page.getByTestId("ai-summaries");
    await group.scrollIntoViewIfNeeded();
    await expect(group).toContainText("Summarize new mail");
    await expect(group).toContainText("Sends the text of each new conversation to Offline demo as it arrives.");
    const toggle = page.getByTestId("ai-summaries-switch");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    expect((await new AxeBuilder({ page }).setLegacyMode().include("[data-testid=ai-summaries]").include("[data-testid=ai-use]").analyze()).violations).toEqual([]);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
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
    await expect(page.getByTestId("summary-item").first()).toContainText("Action");
    await expect(page.getByTestId("summary-item").first()).toContainText("Please send the signed contract by Friday");

    // it stands above the conversation
    const blockBox = (await block.boundingBox())!;
    const messageBox = (await page.getByTestId("message").first().boundingBox())!;
    expect(blockBox.y + blockBox.height).toBeLessThanOrEqual(messageBox.y + 1);

    // the label's tooltip says who wrote it, and that it can be wrong
    await page.getByTestId("summary-toggle").hover();
    await expect(page.getByTestId("summary-provenance")).toContainText(/Written by demo, .*It can make mistakes\./);
    await page.mouse.move(0, 0);
    await expect(page.getByTestId("summary-provenance")).toHaveCount(0);

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
  });

  test("plan 148: a card in every design, its edges on the column and its text inset; nothing spills out of it", { tag: "@design" }, async ({ app: page, server }, info) => {
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
    if (info.project.name === "e2e-graphite") {
      expect(surface.fill).toBe(NONE);
      expect(surface.ring).not.toBe("none");
      expect(surface.ring).not.toContain(NONE);
    } else {
      expect(surface.fill).not.toBe(NONE);
    }

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
    for (const text of [page.getByTestId("summary-text"), page.getByTestId("summary-item").first().locator("span").nth(1)]) {
      const fits = await text.evaluate((el) => el.scrollWidth <= el.clientWidth);
      expect(fits).toBe(true);
      const right = (await text.boundingBox())!;
      const card = (await block.boundingBox())!;
      expect(right.x + right.width).toBeLessThanOrEqual(card.x + card.width);
    }

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
      await expect(summarize).toHaveAttribute("aria-label", "Summarize");
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
      await expect(page.getByTestId("summary-text")).toHaveText("The stub read the conversation and wrote this.");
      // plan 148: the answer takes the running card's place: same box, same header line
      const ready = (await block.boundingBox())!;
      expect({ x: ready.x, y: ready.y, width: ready.width }).toEqual({ x: running.x, y: running.y, width: running.width });
      expect((await page.getByTestId("summary-toggle").boundingBox())!.height).toBe(running.height);

      // the arrow unfolds and goes to the message it names, and the toolbar's button stays where it is
      await page.getByTestId("summary-item").click();
      const target = page.locator(`[data-reader-scroller] article[data-message-id]`).first();
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
      await settingUp(page, server, { ai: { provider: "fake" } });
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
      await expect(button).toHaveAttribute("aria-label", "Summarize");
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
      await expect(page.getByTestId("summary-item").first()).toContainText("Acción");
      await expect(page.getByTestId("action-summarize")).toHaveAttribute("aria-label", "Resumir");
      await page.getByTestId("open-settings").click();
      await page.getByTestId("tab-ai").click();
      await page.getByTestId("ai-summaries").scrollIntoViewIfNeeded();
      await expect(page.getByTestId("ai-summaries")).toContainText("Resumir el correo nuevo");
      await expect(page.getByTestId("ai-use")).toContainText("Límite mensual");
      expect(await englishLeaks(page)).toEqual([]);
    });
  });

  test("the first cloud request says where it goes, once per provider; no provider points to Settings; errors say what to do", async ({ app: page, server }) => {
    const accountId = await firstAccount(server);
    let failing: number | null = null;
    const stub = await startOllamaStub({ summaryFails: () => failing });
    try {
      // plan 147: nothing set up: nothing offered, in the toolbar or the palette; Settings → AI is the way in
      await settingUp(page, server, { ai: { provider: "none" } });
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
      await expect(page.getByTestId("ai-summaries-switch")).toBeDisabled();

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

      // OpenAI (on the stub, never the real one): told once, then it goes
      await server.backend.server.invoke("settings.update", { ai: { provider: "openai", baseURL: `${stub.url}/v1`, model: "gpt-6-luna" } }, dev);
      await server.backend.server.invoke("ai.setKey", { provider: "openai", value: "sk-openai-e2e-not-a-real-key" }, dev);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await openSubject(page, "No provider yet");
      await page.getByTestId("action-summarize").click();
      await expect(page.getByTestId("summary-consent")).toHaveText("This sends the text of this conversation to OpenAI.");
      expect(stub.summaries).toEqual([]);
      expect((await new AxeBuilder({ page }).setLegacyMode().include("[data-testid=summary-block]").analyze()).violations).toEqual([]);
      await page.getByTestId("summary-continue").click();
      await expect(page.getByTestId("summary-block")).toHaveAttribute("data-state", "ready");
      expect(stub.summaries).toHaveLength(1);
      await page.getByTestId("summary-toggle").hover();
      await expect(page.getByTestId("summary-provenance")).toContainText("Written by GPT Luna");
      await page.mouse.move(0, 0);

      // a second thread isn't asked again; and when it fails, the block says so and can try again
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
