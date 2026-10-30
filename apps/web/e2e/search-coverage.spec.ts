import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { RpcRequest } from "@terno/core/rpc";
import { createDemoProvider, demoRegistry, type ProviderRegistry } from "@terno/mail";
import { sqlDb, startDevServer } from "../../backend-dev/src/server";
import { msg } from "../../../packages/store/src/conformance/fixtures";
import { E2E_NOW } from "./constants";

const copy = {
  en: {
    name: "Search all your accounts",
    help: "Search covers mail saved in Terno, which may be incomplete. Check your mail provider’s website if something is missing.",
    indexing: "indexing",
  },
  es: {
    name: "Buscar en todas tus cuentas",
    help: "La búsqueda abarca el correo guardado en Terno, que puede estar incompleto. Si falta algo, consulta el sitio web de tu proveedor de correo.",
    indexing: "indexando",
  },
};

for (const design of ["macos", "lumen"] as const) for (const language of ["en", "es"] as const) for (const theme of ["light", "dark"] as const) {
  test(`local search coverage (${design}, ${language}, ${theme})`, async ({ page }, testInfo) => {
    const dir = mkdtempSync(join(tmpdir(), "terno-search-coverage-"));
    const providerCalls: string[] = [];
    const providers: ProviderRegistry = {
      ...demoRegistry,
      create(ctx) {
        const demo = createDemoProvider(ctx, 0);
        return {
          ...demo,
          async sync(sink) { providerCalls.push("sync"); return demo.sync(sink); },
          async execute(op) { providerCalls.push(op.kind); return demo.execute(op); },
        };
      },
    };
    const server = await startDevServer({ port: 0, dataDir: dir, token: "synthetic", fresh: true, threads: 180, accounts: 2, autoSync: false, providers, iconTransport: null, now: () => E2E_NOW });
    const ctx = { clientId: "setup", origin: "dev" as const };
    const rpc: RpcRequest[] = [];
    const responses: { complete: boolean }[] = [];
    const external: string[] = [];
    // Fail closed on browser traffic outside this synthetic renderer and backend.
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === "127.0.0.1") await route.continue();
      else { external.push(url.origin); await route.abort(); }
    });
    page.on("websocket", (ws) => {
      ws.on("framesent", ({ payload }) => {
        const message = JSON.parse(String(payload));
        if (message.t === "req") rpc.push(message);
      });
      ws.on("framereceived", ({ payload }) => {
        const message = JSON.parse(String(payload));
        if (message.t === "res" && rpc.some((r) => r.id === message.id && r.m === "threads.search")) responses.push(message.r);
      });
    });
    try {
      await server.backend.server.invoke("settings.update", { design, language, theme, senderIcons: false }, ctx);
      const db = sqlDb(server.backend.store);
      const accounts = db.all<{ id: number; email: string }>("SELECT id, email FROM accounts ORDER BY id");
      await server.backend.store.sync.ingest(
        (["inbox", "archive", "spam", "trash"] as const).map((place, i) => msg({
          accountId: accounts[i % accounts.length]!.id,
          providerMsgId: `coverage-${place}`, providerThreadId: `coverage-${place}`, rfcMessageId: `<coverage-${place}@example.test>`, date: E2E_NOW - i * 1000,
          subject: "Coverageneedle", bodyText: "Saved searchable body", isRead: false,
          inInbox: place === "inbox", isSpam: place === "spam", isTrash: place === "trash",
        })),
        { applyFilters: false, now: E2E_NOW, classifier: null },
      );
      await page.goto(`/?backend=${encodeURIComponent(server.url)}&token=synthetic`);
      await page.locator("[data-ready]").waitFor();
      await expect(page.getByTestId("thread-row").first()).toBeVisible();
      const input = page.getByTestId("search-input");
      const help = page.getByTestId("search-coverage");
      await expect(help).toHaveCount(0);
      if (language === "es") await page.setViewportSize({ width: 980, height: 740 });
      const scroller = page.getByRole("listbox");
      await scroller.evaluate((el) => new Promise<void>((resolve) => {
        el.addEventListener("scroll", () => requestAnimationFrame(() => resolve()), { once: true });
        el.scrollTop = 180;
      }));
      const position = await scroller.evaluate((el) => el.scrollTop);
      const selected = await page.locator("[data-testid=thread-row][data-cursor]").getAttribute("data-thread-id");
      const beforeOpen = rpc.filter((r) => r.m === "threads.search").length;
      await page.keyboard.press("/");
      await expect(input).toBeFocused();
      await expect(input).toHaveAccessibleName(copy[language].name);
      await expect(input).toHaveAccessibleDescription(copy[language].help);
      await expect(help).toHaveText(copy[language].help);
      expect(await scroller.evaluate((el) => el.scrollTop)).toBe(position);
      expect(await page.locator("[data-testid=thread-row][data-cursor]").getAttribute("data-thread-id")).toBe(selected);
      await input.press("Tab");
      await expect(help).toHaveCount(0);
      expect(await scroller.evaluate((el) => el.scrollTop)).toBe(position);
      await page.keyboard.press("/");
      await expect(input).toBeFocused();
      expect(rpc.filter((r) => r.m === "threads.search")).toHaveLength(beforeOpen);

      // An exact local answer is not a claim about older, undownloaded provider mail.
      await input.fill("subject:provideronlyoldermail");
      await expect(page.getByTestId("list-empty")).toBeVisible();
      await expect(page.getByTestId("search-stats")).toContainText(language === "en" ? "0 results" : "0 resultados");
      await expect(page.getByTestId("search-stats")).not.toContainText(copy[language].indexing);
      await input.press("Tab");
      await expect(input).not.toBeFocused();
      await expect(help).toBeVisible();
      const scoped = new AxeBuilder({ page }).include("[data-testid=list-header]").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
      expect((await scoped.analyze()).violations).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`search-coverage-${design}-${language}-${theme}.png`) });
      expect(responses.at(-1)?.complete).toBe(true);
      await server.backend.store.sync.ingest([
        msg({ accountId: accounts[0]!.id, providerMsgId: "headers-only", subject: "Headeronlyneedle", bodyState: "none", bodyText: null, bodyHtml: null }),
      ], { applyFilters: false, now: E2E_NOW, classifier: null });
      await input.fill("subject:headeronlyneedle");
      await expect(page.getByTestId("thread-row")).toHaveCount(1);
      await expect(page.getByTestId("search-stats")).toContainText(copy[language].indexing);
      expect(responses.at(-1)?.complete).toBe(false);
      await expect(help).toBeVisible();
      await input.fill("bodyonlynotdownloaded");
      await expect(page.getByTestId("list-empty")).toBeVisible();
      expect(db.get<{ n: number }>("SELECT count(*) AS n FROM messages WHERE provider_msg_id = 'headers-only'")!.n).toBe(1);

      const category = db.get<{ id: number }>("SELECT id FROM categories ORDER BY id LIMIT 1")!;
      await page.evaluate(async ({ accountId, categoryId }) => {
        const modulePath = "/src/state/app.ts";
        const { navigate } = await import(modulePath);
        navigate({ accountId, categoryId });
      }, { accountId: accounts[0]!.id, categoryId: category.id });
      await page.keyboard.press("/");
      await input.fill("coverageneedle");
      await expect(page.getByTestId("thread-row")).toHaveCount(4);
      await expect.poll(() => rpc.filter((r) => r.m === "threads.search").at(-1)?.p).toEqual({ query: "coverageneedle", limit: 100 });
      expect((await page.getByTestId("row-place").allTextContents()).sort()).toEqual((language === "en" ? ["Spam", "Trash"] : ["Spam", "Papelera"]).sort());
      await expect(help).toBeVisible();
      await input.evaluate((el: HTMLInputElement) => el.setSelectionRange(3, 7));
      expect(await input.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([3, 7]);
      await expect(input).toBeFocused();
      await input.press("ArrowDown");
      await expect(input).not.toBeFocused();
      await expect(help).toBeVisible();
      await page.keyboard.press("/");
      await input.press("Enter");
      await expect(input).not.toBeFocused();
      await expect(input).toHaveValue("coverageneedle");
      await input.fill("in:all coverageneedle");
      await expect(page.getByTestId("thread-row")).toHaveCount(2);

      // Real typed operators and the quick filter reach the local RPC unchanged.
      const account = accounts[0]!;
      await page.getByTestId(design === "lumen" ? "quick-filter-unread" : "unread-filter").click();
      const query = `in:all account:${account.email} subject:factura`;
      await input.fill(query);
      await expect.poll(() => rpc.filter((r) => r.m === "threads.search").at(-1)?.p).toEqual({ query, limit: 100, filter: "unread" });
      await expect(page.getByTestId("search-stats")).toBeVisible();
      await expect(help).toBeVisible();
      await input.press("Escape");
      await expect(input).toHaveValue("");
      await expect(help).toHaveCount(0);
      await page.getByTestId("nav-inbox").click();
      await expect(page.getByTestId("thread-row").first()).toBeVisible();
      await page.keyboard.press("/");
      await expect(input).toBeFocused();
      if (design === "lumen") {
        await input.press("Escape");
        await expect(input).toHaveCount(0);
        await expect(page.getByTestId("search-button")).toBeFocused();
      } else {
        await input.press("Tab");
        await expect(help).toHaveCount(0);
      }
      // Category review keeps its own suggestions list; it is not a mail search.
      await page.evaluate(async (id) => {
        const modulePath = "/src/state/app.ts";
        const { navigate } = await import(modulePath);
        navigate({ categoryId: id, reviewCategoryId: id });
      }, category.id);
      await page.keyboard.press("/");
      await expect(input).toBeFocused();
      await input.fill("review text");
      await expect(help).toHaveCount(0);
      expect(providerCalls).toEqual([]);
      expect(external).toEqual([]);
      expect(rpc.filter((r) => r.m === "sync.now" || r.m.startsWith("threads.act") || r.m === "messages.loadBody")).toEqual([]);
      await testInfo.attach("search-observations", { body: JSON.stringify({ searches: rpc.filter((r) => r.m === "threads.search"), responses, providerCalls, external }, null, 2), contentType: "application/json" });
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
