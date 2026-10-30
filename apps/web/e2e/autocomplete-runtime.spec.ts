import type { Page } from "@playwright/test";
import type { Node as PMNode } from "prosemirror-model";
import { fromPlainText, toEmailHtml } from "@terno/richtext";
import { sqlDb, type DevServer } from "../../backend-dev/src/server";
import { expect, focusOn, readerShown, rows, test } from "./fixtures";

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

/** The caret at the end of the top-level line `index` (-1: the last), or at `offset` into it, set in the editor's state (a DOM selection would race the editor reading it in a huge draft). */
async function caretAt(page: Page, index: number, offset?: number) {
  expect(await page.evaluate(([index, offset]) => (window as unknown as { __terno: { setComposerCaret(i: number, o?: number): boolean } }).__terno.setComposerCaret(index!, offset ?? undefined), [index, offset ?? null] as const)).toBe(true);
  await page.waitForTimeout(60);
}

/** Chinese lines: three bytes a character in UTF-8, so a 10 MB draft stays within the 5M-character draft limit (plan 16). */
const CHINESE = "你好，我把会议的笔记发给你，包括我们今天讨论的所有要点和下一步的安排。";
function chineseLines(megabytes: number) {
  const n = Math.ceil((megabytes * 1_000_000) / (new TextEncoder().encode(CHINESE).length + 8));
  return Array.from({ length: n }, (_, i) => `${i} ${CHINESE}`).join("\n");
}


test("a fitted suggestion at the true 10 MB model midpoint preserves the full draft and native history", async ({ app: page, server }) => {
  test.setTimeout(180_000);
  const lines = chineseLines(10).split("\n");
  const index = Math.floor(lines.length / 2);
  const body = await openDraft(page, server, lines.join("\n"));
  await caretAt(page, index);
  await page.keyboard.press("Enter");
  lines.splice(index + 1, 0, "Could you take a");
  await page.keyboard.type(lines[index + 1]!, { delay: 30 });
  const ghost = page.getByTestId("compose-ghost");
  await expect.poll(() => ghost.getAttribute("data-ghost")).toMatch(/^ look/);
  const shown = await ghost.getAttribute("data-ghost");
  expect(shown).toBeTruthy();
  await page.keyboard.press("Tab");
  lines[index + 1] += shown!;
  const check = async () => {
    const actual = await body.evaluate(root => {
      const doc = (root as unknown as { pmViewDesc: { node: PMNode } }).pmViewDesc.node;
      return { json: doc.toJSON(), text: [...root.querySelectorAll("p")].map(p => p.textContent).join("\n") };
    });
    const expected = lines.join("\n");
    expect(actual.json).toEqual(fromPlainText(expected).toJSON());
    expect(actual.text).toBe(expected);
    await expect(body).toBeFocused();
    await expect(page.getByTestId("draft-status")).toHaveText(/saved/i, { timeout: 60_000 });
    const saved = await server.backend.server.invoke("drafts.list", {}, { clientId: "autocomplete-runtime", origin: "dev" });
    expect(saved[0]!.bodyText).toBe(expected);
    expect(saved[0]!.bodyHtml).toBe(toEmailHtml(fromPlainText(expected)));
  };
  await check();
  await page.keyboard.press("ControlOrMeta+z");
  lines[index + 1] = "Could you take a";
  await check();
  await page.keyboard.press("ControlOrMeta+Shift+z");
  lines[index + 1] += shown!;
  await check();
});
