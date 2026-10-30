import { mkdirSync } from "node:fs";
import type { Node as PMNode } from "prosemirror-model";
import AxeBuilder from "@axe-core/playwright";
import { expect, focusOn, readerShown, rows, test } from "./fixtures";
import { sqlDb } from "../../backend-dev/src/server";

for (const scheme of ["light", "dark"] as const) test(`supported huge sibling groups preserve real authored content (${scheme})`, async ({ app: page, server }) => {
  test.setTimeout(180_000);
  await server.backend.server.invoke("settings.update", { theme: scheme }, { clientId: "groups", origin: "dev" });
  const line = "Hola, te paso las notas de la reunión con todos los puntos que vimos hoy.";
  const lines = Array.from({ length: Math.ceil(2_000_000 / (line.length + 1)) }, (_, i) => `${i} ${line}`);
  const m = sqlDb(server.backend.store).get<{ id: number; thread_id: number; account_id: number }>("SELECT m.id, m.thread_id, m.account_id FROM messages m JOIN threads t ON t.id=m.thread_id WHERE t.in_inbox=1 ORDER BY t.last_date DESC,m.date DESC LIMIT 1")!;
  await server.backend.store.drafts.save({ accountId: m.account_id, threadId: m.thread_id, mode: "reply", to: [{ name: "", email: "ana@example.com" }], cc: [], subject: "Re: groups", inReplyToMessageId: m.id, bodyText: lines.join("\n") }, Date.now());
  await page.reload(); await page.locator("[data-ready]").waitFor();
  await rows(page).first().dispatchEvent("mousedown"); await readerShown(page, 20_000);
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await page.keyboard.press("r"); await focusOn(page, "compose-body", 20_000);
  const body = page.getByTestId("compose-body");
  const groupCount = await body.locator(":scope > .ProseMirror-sibling-group").count();
  expect(groupCount).toBeGreaterThanOrEqual(Math.ceil((lines.length - 2) / 256));
  expect(groupCount).toBeLessThanOrEqual(Math.ceil((lines.length - 2) / 128));
  for (const index of [0, 13514, lines.length - 1]) {
    await body.evaluate((root, at) => {
      const p = root.querySelectorAll("p")[at]!;
      p.scrollIntoView({ block: "center" });
      const sel = document.getSelection()!;
      sel.collapse(p.firstChild, 3);
    }, index);
    await page.keyboard.type("XYZ", { delay: 40 });
    lines[index] = lines[index]!.slice(0, 3) + "XYZ" + lines[index]!.slice(3);
    expect(await body.locator("p").nth(index).textContent()).toBe(lines[index]);
  }
  await page.keyboard.press("ControlOrMeta+z");
  lines[lines.length - 1] = lines[lines.length - 1]!.replace("XYZ", "");
  expect(await body.locator("p").last().textContent()).toBe(lines.at(-1));
  await page.keyboard.press("ControlOrMeta+Shift+z");
  lines[lines.length - 1] = lines[lines.length - 1]!.slice(0, 3) + "XYZ" + lines[lines.length - 1]!.slice(3);
  await body.evaluate(root => {
    const paragraphs = root.querySelectorAll("p");
    const sel = document.getSelection()!;
    sel.setBaseAndExtent(paragraphs[256]!.firstChild!, 4, paragraphs[127]!.firstChild!, 2);
  });
  expect(await page.evaluate(() => { const sel = document.getSelection()!; return sel.anchorNode!.compareDocumentPosition(sel.focusNode!) & Node.DOCUMENT_POSITION_PRECEDING; })).toBeTruthy();
  // Read-only observation of the actual application's document, not a replacement editor or transaction.
  const authored = await body.evaluate(async root => {
    // @ts-expect-error Vite resolves the application module in the browser.
    const { serialize } = await import("/src/components/composer/editor.ts");
    const doc = (root as unknown as { pmViewDesc: { node: PMNode } }).pmViewDesc.node;
    return { ...serialize(doc), count: doc.childCount, domText: [...root.querySelectorAll("p")].map(p => p.textContent).join("\n") };
  });
  expect(authored.count).toBe(27028);
  expect(authored.text).toBe(lines.join("\n"));
  expect(authored.domText).toBe(authored.text);
  await expect(page.getByTestId("draft-status")).toHaveText("Draft saved", { timeout: 20_000 });
  const saved = await server.backend.server.invoke("drafts.list", {}, { clientId: "groups", origin: "dev" });
  expect(saved[0]!.bodyText).toBe(authored.text); expect(saved[0]!.bodyHtml).toBe(authored.html);
  expect(await page.evaluate(() => (window as unknown as { find(text: string): boolean }).find("13515"))).toBe(true);
  // Exercise native parsing and composition inside a contained middle group.
  await body.evaluate(root => {
    const p = root.querySelectorAll("p")[300]!;
    p.scrollIntoView({ block: "center" });
    document.getSelection()!.collapse(p.firstChild, 4);
    const data = new DataTransfer();
    data.setData("text/html", `<blockquote><p><b>PASTED</b> ${"wrapped ".repeat(1500)}</p><ul><li>list item</li></ul></blockquote>`);
    data.setData("text/plain", "PASTED wrapped list item");
    root.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(body.locator("blockquote")).toContainText("PASTED");
  await expect(body.locator("li")).toContainText("list item");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "漢字", selectionStart: 2, selectionEnd: 2 });
  await cdp.send("Input.insertText", { text: "漢字" });
  await cdp.detach();
  await expect(body).toContainText("漢字");
  const at = await body.evaluate(root => {
    const p = root.querySelectorAll("p")[500]!;
    p.scrollIntoView({ block: "center" });
    const range = document.createRange(); range.setStart(p.firstChild!, 3); range.setEnd(p.firstChild!, 4);
    const box = range.getBoundingClientRect(); return { x: box.right - 1, y: box.top + box.height / 2 };
  });
  const data = await page.evaluateHandle(async () => {
    const canvas = new OffscreenCanvas(120, 60); const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#337755"; ctx.fillRect(0, 0, 120, 60);
    const dt = new DataTransfer(); dt.items.add(new File([await canvas.convertToBlob({ type: "image/png" })], "group.png", { type: "image/png" }));
    return dt;
  });
  await body.dispatchEvent("drop", { dataTransfer: data, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true });
  await data.dispose();
  await expect(body.locator("img.rt-image:not(.ProseMirror-widget)")).toHaveCount(1);
  await expect(body).toBeFocused();
  await page.keyboard.press("ControlOrMeta+z"); await expect(body.locator("img.rt-image:not(.ProseMirror-widget)")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Shift+z"); await expect(body.locator("img.rt-image:not(.ProseMirror-widget)")).toHaveCount(1);
  await expect(page.getByTestId("draft-status")).toHaveText("Draft saved", { timeout: 20_000 });
  const mixed = await body.evaluate(async root => {
    // @ts-expect-error Vite resolves the application module in the browser.
    const { serialize } = await import("/src/components/composer/editor.ts");
    return serialize((root as unknown as { pmViewDesc: { node: PMNode } }).pmViewDesc.node);
  });
  const mixedSaved = await server.backend.server.invoke("drafts.list", {}, { clientId: "groups", origin: "dev" });
  expect(mixedSaved[0]!.bodyText).toBe(mixed.text); expect(mixedSaved[0]!.bodyHtml).toBe(mixed.html);
  expect(mixed.html).toContain("cid:"); expect(mixed.text).toContain("漢字");
  expect((await new AxeBuilder({ page }).include('[data-testid="compose-body"]').analyze()).violations).toEqual([]);
  mkdirSync("/tmp/terno-supported-groups/shots", { recursive: true });
  await page.screenshot({ path: `/tmp/terno-supported-groups/shots/${scheme}.png` });
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.documentElement.hasAttribute("data-focus-ring"))).toBe(true);
});
