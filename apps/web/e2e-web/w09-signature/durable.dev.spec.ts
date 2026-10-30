import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { switches } from "../../e2e/w09-signature-helper";

for (const storage of ["opfs", "idb"] as const) for (const mode of ["new", "reply", "replyAll", "forward"] as const) {
  test(`${storage} ${mode} mounted switch and durable reopen`, async ({ page, context }, info) => {
    const unexpected: string[] = [];
    await context.route("**/*", (route) => {
      if (new URL(route.request().url()).origin === new URL(info.project.use.baseURL!).origin) return route.continue();
      unexpected.push(route.request().url()); return route.abort();
    });
    await page.goto(`/?demo=20&accounts=2&mailbox=w09-${storage}-${mode}&storage=${storage === "opfs" ? "opfs-sqlite" : storage}`);
    await expect.poll(() => page.evaluate(() => window.__ternoWeb?.storage)).toBe(storage === "opfs" ? "opfs-sqlite" : "idb");
    const accounts = await page.evaluate(async () => {
      const c = window.__ternoWeb!.client;
      const { accounts } = await c.call("app.bootstrap", {});
      for (const [i, a] of accounts.entries()) await c.call("accounts.update", { id: a.id, signature: i ? "Signature B" : "Signature A" });
      return accounts.map((a, i) => ({ ...a, signature: i ? "Signature B" : "Signature A" }));
    });
    const theme = storage === "idb" ? "dark" as const : "light" as const, language = storage === "idb" ? "es" as const : "en" as const;
    await page.evaluate(async ({ theme, language }) => { await window.__ternoWeb!.client.call("settings.update", { theme, language }); localStorage.setItem("terno:language", language); }, { theme, language });
    await page.reload(); await page.locator("[data-ready]").waitFor();
    if (mode === "new") {
      await page.getByTestId("compose-button").click();
      await page.getByTestId("compose-to").fill("recipient@example.test"); await page.getByTestId("compose-to").press("Enter");
      await page.getByTestId("compose-subject").fill("W09 browser durable");
    } else {
      const thread = await page.evaluate(async (accountId) => {
        const c = window.__ternoWeb!.client;
        const list = await c.call("threads.list", { view: "inbox", accountId, limit: 30 });
        for (const t of list.items) {
          const d = await c.call("threads.get", { threadId: t.id });
          if (d && d.messages.every((m) => !m.attachments.length)) return t.id;
        }
        throw new Error("No attachment-free source");
      }, accounts[0]!.id);
      await page.locator(`[data-testid="thread-row"][data-thread-id="${thread}"]`).click();
      await page.getByTestId(mode === "replyAll" ? "action-reply-all" : `action-${mode}`).click();
      if (mode === "forward") { await page.getByTestId("compose-to").fill("recipient@example.test"); await page.getByTestId("compose-to").press("Enter"); }
    }
    const { saved, before } = await switches(page, accounts);
    expect(saved.threadId).toBeNull(); expect(saved.inReplyToMessageId).toBe(before.inReplyToMessageId); expect(saved.forwardOfMessageId).toBe(before.forwardOfMessageId); expect(saved.replyContext).toEqual(before.replyContext ?? null);
    expect((await new AxeBuilder({ page }).include('[data-testid="composer"]').analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`${storage}-${mode}-${language}.png`) });
    expect(unexpected).toEqual([]);
  });
}
