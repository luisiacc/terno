import AxeBuilder from "@axe-core/playwright";
import { fromPlainText, toEmailHtml } from "@terno/richtext";
import { sqlDb, type DevServer } from "../../backend-dev/src/server";
import type { Page } from "@playwright/test";
import { test, expect, rows, readerShown, focusOn } from "./fixtures";
test.use({fixedClock:false});
/** A reply draft with this body on the newest conversation, opened (r) and focused. */
async function openDraft(page: Page, server: DevServer, bodyText: string) {
  const db = sqlDb(server.backend.store);
  const m = db.get<{ id: number; thread_id: number; account_id: number }>("SELECT m.id, m.thread_id, m.account_id FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.in_inbox = 1 ORDER BY t.last_date DESC, m.date DESC LIMIT 1")!;
  await server.backend.store.drafts.save({ accountId: m.account_id, threadId: m.thread_id, mode: "reply", to: [{ name: "Ana", email: "ana@example.com" }], cc: [], subject: "Re: x", inReplyToMessageId: m.id, bodyText }, Date.now());
  await page.reload();
  await page.locator("[data-ready]").waitFor();
  await rows(page).first().dispatchEvent("mousedown");
  await readerShown(page, 8_000);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("r");
  const editor = page.getByTestId("compose-body");
  await focusOn(page, "compose-body", 60_000);
  // the backend's models are warm (a draft opened warms them; the first build is over)
  await server.backend.autocomplete.warm();
  await server.backend.autocomplete.idle();
  return editor;
}



for (const scheme of ["light", "dark"] as const) test(`huge suggestion preserves authored content and native controls (${scheme})`, async ({ app: page, server }) => {
  test.setTimeout(180_000);
  await server.backend.server.invoke("settings.update", { theme: scheme }, { clientId: "huge", origin: "dev" });
  const lines = Array.from({ length: 3000 }, (_, i) => `${i} authored line`);
  const body = await openDraft(page, server, lines.join("\n"));
  const ghost = page.getByTestId("compose-ghost");
  const shown = async () => {
    await expect.poll(() => ghost.getAttribute("data-ghost"), { timeout: 10_000 }).toMatch(/^ look/);
    return (await ghost.getAttribute("data-ghost"))!;
  };
  const saved = async () => {
    const expected = lines.join("\n");
    const html = toEmailHtml(fromPlainText(expected));
    await expect.poll(async () => {
      const drafts = await server.backend.server.invoke("drafts.list", {}, { clientId: "huge", origin: "dev" });
      return { text: drafts[0]?.bodyText, html: drafts[0]?.bodyHtml };
    }, { timeout: 20_000 }).toEqual({ text: expected, html });
    expect(await body.locator("p").allTextContents()).toEqual(lines);
    expect(await body.evaluate(root => {
      const sel = document.getSelection()!;
      return { inside: root.contains(sel.focusNode), collapsed: sel.isCollapsed, offset: sel.focusOffset };
    })).toEqual({ inside: true, collapsed: true, offset: lines.at(-1)!.length });
  };
  await page.keyboard.press("Enter"); lines.push("");
  await page.keyboard.type("Could you take a", { delay: 90 }); lines[lines.length - 1] = "Could you take a";
  const accepted = await shown();
  await page.screenshot({ path: `/tmp/terno-huge-${scheme}.png` });
  expect((await new AxeBuilder({ page }).include('[data-testid="compose-body"]').analyze()).violations).toEqual([]);
  await page.keyboard.press("Tab"); lines[lines.length - 1] += accepted;
  await expect(body).toBeFocused(); await saved();
  await page.keyboard.press("ControlOrMeta+z"); lines[lines.length - 1] = "Could you take a"; await saved();
  await page.keyboard.press("ControlOrMeta+Shift+z"); lines[lines.length - 1] += accepted; await saved();
  await page.keyboard.press("Enter"); lines.push("");
  await page.keyboard.type("Could you take a", { delay: 90 }); lines[lines.length - 1] = "Could you take a";
  await shown(); await page.keyboard.press("Escape");
  await expect(body).toBeFocused(); await expect(ghost).toHaveAttribute("hidden", ""); await saved();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "漢字", selectionStart: 2, selectionEnd: 2 });
  await cdp.send("Input.insertText", { text: "漢字" }); await cdp.detach();
  lines[lines.length - 1] += "漢字"; await saved();
});
