import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { loadLocale, t } from "@terno/i18n";
import { createGmailProvider, type ProviderRegistry } from "@terno/mail";
import { startDevServer } from "../../backend-dev/src/server";

for (const language of ["en", "es"] as const) for (const theme of ["light", "dark"] as const) {
  test(`cached selected-reader hydration and stale completion ${language} ${theme}`, async ({ page, context }) => {
    await loadLocale(language);
    let rawRequests = 0;
    const dir = mkdtempSync(join(tmpdir(), "terno-reader-ui-"));
    const previous = globalThis.fetch;
    const unexpected: string[] = [], paths: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let requested!: () => void;
    const request = new Promise<void>((resolve) => { requested = resolve; });
    globalThis.fetch = async (input) => {
      if (!(input instanceof Request)) throw new Error("Expected managed native Request");
      const url = new URL(input.url); paths.push(url.pathname);
      if (url.origin === "https://reader-ui.invalid") {
        if (url.pathname === "/token") return Response.json({ access_token: "synthetic-ui", token_type: "Bearer", expires_in: 3600 });
        if (url.pathname === "/gmail/profile") return Response.json({ emailAddress: "reader@example.test", historyId: "10" });
        if (url.pathname === "/gmail/history") return Response.json({ historyId: "10" });
        if (url.pathname === "/gmail/labels") return Response.json({ labels: [] });
        if (url.pathname === "/gmail/messages/header" && url.searchParams.get("format") === "raw") {
          if (++rawRequests === 1) return Response.json({}, { status: 503 });
          requested(); await held;
          const raw = Buffer.from("From: sender@example.test\r\nTo: reader@example.test\r\nSubject: Header body\r\nContent-Type: text/plain\r\n\r\nExact selected-reader body.").toString("base64url");
          return Response.json({ id: "header", threadId: "header", raw, labelIds: ["INBOX"] });
        }
      }
      unexpected.push(input.url); throw new Error("Unexpected synthetic route");
    };
    const providers: ProviderRegistry = {
      create: (ctx) => createGmailProvider(ctx, { endpoints: { api: "https://reader-ui.invalid/gmail", token: "https://reader-ui.invalid/token" } }),
      async verifyImap() {}, async connectGmail() { throw new Error("Unexpected OAuth"); },
    };
    let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
    try {
      server = await startDevServer({ port: 0, dataDir: dir, token: "synthetic-ui", seed: false, autoSync: false, providers, iconTransport: null });
      const backend = server.backend;
      const { account } = await backend.store.accounts.create({ kind: "gmail", email: "reader@example.test", displayName: "Reader", color: "indigo", now: 1 });
      await backend.setSecret(`account:${account.id}:refreshToken`, "synthetic-refresh");
      await backend.store.accounts.setCursor(account.id, { historyId: "10" });
      await backend.server.invoke("settings.update", { language, theme, layout: "split", senderIcons: false, gmailClientId: "synthetic-client" }, { clientId: "setup", origin: "dev" });
      await backend.ingestSliced([true, false].map((full) => ({
        accountId: account.id, providerMsgId: full ? "sibling" : "header", providerThreadId: full ? "sibling" : "header", rfcMessageId: `${full ? "sibling" : "header"}@example.test`,
        inReplyTo: null, references: [], from: { name: "Sender", email: "sender@example.test" }, to: [], cc: [], bcc: [], subject: full ? "Healthy sibling" : "Header body", date: full ? 2000 : 1000, snippet: full ? "Exact sibling" : "", bodyText: full ? "Exact sibling\n" + "Sibling context\n".repeat(100) : null, bodyHtml: null, bodyState: full ? "full" as const : "partial" as const, listId: null,
        isRead: true, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 10,
      })));
      const threads = await backend.store.threads.list({ view: "inbox", limit: 10 });
      const partial = threads.items.find((item) => item.subject === "Header body")!;
      const draft = await backend.server.invoke("drafts.save", { accountId: account.id, subject: "Saved draft", bodyText: "Exact authored text" }, { clientId: "setup", origin: "renderer" });
      await backend.reminders.set([partial.id], Date.now() + 3_600_000, "always");
      const reminders = await backend.reminders.refresh();
      await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (url.hostname === "127.0.0.1") return route.continue();
        unexpected.push(url.href); return route.abort();
      });
      await page.addInitScript((value) => localStorage.setItem("terno:language", value), language);
      await page.goto(`/?backend=${encodeURIComponent(server.url)}&token=synthetic-ui`);
      await expect(page.getByTestId("reader-subject")).toHaveText("Healthy sibling");
      await page.evaluate(async (id) => {
        const module = "/src/state/threads.ts";
        const { loadThread }: typeof import("../src/state/threads") = await import(module);
        await loadThread(id);
      }, partial.id);
      expect(paths.filter((path) => path === "/gmail/messages/header")).toHaveLength(0);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("j");
      await expect(page.getByTestId("reader-subject")).toHaveText("Header body");
      await expect(page.getByText(t("reader.downloadFailed"), { exact: true })).toBeVisible();
      expect((await new AxeBuilder({ page }).include('[data-testid="reader"]').include('[data-testid="snack-dock"]').analyze()).violations).toEqual([]);
      await page.screenshot({ path: `/tmp/terno-w05-foreground/reader-error-${language}-${theme}.png` });
      const retry = page.getByRole("button", { name: t("common.retry"), exact: true });
      await retry.focus(); await page.keyboard.press("Enter");
      await request;
      await page.keyboard.press("k");
      await expect(page.getByTestId("reader-subject")).toHaveText("Healthy sibling");
      const preserved = await page.locator("[data-reader-scroller]").evaluate((element) => { element.scrollTop = 250; return element.scrollTop; });
      expect(preserved).toBeGreaterThan(0);
      await page.getByTestId("reader").evaluate((element) => element.setAttribute("data-foreground-reader", "true"));
      await page.evaluate(() => document.activeElement?.setAttribute("data-foreground-focus", "true"));
      release();
      await expect.poll(async () => (await backend.store.threads.get(partial.id))?.messages[0]?.bodyText).toBe("Exact selected-reader body.\n");
      await expect(page.getByTestId("reader-subject")).toHaveText("Healthy sibling");
      await expect(page.locator('[data-foreground-reader="true"]')).toBeVisible();
      await expect(page.locator('[data-foreground-focus="true"]')).toBeFocused();
      expect(await page.locator("[data-reader-scroller]").evaluate((element) => element.scrollTop)).toBe(preserved);
      await page.keyboard.press("j");
      await expect(page.getByTestId("reader")).toContainText("Exact selected-reader body.");
      expect(paths.filter((path) => path === "/gmail/messages/header")).toHaveLength(2);
      await expect(page.locator("html")).toHaveClass(theme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
      expect((await new AxeBuilder({ page }).include('[data-testid="reader"]').analyze()).violations).toEqual([]);
      expect(await backend.server.invoke("drafts.list", {}, { clientId: "setup", origin: "renderer" })).toEqual([draft]);
      expect((await backend.reminders.refresh()).reminders).toEqual(reminders.reminders);
      await page.screenshot({ path: `/tmp/terno-w05-foreground/reader-${language}-${theme}.png` });
      expect(unexpected).toEqual([]);
    } finally {
      release(); await page.close(); await server?.close(); globalThis.fetch = previous; rmSync(dir, { recursive: true, force: true });
    }
  });
}
