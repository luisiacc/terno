import { ingest, msg } from "@terno/store/conformance";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { expect, openRow, stabilize, test } from "./fixtures";
mkdirSync("/tmp/terno-missing-draft-r2-shots", { recursive: true });

for (const normalization of ["missing original", "cross-account"] as const) test(`copy context normalization keeps its original inline editor (${normalization}) @design`, async ({ app: page, server }, info) => {
  const account = (await server.backend.store.accounts.list())[0]!;
  await ingest(server.backend.store, [msg({ accountId: account.id, providerMsgId: "r2-first", rfcMessageId: "r2-first@example.test", date: Date.now() + 1000 }), msg({ accountId: account.id, providerMsgId: "r2-second", references: ["r2-first@example.test"], date: Date.now() + 2000 })]);
  await page.reload(); await page.getByTestId("thread-row").first().waitFor();
  await openRow(page, 0); await page.getByTestId("quick-reply").click();
  const body = page.getByTestId("compose-body"); await body.fill("inline exact work");
  await body.press("Meta+a"); await body.press("Meta+b"); await body.press("ArrowRight");
  await page.getByTestId("compose-to").fill('"Pérez, Ana" <ana@example.test>, bob@');
  await expect.poll(async () => (await server.backend.store.drafts.list())[0]?.body_text).toBe("inline exact work");
  const original = (await server.backend.store.drafts.list())[0]!;
  if (normalization === "cross-account") {
    const accounts = await server.backend.store.accounts.list(), other = accounts.find((a) => a.id !== original.account_id)!;
    await page.getByTestId("compose-from").click(); await page.getByRole("option").filter({ hasText: other.email }).click();
    await expect.poll(async () => (await server.backend.store.drafts.list())[0]?.account_id).toBe(other.id);
    await expect(body).toBeVisible();
  } else {
    expect((await server.backend.store.threads.get(original.thread_id!))!.messages.length).toBeGreaterThan(1);
    await server.backend.store.sync.remove([original.in_reply_to_message_id!]);
    expect((await server.backend.store.threads.get(original.thread_id!))!.messages.length).toBeGreaterThan(0);
  }
  await server.backend.store.drafts.delete(original.id);
  await expect(body).toHaveText("inline exact work");
  await page.evaluate("window.__terno.setComposerCaret(0)"); await page.keyboard.type(" latest");
  await expect(body).toHaveText("inline exact work latest");
  await expect(page.getByTestId("draft-save-copy")).toBeVisible();
  const save = server.backend.store.drafts.save;
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>((r) => { release = r; }), waiting = new Promise<void>((r) => { reached = r; });
  server.backend.store.drafts.save = async (...args) => { if (args[0].id === undefined) { reached(); await gate; } return save(...args); };
  try {
    await page.getByTestId("draft-save-copy").click(); await waiting;
    await body.click(); await body.press("ArrowRight"); await body.press("Meta+ArrowRight"); await page.keyboard.type(" during copy"); await body.press("ArrowLeft");
    await page.getByTestId("format-italic").click();
    const html = await body.innerHTML();
    const caret = await page.evaluate(() => ({ offset: window.getSelection()?.anchorOffset, text: window.getSelection()?.anchorNode?.textContent }));
    const dom = await body.elementHandle(); release();
    await expect(page.getByTestId("draft-save-copy")).toHaveCount(0); await expect(body).toBeFocused();
    expect(await body.evaluate((el, old) => el === old, dom)).toBe(true);
    expect(await body.innerHTML()).toBe(html);
    expect(await page.evaluate(() => ({ offset: window.getSelection()?.anchorOffset, text: window.getSelection()?.anchorNode?.textContent }))).toEqual(caret);
    await expect(page.getByTestId("format-italic")).toHaveAttribute("aria-pressed", "true");
    await page.clock.setFixedTime(new Date((await page.evaluate(() => Date.now())) + 1000));
    await page.keyboard.type("X"); await body.press("Meta+z"); expect(await body.innerHTML()).toBe(html);
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme }); await stabilize(page);
      expect((await new AxeBuilder({ page }).include("[data-testid=composer]").analyze()).violations).toEqual([]);
      await page.screenshot({ path: `/tmp/terno-missing-draft-r2-shots/normalized-${normalization.replace(" ", "-")}-${info.project.name}-${theme}.png` });
    }
    await expect.poll(async () => (await server.backend.store.drafts.list())[0]?.body_text).toBe("inline exact work latest during copy");
    expect((await server.backend.store.drafts.list())[0]).toMatchObject(normalization === "cross-account" ? { thread_id: null, mode: "reply" } : { mode: "reply", in_reply_to_message_id: original.in_reply_to_message_id, reply_context_json: original.reply_context_json });
  } finally { release(); server.backend.store.drafts.save = save; }
});

